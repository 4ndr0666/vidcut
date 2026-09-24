/* vidcut — ffmpeg supervision in the main process.
 *
 * One job slot, several job kinds: cut (lossless + re-encode fallback),
 * convert (compatibility re-encode to MP4), extract (audio to MP3),
 * capture (single frame to JPG) and merge (ffx-style: probe →
 * lossless concat fast path with validation → normalize path with
 * per-file uniform intermediates). merge resolves to a result object
 * { mode, merged, reencoded, skipped } — the renderer turns it into
 * the status line. Every video-writing kind honors job.muted: while the renderer's MUTE
 * toggle is on, the audio stream is simply not mapped (-an) — for the
 * copy path that still costs nothing, and the re-encode path skips the
 * audio encode entirely. The renderer never spawns processes — it sends
 * IPC jobs here, so the OS-level lifecycle (cancel, quit) is fully owned
 * by main.
 *
 * Every writer is atomic and validated (the ffx quality gates): the
 * work lands in <stem>.vidcut.<ext> beside the real destination and is
 * renamed in only after it passes validation — a cancelled, failed or
 * corrupt write never squats on the user's chosen name (which the
 * idempotent naming would treat as occupied). Merge preprocessing
 * intermediates live in a configurable work dir (job.workDir, default
 * the folder beside the output) with a disk-space preflight.
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
 * are mapped — both optional, so audio-only sources cut fine too.
 * job.muted drops the audio map entirely (-an keeps it explicit even
 * on the copy path).
 *
 * -fflags +genpts (an input flag, hence before -i) regenerates any
 * MISSING presentation timestamps while copying — the same insurance
 * ffx's fix_dts applies to its remuxes. On well-formed sources it is
 * byte-identical to its absence; on sources with missing PTS it turns
 * a doomed stream copy (which would fall to a lossy re-encode) into a
 * clean lossless one. */
function buildArgs(job, reencode) {
  const args = [
    '-y', '-hide_banner', '-nostdin',
    '-fflags', '+genpts',
    '-ss', job.start.toFixed(3),
    '-i', job.input,
    '-t', job.duration.toFixed(3),
  ]
  if (job.muted) args.push('-map', '0:v:0?', '-an')
  else args.push('-map', '0:v:0?', '-map', '0:a:0?')
  if (reencode) {
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p')
    if (!job.muted) args.push('-c:a', 'aac', '-b:a', '192k')
  } else {
    args.push('-c', 'copy', '-avoid_negative_ts', 'make_zero')
  }
  args.push('-map_metadata', '0', job.output)
  return args
}

/* Convert deliberately re-encodes: same mapping policy and encoder
 * settings as the cut fallback, so anything that can be cut can also
 * be converted (including audio-only sources — which the renderer
 * exempts from the mute flag, since a silent audio file is pointless). */
