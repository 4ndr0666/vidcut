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
 *  10. metadata probe (duration/codec/size parsing)
 *  11. merge engine: moov-atom validation, planner branches,
 *      normalize E2E (mixed resolutions, anullsrc injection),
 *      fault tolerance, atomicity, mid-merge cancel */

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

/* Stream presence via the same `ffmpeg -i` banner the probe parses. */
function hasStream(file, kind) {
  const result = spawnSync(FFMPEG, ['-hide_banner', '-i', file], { encoding: 'utf8' })
  return (result.stderr || '').includes(kind + ':')
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
    // The atomic writer: a cancelled cut leaves NOTHING on the real
    // name (v2.6.0 and earlier left the partial squatting there).
    ok('cancel: no partial file on the real name', !fs.existsSync(out))
    const cutResidue = fs.readdirSync(work).filter(n => n.includes('.vidcut'))
    ok('cancel: no .vidcut working-file residue', cutResidue.length === 0, cutResidue.join(','))
  }

  // 7. argument sanity
  {
    const args = cutter._internal.buildArgs({ input: 'a.mp4', output: 'b.mp4', start: 1.5, duration: 2.5 }, false)
    ok('args: input seek -ss 1.500 before -i', args.indexOf('-ss') < args.indexOf('-i') && args[args.indexOf('-i') - 1] === '1.500', args.join(' '))
    ok('args: genpts insurance before -i (input flag)', args.indexOf('-fflags') < args.indexOf('-i') && args[args.indexOf('-fflags') + 1] === '+genpts', args.join(' '))
    ok('args: -t 2.500', args[args.indexOf('-t') + 1] === '2.500')
    ok('args: stream copy', args.includes('copy'))
    ok('args: output is the last token', args[args.length - 1] === 'b.mp4')
    ok('args: optional stream maps', args.includes('0:v:0?') && args.includes('0:a:0?'))
    const reArgs = cutter._internal.buildArgs({ input: 'a.mp4', output: 'b.mp4', start: 0, duration: 1 }, true)
    ok('args: reencode uses libx264', reArgs.includes('libx264'))
    ok('args: reencode does not stream-copy', !reArgs.includes('copy'))
    ok('args: reencode keeps the genpts input flag', reArgs.indexOf('-fflags') < reArgs.indexOf('-i') && reArgs[reArgs.indexOf('-fflags') + 1] === '+genpts', reArgs.join(' '))
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
    const result = await cutter.merge({ inputs: [a, b], output: out })
    ok('merge: returns the copy fast path',
       result.mode === 'copy' && result.merged === 2 && result.reencoded === 0,
       JSON.stringify(result))
    ok('merge: duration ≈ 8s (4 + 4)', near(durationOf(out), 8, 1), durationOf(out).toFixed(2) + 's')
  }

  // 9b. merge with apostrophe filenames (the original concat bug)
  {
    const hostileA = path.join(work, "it's a 'test' & a.mp4")
    const hostileB = path.join(work, "it's a 'test' & b.mp4")
    fs.copyFileSync(path.join(work, 'part-a.mp4'), hostileA)
    fs.copyFileSync(path.join(work, 'part-b.mp4'), hostileB)
    const out = path.join(work, "it's merged (ok).mp4")
    const result = await cutter.merge({ inputs: [hostileA, hostileB], output: out })
    ok('merge: apostrophe filenames succeed', result.mode === 'copy' && fs.existsSync(out))
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

  // 9d. moov-atom validator — the ffx structural check, in Node
  {
    const good = path.join(work, 'part-a.mp4')
    ok('moov: valid mp4 passes', cutter._internal.checkMoov(good) === true)

    const truncated = path.join(work, 'truncated.mp4')
    const whole = fs.readFileSync(good)
    fs.writeFileSync(truncated, whole.subarray(0, Math.floor(whole.length * 0.6)))
    ok('moov: truncated mp4 fails (tail moov lost)', cutter._internal.checkMoov(truncated) === false)

    // ftyp (20 B) + mdat (108 B): a clean atom walk that never meets moov
    const fake = path.join(work, 'fake.mp4')
    const fakeBuf = Buffer.alloc(128)
    fakeBuf.writeUInt32BE(20, 0); fakeBuf.write('ftyp', 4, 'latin1')
    fakeBuf.writeUInt32BE(108, 20); fakeBuf.write('mdat', 24, 'latin1')
    fs.writeFileSync(fake, fakeBuf)
    ok('moov: moov-less atom chain fails', cutter._internal.checkMoov(fake) === false)

    // a moov box far too small to be one
    const stub = path.join(work, 'stub.mp4')
    const stubBuf = Buffer.alloc(80)
    stubBuf.writeUInt32BE(20, 0); stubBuf.write('ftyp', 4, 'latin1')
    stubBuf.writeUInt32BE(56, 20); stubBuf.write('moov', 24, 'latin1')
    fs.writeFileSync(stub, stubBuf)
    ok('moov: stub-sized moov fails', cutter._internal.checkMoov(stub) === false)

    ok('moov: non-mp4 container skips the walk',
       cutter._internal.checkMoov(path.join(work, 'tone.mp3')) === true)

    const empty = path.join(work, 'empty.mp4')
    fs.writeFileSync(empty, '')
    ok('moov: empty file fails', cutter._internal.checkMoov(empty) === false)
  }

  // 9e. the merge planner — every branch, synthetic probes (pure)
  {
    const P = cutter._internal.planMerge
    const v = (w, h, fps, opts) => ({
      file: 'f',
      info: {
        duration: 4,
        video: { codec: 'h264', width: w, height: h, fps, pix: 'yuv420p', sar: '1:1' },
        // 'audio' in opts (even null) is authoritative — a silent file
        audio: opts && Object.prototype.hasOwnProperty.call(opts, 'audio')
          ? opts.audio
          : { codec: 'aac', hz: 48000, ch: 2 },
      },
    })
    ok('planner: twin files take the fast path', P([v(320, 240, 30), v(320, 240, 30)], false).uniform === true)
    ok('planner: mixed resolutions normalize', P([v(320, 240, 30), v(640, 480, 30)], false).uniform === false)
    ok('planner: canvas is the max resolution',
       P([v(320, 240, 30), v(640, 480, 30)], false).canvasW === 640)
    ok('planner: odd canvas evens up',
       P([v(321, 239, 30), v(321, 239, 30)], false).canvasW === 322)
    ok('planner: one silent file forces normalize',
       P([v(320, 240, 30, { audio: null }), v(320, 240, 30)], false).uniform === false)
    ok('planner: mixed audio codecs force normalize (the ffx gap)',
       P([v(320, 240, 30), v(320, 240, 30, { audio: { codec: 'mp3', hz: 44100, ch: 2 } })], false).uniform === false)
    ok('planner: muted ignores audio shape',
       P([v(320, 240, 30, { audio: null }), v(320, 240, 30, { audio: { codec: 'mp3', hz: 44100, ch: 2 } })], true).uniform === true)
    ok('planner: fps mismatch normalizes', P([v(320, 240, 30), v(320, 240, 24)], false).uniform === false)
    ok('planner: modal fps wins (2×30 vs 1×24)',
       P([v(320, 240, 30), v(320, 240, 30), v(320, 240, 24)], false).targetFps === 30)
    ok('planner: video-only set takes the fast path',
       P([v(320, 240, 30, { audio: null }), v(320, 240, 30, { audio: null })], false).uniform === true)
    const odd = P([v(320, 240, 30, { audio: null }), v(320, 240, 30)], false)
    ok('planner: silent file flagged for audio injection',
       odd.plan[0].encode === true && odd.plan[1].encode === false,
       JSON.stringify(odd.plan))
    const corrupt = P([{ file: 'bad', info: null }, v(320, 240, 30), v(320, 240, 30)], false)
    ok('planner: unreadable file skipped with a reason',
       corrupt.skipped.length === 1 && /unreadable/.test(corrupt.skipped[0].reason)
       && corrupt.usable.length === 2)
    ok('planner: audio-only file skipped (no video stream)',
       P([{ file: 'x.mp3', info: { duration: 3, video: null, audio: { codec: 'mp3', hz: 44100, ch: 2 } } },
          v(320, 240, 30)], false).skipped[0].reason === 'no video stream')
    const sarMix = P([
      { file: 'a', info: { duration: 4, video: { codec: 'h264', width: 320, height: 240, fps: 30, pix: 'yuv420p', sar: '2:1' }, audio: null } },
      v(320, 240, 30, { audio: null }),
    ], false)
    ok('planner: SAR mismatch normalizes (the other ffx gap)', sarMix.uniform === false)
    const hybrid = P([v(320, 240, 30, { audio: { codec: 'mp3', hz: 44100, ch: 2 } })], false)
    ok('planner: hybrid plan — conformant video kept, audio fixed',
       hybrid.plan[0].videoOk === true && hybrid.plan[0].audioOk === false,
       JSON.stringify(hybrid.plan))
  }

  // 9f. normalize E2E: mixed resolutions → one shared canvas; the
  //     conformant file is remuxed, only the odd one is re-encoded
  {
    const small = path.join(work, 'mix-small.mp4')
    const big = path.join(work, 'mix-big.mp4')
    run(small, ['-f', 'lavfi', '-i', 'testsrc2=duration=4:size=320x240:rate=30',
                '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '30', '-pix_fmt', 'yuv420p', small])
    run(big, ['-f', 'lavfi', '-i', 'testsrc2=duration=4:size=640x480:rate=30',
              '-f', 'lavfi', '-i', 'sine=frequency=550:duration=4',
              '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '30', '-pix_fmt', 'yuv420p',
              '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-shortest', big])
    const psmall = await cutter.probe(small)
    const pbig = await cutter.probe(big)
    ok('probe: pix_fmt parsed (yuv420p)', pbig.video.pix === 'yuv420p', pbig.video.pix)
    ok('probe: SAR parsed square', pbig.video.sar === '1:1', pbig.video.sar)
    ok('probe: audio channels parsed (stereo → 2)', pbig.audio.ch === 2, JSON.stringify(pbig.audio))
    ok('probe: audio rate parsed (48000)', pbig.audio.hz === 48000, JSON.stringify(pbig.audio))
    ok('probe: silent fixture has no audio', psmall.audio === null || psmall.audio === undefined,
       JSON.stringify(psmall.audio))

    const out = path.join(work, 'mix-merged.mp4')
    let lastP = 0
    const result = await cutter.merge({ inputs: [small, big], output: out }, p => { lastP = p })
    ok('normalize: mode reported', result.mode === 'normalize', JSON.stringify(result))
    ok('normalize: one file re-encoded, one remuxed',
       result.reencoded === 1 && result.merged === 2, JSON.stringify(result))
    ok('normalize: nothing skipped', result.skipped.length === 0)
    const info = await cutter.probe(out)
    ok('normalize: output carries the max canvas',
       !!(info && info.video.width === 640 && info.video.height === 480),
       info && JSON.stringify(info.video))
    ok('normalize: duration ≈ 8s', near(durationOf(out), 8, 1.5), durationOf(out).toFixed(2) + 's')
    ok('normalize: progress crossed into the concat half', lastP >= 0.4, 'last=' + lastP)
  }

  // 9g. anullsrc injection: a silent input joined with an audible one
  //     still yields a well-formed audio track in the output
  {
    const silent = path.join(work, 'pure-silent.mp4')
    const audible = path.join(work, 'pure-audible.mp4')
    run(silent, ['-f', 'lavfi', '-i', 'testsrc2=duration=3:size=320x240:rate=30',
                 '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '30', '-pix_fmt', 'yuv420p', silent])
    run(audible, ['-f', 'lavfi', '-i', 'testsrc2=duration=3:size=320x240:rate=30',
                  '-f', 'lavfi', '-i', 'sine=frequency=660:duration=3',
                  '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '30', '-pix_fmt', 'yuv420p',
                  '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-shortest', audible])
    const out = path.join(work, 'injected.mp4')
    const result = await cutter.merge({ inputs: [silent, audible], output: out })
    ok('anullsrc: normalize path ran', result.mode === 'normalize', JSON.stringify(result))
    const info = await cutter.probe(out)
    ok('anullsrc: output carries an audio stream', !!(info && info.audio),
       info && JSON.stringify(info.audio))
    ok('anullsrc: duration ≈ 6s', near(durationOf(out), 6, 1.5), durationOf(out).toFixed(2) + 's')
  }

  // 9h. fault tolerance: one unreadable file is skipped, batch lives
  {
    const truncated = path.join(work, 'truncated.mp4')
    const out = path.join(work, 'fault-tolerant.mp4')
    const result = await cutter.merge({
      inputs: [truncated, path.join(work, 'part-a.mp4'), path.join(work, 'part-b.mp4')],
      output: out,
    })
    ok('tolerance: bad file skipped, good pair merged',
       result.mode === 'copy' && result.merged === 2 && result.skipped.length === 1,
       JSON.stringify(result))
    ok('tolerance: skip carries a reason',
       /unreadable|probe/.test(result.skipped[0].reason), result.skipped[0].reason)
    ok('tolerance: output is valid and full-length', near(durationOf(out), 8, 1))
  }

  // 9i. atomicity: a total failure leaves no output, no .part, no temp
  {
    const out = path.join(work, 'never.mp4')
    let threw = false
    try {
      await cutter.merge({ inputs: [path.join(work, 'truncated.mp4'), path.join(work, 'tone.mp3')], output: out })
    } catch (e) { threw = true }
    ok('atomic: total failure throws', threw)
    ok('atomic: no output file', !fs.existsSync(out))
    const residue = fs.readdirSync(work).filter(n => n.includes('.vidcut'))
    ok('atomic: no .part residue', residue.length === 0, residue.join(','))
    const leftovers = fs.readdirSync(work).filter(n => n.startsWith('.vidcut-merge-'))
    ok('atomic: no temp-dir residue', leftovers.length === 0, leftovers.join(','))
  }

  // 9j. cancel mid-merge: the kill rejects as Cancelled and the
  //     finally block removes every artifact — a cancelled writer of
  //     ANY kind (cut or merge) leaves nothing behind.
  {
    const out = path.join(work, 'merge-cancelled.mp4')
    let saw = false
    const late = cutter.merge({
      inputs: [path.join(work, 'mix-small.mp4'), path.join(work, 'mix-big.mp4')],
      output: out,
    }, p => { if (p > 0) saw = true })
    // cancel as soon as the first progress tick lands (mid-encode)
    const poll = setInterval(() => { if (saw) cutter.cancel() }, 25)
    let cancelled = false
    try { await late } catch (e) { cancelled = /Cancelled/.test(e.message) }
    clearInterval(poll)
    ok('cancel: merge rejects with Cancelled', cancelled)
    ok('cancel: no output after cancel', !fs.existsSync(out))
    const residue = fs.readdirSync(work).filter(n => n.includes('.vidcut'))
    ok('cancel: no .part residue', residue.length === 0, residue.join(','))
    const leftovers = fs.readdirSync(work).filter(n => n.startsWith('.vidcut-merge-'))
    ok('cancel: temp dir removed', leftovers.length === 0, leftovers.join(','))
  }

  // 9k. atomic writers: partPath naming, JPEG marker validation,
  //     artifact validation (floor / ceiling / truncation), and the
  //     byte formatting the preflight messages carry.
  {
    const { partPath, checkJpeg, validSegmentOutput, humanBytes } = cutter._internal
    ok('partPath: inserts .vidcut before the extension',
      partPath('/a/b/clip [cut].mp4') === '/a/b/clip [cut].vidcut.mp4')
    ok('partPath: non-mp4 families keep their extension',
      partPath('/a/b tone.mp3') === '/a/b tone.vidcut.mp3')
    ok('partPath: extensionless output gains .mp4',
      partPath('/a/clip') === '/a/clip.vidcut.mp4')

    const realFrame = path.join(work, 'frame-ok.jpg')
    run(realFrame, ['-y', '-hide_banner', '-ss', '2', '-i', sample,
      '-frames:v', '1', '-f', 'mjpeg', '-q:v', '2', realFrame])
    ok('jpeg: complete capture validates', checkJpeg(realFrame))
    const stub = path.join(work, 'frame-stub.jpg')
    fs.writeFileSync(stub, Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(2048, 0)])) // SOI, no EOI
    ok('jpeg: truncated capture (no EOI) fails', !checkJpeg(stub))

    const seg = path.join(work, 'valid-reseg.mp4')
    await cutter.cut({ input: sample, output: seg, start: 1, duration: 6, forceReencode: true })
    ok('segment: healthy re-encode output validates', await validSegmentOutput(seg, 6, true, true))
    ok('segment: floor rejects a half-missing output', !(await validSegmentOutput(seg, 20, true, true)))
    ok('segment: ceiling rejects a runaway output (exact paths)', !(await validSegmentOutput(seg, 2, true, true)))
    const copySeg = path.join(work, 'valid-copyseg.mp4')
    await cutter.cut({ input: sample, output: copySeg, start: 1, duration: 3 })
    ok('segment: keyframe-snapped copy output stays valid (one-sided floor)',
      await validSegmentOutput(copySeg, 1, true, false))
    const chopped = path.join(work, 'truncated.mp4')
    fs.copyFileSync(copySeg, chopped)
    fs.truncateSync(chopped, Math.floor(fs.statSync(chopped).size * 0.55)) // tail cut → moov gone
    ok('segment: truncated output fails validation', !(await validSegmentOutput(chopped, 3, true, false)))

    ok('humanBytes: bytes, units and rounding',
      humanBytes(0) === '0 B' && humanBytes(512) === '512 B' && humanBytes(1536) === '1.5 KB'
      && humanBytes(5 * 1024 ** 3) === '5.0 GB' && humanBytes(100 * 1024 ** 3) === '100 GB'
      && humanBytes(-1) === '?',
      [humanBytes(0), humanBytes(512), humanBytes(1536), humanBytes(5 * 1024 ** 3)].join(' | '))
  }

  // 9l. merge work dir: intermediates honor job.workDir, both dirs
  //     come out clean, and the disk preflight refuses a starving
  //     filesystem with the numbers in the message.
  {
    const { ensureWorkspace, humanBytes } = cutter._internal
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'vidcut-work-'))
    let sawRemoteTmp = false
    const inputs = [path.join(work, 'mix-small.mp4'), path.join(work, 'mix-big.mp4')]
    const merged = await cutter.merge({
      inputs,
      output: path.join(work, 'workdir-merged.mp4'),
      workDir: remote,
    }, () => {
      if (!sawRemoteTmp) {
        sawRemoteTmp = fs.readdirSync(remote).some(n => n.startsWith('.vidcut-merge-'))
      }
    })
    ok('workdir: merge with a remote work dir succeeds',
      !!(merged && merged.mode === 'normalize'), JSON.stringify(merged))
    ok('workdir: intermediates observed inside the work dir', sawRemoteTmp)
    ok('workdir: work dir cleaned afterwards',
      fs.readdirSync(remote).filter(n => n.startsWith('.vidcut-merge-')).length === 0)
    ok('workdir: no working-file residue beside the output',
      fs.readdirSync(work).filter(n => n.includes('workdir-merged') && n.includes('.vidcut')).length === 0)
    fs.rmSync(remote, { recursive: true, force: true })

    // preflight: stub statfs to report a starving filesystem
    const realStatfs = fs.statfsSync
    const need = inputs.reduce((s, f) => s + fs.statSync(f).size, 0)
    fs.statfsSync = () => ({ bsize: 1, blocks: 1e9, bfree: 1000, bavail: 1000 })
    let refused = null
    try { ensureWorkspace(remote, inputs) } catch (e) { refused = e }
    fs.statfsSync = realStatfs
    ok('workdir: starving disk is refused with numbers',
      !!refused && /free/.test(refused.message), String(refused && refused.message))
    ok('workdir: refusal states the needed size',
      !!refused && refused.message.includes(humanBytes(need)), String(refused && refused.message))

    // preflight passes on a roomy stub
    fs.statfsSync = () => ({ bsize: 4096, blocks: 1e9, bfree: 1e9, bavail: 1e9 })
    const roomy = ensureWorkspace(remote, inputs)
    fs.statfsSync = realStatfs
    ok('workdir: roomy disk passes the preflight', !!(roomy && roomy.free > roomy.need))

    // preflight skips cleanly when statfs is unavailable (old Node)
    const hadStatfs = typeof fs.statfsSync === 'function'
    if (hadStatfs) delete fs.statfsSync
    ok('workdir: missing statfs skips the preflight', ensureWorkspace(remote, inputs) === null)
    if (hadStatfs) fs.statfsSync = realStatfs
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

  // 10c. chapter parsing (synthetic banner with decoy titles: an
  //     input-level title and a stream-level title must NOT bind to
  //     chapters — only the title inside a chapter's metadata block)
  {
    const banner = [
      "Input #0, matroska,webm, from 'x.mkv':",
      '  Metadata:',
      '    title           : Movie Title (decoy)',
      '  Duration: 00:00:10.00, start: 0.000000, bitrate: 123 kb/s',
      '    Chapters:',
      '    Chapter #0:0: start 0.000000, end 2.000000',
      '      Metadata:',
      '        title           : Alpha',
      '    Chapter #0:1: start 2.000000, end 5.000000',
      '      Metadata:',
      '        title           : Bravo',
      '    Chapter #0:2: start 5.000000, end 10.000000',
      '      Metadata:',
      '        title           : Charlie',
      '    Stream #0:0: Video: h264 (High), yuv420p, 480x360, 30 fps',
      '    Metadata:',
      '      title           : stream decoy',
      '    Stream #0:1: Audio: aac (LC), 48000 Hz, stereo, fltp, 128 kb/s',
    ].join('\n')
    const info = cutter._internal.parseStreams(banner)
    ok('chapters: three parsed from the banner', info.chapters.length === 3,
       JSON.stringify(info.chapters))
    ok('chapters: starts land on 0 / 2 / 5',
       info.chapters.map(c => c.start).join(',') === '0,2,5')
    ok('chapters: titles bound to their chapters only',
       info.chapters.map(c => c.title).join(',') === 'Alpha,Bravo,Charlie',
       JSON.stringify(info.chapters.map(c => c.title)))
    ok('chapters: chapterless banner yields an empty array',
       cutter._internal.parseStreams('Input #0\n  Duration: 00:00:01.00\n').chapters.length === 0)
  }

  // 10d. chapters on a REAL container: FFMETADATA → matroska remux,
  //     parsed back through the live probe path
  {
    const meta = path.join(work, 'chapters.txt')
    fs.writeFileSync(meta, [
      ';FFMETADATA1',
      '[CHAPTER]', 'TIMEBASE=1/1000', 'START=0', 'END=2000', 'title=Alpha',
      '[CHAPTER]', 'TIMEBASE=1/1000', 'START=2000', 'END=5000', 'title=Bravo',
      '[CHAPTER]', 'TIMEBASE=1/1000', 'START=5000', 'END=12000', 'title=Charlie',
    ].join('\n') + '\n')
    const chaptered = path.join(work, 'chaptered.mkv')
    run(chaptered, ['-i', sample, '-i', meta, '-map', '0', '-map_metadata', '1', '-c', 'copy', chaptered])
    const info = await cutter.probe(chaptered)
    ok('chapters: real mkv probe finds 3 chapters',
       !!(info && info.chapters && info.chapters.length === 3),
       info && JSON.stringify(info.chapters))
    ok('chapters: real mkv starts on 0 / 2 / 5',
       !!(info && info.chapters.map(c => c.start).join(',') === '0,2,5'))
    ok('chapters: real mkv titles parsed',
       !!(info && info.chapters.map(c => c.title).join(',') === 'Alpha,Bravo,Charlie'),
       info && JSON.stringify(info.chapters.map(c => c.title)))
  }

  // 10e. MUTE argument builders — the audio map disappears, -an is
  //     explicit, and the re-encode path skips the audio codec
  {
    const cut = cutter._internal.buildArgs({ input: 'a.mp4', output: 'b.mp4', start: 1, duration: 2, muted: true }, false)
    ok('muted args: cut drops the audio map, keeps -an',
       !cut.includes('0:a:0?') && cut.includes('-an'), cut.join(' '))
    const reCut = cutter._internal.buildArgs({ input: 'a.mp4', output: 'b.mp4', start: 1, duration: 2, muted: true }, true)
    ok('muted args: re-encode skips the audio codec',
       reCut.includes('-an') && !reCut.includes('aac'), reCut.join(' '))
    const conv = cutter._internal.convertArgs({ input: 'a.mp4', output: 'b.mp4', start: 1, duration: 2, muted: true })
    ok('muted args: convert drops the audio map',
       !conv.includes('0:a:0?') && conv.includes('-an'), conv.join(' '))
    const mrg = cutter._internal.mergeArgs({ inputs: ['a.mp4', 'b.mp4'], output: 'c.mp4', muted: true })
    ok('muted args: merge adds -an', mrg.includes('-an'), mrg.join(' '))
    const clean = cutter._internal.buildArgs({ input: 'a.mp4', output: 'b.mp4', start: 1, duration: 2 }, false)
    ok('muted args: unmapped audio only when muted',
       clean.includes('0:a:0?') && !clean.includes('-an'), clean.join(' '))
  }

  // 10f. MUTE end-to-end: a muted cut/convert/merge writes a silent
  //     file, the unmuted control still carries audio
  {
    const silentCut = path.join(work, 'silent-cut.mp4')
    const mode = await cutter.cut({ input: sample, output: silentCut, start: 1, duration: 2, muted: true })
    ok('muted cut: succeeds (copy mode)', mode === 'copy', 'mode=' + mode)
    ok('muted cut: output has video but NO audio',
       hasStream(silentCut, 'Video') && !hasStream(silentCut, 'Audio'))

    const audibleCut = path.join(work, 'audible-cut.mp4')
    await cutter.cut({ input: sample, output: audibleCut, start: 1, duration: 2 })
    ok('muted cut: control (unmuted) keeps its audio', hasStream(audibleCut, 'Audio'))

    const silentConv = path.join(work, 'silent-conv.mp4')
    await cutter.convert({ input: sample, output: silentConv, start: 1, duration: 2, muted: true })
    ok('muted convert: output has video but NO audio',
       hasStream(silentConv, 'Video') && !hasStream(silentConv, 'Audio'))

    const silentMerge = path.join(work, 'silent-merge.mp4')
    await cutter.merge({
      inputs: [path.join(work, 'part-a.mp4'), path.join(work, 'part-b.mp4')],
      output: silentMerge, muted: true,
    })
    ok('muted merge: output has video but NO audio',
       hasStream(silentMerge, 'Video') && !hasStream(silentMerge, 'Audio'))
  }

  // 11. save-name suggestion (idempotent + ascending)
  {
    const { nextFreePath } = require(path.join(ROOT, 'app', 'naming.js'))
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidcut-name-'))
    const free = path.join(dir, 'clip [cut].mp4')
    ok('naming: free name offered as-is (idempotent)', nextFreePath(free) === free)

    fs.writeFileSync(free, 'x')
    ok('naming: first collision bumps to  2',
      nextFreePath(free) === path.join(dir, 'clip [cut] 2.mp4'), nextFreePath(free))

    fs.writeFileSync(path.join(dir, 'clip [cut] 2.mp4'), 'x')
    ok('naming: next collision bumps to  3',
      nextFreePath(free) === path.join(dir, 'clip [cut] 3.mp4'), nextFreePath(free))

    // a suggested name that already carries a counter continues it
    ok('naming: counted default continues its counter',
      nextFreePath(path.join(dir, 'clip [cut] 2.mp4')) === path.join(dir, 'clip [cut] 3.mp4'))

    // first FREE number wins: base + 3 exist, 2 is the gap
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'vidcut-name2-'))
    const base = path.join(dir2, 'vid.mp4')
    fs.writeFileSync(base, 'x')
    fs.writeFileSync(path.join(dir2, 'vid 3.mp4'), 'x')
    ok('naming: the first free number wins (gap at 2)',
      nextFreePath(base) === path.join(dir2, 'vid 2.mp4'), nextFreePath(base))

    // each extension is its own series
    ok('naming: other extensions are their own series',
      nextFreePath(path.join(dir, 'clip [cut].jpg')) === path.join(dir, 'clip [cut].jpg'))

    // garbage passes through untouched, never throws
    ok('naming: non-string/non-path passthrough',
      nextFreePath('') === '' && nextFreePath(null) === null)

    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(dir2, { recursive: true, force: true })
  }

  // 11b. recorder output naming is idempotent too — the recording is
  //      the one file the app creates without a save dialog, so the
  //      bump must happen at the naming point inside recorder.start()
  {
    const recorder = require(path.join(ROOT, 'app', 'recorder.js'))
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidcut-rec-'))
    const pad = v => String(v).padStart(2, '0')
    const stampFor = d => pad(d.getFullYear() % 100) + pad(d.getMonth() + 1) + pad(d.getDate()) +
      '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds())
    // Occupy every second around "now": whichever stamp start() picks,
    // the plain name collides, so the bump has to engage.
    for (let offset = -2; offset <= 2; offset++) {
      fs.writeFileSync(path.join(dir, `box-${stampFor(new Date(Date.now() + offset * 1000))}.mp4`), 'x')
    }
    const result = await recorder.start(dir)
    ok('recorder: collision bumps the recording name',
      / 2\.mp4$/.test(result.output), result.output)
    // Let the async spawn outcome settle (ENOENT here), then reset.
    await new Promise(r => setTimeout(r, 200))
    recorder.destroy()
    fs.rmSync(dir, { recursive: true, force: true })
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
