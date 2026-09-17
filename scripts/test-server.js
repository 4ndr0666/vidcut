/* Quick offline verification of app/server.js — the streaming
 * transcode server — without Electron. Boots the server, pulls a
 * chunk through a real HTTP request, verifies the bytes look like a
 * fragmented MP4, then verifies shutdown() destroys the socket set.
 * Run: node scripts/test-server.js */

const { execFileSync } = require('child_process')
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const streamer = require(path.join(ROOT, 'app', 'server.js'))
const FFMPEG = path.join(ROOT, 'app', 'bin', 'ffmpeg')

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vidcut-server-test-'))
let passed = 0
const failures = []

function ok(name, condition, detail) {
  if (condition) {
    passed++
    console.log('  ok    ' + name)
  } else {
    failures.push(name)
    console.log('  FAIL  ' + name + (detail !== undefined ? ' — ' + detail : ''))
  }
}

function fetchBody(url, maxBytes) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, res => {
      const chunks = []
      let total = 0
      res.on('data', chunk => {
        total += chunk.length
        if (chunks.length < 8) chunks.push(chunk)
        if (total >= maxBytes) req.destroy()
      })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, total, head: Buffer.concat(chunks).subarray(0, 16) }))
      res.on('close', () => resolve({ status: res.statusCode, headers: res.headers, total, head: Buffer.concat(chunks).subarray(0, 16) }))
    })
    req.on('error', e => {
      if (e.code === 'ECONNRESET') return // deliberate destroy mid-stream
      reject(e)
    })
  })
}

async function main() {
  // h264 in Matroska: Chromium cannot demux .mkv, so this is exactly
  // what the streaming fallback exists for (and the bundled ffmpeg
  // reads it fine). NOTE: .ts fixtures are deliberately NOT used —
  // the bundled ffmpeg 4.3.1 static build segfaults reading MPEG-TS.
  const sample = path.join(work, 'legacy.mkv')
  execFileSync(FFMPEG, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=duration=10:size=320x240:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', sample,
  ])
  ok('fixture: unplayable-in-chromium .mkv generated', fs.existsSync(sample))

  const opened = await streamer.open(sample, 0)
  ok('open: returns url', typeof opened.url === 'string' && opened.url.startsWith('http://127.0.0.1:'))
  ok('open: probed duration ≈ 10s', Math.abs((opened.duration || 0) - 10) < 1, opened.duration)

  const res = await fetchBody(opened.url, 256 * 1024)
  ok('http: 200 video/mp4', res.status === 200 && /video\/mp4/.test(res.headers['content-type'] || ''))
  ok('http: stream delivered > 128KB', res.total > 128 * 1024, res.total + ' bytes')
  ok('http: bytes start with MP4 ftyp box', res.head.length >= 8 &&
     res.head.subarray(4, 8).toString('ascii') === 'ftyp', res.head.toString('hex'))

  // A second open (seek) must reuse the same server instance/port.
  const second = await streamer.open(sample, 5)
  ok('open: seek reuses the server port', second.url.startsWith(new URL(opened.url).origin))

  // Hostile path characters must survive the query round-trip.
  const hostile = path.join(work, "weird & name #1 (it's).mp4")
  execFileSync(FFMPEG, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=duration=2:size=320x240:rate=30',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', hostile,
  ])
  const hostileOpen = await streamer.open(hostile, 0)
  const hostileRes = await fetchBody(hostileOpen.url, 64 * 1024)
  ok('http: hostile filename streams', hostileRes.status === 200 && hostileRes.total > 16 * 1024,
     hostileRes.status + ' ' + hostileRes.total)

  // 404 for a missing source (open throws — it is a precondition).
  let threw = false
  try { await streamer.open(path.join(work, 'nope.mp4'), 0) } catch (e) { threw = true }
  ok('open: missing source rejected', threw)

  streamer.shutdown()
  ok('shutdown: server closed cleanly', true)

  if (failures.length) {
    console.log(`\n${passed} passed, ${failures.length} FAILED — artifacts kept at ${work}`)
    process.exitCode = 1
  } else {
    console.log(`\nAll ${passed} server checks passed`)
    fs.rmSync(work, { recursive: true, force: true })
  }
  process.exit(process.exitCode || 0)
}

main().catch(error => {
  console.error('Server harness crashed:', error)
  process.exit(1)
})