function convertArgs(job) {
  const args = [
    '-y', '-hide_banner', '-nostdin',
    '-ss', job.start.toFixed(3),
    '-i', job.input,
    '-t', job.duration.toFixed(3),
  ]
  if (job.muted) args.push('-map', '0:v:0?', '-an')
  else args.push('-map', '0:v:0?', '-map', '0:a:0?')
  args.push(
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
  )
  if (!job.muted) args.push('-c:a', 'aac', '-b:a', '192k')
  args.push('-map_metadata', '0', job.output)
  return args
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
 * NOTE: -nostdin must NOT appear here; the list arrives on stdin.
 * -avoid_negative_ts make_zero belongs here just as on the cut: a
 * concat join can inherit negative start offsets from edit lists,
 * which players show as frozen lead-in frames. job.muted drops the
 * audio streams from the concatenated output. */
function mergeArgs(job) {
  const args = [
    '-y', '-hide_banner',
    '-f', 'concat', '-safe', '0', '-protocol_whitelist', 'file,pipe',
    '-i', '-',
    '-map', '0', '-c', 'copy',
    '-avoid_negative_ts', 'make_zero',
  ]
  if (job.muted) args.push('-an')
  /* The final write lands in <output>.vidcut.part — the family must
   * come from the REAL output path, so merge() passes mp4Out along. */
  const mp4 = job.mp4Out !== undefined ? !!job.mp4Out : isMp4Family(job.output)
  if (mp4) args.push('-movflags', '+faststart')
  args.push('-map_metadata', '0', job.output)
  return args
}

/* Escape single quotes for the concat demuxer's file-list syntax.
 * (Written via the RegExp constructor rather than a /'/g literal: a
 * quote inside a regex literal trips naive brace/string scanners —
 * including the GUP atomizer — into swallowing the functions that
 * follow; the constructor form is scanner-unambiguous.) */
function concatList(paths) {
  const singleQuote = new RegExp("'", 'g')
  return paths.map(p => "file '" + p.replace(singleQuote, "'\\''") + "'").join('\n') + '\n'
}

/* ---- merge engine (modeled on the reference ffx workflow) ----
 *
 * ffx — the author's standalone merge CLI — proved the shape this
 * follows: PROBE every input, then decide between two paths before
 * anything is written:
 *
 *   fast path    every input already agrees on codec, resolution,
 *                fps, pixel format, SAR and audio shape → one concat
 *                demuxer pass with -c copy. Instant, lossless.
 *   normalize    heterogeneous inputs → per-file intermediates made
 *                uniform (max-canvas scale+pad, one fps, yuv420p,
 *                aac/48k/stereo — silent sources get anullsrc audio
 *                injected so the join is well-formed), then a single
 *                -c copy concat over the intermediates.
 *
 * Ported deliberately:
 *   - anullsrc injection for audio-less inputs (ffx v8.1.1's fix)
 *   - -fflags +genpts on re-encoded inputs (timestamp repair)
 *   - one bad file is skipped, never fatal to the batch
 *   - MP4 moov-atom validation of every artifact (ffx's MOV-atom check)
 *   - atomic publish: write <output>.vidcut.part, rename on success
 *
 * Deviating on purpose (tighter than ffx):
 *   - the uniformity check also compares AUDIO codecs, SAR and sample
 *     rate/channel count — ffx's fast path never compares audio
 *     codecs, so "same video, one aac + one mp3" sails into a -c copy
 *     concat that produces a broken audio track
 *   - a conformant VIDEO stream is stream-copied even when its AUDIO
 *     needs normalizing (ffx re-encodes the whole file)
 *   - the fast path output is validated (moov + duration) and falls
 *     back to normalize instead of trusting a clean exit code
 *
 * Left out on purpose: ffx's checkpoint/resume cache (a CLI batch
 * concern — GUI merges are interactive and small), image inputs,
 * deinterlace detection. */

const MERGE_AUDIO = { codec: 'aac', hz: 48000, ch: 2 } // the normalize target

function gcd(a, b) {
  while (b) { const t = a % b; a = b; b = t }
  return a
}

/* Sample aspect reduced to lowest terms — 8:9 and 16:18 are the same
 * shape and must not split a uniform set. Unknown/absent SAR reads
 * as square (1:1), which is what ffmpeg prints for square pixels. */
function sarKey(num, den) {
  const n = Number(num)
  const d = Number(den)
  if (!Number.isFinite(n) || !Number.isFinite(d) || n <= 0 || d <= 0) return '1:1'
  const g = gcd(n, d) || 1
  return `${n / g}:${d / g}`
}

function isMp4Family(file) {
  return /\.(mp4|m4v|mov|m4a|3gp|3g2)$/i.test(String(file))
}

/* The working name every writer lands in before it is validated and
 * renamed into place: <stem>.vidcut.<ext>. The real extension is
 * preserved so ffmpeg infers the right container for the working
 * file — a generic .part suffix would break that inference (learned
 * live in the v2.6.0 merge engine). An extensionless output gets
 * .mp4 appended, matching the merge engine's rule. */
function partPath(output) {
  const ext = path.extname(output)
  return ext ? `${output.slice(0, -ext.length)}.vidcut${ext}` : `${output}.vidcut.mp4`
}

/* JPEG structural check: a complete file starts with SOI (FF D8) and
 * ends with EOI (FF D9). A capture killed mid-write is missing its
 * EOI; a stub is missing both. The size floor rules out a marker-only
 * degenerate. */
function checkJpeg(file) {
  let fd
  try {
    const st = fs.statSync(file)
    if (!st.isFile() || st.size < 256) return false
    fd = fs.openSync(file, 'r')
    const head = Buffer.alloc(2)
    const tail = Buffer.alloc(2)
    if (fs.readSync(fd, head, 0, 2, 0) < 2) return false
    if (fs.readSync(fd, tail, 0, 2, st.size - 2) < 2) return false
    return head[0] === 0xff && head[1] === 0xd8 && tail[0] === 0xff && tail[1] === 0xd9
  } catch (e) {
    return false
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd) } catch (e) { /* gone */ } }
  }
}

