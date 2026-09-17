/* Electron smoke test for vidcut (full edition) — boots the REAL app
 * (by requiring app/main.js, so every real IPC handler is live) and
 * drives it from inside the renderer:
 *
 *   renderer boot & controls, webUtils drag-drop bridge, media load,
 *   THE merge/record sheets stay hidden at boot (the reported
 *   "panel extended by default" bug), aspect-ratio + toolbar
 *   visibility layout invariants, clip marking, timeline painting,
 *   speed controls, segment time inputs, keyboard navigation, real
 *   job round-trips (cut / capture / merge, incl. hostile filenames
 *   + invalid jobs), metadata title probe, the live-transcode stream
 *   fallback for unplayable containers, the audio-only waveform, and
 *   the recorder ENOENT failure path.
 *
 * Run headlessly:
 *   xvfb-run -a -s "-screen 0 1920x1080x24" npx electron scripts/electron-smoke.js
 * (or: Xvfb :99 & DISPLAY=:99 npx electron scripts/electron-smoke.js) */

const { app, BrowserWindow } = require('electron')
const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const FFMPEG = path.join(ROOT, 'app', 'bin', 'ffmpeg')
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vidcut-smoke-'))

let passed = 0
const failures = []

function ok(name, condition, detail) {
  if (condition) {
    passed++
    console.log('  ok    ' + name)
  } else {
    failures.push(name + (detail !== undefined ? ' — ' + detail : ''))
    console.log('  FAIL  ' + name + (detail !== undefined ? ' — ' + detail : ''))
  }
}

function finish() {
  if (failures.length) {
    console.log(`\n${passed}/${passed + failures.length} passed, ${failures.length} FAILED`)
    console.log('artifacts kept at ' + work)
  } else {
    console.log(`\nAll ${passed} smoke checks passed`)
    try { fs.rmSync(work, { recursive: true, force: true }) } catch (e) { /* keep */ }
  }
  app.exit(failures.length ? 1 : 0)
}

/* Boot the real application (registers the IPC handlers). */
require(path.join(ROOT, 'app', 'main.js'))

