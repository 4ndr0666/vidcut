/* Visual + font verification: boots the app, loads media, marks a
 * clip, captures screenshots at three window sizes (fullscreen-like,
 * restored, minimum) and verifies the webfonts actually loaded under
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

    const win = BrowserWindow.getAllWindows()[0]
    if (win.webContents.isLoading()) {
      await new Promise(r => win.webContents.once('did-finish-load', r))
    }
    await new Promise(r => setTimeout(r, 500))

    await win.webContents.executeJavaScript(`(async () => {
      window.vidcut.loadFile(${JSON.stringify(sample)})
      for (let i = 0; i < 100 && !window.vidcut.state.ready; i++) {
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
        loaded: [...document.fonts].filter(f => f.status === 'loaded').map(f => f.family),
      }
    })()`)
    console.log('fonts:', JSON.stringify(fonts))

    // Fullscreen-like state (the user's first screenshot).
    win.setContentSize(1920, 1000)
    await new Promise(r => setTimeout(r, 400))
    fs.writeFileSync(path.join(OUT, 'vidcut-2.2.0-1920x1000.png'),
      (await win.webContents.capturePage()).toPNG())

    // Restored state (the user's second screenshot).
    win.setContentSize(900, 600)
    await new Promise(r => setTimeout(r, 400))
    fs.writeFileSync(path.join(OUT, 'vidcut-2.2.0-900x600.png'),
      (await win.webContents.capturePage()).toPNG())

    // The merge sheet, explicitly opened — the "default expanded"
    // bug this edition must never regress.
    await win.webContents.executeJavaScript(`(async () => {
      window.vidcut.merge.addFiles([${JSON.stringify(sample)}, ${JSON.stringify(sample)}])
      window.vidcut.merge.open()
      await new Promise(r => setTimeout(r, 300))
    })()`)
    fs.writeFileSync(path.join(OUT, 'vidcut-2.1.0-merge-sheet.png'),
      (await win.webContents.capturePage()).toPNG())
    await win.webContents.executeJavaScript('window.vidcut.merge.close()')

    // The record sheet, explicitly opened.
    await win.webContents.executeJavaScript(`(async () => {
      window.vidcut.record.open()
      await new Promise(r => setTimeout(r, 300))
    })()`)
    fs.writeFileSync(path.join(OUT, 'vidcut-2.1.0-record-sheet.png'),
      (await win.webContents.capturePage()).toPNG())
    await win.webContents.executeJavaScript('window.vidcut.record.close()')

    win.setContentSize(520, 480)
    await new Promise(r => setTimeout(r, 400))
    fs.writeFileSync(path.join(OUT, 'vidcut-2.2.0-520x480.png'),
      (await win.webContents.capturePage()).toPNG())

    console.log('screenshots written to ' + OUT)
  } catch (error) {
    console.error('harness error:', error)
    process.exitCode = 1
  } finally {
    app.exit(0)
  }
})