function isJpegPath(file) {
  return /\.jpe?g$/i.test(String(file))
}

/* Post-run artifact validation shared by cut / convert / extract:
 * structure (moov walk for the MP4 family — an MP4 written without
 * +faststart carries its moov LAST, so a truncated write has none)
 * plus a duration probe against the requested length. The floor is
 * one-sided for stream copies ON PURPOSE: a copy cut legitimately
 * begins at the keyframe BEFORE the requested start, so its output
 * can run a whole GOP longer than requested; the frame-exact
 * re-encode paths get a ceiling too. Uses the UNcached probe runner
 * — the part is renamed the instant it validates, and caching by
 * path would poison the next job into the same destination. */
async function validSegmentOutput(file, requested, mp4Family, exact) {
  try {
    const st = fs.statSync(file)
    if (!st.isFile() || st.size < 1024) return false
  } catch (e) { return false }
  if (isJpegPath(file)) return checkJpeg(file)
  if (mp4Family && !checkMoov(file, true)) return false
  if (Number.isFinite(requested) && requested > 0) {
    const info = await probeRun(file)
    if (!info || !Number.isFinite(info.duration) || info.duration <= 0) return false
    if (info.duration < Math.max(0.1, requested * 0.5)) return false
    if (exact && info.duration > requested * 1.5 + 2) return false
  }
  return true
}

/* Human-readable byte count for the disk preflight messages. */
function humanBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '?'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = n
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

/* Disk preflight for the merge normalize path: the intermediates
 * total about the sum of the input sizes (each normalized part is on
 * the scale of its source at CRF 18), so a work directory with less
 * free space than that is a merge that would die an hour in. One
 * check, before anything is written. statfs is feature-detected;
 * unknowable sizes or missing filesystem data skip the check (the
 * run itself surfaces ENOSPC honestly) rather than guessing. */
function ensureWorkspace(dir, files) {
  if (typeof fs.statfsSync !== 'function') return null
  let need = 0
  for (const file of files) {
    try { need += fs.statSync(file).size } catch (e) { return null }
  }
  if (need <= 0) return null
  let free
  try {
    const st = fs.statfsSync(dir)
    free = Number(st.bsize) * Number(st.bavail)
  } catch (e) { return null }
  if (!Number.isFinite(free) || free <= 0) return null
  if (free < need) {
    throw new Error(
      `Work dir has only ${humanBytes(free)} free — this merge needs about ${humanBytes(need)} for preprocessing. `
      + 'Pick a different work dir (Merge sheet) or free up space.')
  }
  return { free, need }
}

/* MP4/QuickTime top-level atom walk: the container is a chain of
 * length-prefixed boxes, so a file is structurally sound iff the walk
 * lands exactly on EOF and passes a moov box of non-trivial size
 * along the way. Truncation (a killed concat) breaks the chain;
 * a moov-less or stub-moov file fails the second test. Non-MP4
 * containers are structurally validated by the duration probe. */
