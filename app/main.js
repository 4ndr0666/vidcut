/* vidcut — main process: window lifecycle, native dialogs, tray,
 * recorder supervision and IPC routing.
 *
 * Every OS-level action (dialogs, ffmpeg jobs, screen recording,
 * streaming transcodes, revealing files, help) arrives here; the
 * renderer stays a pure UI. Children never outlive the app: jobs are
 * killed on quit, the recorder gets a SIGINT grace to finalize its
 * container, and the stream server's sockets are destroyed.
 *
 * Paradigm: main-process orchestrator. */

const { app, BrowserWindow, Menu, ipcMain, dialog, shell, Tray, nativeImage } = require('electron')
const path = require('path')
const ffmpeg = require('./ffmpeg')
const recorder = require('./recorder')
const streamer = require('./server')

let mainWindow = null
let tray = null
let quitting = false

const appIcon = path.join(__dirname, 'assets', 'logo.png')
const emptyIcon = nativeImage.createEmpty()
const HELP_URL = 'https://github.com/4ndr0666/vidcut'

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

/* Screen recordings land on the desktop (home as fallback). */
function recordDir() {
  try {
    return app.getPath('desktop')
  } catch (e) {
    return app.getPath('home')
  }
}

/* ---- tray (exists only while a recording is live) ---- */

function removeTray() {
  if (!tray || tray.isDestroyed()) return
  if (tray.timer) clearInterval(tray.timer)
  tray.destroy()
  tray = null
}

function createTray() {
  removeTray()
  try {
    tray = new Tray(appIcon)
  } catch (e) {
    // Tray-less desktops (bare WMs, headless sessions): recording
    // continues without a tray — the window simply stays visible.
    tray = null
    return false
  }
  tray.setToolTip('Recording… click to show vidcut')
  let blink = 0
  tray.timer = setInterval(() => {
    if (!tray || tray.isDestroyed()) return removeTray()
    blink++
    tray.setImage(blink % 2 ? emptyIcon : appIcon)
  }, 500)
  tray.on('click', () => {
    if (!mainWindow) {
      createWindow()
      return
    }
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })
  if (mainWindow) mainWindow.hide()
  return true
}

/* ---- window ---- */

function createWindow() {
  Menu.setApplicationMenu(null)

  mainWindow = new BrowserWindow({
    width: 900,
    height: 600,
    // Hard floor: the toolbar can never be resized out of existence.
    // The full edition stacks four wrapping control rows — 480px of
    // height guarantees the whole stack stays visible at minimum.
    minWidth: 520,
    minHeight: 480,
    useContentSize: true,
    icon: appIcon,
    backgroundColor: '#050A0F',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true, // local-only app — documented choice
      contextIsolation: false,
      sandbox: false,
    },
  })

  mainWindow.loadFile(path.join(__dirname, 'index.html'))
  mainWindow.on('closed', () => { mainWindow = null })
}

/* ---- IPC: the renderer's only door to the OS ---- */

ipcMain.handle('dialog:open', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Open video',
    properties: ['openFile'],
    filters: [
      {
        name: 'Video & Audio',
        extensions: [
          '3gp', 'asf', 'avi', 'dat', 'flv', 'm4v', 'mkv', 'mov', 'mp4',
          'mpeg', 'mpg', 'ogv', 'rm', 'rmvb', 'ts', 'vob', 'webm', 'wmv',
          'aac', 'flac', 'm4a', 'mp3', 'ogg', 'wav',
        ],
      },
      { name: 'All Files', extensions: ['*'] },
    ],
  })
  return canceled ? null : (filePaths[0] || null)
})

ipcMain.handle('dialog:open-multi', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Select videos to merge',
    properties: ['openFile', 'multiSelections'],
    filters: [
      {
        name: 'Video & Audio',
        extensions: [
          '3gp', 'asf', 'avi', 'dat', 'flv', 'm4v', 'mkv', 'mov', 'mp4',
          'mpeg', 'mpg', 'ogv', 'rm', 'rmvb', 'ts', 'vob', 'webm', 'wmv',
        ],
      },
      { name: 'All Files', extensions: ['*'] },
    ],
  })
  return canceled ? [] : (filePaths || [])
})

ipcMain.handle('dialog:save', async (_event, options) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, options || {})
  return canceled ? null : filePath
})

/* One slot, five kinds — ffmpeg enforces the single-flight rule. */
ipcMain.handle('job:start', async (_event, job) => {
  const sendProgress = progress => send('job:progress', progress)
  try {
    const kind = job && job.kind
    if (kind === 'cut') return { ok: true, mode: await ffmpeg.cut(job, sendProgress) }
    if (kind === 'convert') return { ok: true, mode: await ffmpeg.convert(job, sendProgress) }
    if (kind === 'extract') return { ok: true, mode: await ffmpeg.extract(job, sendProgress) }
    if (kind === 'capture') return { ok: true, mode: await ffmpeg.capture(job) }
    if (kind === 'merge') return { ok: true, mode: await ffmpeg.merge(job, sendProgress) }
    return { ok: false, error: 'Unknown job kind' }
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) }
  }
})

ipcMain.handle('job:cancel', () => ffmpeg.cancel())

ipcMain.handle('media:probe', async (_event, source) => {
  const info = await ffmpeg.probe(typeof source === 'string' ? source : '')
  return { ok: !!info, info: info || null }
})

ipcMain.handle('recorder:start', async () => {
  try {
    const { output } = await recorder.start(recordDir())
    // Defer the "started" confirmation slightly: an instant spawn
    // failure (wf-recorder missing) fires 'failed' within a few
    // milliseconds, and a stale "started" must never arrive after
    // it — the tray and the live UI only appear once the recorder is
    // still alive past that window.
    setTimeout(() => {
      if (recorder.isActive()) {
        createTray()
        send('recorder:started', { output })
      }
    }, 150)
    return { ok: true, output }
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) }
  }
})

ipcMain.handle('recorder:stop', () => recorder.stop())

ipcMain.handle('recorder:status', () => recorder.status())

ipcMain.handle('stream:open', async (_event, request) => {
  try {
    const source = request && request.source
    const start = Number(request && request.start) || 0
    return { ok: true, ...(await streamer.open(source, start)) }
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) }
  }
})

ipcMain.handle('stream:shutdown', () => streamer.shutdown())

/* The URL is fixed here on purpose: the renderer cannot aim
 * openExternal at arbitrary targets. */
ipcMain.handle('help:open', () => shell.openExternal(HELP_URL))

ipcMain.handle('shell:show', (_event, target) => shell.showItemInFolder(String(target)))

/* ---- recorder events → renderer (tray + window stay main-side) ---- */

recorder.on('stopped', payload => {
  removeTray()
  if (mainWindow && !mainWindow.isVisible()) mainWindow.show()
  send('recorder:stopped', payload)
})

recorder.on('failed', message => {
  removeTray()
  if (mainWindow && !mainWindow.isVisible()) mainWindow.show()
  send('recorder:failed', message)
})

/* ---- lifecycle ---- */

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(createWindow)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  app.on('window-all-closed', () => {
    // A live recording keeps the app alive in the tray.
    if (recorder.isActive()) return
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', event => {
    if (quitting) return
    quitting = true
    event.preventDefault()

    ffmpeg.killAll()
    streamer.shutdown()

    if (recorder.isActive()) {
      // SIGINT now; give wf-recorder a moment to finalize the mp4
      // container, then quit for real.
      recorder.destroy()
      setTimeout(() => app.quit(), 1500)
    } else {
      app.quit()
    }
  })
}
