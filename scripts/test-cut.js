/* Offline pipeline test for app/ffmpeg.js — no Electron needed.
 * Generates real media with the bundled ffmpeg and verifies:
 *   1. lossless copy cuts (mode, existence, duration, progress events)
 *   2. forced re-encode path
 *   3. hostile filenames (& # ' ( ) spaces)
 *   4. audio-only and video-only sources (optional stream maps)
 *   5. job validation rejections
 *   6. live cancel
 *   7. argument sanity via _internal.buildArgs
 *   8. convert (MP4 re-encode), extract (MP3), capture (JPG)
 *   9. merge (concat demuxer, incl. apostrophe filenames — the
 *      original concat-quoting bug)
 *  10. metadata probe (duration/codec/size parsing) */

const { execFileSync, spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const cutter = require(path.join(ROOT, 'app', 'ffmpeg.js'))
const FFMPEG = path.join(ROOT, 'app', 'bin', 'ffmpeg')

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vidcut-test-'))
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

function run(file, args) {
  execFileSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', ...args], {
    stdio: ['ignore', 'ignore', 'pipe'],
  })
}

function durationOf(file) {
  const result = spawnSync(FFMPEG, ['-hide_banner', '-i', file], { encoding: 'utf8' })
  const match = /Duration: (\d+):(\d+):([\d.]+)/.exec(result.stderr || '')
  if (!match) return NaN
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
}

const near = (value, target, tolerance) => Math.abs(value - target) <= tolerance