function checkMoov(file, assumeMp4) {
  if (assumeMp4 === undefined) assumeMp4 = isMp4Family(file)
  if (!assumeMp4) return true
  let fd
  try {
    const st = fs.statSync(file)
    if (!st.isFile() || st.size < 16) return false
    fd = fs.openSync(file, 'r')
    const head = Buffer.alloc(16)
    let pos = 0
    let sawMoov = false
    while (pos + 8 <= st.size) {
      const read = fs.readSync(fd, head, 0, 16, pos)
      if (read < 8) return false
      const size = head.readUInt32BE(0)
      const type = head.toString('latin1', 4, 8)
      let boxSize = size
      if (size === 1) { // 64-bit largesize follows the type
        const big = head.readBigUInt64BE(8)
        if (big <= 0n) return false
        boxSize = Number(big) > Number.MAX_SAFE_INTEGER ? st.size - pos : Number(big)
      } else if (size === 0) { // this box extends to EOF
        boxSize = st.size - pos
      }
      if (boxSize < 8 || pos + boxSize > st.size) return false // corrupt or truncated
      if (type === 'moov') {
        if (boxSize < 100) return false // a stub moov is not a moov
        sawMoov = true
      }
      pos += boxSize
    }
    return sawMoov && pos === st.size
  } catch (e) {
    return false
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd) } catch (e) { /* gone */ } }
  }
}

/* The pure planner: probes in, decision out. No I/O, so the offline
 * test suite can drive every branch with synthetic probe results.
 *
 *   uniform     true → the fast path is safe (all copy-concatable)
 *   canvasW/H   the max resolution across inputs, evened for yuv420p
 *   targetFps   the most common fps (ties keep the earliest)
 *   plan[]      per usable input: videoOk / audioOk / encode
 *   skipped[]   inputs that cannot participate, with reasons */
function planMerge(entries, muted) {
  const skipped = []
  const usable = []
  for (const entry of entries) {
    if (!entry || !entry.info) {
      skipped.push({ file: entry && entry.file, reason: 'unreadable (ffmpeg probe failed)' })
    } else if (!entry.info.video) {
      skipped.push({ file: entry.file, reason: 'no video stream' })
    } else {
      usable.push(entry)
    }
  }

  const roundFps = v => Math.round((Number(v) || 0) * 100)
  const first = usable.length ? usable[0].info.video : null
  const sameVideo = usable.every(e => {
    const v = e.info.video
    return v.codec === first.codec
      && v.width === first.width && v.height === first.height
      && roundFps(v.fps) === roundFps(first.fps)
      && (v.pix || '') === (first.pix || '')
      && (v.sar || '1:1') === (first.sar || '1:1')
  })
  /* Audio uniformity includes the codec/rate/channel signature — a
   * mixed set must normalize even when the video matches (see the
   * ffx deviation note above). While muted, audio is dropped at the
   * concat and never matters. */
  const audioShapes = new Set(usable.map(e => e.info.audio
    ? `${e.info.audio.codec}/${e.info.audio.hz}/${e.info.audio.ch}` : 'none'))
  const audioUniform = muted || audioShapes.size === 1

  let canvasW = 0
  let canvasH = 0
  const fpsCounts = new Map()
  for (const e of usable) {
    const v = e.info.video
    canvasW = Math.max(canvasW, v.width || 0)
    canvasH = Math.max(canvasH, v.height || 0)
    if (Number.isFinite(v.fps) && v.fps > 0) {
      const key = roundFps(v.fps)
      fpsCounts.set(key, (fpsCounts.get(key) || 0) + 1)
    }
  }
  let bestCount = 0
  let targetFps = 30
  for (const [key, count] of fpsCounts) {
    if (count > bestCount) { bestCount = count; targetFps = key / 100 }
  }
  canvasW += canvasW % 2
  canvasH += canvasH % 2

  const plan = usable.map(e => {
    const v = e.info.video
    const a = e.info.audio
    const videoOk = v.codec === 'h264' && (v.pix || '') === 'yuv420p'
      && v.width === canvasW && v.height === canvasH
      && roundFps(v.fps) === roundFps(targetFps)
      && (v.sar || '1:1') === '1:1'
    const audioOk = muted
      || (!!a && a.codec === MERGE_AUDIO.codec && a.hz === MERGE_AUDIO.hz && a.ch === MERGE_AUDIO.ch)
    return { file: e.file, videoOk, audioOk, encode: !(videoOk && audioOk) }
  })

  return {
    usable, skipped, plan,
    uniform: usable.length >= 2 && sameVideo && audioUniform,
    canvasW, canvasH, targetFps,
  }
}