app.whenReady().then(async () => {
  try {
    const sample = path.join(work, 'sample.mp4')
    execFileSync(FFMPEG, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=duration=10:size=480x360:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', sample,
    ])

    // mpeg4 (xvid) in AVI: Chromium cannot demux .avi at all — the
    // stream fallback exists for exactly this. (h264-in-mkv is NOT a
    // usable fixture: Electron 42's Chromium plays it natively; and
    // .ts is out too — the bundled ffmpeg 4.3.1 segfaults on MPEG-TS.)
    const legacy = path.join(work, 'legacy.avi')
    execFileSync(FFMPEG, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=duration=10:size=480x360:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=330:duration=10',
      '-c:v', 'mpeg4', '-vtag', 'xvid', '-q:v', '5', '-c:a', 'libmp3lame', '-shortest', legacy,
    ])

    const tone = path.join(work, 'tone.mp3')
    execFileSync(FFMPEG, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'sine=frequency=880:duration=6', '-c:a', 'libmp3lame', tone,
    ])

    const win = BrowserWindow.getAllWindows()[0]
    ok('boot: app window created', !!win)
    if (!win) return finish()

    if (win.webContents.isLoading()) {
      await new Promise(resolve => win.webContents.once('did-finish-load', resolve))
    }
    await new Promise(resolve => setTimeout(resolve, 400)) // let renderer finish wiring

    win.webContents.on('render-process-gone', (_event, details) => {
      failures.push('renderer crashed: ' + details.reason)
    })

    const outPath = path.join(work, 'smoke-cut.mp4')
    const hostileOut = path.join(work, 'smoke & cut #1.mp4')
    const frameOut = path.join(work, 'smoke-frame.jpg')
    const mergeA = path.join(work, 'merge-a.mp4')
    const mergeB = path.join(work, 'merge-b.mp4')
    const mergeOut = path.join(work, "smoke & merged (ok).mp4")
    execFileSync(FFMPEG, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=duration=4:size=480x360:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', mergeA,
    ])
    execFileSync(FFMPEG, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=duration=4:size=480x360:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=550:duration=4',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', mergeB,
    ])

    const pageChecks = await win.webContents.executeJavaScript(`(async () => {
      const results = []
      const report = (name, cond, detail) => results.push({ name, cond: !!cond, detail: String(detail || '') })
      const electron = require('electron')
      const fs = require('fs')
      const wait = async (fn, ms) => {
        const deadline = Date.now() + (ms || 8000)
        while (Date.now() < deadline) {
          const value = fn()
          if (value) return value
          await new Promise(r => setTimeout(r, 100))
        }
        return fn()
      }

      // 1. renderer booted and every control exists
      const ids = ['cut-btn', 'set-in-btn', 'set-out-btn', 'timeline', 'play-btn',
                   'status', 'dropzone', 'flag-in', 'flag-out', 'progress',
                   'speed-down-btn', 'speed-up-btn', 'speed-chip',
                   'in-input', 'out-input',
                   'nav-start-btn', 'nav-in-btn', 'nav-out-btn', 'nav-end-btn',
                   'capture-btn', 'extract-btn', 'convert-btn',
                   'merge-btn', 'record-btn', 'help-btn', 'wave',
                   'merge-sheet', 'record-sheet', 'merge-list', 'record-elapsed']
      report('renderer: all controls present', ids.every(id => document.getElementById(id)))

      // 2. THE reported bug: sheets must be hidden at init, and the
      //    layout must be intact without ever touching them.
      report('sheets: merge hidden at boot', document.getElementById('merge-sheet').hidden)
      report('sheets: record hidden at boot', document.getElementById('record-sheet').hidden)
      report('sheets: no computed display before open',
        getComputedStyle(document.getElementById('merge-sheet')).display === 'none' &&
        getComputedStyle(document.getElementById('record-sheet')).display === 'none')
      report('sheets: no phantom layout at boot',
        document.documentElement.scrollWidth <= window.innerWidth &&
        document.body.scrollHeight <= window.innerHeight + 1,
        document.documentElement.scrollWidth + 'x' + document.body.scrollHeight + ' vs ' +
        window.innerWidth + 'x' + window.innerHeight)

      // 3. webUtils bridge available (Electron 32+ removed File.path)
      report('drag-drop: webUtils available',
        !!(electron.webUtils && typeof electron.webUtils.getPathForFile === 'function'))

      // 4. synthetic File resolves gracefully (no crash, no fake path)
      let synthetic = 'threw'
      try { synthetic = window.vidcut.pathFromFile(new File(['x'], 'fake.mp4')) } catch (e) { synthetic = 'threw' }
      report('drag-drop: synthetic file handled safely', synthetic === null || synthetic === '')

      // 5. load a real file through the real loadFile()
      window.vidcut.loadFile(${JSON.stringify(sample)})
      let loaded = false
      for (let i = 0; i < 100 && !loaded; i++) {
        await new Promise(r => setTimeout(r, 50))
        loaded = window.vidcut.state.ready
      }
      report('load: metadata ready', loaded)
      report('load: duration ≈ 10s', Math.abs(window.vidcut.state.clipEnd - 10) < 0.5,
        window.vidcut.state.clipEnd)
      report('load: dropzone hidden', document.getElementById('dropzone').hidden)
      report('load: native mode (no stream)', window.vidcut.state.streamMode === false)

      // 6. metadata title enrichment via the probe round-trip
      await new Promise(r => setTimeout(r, 1200))
      report('probe: title enriched', /h264/i.test(document.title), document.title)

      // 7. layout invariants (the reported symptoms)
      const playerStyle = getComputedStyle(document.getElementById('player'))
      report('layout: video object-fit contain', playerStyle.objectFit === 'contain')
      report('layout: video absolutely positioned', playerStyle.position === 'absolute')
      const stage = document.getElementById('stage').getBoundingClientRect()
      report('layout: stage fluid and sized', stage.width > 100 && stage.height > 100,
        Math.round(stage.width) + 'x' + Math.round(stage.height))
      const controls = document.getElementById('controls').getBoundingClientRect()
      report('layout: toolbar fully visible inside viewport',
        controls.top >= 0 && controls.bottom <= window.innerHeight + 1,
        'top=' + Math.round(controls.top) + ' bottom=' + Math.round(controls.bottom) +
        ' viewport=' + window.innerHeight)
      const topbar = document.getElementById('topbar').getBoundingClientRect()
      report('layout: topbar visible', topbar.bottom <= window.innerHeight)

      // 8. mark a clip through the real functions
      const player = document.getElementById('player')
      player.currentTime = 3
      window.vidcut.markStart()
      player.currentTime = 7
      window.vidcut.markEnd()
      report('clip: range 3 → 7',
        Math.abs(window.vidcut.state.clipStart - 3) < 0.2 &&
        Math.abs(window.vidcut.state.clipEnd - 7) < 0.2,
        window.vidcut.state.clipStart + '→' + window.vidcut.state.clipEnd)
      const region = document.getElementById('tl-region')
      report('clip: selection region painted', parseFloat(region.style.width) > 30, region.style.width)

      // 9. segment inputs mirror the marks (canonical HH:MM:SS.mmm)
      report('inputs: mirrors clip start', document.getElementById('in-input').value === '00:00:03.000',
        document.getElementById('in-input').value)
      report('inputs: mirrors clip end', document.getElementById('out-input').value === '00:00:07.000',
        document.getElementById('out-input').value)

      // 10. timecode parsing round-trips
      report('inputs: parser accepts H:MM:SS.mmm', window.vidcut.parseTime('00:00:03.000') === 3)
      report('inputs: parser accepts M:SS', window.vidcut.parseTime('2:05') === 125)
      report('inputs: parser accepts bare seconds', window.vidcut.parseTime('9.5') === 9.5)
      report('inputs: parser rejects garbage', window.vidcut.parseTime('banana') === null)
      report('inputs: formatter canonical', window.vidcut.formatTime(125.5) === '00:02:05.500',
        window.vidcut.formatTime(125.5))

      // 11. typing an input moves the clip bound (validated + clamped)
      const inInput = document.getElementById('in-input')
      inInput.value = '00:00:01.500'
      inInput.dispatchEvent(new Event('input', { bubbles: true }))
      report('inputs: typing updates the bound', Math.abs(window.vidcut.state.clipStart - 1.5) < 0.01,
        window.vidcut.state.clipStart)

      // 12. navigation seeks
      window.vidcut.seekTo(0)
      await new Promise(r => setTimeout(r, 150))
      report('nav: seek to start lands at 0', player.currentTime < 0.15, player.currentTime)
      window.vidcut.seekTo(window.vidcut.state.clipEnd)
      await new Promise(r => setTimeout(r, 150))
      report('nav: seek to clip end', Math.abs(player.currentTime - 6.5) < 0.4 || Math.abs(player.currentTime - 7) < 0.4,
        player.currentTime)

      // 13. speed controls
      window.vidcut.setRate(1.5)
      report('speed: playbackRate 1.5', Math.abs(player.playbackRate - 1.5) < 0.01, player.playbackRate)
      report('speed: chip reads 1.5×', document.getElementById('speed-chip').textContent === '1.5×',
        document.getElementById('speed-chip').textContent)
      document.getElementById('speed-down-btn').click()
      report('speed: ⏪ steps down to 1.4', Math.abs(player.playbackRate - 1.4) < 0.01, player.playbackRate)
      document.getElementById('speed-chip').click()
      report('speed: chip click resets to 1.0', Math.abs(player.playbackRate - 1) < 0.01, player.playbackRate)

      // 14. playhead follows the seek
      const played = document.getElementById('tl-progress')
      await new Promise(r => setTimeout(r, 120))
      const playedPct = parseFloat(played.style.width)
      report('timeline: playhead at ≈ 70%', playedPct > 60 && playedPct < 80, playedPct + '%')

      // 15. real cut through the real IPC handler
      const res = await electron.ipcRenderer.invoke('job:start', {
        kind: 'cut',
        input: ${JSON.stringify(sample)}, output: ${JSON.stringify(outPath)}, start: 2, duration: 3,
      })
      report('cut: job ok', res && res.ok, res && res.error)
      report('cut: lossless copy mode', res && res.mode === 'copy')
      report('cut: output written', fs.existsSync(${JSON.stringify(outPath)}))

      // 16. cut to a hostile filename through IPC
      const res2 = await electron.ipcRenderer.invoke('job:start', {
        kind: 'cut',
        input: ${JSON.stringify(sample)}, output: ${JSON.stringify(hostileOut)}, start: 1, duration: 2,
      })
      report('cut: hostile filename ok', res2 && res2.ok && fs.existsSync(${JSON.stringify(hostileOut)}),
        res2 && res2.error)

      // 17. invalid job rejected without a crash
      const res3 = await electron.ipcRenderer.invoke('job:start', {
        kind: 'cut',
        input: '/nope/x.mp4', output: '/nope/y.mp4', start: 0, duration: 0,
      })
      report('cut: invalid job rejected', res3 && res3.ok === false)

      // 18. capture tool through the real IPC (frame at playhead)
      const resCap = await electron.ipcRenderer.invoke('job:start', {
        kind: 'capture', input: ${JSON.stringify(sample)}, output: ${JSON.stringify(frameOut)}, at: 5,
      })
      const head = fs.existsSync(${JSON.stringify(frameOut)})
        ? fs.readFileSync(${JSON.stringify(frameOut)}).subarray(0, 2) : null
      report('capture: jpg written with SOI marker',
        resCap && resCap.ok && head && head[0] === 0xff && head[1] === 0xd8,
        resCap && resCap.error)

      // 19. merge flow: sheet API + real merge through IPC
      window.vidcut.merge.addFiles(${JSON.stringify([mergeA, mergeB])})
      window.vidcut.merge.open()
      const sheet = document.getElementById('merge-sheet')
      report('merge: sheet opens on demand', sheet.hidden === false)
      report('merge: sheet renders as flex overlay', getComputedStyle(sheet).display === 'flex')
      report('merge: list has both files',
        document.querySelectorAll('#merge-list li').length === 2,
        document.querySelectorAll('#merge-list li').length + ' items')
      report('merge: start button labeled with count',
        document.getElementById('merge-start-btn').textContent.includes('2'),
        document.getElementById('merge-start-btn').textContent)
      window.vidcut.merge.close()
      report('merge: sheet closes back to hidden', sheet.hidden === true &&
        getComputedStyle(sheet).display === 'none')
      const resM = await electron.ipcRenderer.invoke('job:start', {
        kind: 'merge', inputs: ${JSON.stringify([mergeA, mergeB])}, output: ${JSON.stringify(mergeOut)},
      })
      report('merge: hostile-named output written', resM && resM.ok && fs.existsSync(${JSON.stringify(mergeOut)}),
        resM && resM.error)

      // 20. Escape closes any open sheet
      window.vidcut.merge.open()
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      report('sheets: Escape closes the open sheet', document.getElementById('merge-sheet').hidden === true)

      // 21. stream fallback for a container Chromium cannot demux
      window.vidcut.loadFile(${JSON.stringify(legacy)})
      const streamReady = await wait(() => window.vidcut.state.ready && window.vidcut.state.streamMode)
      report('stream: fallback engaged for .avi', !!streamReady)
      report('stream: probed duration ≈ 10s',
        streamReady && Math.abs(window.vidcut.state.clipEnd - 10) < 1, window.vidcut.state.clipEnd)
      report('stream: playing over http', /^http:\\/\\/127\\.0\\.0\\.1:\\d+\\//.test(player.currentSrc),
        player.currentSrc)
      // A seek outside the buffered range re-opens the stream at the target
      window.vidcut.seekTo(5)
      const reseeked = await wait(() => window.vidcut.state.ready && window.vidcut.state.streamStart > 4.5)
      report('stream: unbuffered seek re-opens at target', !!reseeked, window.vidcut.state.streamStart)

      // 22. audio-only source shows the waveform; video hides it again
      window.vidcut.loadFile(${JSON.stringify(tone)})
      const toneReady = await wait(() => window.vidcut.state.ready)
      report('audio: tone loads', !!toneReady)
      report('audio: visualizer visible', window.vidcut.wave.isActive() &&
        document.getElementById('wave').hidden === false)
      window.vidcut.loadFile(${JSON.stringify(sample)})
      const videoBack = await wait(() => window.vidcut.state.ready)
      report('audio: visualizer hides for video sources',
        !!videoBack && window.vidcut.wave.isActive() === false &&
        document.getElementById('wave').hidden === true)

      // 23. keyboard: [ and ] jump to the clip bounds
      document.getElementById('in-input').value = '00:00:02.000'
      document.getElementById('in-input').dispatchEvent(new Event('input', { bubbles: true }))
      document.getElementById('out-input').value = '00:00:08.000'
      document.getElementById('out-input').dispatchEvent(new Event('input', { bubbles: true }))
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '[' }))
      await new Promise(r => setTimeout(r, 150))
      const afterIn = player.currentTime
      window.dispatchEvent(new KeyboardEvent('keydown', { key: ']' }))
      await new Promise(r => setTimeout(r, 150))
      report('keyboard: [ and ] jump to the bounds', Math.abs(afterIn - 2) < 0.3 && player.currentTime > 6,
        afterIn.toFixed(2) + ' → ' + player.currentTime.toFixed(2))

      // 24. recorder ENOENT path (wf-recorder is absent here): the
      // state machine must reset with a helpful message, never hang.
      const failed = new Promise(resolve => {
        electron.ipcRenderer.once('recorder:failed', (_e, message) => resolve(message))
      })
      const recStart = await electron.ipcRenderer.invoke('recorder:start')
      if (recStart && recStart.ok) {
        const message = await Promise.race([
          failed,
          new Promise(r => setTimeout(() => r('__timeout__'), 6000)),
        ])
        report('record: ENOENT surfaces as a failure event', message !== '__timeout__' && /wf-recorder/.test(String(message)), message)
        report('record: sheet resets to idle after failure',
          document.getElementById('record-stop-btn').hidden === true &&
          document.getElementById('record-start-btn').hidden === false)
        report('record: failure message on the status line',
          /wf-recorder/.test(document.getElementById('status').textContent),
          document.getElementById('status').textContent)
        report('record: status reports inactive after failure',
          (await electron.ipcRenderer.invoke('recorder:status')).active === false)
      } else {
        // Tray creation failed headlessly before the spawn error could
        // fire: start() must still have refused cleanly with the reason.
        report('record: ENOENT surfaces as a failure event', /wf-recorder|Tray|tray/i.test(String(recStart && recStart.error)), recStart && recStart.error)
        report('record: sheet resets to idle after failure',
          document.getElementById('record-stop-btn').hidden === true)
        report('record: failure message on the status line',
          /wf-recorder|Recording failed/i.test(document.getElementById('status').textContent),
          document.getElementById('status').textContent)
        report('record: status reports inactive after failure',
          (await electron.ipcRenderer.invoke('recorder:status')).active === false)
      }

      return results
    })()`)

    for (const check of pageChecks) ok('app: ' + check.name, check.cond, check.detail)

    /* ---- size sweep: the "toolbar skews / disappears at certain
     * sizes" symptoms. Resizes the real window across its allowed
     * range (incl. minimum and a portrait aspect) with media loaded,
     * and asserts the toolbar is always fully visible and nothing
     * overflows the viewport. ---- */
    const portrait = path.join(work, 'portrait.mp4')
    execFileSync(FFMPEG, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=duration=6:size=540x960:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=330:duration=6',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '30',
      '-c:a', 'aac', '-shortest', portrait,
    ])
    await win.webContents.executeJavaScript(
      `window.vidcut.loadFile(${JSON.stringify(portrait)})`,
    )
    await new Promise(resolve => setTimeout(resolve, 1200))

    const sizes = [[520, 480], [600, 520], [520, 720], [900, 600], [1280, 800]]
    for (const [w, h] of sizes) {
      win.setContentSize(w, h)
      await new Promise(resolve => setTimeout(resolve, 250))
      const layout = await win.webContents.executeJavaScript(`(() => {
        const controls = document.getElementById('controls').getBoundingClientRect()
        const stage = document.getElementById('stage').getBoundingClientRect()
        return {
          toolbarVisible: controls.top >= 0 && controls.bottom <= window.innerHeight + 1,
          topbarVisible: document.getElementById('topbar').getBoundingClientRect().bottom > 0,
          noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth,
          stageAlive: stage.height > 40 && stage.width > 40,
          videoContained: getComputedStyle(document.getElementById('player')).objectFit === 'contain',
          sheetsStillHidden: document.getElementById('merge-sheet').hidden &&
            document.getElementById('record-sheet').hidden,
        }
      })()`)
      ok(`sweep ${w}x${h}: toolbar fully visible`, layout.toolbarVisible)
      ok(`sweep ${w}x${h}: topbar visible`, layout.topbarVisible)
      ok(`sweep ${w}x${h}: nothing overflows horizontally`, layout.noHorizontalOverflow)
      ok(`sweep ${w}x${h}: stage stays alive with portrait media`, layout.stageAlive && layout.videoContained)
      ok(`sweep ${w}x${h}: sheets stay hidden`, layout.sheetsStillHidden)
    }

  } catch (error) {
    failures.push('harness: ' + ((error && error.message) || error))
  } finally {
    finish()
  }
})
