/* Visual + font verification: boots the app, loads a CHAPTERED media
 * file, marks a clip, captures screenshots at three window sizes
 * (fullscreen-like, restored, minimum), captures the arrow-scrub HUD
 * mid-scrub, the latched MUTE state, a zoomed+panned picture, the
 * shortcuts sheet, and verifies the webfonts actually loaded under
 * the CSP. */
const { app, BrowserWindow } = require('electron')
const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const FFMPEG = path.join(ROOT, 'app', 'bin', 'ffmpeg')
// Screenshots land wherever you point argv[2] (defaults to the repo root).
const OUT = process.argv[2] || ROOT
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vidcut-shot-'))

require(path.join(ROOT, 'app', 'main.js'))

app.whenReady().then(async () => {
  try {
    fs.mkdirSync(OUT, { recursive: true })
    const sample = path.join(work, 'sample.mp4')
    execFileSync(FFMPEG, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=duration=10:size=640x360:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '30',
      '-c:a', 'aac', '-shortest', sample,
    ])
    // Chaptered variant: chapters at 0 / 2 / 5 s — the timeline ticks
    // and the number keys have something real to show.
    const chaptersMeta = path.join(work, 'chapters.txt')
    fs.writeFileSync(chaptersMeta, [
      ';FFMETADATA1',
      '[CHAPTER]', 'TIMEBASE=1/1000', 'START=0', 'END=2000', 'title=Alpha',
      '[CHAPTER]', 'TIMEBASE=1/1000', 'START=2000', 'END=5000', 'title=Bravo',
      '[CHAPTER]', 'TIMEBASE=1/1000', 'START=5000', 'END=10000', 'title=Charlie',
    ].join('\n') + '\n')
    const chaptered = path.join(work, 'sample-chapters.mkv')
    execFileSync(FFMPEG, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', sample, '-i', chaptersMeta,
      '-map', '0', '-map_metadata', '1', '-c', 'copy', chaptered,
    ])

    const win = BrowserWindow.getAllWindows()[0]
    if (win.webContents.isLoading()) {
      await new Promise(r => win.webContents.once('did-finish-load', r))
    }
    await new Promise(r => setTimeout(r, 500))

    await win.webContents.executeJavaScript(`(async () => {
      window.vidcut.loadFile(${JSON.stringify(chaptered)})
      for (let i = 0; i < 100 && !window.vidcut.state.ready; i++) {
        await new Promise(r => setTimeout(r, 50))
      }
      // let the chapter probe land so the ticks render
      for (let i = 0; i < 100 && window.vidcut.state.chapters.length !== 3; i++) {
        await new Promise(r => setTimeout(r, 50))
      }
      const player = document.getElementById('player')
      player.currentTime = 2
      window.vidcut.markStart()
      player.currentTime = 8
      window.vidcut.markEnd()
      player.currentTime = 5
      await new Promise(r => setTimeout(r, 300))
    })()`)

    const fonts = await win.webContents.executeJavaScript(`(async () => {
      await document.fonts.ready
      return {
        orbitron: document.fonts.check('700 15px Orbitron'),
        roboto: document.fonts.check('500 14px "Roboto Mono"'),
        cinzel: document.fonts.check('700 26px "Cinzel Decorative"'),
        loaded: [...document.fonts].filter(f => f.status === 'loaded').map(f => f.family),
      }
    })()`)
    console.log('fonts:', JSON.stringify(fonts))

    // Fullscreen-like state (chapter ticks + marked clip visible).
    win.setContentSize(1920, 1000)
    await new Promise(r => setTimeout(r, 400))
    fs.writeFileSync(path.join(OUT, 'vidcut-2.7.0-1920x1000.png'),
      (await win.webContents.capturePage()).toPNG())

    // The MUTE toggle latched ON — cyan state, speaker-off icon.
    await win.webContents.executeJavaScript(`(async () => {
      window.vidcut.toggleMute()
      await new Promise(r => setTimeout(r, 250))
    })()`)
    fs.writeFileSync(path.join(OUT, 'vidcut-2.7.0-mute-on.png'),
      (await win.webContents.capturePage()).toPNG())
    await win.webContents.executeJavaScript('window.vidcut.toggleMute()')
    await new Promise(r => setTimeout(r, 250))

    // Restored state (the user's second screenshot).
    win.setContentSize(900, 600)
    await new Promise(r => setTimeout(r, 400))
    fs.writeFileSync(path.join(OUT, 'vidcut-2.7.0-900x600.png'),
      (await win.webContents.capturePage()).toPNG())

    // The arrow-scrub HUD, captured mid-scrub at the restored size —
    // keydown held, fade completed, timestamp + mini timeline live.
    await win.webContents.executeJavaScript(`(async () => {
      const player = document.getElementById('player')
      player.currentTime = 4.2
      await new Promise(r => setTimeout(r, 150))
      window.dispatchEvent(new KeyboardEvent('keydown',
        { key: 'ArrowRight', bubbles: true, cancelable: true }))
      await new Promise(r => setTimeout(r, 350))
    })()`)
    fs.writeFileSync(path.join(OUT, 'vidcut-2.7.0-scrub-hud.png'),
      (await win.webContents.capturePage()).toPNG())
    await win.webContents.executeJavaScript(
      `window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }))`)
    await new Promise(r => setTimeout(r, 300))

    // Zoomed AND panned — four wheel notches (2.44×) with a Ctrl+drag
    // offset applied, then Ctrl+0 resets both before the next shot.
    await win.webContents.executeJavaScript(`(async () => {
      const stage = document.getElementById('stage')
      const rect = stage.getBoundingClientRect()
      for (let i = 0; i < 4; i++) {
        stage.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, cancelable: true }))
      }
      const pan = (type, x, y) => new PointerEvent(type, {
        clientX: x, clientY: y, button: 0, ctrlKey: true,
        bubbles: true, cancelable: true, pointerId: 21,
      })
      stage.dispatchEvent(pan('pointerdown', rect.left + 200, rect.top + 100))
      stage.dispatchEvent(pan('pointermove', rect.left + 320, rect.top + 160))
      stage.dispatchEvent(pan('pointerup', rect.left + 320, rect.top + 160))
      await new Promise(r => setTimeout(r, 250))
    })()`)
    fs.writeFileSync(path.join(OUT, 'vidcut-2.7.0-zoom-pan.png'),
      (await win.webContents.capturePage()).toPNG())
    await win.webContents.executeJavaScript(
      `window.dispatchEvent(new KeyboardEvent('keydown', { key: '0', ctrlKey: true, bubbles: true, cancelable: true }))`)
    await new Promise(r => setTimeout(r, 250))

    // The shortcuts sheet (? / Help) — the in-app keybind cheat sheet.
    await win.webContents.executeJavaScript(`(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true, cancelable: true }))
      await new Promise(r => setTimeout(r, 300))
    })()`)
    fs.writeFileSync(path.join(OUT, 'vidcut-2.7.0-shortcuts-sheet.png'),
      (await win.webContents.capturePage()).toPNG())
    await win.webContents.executeJavaScript(
      `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`)
    await new Promise(r => setTimeout(r, 250))

    // The merge sheet, explicitly opened — the "default expanded"
    // bug this edition must never regress.
    await win.webContents.executeJavaScript(`(async () => {
      window.vidcut.merge.addFiles([${JSON.stringify(sample)}, ${JSON.stringify(sample)}])
      window.vidcut.merge.open()
      await new Promise(r => setTimeout(r, 300))
    })()`)
    fs.writeFileSync(path.join(OUT, 'vidcut-2.7.0-merge-sheet.png'),
      (await win.webContents.capturePage()).toPNG())

    // The same sheet with a CONFIGURED work dir — the label shows the
    // chosen dir plus its live free space, Reset becomes visible.
    await win.webContents.executeJavaScript(`(async () => {
      const electron = require('electron')
      await electron.ipcRenderer.invoke('workdir:set', ${JSON.stringify(work)})
      await window.vidcut.merge.renderWorkDir()
      await new Promise(r => setTimeout(r, 300))
    })()`)
    fs.writeFileSync(path.join(OUT, 'vidcut-2.7.0-merge-workdir.png'),
      (await win.webContents.capturePage()).toPNG())
    await win.webContents.executeJavaScript(`(async () => {
      const electron = require('electron')
      await electron.ipcRenderer.invoke('workdir:reset')
    })()`)
    await win.webContents.executeJavaScript('window.vidcut.merge.close()')

    // The record sheet, explicitly opened.
    await win.webContents.executeJavaScript(`(async () => {
      window.vidcut.record.open()
      await new Promise(r => setTimeout(r, 300))
    })()`)
    fs.writeFileSync(path.join(OUT, 'vidcut-2.7.0-record-sheet.png'),
      (await win.webContents.capturePage()).toPNG())
    await win.webContents.executeJavaScript('window.vidcut.record.close()')

    win.setContentSize(520, 480)
    await new Promise(r => setTimeout(r, 400))
    fs.writeFileSync(path.join(OUT, 'vidcut-2.7.0-520x480.png'),
      (await win.webContents.capturePage()).toPNG())

    console.log('screenshots written to ' + OUT)
  } catch (error) {
    console.error('harness error:', error)
    process.exitCode = 1
  } finally {
    app.exit(0)
  }
})