async function main() {
  console.log('vidcut offline cut tests — workspace ' + work)

  const sample = path.join(work, 'sample.mp4')
  // -g 30: a keyframe every second, so lossless cut points are
  // deterministic and the duration assertions are meaningful.
  run(sample, [
    '-f', 'lavfi', '-i', 'testsrc2=duration=12:size=320x240:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '30', '-c:a', 'aac', '-shortest', sample,
  ])
  ok('fixture: sample generated', fs.existsSync(sample))

  // 1. lossless copy cut
  {
    let events = 0
    const out = path.join(work, 'copy-cut.mp4')
    const mode = await cutter.cut({ input: sample, output: out, start: 2, duration: 3 }, () => { events++ })
    ok('copy: returns mode "copy"', mode === 'copy', 'mode=' + mode)
    ok('copy: output exists', fs.existsSync(out))
    ok('copy: duration ≈ 3s', near(durationOf(out), 3, 0.75), durationOf(out).toFixed(2) + 's')
    ok('copy: progress events fired', events > 0, events + ' events')
  }

  // 2. forced re-encode
  {
    const out = path.join(work, 'reenc-cut.mp4')
    const mode = await cutter.cut({ input: sample, output: out, start: 1, duration: 2, forceReencode: true })
    ok('reencode: returns mode "reencode"', mode === 'reencode', 'mode=' + mode)
    ok('reencode: duration ≈ 2s', near(durationOf(out), 2, 0.3), durationOf(out).toFixed(2) + 's')
  }

  // 3. hostile filenames
  {
    const hostile = path.join(work, "hostile & name #1 (it's).mp4")
    fs.copyFileSync(sample, hostile)
    const out = path.join(work, "hostile & out #2 (cut).mp4")
    const mode = await cutter.cut({ input: hostile, output: out, start: 1, duration: 2 })
    ok('hostile: cut succeeds losslessly', mode === 'copy' && fs.existsSync(out))
  }

  // 4a. audio-only source
  {
    const audio = path.join(work, 'tone.mp3')
    run(audio, ['-f', 'lavfi', '-i', 'sine=frequency=880:duration=6', '-c:a', 'libmp3lame', audio])
    const out = path.join(work, 'tone-cut.mp3')
    const mode = await cutter.cut({ input: audio, output: out, start: 1, duration: 2 })
    ok('audio-only: cut succeeds', mode === 'copy' && fs.existsSync(out))
    ok('audio-only: duration ≈ 2s', near(durationOf(out), 2, 0.35), durationOf(out).toFixed(2) + 's')
  }

  // 4b. video-only source
  {
    const silent = path.join(work, 'silent.mp4')
    run(silent, [
      '-f', 'lavfi', '-i', 'testsrc2=duration=8:size=320x240:rate=30',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '30', silent,
    ])
    const out = path.join(work, 'silent-cut.mp4')
    const mode = await cutter.cut({ input: silent, output: out, start: 2, duration: 3 })
    ok('video-only: cut succeeds', mode === 'copy' && fs.existsSync(out))
  }

  // 5. job validation
  {
    const cases = [
      [{}, 'missing input rejected'],
      [{ input: sample, output: sample, start: 1, duration: 1 }, 'source overwrite rejected'],
      [{ input: sample, output: path.join(work, 'x.mp4'), start: -1, duration: 1 }, 'negative start rejected'],
      [{ input: sample, output: path.join(work, 'x.mp4'), start: 1, duration: 0 }, 'zero duration rejected'],
      [{ input: path.join(work, 'missing.mp4'), output: path.join(work, 'x.mp4'), start: 1, duration: 1 }, 'missing file rejected'],
    ]
    for (const [job, label] of cases) {
      let rejected = false
      try { await cutter.cut(job) } catch (e) { rejected = true }
      ok('validation: ' + label, rejected)
    }
  }

  // 6. live cancel (re-encode of a longer clip so there is time to kill)
  {
    const long = path.join(work, 'long.mp4')
    run(long, [
      '-f', 'lavfi', '-i', 'testsrc2=duration=90:size=640x480:rate=30',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '30', long,
    ])
    const out = path.join(work, 'cancelled.mp4')
    let error = null
    const job = cutter.cut(
      { input: long, output: out, start: 0, duration: 90, forceReencode: true },
      () => { cutter.cancel() }, // kill as soon as the first progress arrives
    )
    try { await job } catch (e) { error = e }
    ok('cancel: rejects with "Cancelled"', !!error && /cancel/i.test(error.message), String(error && error.message))
  }

  // 7. argument sanity
  {
    const args = cutter._internal.buildArgs({ input: 'a.mp4', output: 'b.mp4', start: 1.5, duration: 2.5 }, false)
    ok('args: input seek -ss 1.500 before -i', args.indexOf('-ss') === 3 && args[args.indexOf('-i') - 1] === '1.500', args.join(' '))
    ok('args: -t 2.500', args[args.indexOf('-t') + 1] === '2.500')
    ok('args: stream copy', args.includes('copy'))
    ok('args: output is the last token', args[args.length - 1] === 'b.mp4')
    ok('args: optional stream maps', args.includes('0:v:0?') && args.includes('0:a:0?'))
    const reArgs = cutter._internal.buildArgs({ input: 'a.mp4', output: 'b.mp4', start: 0, duration: 1 }, true)
    ok('args: reencode uses libx264', reArgs.includes('libx264'))
    ok('args: reencode does not stream-copy', !reArgs.includes('copy'))
  }

  // 8. convert (deliberate re-encode to MP4)
  {
    let events = 0
    const out = path.join(work, 'convert-seg.mp4')
    const mode = await cutter.convert({ input: sample, output: out, start: 2, duration: 3 }, () => { events++ })
    ok('convert: returns "reencode"', mode === 'reencode', 'mode=' + mode)
    ok('convert: output exists', fs.existsSync(out))
    ok('convert: duration ≈ 3s', near(durationOf(out), 3, 0.5), durationOf(out).toFixed(2) + 's')
    ok('convert: progress events fired', events > 0, events + ' events')
  }

  // 8b. convert of an audio-only source (optional video map)
  {
    const audio = path.join(work, 'tone2.mp3')
    run(audio, ['-f', 'lavfi', '-i', 'sine=frequency=660:duration=6', '-c:a', 'libmp3lame', audio])
    const out = path.join(work, 'tone2-seg.mp4')
    const mode = await cutter.convert({ input: audio, output: out, start: 1, duration: 2 })
    ok('convert: audio-only source succeeds', mode === 'reencode' && fs.existsSync(out))
  }

  // 8c. extract audio to MP3
  {
    let events = 0
    const out = path.join(work, 'extract-seg.mp3')
    const mode = await cutter.extract({ input: sample, output: out, start: 1, duration: 2.5 }, () => { events++ })
    ok('extract: returns "mp3"', mode === 'mp3', 'mode=' + mode)
    ok('extract: output exists', fs.existsSync(out))
    ok('extract: duration ≈ 2.5s', near(durationOf(out), 2.5, 0.5), durationOf(out).toFixed(2) + 's')
    ok('extract: progress events fired', events > 0, events + ' events')
  }

  // 8d. capture a frame to JPG
  {
    const out = path.join(work, 'frame.jpg')
    const mode = await cutter.capture({ input: sample, output: out, at: 5 })
    ok('capture: returns "jpg"', mode === 'jpg', 'mode=' + mode)
    ok('capture: output exists and non-empty', fs.existsSync(out) && fs.statSync(out).size > 1000)
    const head = fs.readFileSync(out).subarray(0, 2)
    ok('capture: JPEG SOI marker (FF D8)', head[0] === 0xff && head[1] === 0xd8,
       head[0].toString(16) + ' ' + head[1].toString(16))
  }

  // 9. merge via concat demuxer
  {
    const a = path.join(work, 'part-a.mp4')
    const b = path.join(work, 'part-b.mp4')
    run(a, ['-f', 'lavfi', '-i', 'testsrc2=duration=4:size=320x240:rate=30',
            '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
            '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '30', '-c:a', 'aac', '-shortest', a])
    run(b, ['-f', 'lavfi', '-i', 'testsrc2=duration=4:size=320x240:rate=30',
            '-f', 'lavfi', '-i', 'sine=frequency=550:duration=4',
            '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '30', '-c:a', 'aac', '-shortest', b])
    const out = path.join(work, 'merged.mp4')
    const mode = await cutter.merge({ inputs: [a, b], output: out })
    ok('merge: returns "copy"', mode === 'copy', 'mode=' + mode)
    ok('merge: duration ≈ 8s (4 + 4)', near(durationOf(out), 8, 1), durationOf(out).toFixed(2) + 's')
  }

  // 9b. merge with apostrophe filenames (the original concat bug)
  {
    const hostileA = path.join(work, "it's a 'test' & a.mp4")
    const hostileB = path.join(work, "it's a 'test' & b.mp4")
    fs.copyFileSync(path.join(work, 'part-a.mp4'), hostileA)
    fs.copyFileSync(path.join(work, 'part-b.mp4'), hostileB)
    const out = path.join(work, "it's merged (ok).mp4")
    const mode = await cutter.merge({ inputs: [hostileA, hostileB], output: out })
    ok('merge: apostrophe filenames succeed', mode === 'copy' && fs.existsSync(out))
  }

  // 9c. merge validation
  {
    const out = path.join(work, 'm-reject.mp4')
    const cases = [
      [{ inputs: [], output: out }, 'empty list rejected'],
      [{ inputs: [path.join(work, 'part-a.mp4')], output: out }, 'single file rejected'],
      [{ inputs: [path.join(work, 'part-a.mp4'), path.join(work, 'nope.mp4')], output: out }, 'missing member rejected'],
      [{ inputs: [path.join(work, 'part-a.mp4'), path.join(work, 'part-b.mp4')], output: path.join(work, 'part-a.mp4') }, 'member overwrite rejected'],
    ]
    for (const [job, label] of cases) {
      let rejected = false
      try { await cutter.merge(job) } catch (e) { rejected = true }
      ok('merge validation: ' + label, rejected)
    }
  }

  // 10. metadata probe
  {
    const info = await cutter.probe(sample)
    ok('probe: resolves stream info', !!info)
    ok('probe: duration ≈ 12s', info && near(info.duration, 12, 1), info && info.duration)
    ok('probe: video h264 320x240', info && info.video && info.video.codec === 'h264' &&
       info.video.width === 320 && info.video.height === 240,
       info && info.video && JSON.stringify(info.video))
    ok('probe: audio aac', info && info.audio && info.audio.codec === 'aac',
       info && info.audio && JSON.stringify(info.audio))
    ok('probe: frame rate ≈ 30', info && info.video && near(info.video.fps, 30, 0.5),
       info && info.video && info.video.fps)
    ok('probe: cache returns same object', (await cutter.probe(sample)) === info)
    ok('probe: missing file → null', (await cutter.probe(path.join(work, 'gone.mp4'))) === null)
  }

  // 10b. new-op validation rejections
  {
    const badConvert = { input: sample, output: path.join(work, 'x.mp4'), start: -1, duration: 1 }
    const badCapture = { input: sample, output: path.join(work, 'x.jpg'), at: -5 }
    let rejected = 0
    try { await cutter.convert(badConvert) } catch (e) { rejected++ }
    try { await cutter.capture(badCapture) } catch (e) { rejected++ }
    ok('validation: convert/capture rejections', rejected === 2)
  }

  if (failures.length) {
    console.log(`\n${passed} passed, ${failures.length} FAILED — artifacts kept at ${work}`)
    process.exitCode = 1
  } else {
    console.log(`\nAll ${passed} checks passed`)
    fs.rmSync(work, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error('Test harness crashed:', error)
  process.exitCode = 1
})
