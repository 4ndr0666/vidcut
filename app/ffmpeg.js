/* vidcut — ffmpeg supervision in the main process.
 *
 * One job slot, several job kinds: cut (lossless + re-encode fallback),
 * convert (compatibility re-encode to MP4), extract (audio to MP3),
 * capture (single frame to JPG) and merge (concat demuxer over stdin).
 * The renderer never spawns processes — it sends IPC jobs here, so the
 * OS-level lifecycle (cancel, quit) is fully owned by main.
 *
 * Paradigm: main-process orchestrator; the renderer is a pure UI. */

const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

let active = null // { proc, kind } — a single supervised job at a time
let cancelled = false

/* Prefer the bundled binary (also resolves the packaged
 * app.asar.unpacked layout), fall back to the system PATH. */
function resolveBinary() {
  const name = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const bundled = path.join(__dirname, 'bin', name)
  const unpacked = bundled.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)
  if (fs.existsSync(unpacked)) return unpacked
  if (fs.existsSync(bundled)) return bundled
  return name
}

/* ---- argument builders ---- */

/* Input-seek (-ss before -i) resets timestamps, so -t measures the
 * requested clip length. Only the first video and first audio track
 * are mapped — both optional, so audio-only sources cut fine too. */
function buildArgs(job, reencode) {
  const args = [
    '-y', '-hide_banner', '-nostdin',
    '-ss', job.start.toFixed(3),
    '-i', job.input,
    '-t', job.duration.toFixed(3),
    '-map', '0:v:0?', '-map', '0:a:0?',
  ]
  if (reencode) {
    args.push(
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k',
    )
  } else {
    args.push('-c', 'copy', '-avoid_negative_ts', 'make_zero')
  }
  args.push('-map_metadata', '0', job.output)
  return args
}

/* Convert deliberately re-encodes: same mapping policy and encoder
 * settings as the cut fallback, so anything that can be cut can also
 * be converted (including audio-only sources). */
function convertArgs(job) {
  return [
    '-y', '-hide_banner', '-nostdin',
    '-ss', job.start.toFixed(3),
    '-i', job.input,
    '-t', job.duration.toFixed(3),
    '-map', '0:v:0?', '-map', '0:a:0?',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k',
    '-map_metadata', '0', job.output,
  ]
}

/* MP3 VBR best quality — transparent at any source bitrate, which is
 * why the original mediainfo bitrate lookup is not needed here. */
function extractArgs(job) {
  return [
    '-y', '-hide_banner', '-nostdin',
    '-ss', job.start.toFixed(3),
    '-i', job.input,
    '-t', job.duration.toFixed(3),
    '-map', '0:a:0?', '-vn',
    '-c:a', 'libmp3lame', '-q:a', '0',
    '-map_metadata', '0', job.output,
  ]
}

function captureArgs(job) {
  return [
    '-y', '-hide_banner', '-nostdin',
    '-ss', job.at.toFixed(3),
    '-i', job.input,
    '-map', '0:v:0', '-vframes', '1', '-f', 'mjpeg', '-q:v', '2',
    job.output,
  ]
}

/* Concat demuxer over stdin — no temp list file, no shell involved.
 * NOTE: -nostdin must NOT appear here; the list arrives on stdin. */
function mergeArgs(job) {
  return [
    '-y', '-hide_banner',
    '-f', 'concat', '-safe', '0', '-protocol_whitelist', 'file,pipe',
    '-i', '-',
    '-c', 'copy', '-map', '0', '-map_metadata', '0',
    job.output,
  ]
}

