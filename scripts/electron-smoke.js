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
    for (const failure of failures) console.log('  ✗     ' + failure)
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

    // Long reencode source for the IPC cancel test — 90 s at
    // ultrafast leaves plenty of runway to kill mid-encode.
    const long90 = path.join(work, 'long90.mp4')
    execFileSync(FFMPEG, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=duration=90:size=640x480:rate=30',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '30', long90,
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
    // Page-side errors (incl. injected-script compile failures) must
    // not be silent — the line number is relative to the injected page
    // script, which starts ~147 lines into this file.
    win.webContents.on('console-message', (_event, level, message, line, source) => {
      if (level >= 3 || /syntaxerror|uncaught/i.test(String(message))) {
        console.log('  [renderer console] ' + message + ' @ ' + (source || '') + ':' + line)
      }
    })

    const outPath = path.join(work, 'smoke-cut.mp4')
    const hostileOut = path.join(work, 'smoke & cut #1.mp4')
    const frameOut = path.join(work, 'smoke-frame.jpg')
    const mergeA = path.join(work, 'merge-a.mp4')
    const mergeB = path.join(work, 'merge-b.mp4')
    // 320x240, video-only: mismatched with mergeA on purpose — the
    // normalize-path E2E (canvas unify + anullsrc injection) needs it
    const mergeC = path.join(work, 'merge-c.mp4')
    const mergeNormOut = path.join(work, 'merged-normal.mp4')
    const mergeOut = path.join(work, "smoke & merged (ok).mp4")
    const mutedOut = path.join(work, 'smoke-muted-cut.mp4')
    // Chaptered fixture: FFMETADATA chapters at 0 / 2 / 5 s remuxed
    // onto the sample (matroska carries them; Chromium plays it native).
    const chaptersMeta = path.join(work, 'chapters.txt')
    fs.writeFileSync(chaptersMeta, [
      ';FFMETADATA1',
      '[CHAPTER]', 'TIMEBASE=1/1000', 'START=0', 'END=2000', 'title=Alpha',
      '[CHAPTER]', 'TIMEBASE=1/1000', 'START=2000', 'END=5000', 'title=Bravo',
      '[CHAPTER]', 'TIMEBASE=1/1000', 'START=5000', 'END=10000', 'title=Charlie',
    ].join('\n') + '\n')
    const chaptersMkv = path.join(work, 'sample-chapters.mkv')
    execFileSync(FFMPEG, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', sample, '-i', chaptersMeta,
      '-map', '0', '-map_metadata', '1', '-c', 'copy', chaptersMkv,
    ])
    // Where the no-dialog screenshot flow lands (the app resolves the
    // same way: app.getPath('pictures')/screenshots).
    const shotsDir = path.join(app.getPath('pictures'), 'screenshots')
    const cap1 = path.join(shotsDir, 'sample [capture].jpg')
    const cap2 = path.join(shotsDir, 'sample [capture] 2.jpg')
    // Deterministic: clear any leftovers of this fixture's captures
    // ("sample …" from a clean run, "capture …" from a base-name miss).
    try {
      for (const f of fs.readdirSync(shotsDir)) {
        if (/^(sample|capture) \[capture\]( \d+)?\.jpg$/.test(f)) {
          try { fs.unlinkSync(path.join(shotsDir, f)) } catch (e) { /* keep going */ }
        }
      }
    } catch (e) { /* dir not there yet — the app creates it on demand */ }
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
    execFileSync(FFMPEG, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=duration=4:size=320x240:rate=30',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', mergeC,
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

      try { // any throw below surfaces as a failed check with its stack

      // 1. renderer booted and every control exists
      const ids = ['cut-btn', 'set-in-btn', 'set-out-btn', 'timeline', 'play-btn',
                   'status', 'dropzone', 'flag-in', 'flag-out', 'progress',
                   'speed-down-btn', 'speed-up-btn', 'speed-chip',
                   'in-input', 'out-input',
                   'nav-start-btn', 'nav-in-btn', 'nav-out-btn', 'nav-end-btn',
                   'capture-btn', 'extract-btn', 'convert-btn',
                   'merge-btn', 'record-btn', 'help-btn', 'wave',
                   'merge-sheet', 'record-sheet', 'merge-list', 'record-elapsed',
                   'mute-btn', 'icon-sound', 'icon-muted',
                   'shortcuts-sheet', 'keys-repo-btn', 'keys-close-btn']
      report('renderer: all controls present', ids.every(id => document.getElementById(id)))

      // 2. THE reported bug: sheets must be hidden at init, and the
      //    layout must be intact without ever touching them.
      report('sheets: merge hidden at boot', document.getElementById('merge-sheet').hidden)
      report('sheets: record hidden at boot', document.getElementById('record-sheet').hidden)
      report('sheets: shortcuts hidden at boot', document.getElementById('shortcuts-sheet').hidden)
      // the cheat sheet carries the pan / zoom-reset / undo rows
      window.vidcut.openSheet('shortcuts')
      const keysText = document.getElementById('shortcuts-sheet').textContent
      report('shortcuts: pan, zoom-reset and undo rows present',
        keysText.includes('Ctrl + drag') && keysText.includes('Ctrl+0')
        && keysText.includes('Ctrl+Z') && keysText.includes('Ctrl+Shift+Z'),
        'missing rows')
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      report('shortcuts: sheet closes again', document.getElementById('shortcuts-sheet').hidden === true)
      report('sheets: no computed display before open',
        getComputedStyle(document.getElementById('merge-sheet')).display === 'none' &&
        getComputedStyle(document.getElementById('record-sheet')).display === 'none' &&
        getComputedStyle(document.getElementById('shortcuts-sheet')).display === 'none')
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

      // 14b. the keybind map (dialog-triggering keys s/a/c/Enter are
      //      exercised by the button-driven job checks below — a real
      //      save dialog would block the headless run)
      const key = k => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))
      player.currentTime = 4
      await new Promise(r => setTimeout(r, 150))
      key('i')
      report('keybind: i marks start at playhead',
        Math.abs(window.vidcut.state.clipStart - 4) < 0.3, window.vidcut.state.clipStart)
      player.currentTime = 6
      await new Promise(r => setTimeout(r, 150))
      key('o')
      report('keybind: o marks end at playhead',
        Math.abs(window.vidcut.state.clipEnd - 6) < 0.3, window.vidcut.state.clipEnd)
      key('[')
      report('keybind: [ slows playback', Math.abs(player.playbackRate - 0.9) < 0.01, player.playbackRate)
      key(']')
      report('keybind: ] speeds playback back up', Math.abs(player.playbackRate - 1) < 0.01, player.playbackRate)
      key('m')
      report('keybind: m opens the merge sheet', document.getElementById('merge-sheet').hidden === false)
      key('Escape')
      report('keybind: Escape closes the sheet', document.getElementById('merge-sheet').hidden === true)
      key('r')
      report('keybind: r opens the record sheet', document.getElementById('record-sheet').hidden === false)
      key('m')
      report('keybind: m supersedes the record sheet',
        document.getElementById('merge-sheet').hidden === false && document.getElementById('record-sheet').hidden === true)
      key('Escape')
      key(' ')
      await new Promise(r => setTimeout(r, 400))
      report('keybind: space toggles playback', player.paused === false, 'paused=' + player.paused)
      key(' ')
      await new Promise(r => setTimeout(r, 150))
      report('keybind: space pauses again', player.paused === true, 'paused=' + player.paused)

      // 14b2. Space is hardcoded to play/pause: a focused button can
      //       never capture it. preventDefault on keydown is what
      //       cancels the browser's own spacebar activation, so the
      //       Open button (focused after a mouse click, or at init)
      //       can no longer re-fire the open dialog.
      const openBtnEl = document.getElementById('open-btn')
      openBtnEl.focus()
      const spaceOnBtn = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })
      openBtnEl.dispatchEvent(spaceOnBtn)
      await new Promise(r => setTimeout(r, 150))
      report('keybind: space plays even with a focused button',
        spaceOnBtn.defaultPrevented === true && player.paused === false,
        'defaultPrevented=' + spaceOnBtn.defaultPrevented + ' paused=' + player.paused)
      const spaceOnBtn2 = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })
      openBtnEl.dispatchEvent(spaceOnBtn2)
      await new Promise(r => setTimeout(r, 150))
      report('keybind: space pauses with a focused button',
        spaceOnBtn2.defaultPrevented === true && player.paused === true,
        'defaultPrevented=' + spaceOnBtn2.defaultPrevented + ' paused=' + player.paused)
      // a mouse-driven click (detail > 0) never leaves focus behind
      const setInBtnEl = document.getElementById('set-in-btn')
      setInBtnEl.focus()
      setInBtnEl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }))
      report('focus: a mouse click releases button focus',
        document.activeElement !== setInBtnEl,
        String(document.activeElement && document.activeElement.id))

      // 14c. mouse-wheel zoom magnifies the video (not the timeline)
      const stageEl = document.getElementById('stage')
      const zoomUp = new WheelEvent('wheel', { deltaY: -100, cancelable: true })
      const zoomDown = new WheelEvent('wheel', { deltaY: 100, cancelable: true })
      stageEl.dispatchEvent(zoomUp)
      report('zoom: wheel up scales the video to 1.25×',
        window.vidcut.state.zoom === 1.25 && player.style.transform === 'translate(0px, 0px) scale(1.25)',
        window.vidcut.state.zoom + ' ' + player.style.transform)
      stageEl.dispatchEvent(zoomDown)
      report('zoom: wheel down returns to 1×',
        window.vidcut.state.zoom === 1 && player.style.transform === '',
        window.vidcut.state.zoom + ' ' + player.style.transform)
      stageEl.dispatchEvent(zoomUp)
      stageEl.dispatchEvent(zoomUp)
      report('zoom: two notches land on 1.56×', window.vidcut.state.zoom === 1.56, window.vidcut.state.zoom)
      window.vidcut.loadFile(${JSON.stringify(sample)})
      const reloaded = await wait(() => window.vidcut.state.ready)
      report('zoom: factor resets with a new source',
        reloaded && window.vidcut.state.zoom === 1 && player.style.transform === '',
        window.vidcut.state.zoom + ' ' + player.style.transform)

      // 14c-2. Ctrl+left-drag pans the magnified picture: clamped to
      //        the zoom overflow, never doubles as a play toggle, and
      //        Ctrl+0 resets zoom AND pan together
      stageEl.dispatchEvent(zoomUp)
      stageEl.dispatchEvent(zoomUp) // 1.56×
      const stageRect = stageEl.getBoundingClientRect()
      const panEvt = (type, x, y) => new PointerEvent(type, {
        clientX: x, clientY: y, button: 0, ctrlKey: true,
        bubbles: true, cancelable: true, pointerId: 11,
      })
      player.pause()
      stageEl.dispatchEvent(panEvt('pointerdown', stageRect.left + 100, stageRect.top + 80))
      stageEl.dispatchEvent(panEvt('pointermove', stageRect.left + 140, stageRect.top + 105))
      stageEl.dispatchEvent(panEvt('pointerup', stageRect.left + 140, stageRect.top + 105))
      report('pan: Ctrl+drag moves the picture',
        window.vidcut.state.panX === 40 && window.vidcut.state.panY === 25,
        window.vidcut.state.panX + ',' + window.vidcut.state.panY)
      report('pan: transform carries translate then scale',
        player.style.transform === 'translate(40px, 25px) scale(1.56)',
        player.style.transform)
      // the click that follows a pan release must NOT toggle play
      player.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await new Promise(r => setTimeout(r, 300)) // the 220 ms toggle-timer window
      report('pan: a pan release never toggles playback', player.paused === true,
        'paused=' + player.paused)
      // the pan is clamped to the scaled element's overflow
      stageEl.dispatchEvent(panEvt('pointerdown', stageRect.left + 100, stageRect.top + 80))
      stageEl.dispatchEvent(panEvt('pointermove', stageRect.left + 10000, stageRect.top + 80))
      stageEl.dispatchEvent(panEvt('pointerup', stageRect.left + 10000, stageRect.top + 80))
      const panB = window.vidcut.panBounds()
      report('pan: clamped to the zoom overflow',
        Math.abs(window.vidcut.state.panX - panB.x) < 1 && window.vidcut.state.panY === 25,
        window.vidcut.state.panX + ' / ' + panB.x)
      // Ctrl+0 resets zoom and pan together
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '0', ctrlKey: true, bubbles: true, cancelable: true }))
      report('pan: Ctrl+0 resets zoom and pan',
        window.vidcut.state.zoom === 1 && window.vidcut.state.panX === 0
        && window.vidcut.state.panY === 0 && player.style.transform === '',
        window.vidcut.state.zoom + ' ' + player.style.transform)
      // at 1× a Ctrl+press explains itself instead of ignoring the gesture
      stageEl.dispatchEvent(panEvt('pointerdown', stageRect.left + 100, stageRect.top + 80))
      stageEl.dispatchEvent(panEvt('pointerup', stageRect.left + 100, stageRect.top + 80))
      report('pan: zoom-1 gesture explains itself',
        document.getElementById('status').textContent.includes('Zoom in first'),
        document.getElementById('status').textContent)
      // consume the swallow flag so later genuine clicks behave normally
      player.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

      // 14d. the clip flags are draggable bounds
      const tlRect = document.getElementById('timeline').getBoundingClientRect()
      const flagIn = document.getElementById('flag-in')
      const fr = flagIn.getBoundingClientRect()
      const down = new PointerEvent('pointerdown', {
        clientX: fr.left + fr.width / 2, clientY: fr.top + fr.height / 2,
        button: 0, bubbles: true, cancelable: true, pointerId: 7,
      })
      const move = new PointerEvent('pointermove', {
        clientX: tlRect.left + tlRect.width * 0.4, clientY: tlRect.top + 13,
        button: 0, bubbles: true, cancelable: true, pointerId: 7,
      })
      const up = new PointerEvent('pointerup', {
        clientX: tlRect.left + tlRect.width * 0.4, clientY: tlRect.top + 13,
        button: 0, bubbles: true, cancelable: true, pointerId: 7,
      })
      flagIn.dispatchEvent(down)
      flagIn.dispatchEvent(move)
      flagIn.dispatchEvent(up)
      report('flags: dragging the start flag moves clip start',
        Math.abs(window.vidcut.state.clipStart - 4) < 0.5, window.vidcut.state.clipStart)
      report('flags: grab cursor is armed on the flags',
        getComputedStyle(flagIn).cursor === 'grab' && getComputedStyle(flagIn).pointerEvents === 'auto',
        getComputedStyle(flagIn).cursor)

      // 14d-2. undo/redo of the clip geometry: a keyed mark and a
      //        typing burst each snapshot first; Ctrl+Z walks back,
      //        Ctrl+Shift+Z re-applies, and one undo rewinds a whole
      //        typing burst (coalesced)
      player.currentTime = 6
      await new Promise(r => setTimeout(r, 150))
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'i', bubbles: true, cancelable: true }))
      report('undo: marking pushes the previous geometry',
        Math.abs(window.vidcut.state.clipStart - 6) < 0.05, window.vidcut.state.clipStart)
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }))
      report('undo: Ctrl+Z restores the pre-mark bounds',
        Math.abs(window.vidcut.state.clipStart - 4) < 0.05, window.vidcut.state.clipStart)
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Z', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }))
      report('undo: Ctrl+Shift+Z re-applies the mark',
        Math.abs(window.vidcut.state.clipStart - 6) < 0.05, window.vidcut.state.clipStart)
      // typing coalesces: two rapid input edits = ONE undo step
      const inInputEl = document.getElementById('in-input')
      inInputEl.value = '00:00:02.500'
      inInputEl.dispatchEvent(new Event('input', { bubbles: true }))
      inInputEl.value = '00:00:03.000'
      inInputEl.dispatchEvent(new Event('input', { bubbles: true }))
      report('undo: typed edits land',
        Math.abs(window.vidcut.state.clipStart - 3) < 0.05, window.vidcut.state.clipStart)
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }))
      report('undo: one Ctrl+Z rewinds the whole typing burst',
        Math.abs(window.vidcut.state.clipStart - 6) < 0.05, window.vidcut.state.clipStart)
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true, bubbles: true, cancelable: true }))
      report('undo: Ctrl+Y also redoes',
        Math.abs(window.vidcut.state.clipStart - 3) < 0.05, window.vidcut.state.clipStart)

      // 14e. arrow scrubbing — frame-by-frame AND tactile: every
      //      discrete press steps EXACTLY one frame (30 fps fixture),
      //      holding accelerates through the tier curve, a tap while
      //      playing pauses and STAYS paused (frame inspection), a
      //      held burst resumes on release, and the video end is a wall.
      const kd = (k, opts) => window.dispatchEvent(new KeyboardEvent('keydown',
        Object.assign({ key: k, bubbles: true, cancelable: true }, opts)))
      const ku = k => window.dispatchEvent(new KeyboardEvent('keyup', { key: k, bubbles: true }))
      const hud = document.getElementById('scrub-overlay')
      const FRAME = 1 / 30
      report('scrub hud: hidden before any scrub',
        !hud.classList.contains('on') && getComputedStyle(hud).opacity === '0',
        getComputedStyle(hud).opacity)
      player.pause()
      player.currentTime = 4
      await new Promise(r => setTimeout(r, 150))
      kd('ArrowRight'); ku('ArrowRight')
      report('scrub: a tap steps exactly one frame',
        Math.abs(player.currentTime - (4 + FRAME)) < 0.03, player.currentTime)
      kd('ArrowRight'); ku('ArrowRight')
      report('scrub: subsequent taps keep frame-stepping',
        Math.abs(player.currentTime - (4 + 2 * FRAME)) < 0.04, player.currentTime)
      kd('ArrowLeft'); ku('ArrowLeft')
      report('scrub: a back-tap steps one frame back',
        Math.abs(player.currentTime - (4 + FRAME)) < 0.04, player.currentTime)
      kd('ArrowRight')
      await new Promise(r => setTimeout(r, 700))
      kd('ArrowRight', { repeat: true }); kd('ArrowRight', { repeat: true }); kd('ArrowRight', { repeat: true })
      ku('ArrowRight')
      // initial press = 1 frame, then three 0.5 s repeats (held past 0.5 s)
      report('scrub: holding accelerates to 0.5 s steps',
        Math.abs(player.currentTime - (4 + 2 * FRAME + 1.5)) < 0.2, player.currentTime)
      kd('ArrowLeft', { shiftKey: true }); ku('ArrowLeft')
      report('scrub: Shift+tap is also exactly one frame',
        Math.abs(player.currentTime - (4 + FRAME + 1.5)) < 0.05, player.currentTime)
      const playA = player.play()
      if (playA && playA.catch) playA.catch(() => {})
      await new Promise(r => setTimeout(r, 200))
      kd('ArrowRight'); ku('ArrowRight')
      await new Promise(r => setTimeout(r, 200))
      report('scrub: a tap while playing pauses and stays paused',
        player.paused === true, 'paused=' + player.paused)
      const playB = player.play()
      if (playB && playB.catch) playB.catch(() => {})
      await new Promise(r => setTimeout(r, 200))
      kd('ArrowRight')
      const pausedWhileHeld = player.paused
      kd('ArrowRight', { repeat: true })
      ku('ArrowRight')
      await new Promise(r => setTimeout(r, 150))
      report('scrub: a held burst pauses, then resumes on release',
        pausedWhileHeld === true && player.paused === false,
        'while=' + pausedWhileHeld + ' after=' + player.paused)
      player.pause()
      const dur = player.duration || 10
      player.currentTime = dur - 0.3
      await new Promise(r => setTimeout(r, 150))
      for (let i = 0; i < 12; i++) { kd('ArrowRight'); ku('ArrowRight') }
      report('scrub: clamped at the end of the video',
        player.currentTime <= dur + 0.01 && player.currentTime >= dur - 0.1,
        player.currentTime + ' / ' + dur)

      // 14f. scrub HUD — realtime visual feedback while an arrow is
      //      held or tapped: top-center translucent card with the
      //      timestamp in Cinzel Decorative #15FFFF and a miniature
      //      timeline fill; after release it lingers 3.5 s so the
      //      user can keep tapping frames before it fades away.
      const hudTime = document.getElementById('scrub-time')
      const hudFill = document.getElementById('scrub-fill')
      try { await document.fonts.load('700 26px "Cinzel Decorative"') } catch (e) { /* load() availability */ }
      player.currentTime = 2
      await new Promise(r => setTimeout(r, 150))
      kd('ArrowRight')
      report('scrub hud: fades in while the arrow is held', hud.classList.contains('on'))
      report('scrub hud: timestamp mirrors the frame-stepped target',
        hudTime.textContent === '0:02.0', hudTime.textContent)
      const fillPct = parseFloat(hudFill.style.width)
      report('scrub hud: miniature timeline tracks the position',
        fillPct > 19 && fillPct < 23, hudFill.style.width)
      report('scrub hud: Cinzel Decorative #15FFFF as specified',
        getComputedStyle(hudTime).color === 'rgb(21, 255, 255)' &&
        getComputedStyle(hudTime).fontFamily.includes('Cinzel Decorative') &&
        document.fonts.check('700 26px "Cinzel Decorative"'),
        getComputedStyle(hudTime).color + ' / ' + getComputedStyle(hudTime).fontFamily)
      report('scrub hud: pointer-transparent, above the picture',
        getComputedStyle(hud).pointerEvents === 'none' &&
        getComputedStyle(hud).position === 'absolute',
        getComputedStyle(hud).pointerEvents)
      ku('ArrowRight')
      await new Promise(r => setTimeout(r, 400))
      report('scrub hud: lingers after release (3.5 s window)',
        hud.classList.contains('on') && getComputedStyle(hud).opacity === '1',
        getComputedStyle(hud).opacity)
      await new Promise(r => setTimeout(r, 3300))
      report('scrub hud: fades away after the 3.5 s timeout',
        !hud.classList.contains('on') && getComputedStyle(hud).opacity === '0',
        getComputedStyle(hud).opacity)

      // 14g. number keys: 1 = video start, 0 = video end — ALWAYS,
      //      chaptered or not; the scrub HUD flashes the destination
      //      exactly like the arrows do, and Home/End answer the same.
      player.currentTime = 5
      await new Promise(r => setTimeout(r, 150))
      key('1')
      await new Promise(r => setTimeout(r, 150))
      report('numbers: 1 seeks to the video start', player.currentTime < 0.15, player.currentTime)
      report('numbers: HUD flashes on the digit seek',
        hud.classList.contains('on') && getComputedStyle(hud).opacity === '1')
      key('0')
      await new Promise(r => setTimeout(r, 250))
      const durG = player.duration || 10
      report('numbers: 0 seeks to the video end', player.currentTime >= durG - 0.25,
        player.currentTime + ' / ' + durG)
      report('numbers: HUD timestamp reads the destination',
        document.getElementById('scrub-time').textContent === '0:10.0',
        document.getElementById('scrub-time').textContent)
      key('Home')
      await new Promise(r => setTimeout(r, 150))
      report('numbers: Home seeks to the start with the HUD',
        player.currentTime < 0.15 && hud.classList.contains('on'))
      key('End')
      await new Promise(r => setTimeout(r, 250))
      report('numbers: End seeks to the end with the HUD',
        player.currentTime >= durG - 0.25 && hud.classList.contains('on'))
      // leave the playhead somewhere a frame capture can grab (block 18b)
      key('Home')
      await new Promise(r => setTimeout(r, 150))

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

      // 18b. screenshots are zero-friction: 's' saves straight into
      //      ~/Pictures/screenshots under the idempotent naming —
      //      no dialog in the way, and a second press bumps to " 2".
      key('s')
      const saved1 = await wait(() => window.vidcut.state.lastOutput === ${JSON.stringify(cap1)})
      report('capture: s saves straight into ~/Pictures/screenshots',
        saved1 && fs.existsSync(${JSON.stringify(cap1)}),
        window.vidcut.state.lastOutput)
      key('s')
      const saved2 = await wait(() => window.vidcut.state.lastOutput === ${JSON.stringify(cap2)})
      report('capture: second capture bumps to " 2" (idempotent)',
        saved2 && fs.existsSync(${JSON.stringify(cap2)}) && fs.existsSync(${JSON.stringify(cap1)}),
        window.vidcut.state.lastOutput)
      try { fs.unlinkSync(${JSON.stringify(cap1)}) } catch (e) { /* keep going */ }
      try { fs.unlinkSync(${JSON.stringify(cap2)}) } catch (e) { /* keep going */ }

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
      report('merge: fast-path contract (mode/merged/reencoded)',
        resM && resM.mode === 'copy' && resM.merged === 2 && resM.reencoded === 0
        && Array.isArray(resM.skipped) && resM.skipped.length === 0,
        JSON.stringify(resM))

      // 19b. the normalize path through IPC: mismatched inputs are
      //      unified onto the max canvas, the silent one gets audio
      //      injected, and nothing is left behind in the output dir
      const resN = await electron.ipcRenderer.invoke('job:start', {
        kind: 'merge', inputs: ${JSON.stringify([mergeA, mergeC])}, output: ${JSON.stringify(mergeNormOut)},
      })
      report('merge: normalize path reported',
        resN && resN.ok && resN.mode === 'normalize' && resN.merged === 2 && resN.reencoded >= 1,
        JSON.stringify(resN))
      report('merge: normalized output written', fs.existsSync(${JSON.stringify(mergeNormOut)}))
      const probeN = await electron.ipcRenderer.invoke('media:probe', ${JSON.stringify(mergeNormOut)})
      report('merge: normalized output carries the max canvas',
        !!(probeN && probeN.info && probeN.info.video && probeN.info.video.width === 480
          && probeN.info.video.height === 360 && probeN.info.audio),
        probeN && JSON.stringify(probeN.info && probeN.info.video))
      const residueM = fs.readdirSync(${JSON.stringify(work)}).filter(n => n.includes('.vidcut'))
      report('merge: no working-file residue', residueM.length === 0, residueM.join(','))

      // 19c. the work dir contract: default is beside the output,
      //      set/get/reset round-trip, the merge sheet renders the
      //      dir plus its live free space, a merge runs through the
      //      SETTING (job:start injection) leaving no residue, and
      //      reset restores the default label.
      const wd0 = await electron.ipcRenderer.invoke('workdir:get')
      report('workdir: default is beside the output',
        wd0 && wd0.ok && wd0.dir === null, JSON.stringify(wd0))
      const scratch = ${JSON.stringify(path.join(work, 'scratch'))}
      fs.mkdirSync(scratch, { recursive: true })
      const wd1 = await electron.ipcRenderer.invoke('workdir:set', scratch)
      report('workdir: set accepts a real folder',
        wd1 && wd1.ok && wd1.dir === scratch, JSON.stringify(wd1))
      report('workdir: free space reported for the chosen dir',
        wd1 && Number.isFinite(wd1.free) && wd1.free > 0, String(wd1 && wd1.free))
      const wd2 = await electron.ipcRenderer.invoke('workdir:get')
      report('workdir: get mirrors the persisted dir',
        wd2 && wd2.ok && wd2.dir === scratch, JSON.stringify(wd2))
      window.vidcut.merge.open()
      const wdLabel = document.getElementById('workdir-label')
      await wait(() => wdLabel.textContent.includes(scratch))
      report('workdir: sheet row shows the dir and free space',
        wdLabel.textContent.includes(scratch) && /free/.test(wdLabel.textContent),
        wdLabel.textContent)
      report('workdir: reset button visible while a dir is set',
        document.getElementById('workdir-reset-btn').hidden === false
        && getComputedStyle(document.getElementById('workdir-reset-btn')).display !== 'none',
        'attribute + computed display (the .hud-button display rule otherwise beats the UA [hidden] style)')
      window.vidcut.merge.close()
      const resW = await electron.ipcRenderer.invoke('job:start', {
        kind: 'merge', inputs: ${JSON.stringify([mergeA, mergeC])},
        output: ${JSON.stringify(path.join(work, 'workdir-merged.mp4'))},
      })
      report('workdir: merge runs through the configured work dir',
        resW && resW.ok && resW.mode === 'normalize', JSON.stringify(resW))
      report('workdir: no residue in the work dir after the merge',
        fs.readdirSync(scratch).filter(n => n.startsWith('.vidcut')).length === 0,
        fs.readdirSync(scratch).join(','))
      const wd3 = await electron.ipcRenderer.invoke('workdir:reset')
      report('workdir: reset restores the default',
        wd3 && wd3.ok && wd3.dir === null, JSON.stringify(wd3))
      window.vidcut.merge.open()
      await wait(() => /beside the output/.test(wdLabel.textContent))
      report('workdir: sheet row back to the default label',
        /beside the output/.test(wdLabel.textContent), wdLabel.textContent)
      report('workdir: reset button hidden again',
        document.getElementById('workdir-reset-btn').hidden === true
        && getComputedStyle(document.getElementById('workdir-reset-btn')).display === 'none',
        'attribute + computed display — caught live by the visual review in this revision')
      window.vidcut.merge.close()

      // 19d. cancelled cut through the real IPC: the atomic writer
      //      leaves NOTHING on the chosen name (the part file is
      //      dropped, never renamed).
      const cancelOut = ${JSON.stringify(path.join(work, 'ipc-cancelled.mp4'))}
      const cutJob = electron.ipcRenderer.invoke('job:start', {
        kind: 'cut', input: ${JSON.stringify(long90)}, output: cancelOut,
        start: 0, duration: 90, forceReencode: true,
      })
      await new Promise(r => setTimeout(r, 900)) // mid-encode
      await electron.ipcRenderer.invoke('job:cancel')
      const cutRes = await cutJob
      report('cancel: IPC cut rejects with Cancelled',
        cutRes && cutRes.ok === false && /cancel/i.test(cutRes.error || ''),
        JSON.stringify(cutRes))
      report('cancel: no partial file on the chosen name', !fs.existsSync(cancelOut))
      const cutResidue = fs.readdirSync(${JSON.stringify(work)}).filter(n => n.includes('.vidcut'))
      report('cancel: no working-file residue after the IPC cancel',
        cutResidue.length === 0, cutResidue.join(','))

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
      // Arrow taps in stream mode: each tap advances the playhead one
      //      frame in MEDIA time. The live transcode is chunked — its
      //      seekable range is empty, so every tap is served by re-
      //      opening the stream AT the frame target (the path that
      //      always lands). Re-opens auto-play during the settling
      //      waits, so assert a forward floor plus a runaway ceiling.
      const playS = player.play()
      if (playS && playS.catch) playS.catch(() => {})
      await wait(() => player.buffered.length &&
        player.buffered.end(player.buffered.length - 1) > 1.5)
      player.pause()
      await new Promise(r => setTimeout(r, 200))
      const eff0 = window.vidcut.state.streamStart + player.currentTime
      for (let i = 0; i < 3; i++) {
        kd('ArrowRight'); ku('ArrowRight')
        await new Promise(r => setTimeout(r, 400))
      }
      const eff1 = window.vidcut.state.streamStart + player.currentTime
      report('stream: arrow taps frame-step the playhead',
        window.vidcut.state.ready === true && eff1 >= eff0 + 3 * FRAME - 0.02 && eff1 <= eff0 + 1.5,
        eff0 + ' → ' + eff1)

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

      // 23. keyboard: [ and ] are speed controls now (jump-to-bounds
      //     lives on the chevron buttons — checked via the nav buttons
      //     further up and the flag-drag block)
      document.getElementById('in-input').value = '00:00:02.000'
      document.getElementById('in-input').dispatchEvent(new Event('input', { bubbles: true }))
      document.getElementById('out-input').value = '00:00:08.000'
      document.getElementById('out-input').dispatchEvent(new Event('input', { bubbles: true }))
      const rateBefore = player.playbackRate
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '[' }))
      await new Promise(r => setTimeout(r, 150))
      const slowed = player.playbackRate
      window.dispatchEvent(new KeyboardEvent('keydown', { key: ']' }))
      await new Promise(r => setTimeout(r, 150))
      report('keyboard: [ slows and ] speeds (bounds intact)',
        Math.abs(rateBefore - slowed - 0.1) < 0.01 && Math.abs(player.playbackRate - rateBefore) < 0.01 &&
        Math.abs(window.vidcut.state.clipStart - 2) < 0.01 && Math.abs(window.vidcut.state.clipEnd - 8) < 0.01,
        rateBefore.toFixed(2) + ' → ' + slowed.toFixed(2) + ' → ' + player.playbackRate.toFixed(2))
      // the chevron buttons still jump to the bounds
      document.getElementById('nav-in-btn').click()
      await new Promise(r => setTimeout(r, 150))
      const atStart = player.currentTime
      document.getElementById('nav-out-btn').click()
      await new Promise(r => setTimeout(r, 150))
      report('keyboard: chevron buttons jump to the bounds', Math.abs(atStart - 2) < 0.3 && player.currentTime > 6,
        atStart.toFixed(2) + ' → ' + player.currentTime.toFixed(2))

      // 23b. chapters: a real chaptered mkv — the probe lands 3
      //      chapters in the renderer, in-range ticks appear on the
      //      timeline, and keys 2/3/1 seek to the chapter starts
      //      (key 1 = chapter 1 = the video start; key 0 = the end).
      window.vidcut.loadFile(${JSON.stringify(chaptersMkv)})
      await wait(() => window.vidcut.state.ready)
      await wait(() => window.vidcut.state.chapters.length === 3)
      report('chapters: probe lands 3 chapters in the renderer',
        window.vidcut.state.chapters.length === 3,
        JSON.stringify(window.vidcut.state.chapters))
      const tickCount = document.querySelectorAll('.chapter-tick').length
      report('chapters: timeline shows the 2 in-range ticks (ch1 starts at 0)',
        tickCount === 2, tickCount + ' ticks')
      key('2')
      await new Promise(r => setTimeout(r, 250))
      report('chapters: key 2 seeks to chapter 2 (2 s)',
        Math.abs(player.currentTime - 2) < 0.25, player.currentTime)
      key('3')
      await new Promise(r => setTimeout(r, 250))
      report('chapters: key 3 seeks to chapter 3 (5 s)',
        Math.abs(player.currentTime - 5) < 0.25, player.currentTime)
      key('1')
      await new Promise(r => setTimeout(r, 250))
      report('chapters: key 1 seeks to chapter 1 / the video start',
        player.currentTime < 0.2, player.currentTime)
      key('0')
      await new Promise(r => setTimeout(r, 250))
      report('chapters: key 0 still means the video end',
        player.currentTime >= (player.duration || 10) - 0.25, player.currentTime)
      key('Home')
      await new Promise(r => setTimeout(r, 200))

      // 23c. MUTE (U): the toggle silences the preview, latches the
      //      button, swaps the icon — and end-to-end, a muted cut
      //      writes a file with NO audio track while the unmuted
      //      control from block 15 keeps its audio.
      const muteBtnEl = document.getElementById('mute-btn')
      key('u')
      report('mute: preview element muted', player.muted === true)
      report('mute: button latched (aria-pressed)',
        muteBtnEl.getAttribute('aria-pressed') === 'true')
      report('mute: speaker-off icon swaps in',
        document.getElementById('icon-muted').hidden === false &&
        document.getElementById('icon-sound').hidden === true)
      report('mute: status explains the contract',
        /muted/i.test(document.getElementById('status').textContent),
        document.getElementById('status').textContent)
      key('u')
      report('mute: toggles back off',
        player.muted === false && muteBtnEl.getAttribute('aria-pressed') === 'false')
      const resMute = await electron.ipcRenderer.invoke('job:start', {
        kind: 'cut', input: ${JSON.stringify(sample)}, output: ${JSON.stringify(mutedOut)},
        start: 1, duration: 2, muted: true,
      })
      const cp = require('child_process')
      const ffp = require('path').join(__dirname, 'bin', 'ffmpeg')
      const probeMuted = cp.spawnSync(ffp, ['-hide_banner', '-i', ${JSON.stringify(mutedOut)}], { encoding: 'utf8' })
      const probeNormal = cp.spawnSync(ffp, ['-hide_banner', '-i', ${JSON.stringify(outPath)}], { encoding: 'utf8' })
      report('mute: muted cut writes a silent file (E2E)',
        !!(resMute && resMute.ok) && /Video:/.test(probeMuted.stderr) && !/Audio:/.test(probeMuted.stderr),
        String((resMute && resMute.error) || '') + ' | ' + (probeMuted.stderr.match(/Stream #.*: (Video|Audio):/g) || []).join(' ; '))
      report('mute: unmuted control cut keeps its audio',
        /Audio:/.test(probeNormal.stderr))

      // 23d. keybind completeness — every visible control answers to
      //      a key: Backspace resets the rate, = / − zoom the video,
      //      ? opens the cheat sheet, Help is the sheet, Shift+Home/End
      //      jump to the clip bounds, and every button advertises its key.
      window.vidcut.setRate(1.5)
      key('Backspace')
      report('keys: Backspace resets the rate to 1.0×',
        Math.abs(player.playbackRate - 1) < 0.01, player.playbackRate)
      key('=')
      report('keys: = zooms the video in',
        window.vidcut.state.zoom === 1.25 && player.style.transform === 'translate(0px, 0px) scale(1.25)',
        window.vidcut.state.zoom + ' ' + player.style.transform)
      key('-')
      report('keys: − zooms the video back out',
        window.vidcut.state.zoom === 1 && player.style.transform === '',
        window.vidcut.state.zoom + ' ' + player.style.transform)
      const keysSheet = document.getElementById('shortcuts-sheet')
      key('?')
      report('keys: ? opens the shortcuts sheet', keysSheet.hidden === false)
      report('keys: shortcut grid is populated',
        document.querySelectorAll('#shortcuts-sheet .keys .k').length >= 20,
        document.querySelectorAll('#shortcuts-sheet .keys .k').length + ' rows')
      key('Escape')
      report('keys: Escape closes the shortcuts sheet', keysSheet.hidden === true)
      document.getElementById('help-btn').click()
      report('keys: Help opens the shortcuts sheet in-app', keysSheet.hidden === false)
      key('Escape')
      report('keys: Escape closes it again', keysSheet.hidden === true)
      document.getElementById('in-input').value = '00:00:02.000'
      document.getElementById('in-input').dispatchEvent(new Event('input', { bubbles: true }))
      document.getElementById('out-input').value = '00:00:08.000'
      document.getElementById('out-input').dispatchEvent(new Event('input', { bubbles: true }))
      kd('Home', { shiftKey: true })
      await new Promise(r => setTimeout(r, 250))
      report('keys: Shift+Home jumps to the clip start',
        Math.abs(player.currentTime - 2) < 0.3, player.currentTime)
      kd('End', { shiftKey: true })
      await new Promise(r => setTimeout(r, 250))
      report('keys: Shift+End jumps to the clip end', player.currentTime > 6, player.currentTime)
      report('keys: nav button titles advertise the right keys (stale [(]) hints gone)',
        document.getElementById('nav-in-btn').title.includes('Shift+Home') &&
        document.getElementById('nav-out-btn').title.includes('Shift+End'),
        document.getElementById('nav-in-btn').title + ' / ' + document.getElementById('nav-out-btn').title)
      report('keys: every toolbar button label carries its keybind',
        ['cut-btn', 'capture-btn', 'extract-btn', 'convert-btn', 'merge-btn',
         'record-btn', 'help-btn', 'mute-btn', 'show-btn']
          .every(id => /\\((Enter|S|A|C|M|R|U|F|\\?)\\)/.test(document.getElementById(id).textContent)),
        ['cut-btn', 'capture-btn', 'extract-btn', 'convert-btn', 'merge-btn',
         'record-btn', 'help-btn', 'mute-btn', 'show-btn']
          .map(id => document.getElementById(id).textContent).join(' | '))
      report('keys: Open button title advertises Ctrl+O',
        document.getElementById('open-btn').title.includes('Ctrl+O'),
        document.getElementById('open-btn').title)
      // 'f' reveals the last output — harmless no-op on a missing path,
      // the point is the key maps and the page survives it
      key('f')
      await new Promise(r => setTimeout(r, 100))

      // 23e. modal key gating: while a sheet is open the global tools
      //      stay suspended (nothing can fire behind the mask); Enter
      //      runs the sheet's primary action; Escape closes.
      window.vidcut.merge.clear()
      key('m')
      report('gating: merge sheet opens', document.getElementById('merge-sheet').hidden === false)
      const gateStart = window.vidcut.state.clipStart
      key('i')
      report('gating: mark-in suspended behind the sheet',
        Math.abs(window.vidcut.state.clipStart - gateStart) < 0.01)
      key(' ')
      await new Promise(r => setTimeout(r, 150))
      report('gating: space suspended behind the sheet', player.paused === true, 'paused=' + player.paused)
      key('Enter') // empty merge list → friendly validation, no dialog
      await new Promise(r => setTimeout(r, 150))
      report('gating: Enter runs the sheet primary (validation status)',
        /at least two files/i.test(document.getElementById('status').textContent),
        document.getElementById('status').textContent)
      key('Escape')
      report('gating: Escape closes the sheet', document.getElementById('merge-sheet').hidden === true)

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

      } catch (e) {
        results.push({ name: 'page script threw', cond: false, detail: String((e && e.stack) || e) })
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