/* Per-file normalization for the merge normalize path — the ffx
 * recipe: regenerate timestamps, scale+pad onto the shared canvas
 * (letterboxing smaller inputs, never stretching), pin one fps,
 * and make the audio uniform (aac/48k/stereo; anullsrc injection for
 * silent sources; -an when the whole job is muted). A conformant
 * video stream is still stream-copied — only what differs is
 * re-encoded, which is where this departs from ffx's whole-file
 * re-encode. */
function normalizeArgs(job) {
  const args = ['-y', '-hide_banner', '-nostdin', '-fflags', '+genpts', '-i', job.input]
  if (!job.hasAudio && !job.muted) {
    // anullsrc is a second INPUT — declared before the output options
    // (the ffx v8.1.1 ordering fix; after them ffmpeg misparses -vf as
    // an option of the lavfi input and aborts).
    args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000')
  }
  args.push('-map', '0:v:0')
  if (job.videoOk) {
    args.push('-c:v', 'copy')
  } else {
    args.push(
      '-vf', `scale=${job.canvasW}:${job.canvasH}:force_original_aspect_ratio=decrease:flags=lanczos`
        + `,pad=${job.canvasW}:${job.canvasH}:-1:-1:color=black,setsar=1`,
      '-r', String(job.fps),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
    )
  }
  if (job.muted) {
    args.push('-an')
  } else if (!job.hasAudio) {
    args.push('-map', '1:a:0', '-c:a', 'aac', '-b:a', '192k', '-shortest')
  } else if (job.audioOk) {
    args.push('-map', '0:a:0', '-c:a', 'copy')
  } else {
    args.push('-map', '0:a:0', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2')
  }
  args.push('-movflags', '+faststart', job.output)
  return args
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

/* Best-effort removal of a working file — dropping the part is
 * cleanup, never the failure itself, so its own errors are swallowed
 * (the file is usually already gone: renamed on success, or never
 * written when the spawn itself died). */
function dropFile(file) {
  try { fs.unlinkSync(file) } catch (e) { /* absent */ }
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
  const part = partPath(job.output)
  if (part === job.input) throw new Error('The output working name collides with the source file')

  cancelled = false
  const work = { kind: 'cut', duration: job.duration }
  const mp4Family = isMp4Family(job.output)
  try {
    if (!job.forceReencode) {
      try {
        await runOnce(buildArgs({ ...job, output: part }, false), work, onProgress)
        if (await validSegmentOutput(part, job.duration, mp4Family, false)) {
          publishPart(part, job.output)
          return 'copy'
        }
        dropFile(part) // exit 0 but a broken artifact — re-encode below
      } catch (error) {
        dropFile(part)
        if (error.fatal || cancelled) throw error
        // Stream copy failed (codec/container mismatch etc.) — retry
        // below as a compatibility re-encode.
      }
    }
    await runOnce(buildArgs({ ...job, output: part }, true), work, onProgress)
    if (!(await validSegmentOutput(part, job.duration, mp4Family, true))) {
      throw new Error('The cut output failed validation (structure or duration)')
    }
    publishPart(part, job.output)
    return 'reencode'
  } finally {
    dropFile(part)
  }
}

async function convert(job, onProgress) {
  validateSegment(job, 'convert')
  if (active) throw new Error('A job is already running')
  const part = partPath(job.output)
  if (part === job.input) throw new Error('The output working name collides with the source file')

  cancelled = false
  try {
    await runOnce(convertArgs({ ...job, output: part }), { kind: 'convert', duration: job.duration }, onProgress)
    if (!(await validSegmentOutput(part, job.duration, isMp4Family(job.output), true))) {
      throw new Error('The converted output failed validation (structure or duration)')
    }
    publishPart(part, job.output)
    return 'reencode'
  } finally {
    dropFile(part)
  }
}

async function extract(job, onProgress) {
  validateSegment(job, 'extract')
  if (active) throw new Error('A job is already running')
  const part = partPath(job.output)
  if (part === job.input) throw new Error('The output working name collides with the source file')

  cancelled = false
  try {
    await runOnce(extractArgs({ ...job, output: part }), { kind: 'extract', duration: job.duration }, onProgress)
    if (!(await validSegmentOutput(part, job.duration, false, true))) {
      throw new Error('The extracted audio failed validation (structure or duration)')
    }
    publishPart(part, job.output)
    return 'mp3'
  } finally {
    dropFile(part)
  }
}

async function capture(job) {
  if (!job || typeof job !== 'object') throw new Error('Invalid capture request')
  if (typeof job.input !== 'string' || !job.input) throw new Error('Missing input file')
  if (typeof job.output !== 'string' || !job.output) throw new Error('Missing output file')
  if (job.input === job.output) throw new Error('Output would overwrite the source')
  if (!Number.isFinite(job.at) || job.at < 0) throw new Error('Invalid capture time')
  if (!fs.existsSync(job.input)) throw new Error('Input file not found')
  if (active) throw new Error('A job is already running')

  const part = partPath(job.output)
  if (part === job.input) throw new Error('The output working name collides with the source file')

  cancelled = false
  try {
    await runOnce(captureArgs({ ...job, output: part }), { kind: 'capture' })
    if (!checkJpeg(part)) throw new Error('The captured frame failed validation')
    publishPart(part, job.output)
    return 'jpg'
  } finally {
    dropFile(part)
  }
}

/* Post-run artifact validation: structure (moov walk for MP4) plus a
 * duration probe against the sum of the inputs. A concat that exits 0
 * can still be a broken file (timestamp wrap, truncated tail), and a
 * bad fast-path result is the normalize path's cue, not the user's
 * problem. Uses the UNcached probe runner — the .part file is renamed
 * the instant it validates, so caching by path would poison the next
 * merge into the same destination. */
async function validMergeOutput(file, expectedDuration, mp4Family) {
  try {
    const st = fs.statSync(file)
    if (!st.isFile() || st.size < 1024) return false
  } catch (e) { return false }
  if (!checkMoov(file, mp4Family)) return false
  if (Number.isFinite(expectedDuration) && expectedDuration > 0) {
    const info = await probeRun(file)
    if (!info || !Number.isFinite(info.duration) || info.duration <= 0) return false
    const tolerance = Math.max(2, expectedDuration * 0.25)
    if (Math.abs(info.duration - expectedDuration) > tolerance) return false
  }
  return true
}

/* Rename the validated .part into place. Windows refuses rename over
 * an existing file, so a destination the user deliberately chose to
 * replace is unlinked first (the gap is local and momentary). */
function publishPart(part, output) {
  try {
    fs.renameSync(part, output)
  } catch (e) {
    try { fs.unlinkSync(output) } catch (e2) { /* absent */ }
    fs.renameSync(part, output)
  }
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

  // Probe phase — cached, parallel, read-only; the plan falls out of it.
  const entries = await Promise.all(job.inputs.map(async file => ({ file, info: await probe(file) })))
  const plan = planMerge(entries, !!job.muted)
  if (plan.usable.length < 2) {
    const why = plan.skipped.map(s => `${path.basename(s.file)} (${s.reason})`).join(', ')
    throw new Error(why
      ? `Fewer than two usable videos — skipped: ${why}`
      : 'Select at least two files to merge')
  }
  const totalDur = plan.usable.reduce((sum, e) => sum + (e.info.duration || 0), 0)
  const mp4Out = isMp4Family(job.output) // the part suffix hides the real family

  // Atomic publish: everything lands in <stem>.vidcut.<ext> — the
  // real extension is preserved so ffmpeg infers the right container
  // for the working file — and is renamed into place only after
  // validation. A failed or cancelled merge can never leave a
  // half-written file squatting on the name the user chose (which the
  // idempotent naming treats as occupied).
  const part = partPath(job.output)
  if (job.inputs.includes(part)) throw new Error('The output working name collides with a source file')

  // ── FAST PATH ─ every input already concat-copyable ──────────────
  if (plan.uniform) {
    try {
      await runOnce(
        mergeArgs({ ...job, output: part, mp4Out }),
        { kind: 'merge', stdinData: concatList(plan.usable.map(e => e.file)), duration: totalDur },
        onProgress,
      )
      if (await validMergeOutput(part, totalDur, mp4Out)) {
        publishPart(part, job.output)
        return { mode: 'copy', merged: plan.usable.length, reencoded: 0, skipped: plan.skipped }
      }
      dropFile(part) // structurally bad despite exit 0 — normalize below
    } catch (error) {
      dropFile(part)
      if (error.fatal || cancelled) throw error
      // Copy concat failed (codec/container mismatch etc.) — the
      // normalize path below is the recovery, same contract as cut.
    }
  }

  // ── NORMALIZE PATH ─ per-file intermediates, then one copy concat ─
  // Intermediates live in the configured work dir (job.workDir, set
  // from the persisted app setting by main) — defaulting to a hidden
  // folder NEXT TO the output. The final part file always stays
  // beside the OUTPUT whatever the work dir is: the atomic publish
  // depends on the same-filesystem rename, and the concat demuxer
  // reads intermediates from anywhere. Never /tmp implicitly — that
  // can be a tmpfs RAM disk far too small for video intermediates.
  // The disk preflight refuses a work dir that plainly cannot hold
  // the preprocessing (about the sum of the input sizes) BEFORE an
  // hour of encoding is spent on a doomed run. The folder itself is
  // removed in finally, success or not.
  const workBase = typeof job.workDir === 'string' && job.workDir.trim()
    ? job.workDir
    : path.dirname(job.output)
  ensureWorkspace(workBase, plan.usable.map(e => e.file))
  const tmpDir = path.join(workBase, `.vidcut-merge-${process.pid}-${Math.random().toString(36).slice(2, 8)}`)
  fs.rmSync(tmpDir, { recursive: true, force: true })
  fs.mkdirSync(tmpDir, { recursive: true })

  const failed = [...plan.skipped]
  const temps = []
  const reencodedIdx = []
  let doneDur = 0
  const span = totalDur > 0 ? totalDur * 2 : 0 // per-file half + concat half

  try {
    for (let i = 0; i < plan.plan.length; i++) {
      const step = plan.plan[i]
      const dur = plan.usable[i].info.duration || 0
      const temp = path.join(tmpDir, `part-${String(i).padStart(4, '0')}.mp4`)
      const base = doneDur
      const report = span > 0 && dur > 0 && typeof onProgress === 'function'
        ? local => onProgress((base + local * dur) / span)
        : null
      try {
        await runOnce(
          normalizeArgs({
            input: step.file,
            output: temp,
            videoOk: step.videoOk,
            audioOk: step.audioOk,
            hasAudio: !!plan.usable[i].info.audio,
            muted: !!job.muted,
            canvasW: plan.canvasW,
            canvasH: plan.canvasH,
            fps: plan.targetFps,
          }),
          { kind: 'merge', duration: dur },
          report,
        )
        if (!checkMoov(temp)) throw new Error('normalized part failed MP4 validation')
        temps.push(temp)
        if (step.encode) reencodedIdx.push(i)
      } catch (error) {
        // A kill or a dead binary is a user action, not a bad file.
        if (cancelled || (error && error.fatal)) throw error
        // One bad file never kills the batch (ffx contract): it is
        // skipped and reported at the end with the reason.
        failed.push({ file: step.file, reason: String((error && error.message) || 'normalize failed').split('\n')[0] })
      }
      doneDur += dur
    }

    if (temps.length < 2) {
      const why = failed.map(f => `${path.basename(f.file)} (${f.reason})`).join(', ')
      throw new Error(`Fewer than two parts survived normalization — ${why}`)
    }

    const finalReport = span > 0 && typeof onProgress === 'function'
      ? local => onProgress(0.5 + local * 0.5)
      : null
    await runOnce(
      mergeArgs({ ...job, output: part, mp4Out }),
      { kind: 'merge', stdinData: concatList(temps), duration: totalDur },
      finalReport,
    )
    if (!(await validMergeOutput(part, totalDur, mp4Out))) {
      throw new Error('The merged output failed validation (structure or duration)')
    }
    publishPart(part, job.output)
    return {
      mode: 'normalize',
      merged: temps.length,
      reencoded: reencodedIdx.length,
      skipped: failed,
    }
  } finally {
    dropFile(part)
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch (e) { /* best effort */ }
  }
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
  const info = { duration: null, bitrate: null, video: null, audio: null, chapters: [] }

  const durationMatch = /Duration: (\d+):(\d+):([\d.]+)/.exec(stderr)
  if (durationMatch) {
    info.duration = Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3])
    const bitrateMatch = /bitrate: (\d+) kb\/s/.exec(stderr)
    if (bitrateMatch) info.bitrate = Number(bitrateMatch[1])
  }

  /* Chapters (mkv/mp4 chapter atoms) — the number keys 2–9 address
   * these starts. A `title` line only binds to the most recent
   * Chapter line: input- and stream-level `title` tags are separated
   * from chapter metadata by an Input #/Stream #/Duration line,
   * which resets the binding. */
  let lastChapter = null
  for (const line of stderr.split('\n')) {
    const chapterMatch = /^\s*Chapter #\d+:\d+: start ([\d.]+), end ([\d.]+)/.exec(line)
    if (chapterMatch) {
      lastChapter = { start: Number(chapterMatch[1]), end: Number(chapterMatch[2]), title: null }
      info.chapters.push(lastChapter)
      continue
    }
    if (/(^|\s)Input #|^\s*Stream #|^\s*Duration:/.test(line)) {
      lastChapter = null
      continue
    }
    const titleMatch = /^\s*title\s*:\s*(.*?)\s*$/.exec(line)
    if (titleMatch && lastChapter && lastChapter.title === null) {
      lastChapter.title = titleMatch[1]
    }
  }

  for (const line of stderr.split('\n')) {
    if (line.includes('Video:') && !info.video) {
      const codec = /Video: ([\w-]+)/.exec(line)
      const size = /, (\d{2,5})x(\d{2,5})/.exec(line)
      const fps = /([\d.]+) fps/.exec(line)
      /* pix_fmt sits between the codec details and the resolution
       * (", yuv420p(tv, bt709), 1920x1080") — the optional paren
       * group absorbs the color-range decoration. */
      const pixMatch = /,\s*([\w]+)(?:\([^)]*\))?,\s*\d{2,5}x\d{2,5}/.exec(line)
      const sarMatch = /\[SAR (\d+):(\d+) DAR/.exec(line)
      info.video = {
        codec: codec ? codec[1] : null,
        width: size ? Number(size[1]) : null,
        height: size ? Number(size[2]) : null,
        fps: fps ? Number(fps[1]) : null,
        pix: pixMatch ? pixMatch[1] : null,
        sar: sarMatch ? sarKey(sarMatch[1], sarMatch[2]) : '1:1',
      }
    }
    if (line.includes('Audio:') && !info.audio) {
      const codec = /Audio: ([\w-]+)/.exec(line)
      const hz = /, (\d+) Hz/.exec(line)
      /* Channel count decides concat-copy safety: "stereo"/"mono"/
       * "5.1"/"2 channels" all reduce to a number. */
      const chMatch = /, (\d+) Hz,\s*(stereo|mono|5\.1|7\.1|(\d+) channels?)/.exec(line)
      let ch = null
      if (chMatch) {
        if (chMatch[2] === 'stereo') ch = 2
        else if (chMatch[2] === 'mono') ch = 1
        else if (chMatch[2] === '5.1') ch = 6
        else if (chMatch[2] === '7.1') ch = 8
        else ch = Number(chMatch[3])
      }
      info.audio = { codec: codec ? codec[1] : null, hz: hz ? Number(hz[1]) : null, ch }
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
  _internal: {
    buildArgs, resolveBinary, convertArgs, extractArgs, captureArgs,
    mergeArgs, concatList, parseStreams,
    planMerge, normalizeArgs, checkMoov, sarKey, isMp4Family,
    partPath, checkJpeg, validSegmentOutput, humanBytes, ensureWorkspace,
  },
}