/* Escape single quotes for the concat demuxer's file-list syntax. */
function concatList(paths) {
  return paths.map(p => "file '" + p.replace(/'/g, "'\\''") + "'").join('\n') + '\n'
}

/* Spawn-level failures (ENOENT etc.) are fatal: no retry can fix a
 * missing binary, so they skip the re-encode fallback. */
function fatal(error) {
  error.fatal = true
  return error
}

/* ---- the supervised runner (shared by every job kind) ---- */

function runOnce(args, job, onProgress) {
  return new Promise((resolve, reject) => {
    let proc
    try {
      proc = spawn(resolveBinary(), args, {
        stdio: [job.stdinData ? 'pipe' : 'ignore', 'ignore', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      return reject(fatal(error))
    }
    active = { proc, kind: job.kind }

    if (job.stdinData) {
      // EPIPE on early exit surfaces through the close handler below;
      // an error listener is required so the write never throws.
      proc.stdin.on('error', () => {})
      proc.stdin.end(job.stdinData)
    }

    let tail = ''
    proc.stderr.on('data', chunk => {
      const text = chunk.toString()
      tail = (tail + text).slice(-4000) // memory-bounded error tail
      if (!onProgress) return
      // The stats line repeats "time=HH:MM:SS.ss" as the output grows;
      // the last match in the chunk is the freshest position.
      let match = null
      const pattern = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/g
      let hit
      while ((hit = pattern.exec(text))) match = hit
      if (match && Number.isFinite(job.duration) && job.duration > 0) {
        const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
        onProgress(Math.max(0, Math.min(1, seconds / job.duration)))
      }
    })

    proc.on('error', error => {
      active = null
      reject(fatal(error))
    })

    proc.on('close', code => {
      active = null
      if (code === 0) return resolve()
      if (cancelled) return reject(new Error('Cancelled'))
      const reason = tail.trim().split('\n').slice(-5).join('\n')
      reject(new Error(`ffmpeg exited with code ${code}${reason ? '\n' + reason : ''}`))
    })
  })
}

/* ---- input validation (shared, order-stable) ---- */

function validateSegment(job, label) {
  if (!job || typeof job !== 'object') throw new Error(`Invalid ${label} request`)
  if (typeof job.input !== 'string' || !job.input) throw new Error('Missing input file')
  if (typeof job.output !== 'string' || !job.output) throw new Error('Missing output file')
  if (job.input === job.output) throw new Error('Output would overwrite the source')
  if (!Number.isFinite(job.start) || job.start < 0) throw new Error('Invalid start time')
  if (!Number.isFinite(job.duration) || job.duration <= 0) throw new Error('Invalid duration')
  if (!fs.existsSync(job.input)) throw new Error('Input file not found')
}

/* ---- job kinds ---- */

async function cut(job, onProgress) {
  validateSegment(job, 'cut')
  if (active) throw new Error('A job is already running')

  cancelled = false
  const work = { kind: 'cut', duration: job.duration }
  if (!job.forceReencode) {
    try {
      await runOnce(buildArgs(job, false), work, onProgress)
      return 'copy'
    } catch (error) {
      if (error.fatal || cancelled) throw error
      // Stream copy failed (codec/container mismatch etc.) — retry
      // below as a compatibility re-encode.
    }
  }
  await runOnce(buildArgs(job, true), work, onProgress)
  return 'reencode'
}

async function convert(job, onProgress) {
  validateSegment(job, 'convert')
  if (active) throw new Error('A job is already running')

  cancelled = false
  await runOnce(convertArgs(job), { kind: 'convert', duration: job.duration }, onProgress)
  return 'reencode'
}

async function extract(job, onProgress) {
  validateSegment(job, 'extract')
  if (active) throw new Error('A job is already running')

  cancelled = false
  await runOnce(extractArgs(job), { kind: 'extract', duration: job.duration }, onProgress)
  return 'mp3'
}

async function capture(job) {
  if (!job || typeof job !== 'object') throw new Error('Invalid capture request')
  if (typeof job.input !== 'string' || !job.input) throw new Error('Missing input file')
  if (typeof job.output !== 'string' || !job.output) throw new Error('Missing output file')
  if (job.input === job.output) throw new Error('Output would overwrite the source')
  if (!Number.isFinite(job.at) || job.at < 0) throw new Error('Invalid capture time')
  if (!fs.existsSync(job.input)) throw new Error('Input file not found')
  if (active) throw new Error('A job is already running')

  cancelled = false
  await runOnce(captureArgs(job), { kind: 'capture' })
  return 'jpg'
}

async function merge(job, onProgress) {
  if (!job || typeof job !== 'object') throw new Error('Invalid merge request')
  if (!Array.isArray(job.inputs) || job.inputs.length < 2) {
    throw new Error('Select at least two files to merge')
  }
  for (const input of job.inputs) {
    if (typeof input !== 'string' || !input) throw new Error('Invalid merge request')
    if (!fs.existsSync(input)) throw new Error(`Input file not found: ${path.basename(input)}`)
  }
  if (typeof job.output !== 'string' || !job.output) throw new Error('Missing output file')
  if (job.inputs.includes(job.output)) throw new Error('Output would overwrite a source')
  if (active) throw new Error('A job is already running')

  cancelled = false
  await runOnce(
    mergeArgs(job),
    { kind: 'merge', stdinData: concatList(job.inputs) },
    onProgress,
  )
  return 'copy'
}

/* ---- metadata probe (display + stream-duration fallback) ----
 *
 * `ffmpeg -i <file>` with no output exits 1 with "At least one output
 * file must be specified" — that IS the success path here; the stream
 * lines we need are on stderr. Never rejects: metadata is optional, so
 * a failed probe resolves to null. */

const probeCache = new Map()
const PROBE_CACHE_MAX = 16

function parseStreams(stderr) {
  const info = { duration: null, bitrate: null, video: null, audio: null }

  const durationMatch = /Duration: (\d+):(\d+):([\d.]+)/.exec(stderr)
  if (durationMatch) {
    info.duration = Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3])
    const bitrateMatch = /bitrate: (\d+) kb\/s/.exec(stderr)
    if (bitrateMatch) info.bitrate = Number(bitrateMatch[1])
  }

  for (const line of stderr.split('\n')) {
    if (line.includes('Video:') && !info.video) {
      const codec = /Video: ([\w-]+)/.exec(line)
      const size = /, (\d{2,5})x(\d{2,5})/.exec(line)
      const fps = /([\d.]+) fps/.exec(line)
      info.video = {
        codec: codec ? codec[1] : null,
        width: size ? Number(size[1]) : null,
        height: size ? Number(size[2]) : null,
        fps: fps ? Number(fps[1]) : null,
      }
    }
    if (line.includes('Audio:') && !info.audio) {
      const codec = /Audio: ([\w-]+)/.exec(line)
      const hz = /, (\d+) Hz/.exec(line)
      info.audio = { codec: codec ? codec[1] : null, hz: hz ? Number(hz[1]) : null }
    }
  }
  return info
}

function probeRun(source) {
  return new Promise(resolve => {
    let proc
    try {
      proc = spawn(resolveBinary(), ['-hide_banner', '-i', source], {
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      })
    } catch (e) {
      return resolve(null)
    }

    let stderr = ''
    proc.stderr.on('data', chunk => {
      stderr = (stderr + chunk.toString()).slice(-65536) // bounded
    })

    // Hard timeout: metadata is display-only and never worth a hang.
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL') } catch (e) { /* already gone */ }
    }, 10000)

    proc.on('error', () => {
      clearTimeout(timer)
      resolve(null)
    })
    proc.on('close', () => {
      clearTimeout(timer)
      const info = parseStreams(stderr)
      resolve(info.duration != null || info.video || info.audio ? info : null)
    })
  })
}

/* Cached per source — the streaming server re-probes on every seek. */
function probe(source) {
  if (typeof source !== 'string' || !source) return Promise.resolve(null)
  if (probeCache.has(source)) return probeCache.get(source)
  const pending = probeRun(source)
  probeCache.set(source, pending)
  if (probeCache.size > PROBE_CACHE_MAX) probeCache.delete(probeCache.keys().next().value)
  return pending
}

/* Streaming transcode for the local media server — the playback
 * fallback for codecs the <video> element cannot decode. spawn (not
 * execFile) so stdout is never buffered into a maxBuffer limit:
 * ultrafast re-encodes are routinely larger than the source file. */
function fastCodec(videoPath, startTime) {
  const proc = spawn(resolveBinary(), [
    '-ss', String(startTime), '-i', videoPath,
    '-preset:v', 'ultrafast', '-f', 'mp4', '-frag_duration', '1000000',
    'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  // Drain stderr or the pipe fills up and ffmpeg stalls mid-stream.
  proc.stderr.on('data', () => {})
  return proc
}

/* ---- lifecycle ---- */

function cancel() {
  if (!active) return false
  cancelled = true
  active.proc.kill('SIGKILL')
  return true
}

function killAll() {
  cancelled = true
  if (active) active.proc.kill('SIGKILL')
}

module.exports = {
  cut, convert, extract, capture, merge, probe, fastCodec,
  cancel, killAll,
  _internal: { buildArgs, resolveBinary, convertArgs, extractArgs, captureArgs, mergeArgs, concatList, parseStreams },
}
