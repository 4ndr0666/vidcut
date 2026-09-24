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
const fs = require('fs')
const path = require('path')
const ffmpeg = require('./ffmpeg')
const recorder = require('./recorder')
const streamer = require('./server')
const { nextFreePath } = require('./naming')

let mainWindow = null
let tray = null
let quitting = false

/* ---- persisted settings (last save folder + work dir) ----
 *
 * "Save dir should be the last dir a file was saved in": every
 * confirmed save rewrites the default directory for the next one,
 * surviving restarts via userData/settings.json. Failures are
 * swallowed — a settings problem must never block a save.
 *
 * workDir is where merge PREPROCESSING writes its intermediates
 * (normalize parts). Default null = a hidden folder beside the
 * merged output (same-filesystem atomic rename); a chosen dir is
 * for the "output disk is small, the big scratch lives elsewhere"
 * case — the disk preflight reports its free space, and the merge
 * engine keeps the final publish beside the output regardless. */

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json')
const settings = { lastSaveDir: null, workDir: null }

function loadSettings() {
  try {
    const raw = fs.readFileSync(settingsFile(), 'utf8')
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed.lastSaveDir === 'string') {
        settings.lastSaveDir = parsed.lastSaveDir
      }
      if (parsed && typeof parsed.workDir === 'string' && parsed.workDir) {
        settings.workDir = parsed.workDir
      }
    }
  } catch (e) { /* first run or unreadable — defaults stand */ }
}

function persistSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true })
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2))
  } catch (e) { /* non-fatal by design */ }
}

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
  const opts = { ...(options || {}) }
  // The last confirmed save folder wins over the suggested one —
  // the renderer keeps suggesting names, main owns where they land.
  if (settings.lastSaveDir && typeof opts.defaultPath === 'string' && opts.defaultPath) {
    opts.defaultPath = path.join(settings.lastSaveDir, path.basename(opts.defaultPath))
  }
  // Idempotent + ascending: the offered default never collides with
  // an existing file (clip 2, clip 3 …), so no overwrite prompt for
  // a name the user did not pick themselves.
  if (typeof opts.defaultPath === 'string' && opts.defaultPath) {
    opts.defaultPath = nextFreePath(opts.defaultPath)
  }
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, opts)
  if (!canceled && filePath) {
    settings.lastSaveDir = path.dirname(filePath)
    persistSettings()
  }
  return canceled ? null : filePath
})

/* Screenshots (Capture / S) are zero-friction by design: no save
 * dialog, no directory to pick every time — they land straight in
 * ~/Pictures/screenshots under the app-wide idempotent naming
 * ("name [capture].jpg", then " 2", " 3"… on collision). The folder
 * is created on demand; a failure here surfaces as an error status,
 * never a crash. */
function screenshotsDir() {
  try {
    return path.join(app.getPath('pictures'), 'screenshots')
  } catch (e) {
    return path.join(app.getPath('home'), 'Pictures', 'screenshots')
  }
}

ipcMain.handle('capture:save', async (_event, payload) => {
  try {
    // Accept a plain path or a { source } envelope — defensive both ways.
    const source = typeof payload === 'string' ? payload : (payload && payload.source)
    const dir = screenshotsDir()
    fs.mkdirSync(dir, { recursive: true })
    const extname = typeof source === 'string' ? path.extname(source) : ''
    const base = (typeof source === 'string' && path.basename(source, extname)) || 'capture'
    const output = nextFreePath(path.join(dir, `${base} [capture].jpg`))
    return { ok: true, output }
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) }
  }
})

/* Free space of a directory in bytes, or null when statfs is
 * unavailable (very old runtimes) — the UI then shows the path
 * without a figure instead of a wrong one. */
function freeSpace(dir) {
  if (typeof fs.statfsSync !== 'function') return null
  try {
    const st = fs.statfsSync(dir)
    const free = Number(st.bsize) * Number(st.bavail)
    return Number.isFinite(free) && free > 0 ? free : null
  } catch (e) {
    return null
  }
}

/* ---- work dir (merge preprocessing scratch) ----
 *
 * Contract shared by set/pick/get/reset:
 *   { ok, dir, free }   dir = string | null, free = bytes | null
 * The renderer displays it in the merge sheet; the merge engine
 * receives it via job.workDir at job:start (below) so the UI can
 * never drift from what the engine actually uses. */
function workdirStatus() {
  const dir = settings.workDir
  return { ok: true, dir: dir || null, free: dir ? freeSpace(dir) : null }
}

function setWorkDir(dir) {
  try {
    const st = fs.statSync(dir)
    if (!st.isDirectory()) return { ok: false, error: 'Not a folder' }
  } catch (e) {
    return { ok: false, error: 'Folder not found' }
  }
  settings.workDir = dir
  persistSettings()
  return workdirStatus()
}

ipcMain.handle('workdir:get', () => workdirStatus())

/* Explicit set (tests / future callers) — validates and persists. */
ipcMain.handle('workdir:set', (_event, payload) => {
  const dir = typeof payload === 'string' ? payload : (payload && payload.dir)
  if (typeof dir !== 'string' || !dir) return { ok: false, error: 'Missing folder' }
  return setWorkDir(dir)
})

/* The interactive path: native directory picker, then the same
 * setter. A dismissed dialog is a no-op (canceled: true). */
ipcMain.handle('workdir:pick', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose the preprocessing work dir',
    properties: ['openDirectory', 'createDirectory'],
  })
  if (canceled || !filePaths || !filePaths.length) {
    return { ...workdirStatus(), canceled: true }
  }
  return setWorkDir(filePaths[0])
})

ipcMain.handle('workdir:reset', () => {
  settings.workDir = null
  persistSettings()
  return workdirStatus()
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
    // merge resolves to a result object: which path ran, how many
    // files made it, how many were re-encoded, what was skipped.
    // The persisted work dir is injected here — one source of truth
    // for the engine; an explicit job.workDir (tests) wins.
    if (kind === 'merge') {
      if (!(typeof job.workDir === 'string' && job.workDir) && settings.workDir) {
        job.workDir = settings.workDir
      }
      const merged = await ffmpeg.merge(job, sendProgress)
      return {
        ok: true,
        mode: merged.mode,
        merged: merged.merged,
        reencoded: merged.reencoded,
        skipped: merged.skipped || [],
      }
    }
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

  app.whenReady().then(() => {
    loadSettings()
    createWindow()
  })

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
