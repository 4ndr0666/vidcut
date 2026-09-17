/* vidcut renderer — the entire UI.
 *
 * IPC contract with the main process:
 *   invoke 'dialog:open'            → string | null
 *   invoke 'dialog:open-multi'      → string[]
 *   invoke 'dialog:save'  (opts)    → string | null
 *   invoke 'job:start'    (job)     → { ok, mode?, error? }   kind: cut|convert|extract|capture|merge
 *   invoke 'job:cancel'             → boolean
 *   on     'job:progress' (0..1)
 *   invoke 'media:probe'  (path)    → { ok, info? }
 *   invoke 'stream:open' {source,start} → { ok, url?, duration? }
 *   invoke 'stream:shutdown'       → void
 *   invoke 'recorder:start|stop|status' → recorder events below
 *   on     'recorder:started|stopped|failed'
 *   invoke 'help:open'             → void
 *   invoke 'shell:show'  (path)    → void
 *
 * Two playback modes: native (file:// the element can decode) and
 * stream (a live transcode served by main for everything else — one
 * fallback attempt per source; seeks re-open the stream at the
 * target). Untrusted strings (file names, error text) are only ever
 * written through textContent — the page runs in a privileged context. */

const { ipcRenderer, webUtils } = require('electron')
const { pathToFileURL } = require('url')
const path = require('path')
const Wave = require('./wave')
const createMergeSheet = require('./merge')
const createRecordSheet = require('./record')

/* ---- elements ---- */

const $ = id => document.getElementById(id)
const els = {
  stage: $('stage'),
  player: $('player'),
  wave: $('wave'),
  dropzone: $('dropzone'),
  openBtn: $('open-btn'),
  fileChip: $('file-chip'),
  playBtn: $('play-btn'),
  iconPlay: $('icon-play'),
  iconPause: $('icon-pause'),
  speedDownBtn: $('speed-down-btn'),
  speedUpBtn: $('speed-up-btn'),
  speedChip: $('speed-chip'),
  timeCur: $('time-cur'),
  timeTotal: $('time-total'),
  timeline: $('timeline'),
  region: $('tl-region'),
  played: $('tl-progress'),
  flagIn: $('flag-in'),
  flagOut: $('flag-out'),
  navStartBtn: $('nav-start-btn'),
  navInBtn: $('nav-in-btn'),
  navOutBtn: $('nav-out-btn'),
  navEndBtn: $('nav-end-btn'),
  inInput: $('in-input'),
  outInput: $('out-input'),
  setInBtn: $('set-in-btn'),
  setOutBtn: $('set-out-btn'),
  selInfo: $('sel-info'),
  cutBtn: $('cut-btn'),
  cancelBtn: $('cancel-btn'),
  captureBtn: $('capture-btn'),
  extractBtn: $('extract-btn'),
  convertBtn: $('convert-btn'),
  mergeBtn: $('merge-btn'),
  recordBtn: $('record-btn'),
  helpBtn: $('help-btn'),
  status: $('status'),
  progressWrap: $('progress'),
  progressFill: $('progress-fill'),
  showBtn: $('show-btn'),
  mergeSheet: $('merge-sheet'),
  recordSheet: $('record-sheet'),
}

/* ---- state ---- */

const state = {
  source: null,      // absolute path of the loaded media
  ready: false,      // metadata loaded and playable
  clipStart: 0,      // seconds
  clipEnd: 0,        // seconds
  busy: false,       // an ffmpeg job is running
  busyLabel: '',     // verb shown on the primary button while busy
  lastOutput: null,
  streamMode: false, // playing the live-transcode fallback
  streamStart: 0,    // where the current stream begins
  streamDuration: null, // probed duration (element may report Infinity)
  streamTried: false,   // one fallback attempt per source
  audioOnly: false,  // waveform visualizer active
  boundsFresh: false, // clip bounds not yet initialized for this source
}

const MIN_CLIP = 0.05 // seconds — the smallest cut worth writing

const MEDIA_RE = /\.(3gp|asf|avi|dat|flv|m4v|mkv|mov|mp4|mpeg|mpg|ogv|rm|rmvb|ts|vob|webm|wmv|aac|flac|m4a|mp3|ogg|wav)$/i

/* ---- helpers ---- */

function fmt(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = (seconds % 60).toFixed(1).padStart(4, '0')
  const mm = h ? String(m).padStart(2, '0') : String(m)
  return h ? `${h}:${mm}:${s}` : `${mm}:${s}`
}

/* Canonical timecode for the segment inputs: HH:MM:SS.mmm */
function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0
  let ms = Math.round(seconds * 1000)
  const h = Math.floor(ms / 3600000); ms %= 3600000
  const m = Math.floor(ms / 60000); ms %= 60000
  const s = Math.floor(ms / 1000); ms %= 1000
  const pad = (value, width = 2) => String(value).padStart(width, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`
}

/* Lenient parser — the colon COUNT decides the unit, so "2:05" is
 * two minutes, never two hours: SS(.mmm) | MM:SS(.mmm) | H:MM:SS(.mmm) */
function parseTime(text) {
  const t = String(text).trim()
  let m = /^(\d+):([0-5]?\d):([0-5]?\d(?:[.,]\d{1,3})?)$/.exec(t)
  if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3].replace(',', '.'))
  m = /^(\d{1,4}):([0-5]?\d(?:[.,]\d{1,3})?)$/.exec(t)
  if (m) return Number(m[1]) * 60 + Number(m[2].replace(',', '.'))
  m = /^([0-5]?\d(?:[.,]\d{1,3})?)$/.exec(t)
  if (m) return Number(m[1].replace(',', '.'))
  return null
}

function setStatus(text, kind) {
  els.status.textContent = text
  els.status.className = kind || ''
}

function clipValid() {
  return state.ready && state.clipEnd - state.clipStart >= MIN_CLIP
}

function syncEnabled() {
  const media = state.ready && !state.busy
  const clip = clipValid() && !state.busy
  els.playBtn.disabled = !media
  els.setInBtn.disabled = !media
  els.setOutBtn.disabled = !media
  els.cutBtn.disabled = !clip
  els.captureBtn.disabled = !media
  els.extractBtn.disabled = !clip
  els.convertBtn.disabled = !clip
  els.speedDownBtn.disabled = !media
  els.speedUpBtn.disabled = !media
  els.navStartBtn.disabled = !media
  els.navInBtn.disabled = !media
  els.navOutBtn.disabled = !media
  els.navEndBtn.disabled = !media
  els.inInput.disabled = !media
  els.outInput.disabled = !media
  els.fileChip.hidden = !state.source
  els.showBtn.hidden = !(state.lastOutput && !state.busy)
}

/* Stream-mode arithmetic: the element plays from streamStart on, so
 * the real position is streamStart + currentTime. For the total, the
 * PROBED duration is authoritative — a fragmented stream's
 * element.duration only reflects what has arrived so far and grows
 * in real time, so it is used solely as the probe-less fallback. */
function effDuration() {
  if (!state.streamMode) return Number.isFinite(els.player.duration) ? els.player.duration : 0
  if (Number.isFinite(state.streamDuration) && state.streamDuration > 0) return state.streamDuration
  const d = els.player.duration
  if (Number.isFinite(d) && d > 0) return state.streamStart + d
  return 0
}

function effTime() {
  if (!state.streamMode) return els.player.currentTime || 0
  return state.streamStart + (els.player.currentTime || 0)
}

function render() {
  const duration = effDuration()
  const current = effTime()

  els.timeCur.textContent = fmt(current)
  els.timeTotal.textContent = fmt(duration)

  if (duration > 0) {
    els.played.style.width = (Math.min(1, current / duration) * 100).toFixed(2) + '%'
    const a = Math.min(1, Math.max(0, state.clipStart / duration))
    const b = Math.min(1, Math.max(0, state.clipEnd / duration))
    els.region.style.left = (a * 100).toFixed(2) + '%'
    els.region.style.width = ((b - a) * 100).toFixed(2) + '%'
    els.flagIn.style.left = `calc(${(a * 100).toFixed(3)}% - 1px)`
    els.flagOut.style.left = `calc(${(b * 100).toFixed(3)}% - 2px)`
  } else {
    els.played.style.width = '0%'
  }
  els.flagIn.hidden = els.flagOut.hidden = !state.ready

  // Segment inputs mirror the state — unless the user is typing.
  if (document.activeElement !== els.inInput) els.inInput.value = formatTime(state.clipStart)
  if (document.activeElement !== els.outInput) els.outInput.value = formatTime(state.clipEnd)

  if (state.ready) {
    if (clipValid()) {
      els.selInfo.textContent = `${fmt(state.clipStart)} → ${fmt(state.clipEnd)} · ${fmt(state.clipEnd - state.clipStart)} clip`
      els.selInfo.classList.remove('invalid')
      els.flagIn.title = `Clip start ${fmt(state.clipStart)}`
      els.flagOut.title = `Clip end ${fmt(state.clipEnd)}`
    } else {
      els.selInfo.textContent = 'end must come after start'
      els.selInfo.classList.add('invalid')
    }
  }
}

/* ---- loading media ---- */

function loadFile(filePath) {
  if (!filePath) return
  if (state.busy) {
    setStatus('Finish or cancel the current job first.', 'err')
    return
  }
  if (!MEDIA_RE.test(filePath)) {
    setStatus(`Not a media file: ${path.basename(filePath)}`, 'err')
    return
  }

  // A new source invalidates the previous stream.
  if (state.streamMode) ipcRenderer.invoke('stream:shutdown')
  state.streamMode = false
  state.streamTried = false
  state.streamStart = 0
  state.streamDuration = null

  state.source = filePath
  state.ready = false
  state.boundsFresh = false
  state.clipStart = 0
  state.clipEnd = 0
  state.lastOutput = null

  closeSheets()
  setRate(1)
  updateAudioOnly(false)
  document.title = 'vidcut'
  els.fileChip.textContent = path.basename(filePath)
  setStatus(`Loading ${path.basename(filePath)}…`)
  els.player.src = pathToFileURL(filePath).href
  syncEnabled()
  render()
}

els.player.addEventListener('loadedmetadata', () => {
  const duration = effDuration()
  if (!Number.isFinite(duration) || duration <= 0) {
    state.ready = false
    els.dropzone.hidden = false
    setStatus('This file reports no usable duration — try another source.', 'err')
    syncEnabled()
    render()
    return
  }
  state.ready = true
  // Only a genuinely new source resets the marks — a seek-driven
  // stream re-open must never clobber the user's clip bounds.
  if (!state.boundsFresh) {
    state.boundsFresh = true
    state.clipStart = 0
    state.clipEnd = duration
  }
  els.dropzone.hidden = true
  setStatus(
    state.streamMode
      ? `Ready (live transcode) · ${fmt(duration)} total — mark start/end, then Cut.`
      : `Ready · ${fmt(duration)} total — mark start/end, then Cut.`,
  )
  syncEnabled()
  render()
  updateAudioOnly()
  probeTitle()
})

els.player.addEventListener('error', () => {
  if (!state.source) return
  if (!state.streamMode && !state.streamTried) {
    // The element cannot decode this source — hand it to the live
    // transcoder in main (one attempt per source; loop-proof).
    state.streamTried = true
    setStatus('Format not playable directly — starting live transcode…')
    openStream(0)
    return
  }
  state.ready = false
  els.dropzone.hidden = false
  setStatus('Could not play this file (unsupported codec or corrupted).', 'err')
  syncEnabled()
  render()
})

els.player.addEventListener('loadeddata', () => updateAudioOnly())

/* ---- stream fallback (sources the element cannot decode) ---- */

async function openStream(start) {
  if (!state.source) return
  const result = await ipcRenderer.invoke('stream:open', { source: state.source, start })
  if (!result || !result.ok) {
    state.streamTried = true
    state.ready = false
    els.dropzone.hidden = false
    setStatus('Could not play this file (live transcode failed — unsupported codec or corrupted).', 'err')
    syncEnabled()
    render()
    return
  }
  state.streamMode = true
  state.streamTried = true
  state.streamStart = Math.max(0, start)
  state.streamDuration = result.duration
  els.player.src = result.url
  els.player.load()
  const attempt = els.player.play()
  if (attempt && typeof attempt.catch === 'function') attempt.catch(() => {})
}

/* Dual-mode seek: nudges inside the already-buffered part of a
 * stream are served natively; anything outside re-opens the stream
 * at the target (a new request — the old encode dies with it). */
function seekTo(seconds) {
  if (!state.ready) return
  const duration = effDuration() || 0
  let target = Math.max(0, seconds)
  if (duration > 0) target = Math.min(target, duration)

  if (state.streamMode) {
    const local = target - state.streamStart
    const buffered = els.player.buffered
    let end = -1
    for (let i = 0; i < buffered.length; i++) end = Math.max(end, buffered.end(i))
    if (local >= 0 && end > 0 && local <= end - 0.2) {
      els.player.currentTime = local
      return
    }
    openStream(target)
    return
  }
  els.player.currentTime = target
}

/* ---- drag & drop (window-wide) ---- */

let dragDepth = 0

window.addEventListener('dragover', e => e.preventDefault())
window.addEventListener('dragenter', e => {
  e.preventDefault()
  dragDepth++
  document.body.classList.add('dragging')
})
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0
    document.body.classList.remove('dragging')
  }
})
window.addEventListener('drop', e => {
  e.preventDefault()
  dragDepth = 0
  document.body.classList.remove('dragging')
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]
  if (!file) return
  const filePath = pathFromFile(file)
  if (!filePath) {
    setStatus('Drop failed — could not read the file path. Use “Open video…” instead.', 'err')
    return
  }
  loadFile(filePath)
})

/* Electron 32 removed File.path; webUtils is the supported bridge.
 * Legacy File.path is kept as a fallback, and a failed resolution is
 * reported instead of failing silently. */
function pathFromFile(file) {
  try {
    const viaUtils = webUtils && webUtils.getPathForFile(file)
    if (typeof viaUtils === 'string' && viaUtils) return viaUtils
  } catch (e) { /* fall through to the legacy attribute */ }
  if (typeof file.path === 'string' && file.path) return file.path
  return null
}

/* ---- opening via dialog ---- */

els.openBtn.addEventListener('click', openDialog)
els.dropzone.addEventListener('click', openDialog)

async function openDialog() {
  if (state.busy) return
  const filePath = await ipcRenderer.invoke('dialog:open')
  if (filePath) loadFile(filePath)
}

/* ---- playback & speed ---- */

function togglePlay() {
  const video = els.player
  if (!state.ready) return
  if (video.paused) {
    const attempt = video.play()
    if (attempt && typeof attempt.catch === 'function') attempt.catch(() => {})
  } else {
    video.pause()
  }
}

function setRate(rate) {
  const value = Math.min(2, Math.max(0.2, Math.round(rate * 10) / 10))
  els.player.playbackRate = value
  els.speedChip.textContent = value.toFixed(1) + '×'
  els.speedChip.classList.toggle('changed', Math.abs(value - 1) > 0.01)
}

els.playBtn.addEventListener('click', togglePlay)
function setPlayIcon(playing) {
  els.iconPlay.hidden = playing
  els.iconPause.hidden = !playing
}
els.player.addEventListener('play', () => {
  setPlayIcon(true)
  wave.play()
})
els.player.addEventListener('pause', () => {
  setPlayIcon(false)
  wave.pause()
})
els.player.addEventListener('ended', () => setPlayIcon(false))
els.player.addEventListener('timeupdate', render)
els.player.addEventListener('seeked', render)

els.speedDownBtn.addEventListener('click', () => setRate(els.player.playbackRate - 0.1))
els.speedUpBtn.addEventListener('click', () => setRate(els.player.playbackRate + 0.1))
els.speedChip.addEventListener('click', () => setRate(1))

/* Single click toggles play; double click toggles fullscreen (the
 * 220 ms timer keeps the two from fighting each other). */
let clickTimer = null
els.player.addEventListener('click', () => {
  if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; return }
  clickTimer = setTimeout(() => { clickTimer = null; togglePlay() }, 220)
})
els.player.addEventListener('dblclick', () => {
  if (clickTimer) { clearTimeout(clickTimer); clickTimer = null }
  if (document.fullscreenElement) {
    const attempt = document.exitFullscreen()
    if (attempt && typeof attempt.catch === 'function') attempt.catch(() => {})
  } else {
    const attempt = els.stage.requestFullscreen()
    if (attempt && typeof attempt.catch === 'function') attempt.catch(() => {})
  }
})

/* ---- timeline scrubbing ---- */

let scrubbing = false
let scrubPending = null // stream mode: commit the seek on release only

function pointerTime(e) {
  const rect = els.timeline.getBoundingClientRect()
  if (!rect.width) return 0
  const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
  return (effDuration() || 0) * ratio
}

els.timeline.addEventListener('pointerdown', e => {
  if (!state.ready) return
  scrubbing = true
  try { els.timeline.setPointerCapture(e.pointerId) } catch (err) { /* continue */ }
  if (state.streamMode) {
    scrubPending = pointerTime(e)
    els.timeCur.textContent = fmt(scrubPending)
  } else {
    els.player.currentTime = pointerTime(e)
  }
})
els.timeline.addEventListener('pointermove', e => {
  if (!scrubbing || !state.ready) return
  if (state.streamMode) {
    scrubPending = pointerTime(e)
    els.timeCur.textContent = fmt(scrubPending)
  } else {
    els.player.currentTime = pointerTime(e)
  }
})
const endScrub = e => {
  if (scrubbing && scrubPending !== null) {
    seekTo(scrubPending)
    scrubPending = null
  }
  scrubbing = false
}
els.timeline.addEventListener('pointerup', endScrub)
els.timeline.addEventListener('lostpointercapture', endScrub)

/* ---- clip marking, segment inputs & navigation ---- */

function markStart() {
  if (!state.ready) return
  state.clipStart = Math.min(Math.max(effTime(), 0), effDuration())
  syncEnabled()
  render()
}

function markEnd() {
  if (!state.ready) return
  state.clipEnd = Math.min(Math.max(effTime(), 0), effDuration())
  syncEnabled()
  render()
}

els.setInBtn.addEventListener('click', markStart)
els.setOutBtn.addEventListener('click', markEnd)

/* Typing updates the bound live (validated, clamped); Enter jumps
 * the playhead there; blur rewrites the canonical form. */
function applyInput(which) {
  const input = which === 'in' ? els.inInput : els.outInput
  const parsed = parseTime(input.value)
  if (parsed === null) {
    input.classList.add('invalid')
    return false
  }
  input.classList.remove('invalid')
  const duration = effDuration() || 0
  const clamped = Math.min(Math.max(parsed, 0), duration)
  if (which === 'in') state.clipStart = clamped
  else state.clipEnd = clamped
  syncEnabled()
  render()
  return true
}

for (const which of ['in', 'out']) {
  const input = which === 'in' ? els.inInput : els.outInput
  input.addEventListener('focus', () => input.select())
  input.addEventListener('input', () => applyInput(which))
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (applyInput(which)) {
        seekTo(which === 'in' ? state.clipStart : state.clipEnd)
        input.blur()
      }
    }
  })
  input.addEventListener('blur', () => {
    input.classList.remove('invalid')
    render() // rewrite the canonical form
  })
}

els.navStartBtn.addEventListener('click', () => seekTo(0))
els.navInBtn.addEventListener('click', () => seekTo(state.clipStart))
els.navOutBtn.addEventListener('click', () => seekTo(state.clipEnd))
els.navEndBtn.addEventListener('click', () => seekTo(effDuration()))

/* ---- keyboard ---- */

function nudge(delta) {
  if (!state.ready) return
  seekTo(effTime() + delta)
}

window.addEventListener('keydown', e => {
  const target = e.target
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
  switch (e.key) {
    case ' ':
      if (target && target.tagName === 'BUTTON') return // focused buttons keep Space
      e.preventDefault()
      togglePlay()
      break
    case 'i': case 'I': markStart(); break
    case 'o': case 'O': markEnd(); break
    case '[': seekTo(state.clipStart); break
    case ']': seekTo(state.clipEnd); break
    case 'ArrowLeft': e.preventDefault(); nudge(e.shiftKey ? -0.1 : -1); break
    case 'ArrowRight': e.preventDefault(); nudge(e.shiftKey ? 0.1 : 1); break
    case 'Home': seekTo(0); break
    case 'End': seekTo(effDuration()); break
    case 'm': case 'M': els.player.muted = !els.player.muted; break
    case 'Escape': closeSheets(); break
  }
})

/* ---- jobs (cut / convert / extract / capture) ---- */

els.cutBtn.addEventListener('click', startCut)
els.cancelBtn.addEventListener('click', () => ipcRenderer.invoke('job:cancel'))
els.showBtn.addEventListener('click', () => {
  if (state.lastOutput) ipcRenderer.invoke('shell:show', state.lastOutput)
})

ipcRenderer.on('job:progress', (_event, pct) => {
  const value = Math.max(0, Math.min(1, pct))
  els.progressFill.style.width = (value * 100).toFixed(1) + '%'
  if (state.busyLabel) els.cutBtn.textContent = `${state.busyLabel} ${Math.round(value * 100)}%`
})

async function startCut() {
  if (!clipValid() || state.busy) return

  const start = state.clipStart
  const duration = state.clipEnd - state.clipStart
  const extname = path.extname(state.source)
  const ext = extname.slice(1).toLowerCase() || 'mp4'
  const base = path.basename(state.source, extname) || 'clip'

  // Same container as the source — that is what keeps the cut
  // lossless (nothing to remux, nothing to re-encode).
  const output = await ipcRenderer.invoke('dialog:save', {
    title: 'Save clip as…',
    defaultPath: path.join(path.dirname(state.source), `${base} [cut].${ext}`),
    filters: [
      { name: `${ext.toUpperCase()} file`, extensions: [ext] },
      { name: 'All files', extensions: ['*'] },
    ],
  })
  if (!output) return // canceled

  setBusy(true, { label: 'Cutting…' })
  setStatus(`Cutting ${fmt(duration)} — ${path.basename(output)}…`)

  const result = await ipcRenderer.invoke('job:start', {
    kind: 'cut',
    input: state.source,
    output,
    start,
    duration,
  })

  if (result && result.ok) {
    state.lastOutput = output
    els.progressFill.style.width = '100%'
    setStatus(
      `Saved ${path.basename(output)} — ${
        result.mode === 'reencode'
          ? 're-encoded (the source could not be copied losslessly)'
          : 'lossless copy'
      }.`,
      'ok',
    )
  } else {
    setStatus(`Cut failed: ${(result && result.error) || 'unknown error'}`, 'err')
  }
  setBusy(false)
}

/* The three clip tools share the busy lock, progress channel and
 * save-dialog pattern with the cut; capture works on the playhead,
 * extract/convert on the marked clip. */
async function startTool(kind) {
  if (state.busy) return
  if (kind !== 'capture' && !clipValid()) return
  if (kind === 'capture' && !state.ready) return

  const extname = path.extname(state.source)
  const base = path.basename(state.source, extname) || 'clip'
  const dir = path.dirname(state.source)

  let defaults
  if (kind === 'capture') {
    const at = effTime()
    defaults = {
      title: 'Save frame as…',
      defaultPath: path.join(dir, `${base} [frame ${formatTime(at).replace(/:/g, '.')}].jpg`),
      filters: [{ name: 'JPEG image', extensions: ['jpg'] }],
    }
  } else if (kind === 'extract') {
    defaults = {
      title: 'Extract audio as…',
      defaultPath: path.join(dir, `${base} [audio].mp3`),
      filters: [{ name: 'MP3 audio', extensions: ['mp3'] }],
    }
  } else {
    defaults = {
      title: 'Convert clip as…',
      defaultPath: path.join(dir, `${base} [mp4].mp4`),
      filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
    }
  }

  const output = await ipcRenderer.invoke('dialog:save', defaults)
  if (!output) return // canceled

  const labels = { capture: 'Capturing…', extract: 'Extracting…', convert: 'Converting…' }
  setBusy(true, { label: labels[kind], progress: kind !== 'capture' })
  if (kind === 'capture') setStatus(`Capturing frame — ${path.basename(output)}…`)
  else setStatus(`${labels[kind].replace('…', '')} ${fmt(state.clipEnd - state.clipStart)} — ${path.basename(output)}…`)

  const job = { kind, input: state.source, output }
  if (kind === 'capture') job.at = effTime()
  else {
    job.start = state.clipStart
    job.duration = state.clipEnd - state.clipStart
  }

  const result = await ipcRenderer.invoke('job:start', job)

  if (result && result.ok) {
    state.lastOutput = output
    els.progressFill.style.width = '100%'
    const done = {
      capture: `Saved frame ${path.basename(output)}.`,
      extract: `Saved audio ${path.basename(output)}.`,
      convert: `Saved ${path.basename(output)} — re-encoded MP4.`,
    }
    setStatus(done[kind], 'ok')
  } else {
    setStatus(`${labels[kind].replace('…', '')} failed: ${(result && result.error) || 'unknown error'}`, 'err')
  }
  setBusy(false)
}

els.captureBtn.addEventListener('click', () => startTool('capture'))
els.extractBtn.addEventListener('click', () => startTool('extract'))
els.convertBtn.addEventListener('click', () => startTool('convert'))

els.helpBtn.addEventListener('click', () => ipcRenderer.invoke('help:open'))

function setBusy(flag, opts) {
  const options = opts || {}
  state.busy = flag
  state.busyLabel = flag ? String(options.label || 'Working…').replace(/…$/, '') : ''
  document.body.classList.toggle('busy', flag)
  const showSub = flag && options.progress !== false
  els.progressWrap.hidden = !showSub
  els.cancelBtn.hidden = !showSub
  if (flag) {
    els.progressFill.style.width = '0%'
    els.cutBtn.textContent = options.label || 'Cutting…'
  } else {
    els.cutBtn.textContent = 'Cut'
  }
  syncEnabled()
}

/* ---- metadata in the title (display-only) ---- */

function probeTitle() {
  const source = state.source
  ipcRenderer.invoke('media:probe', source).then(result => {
    if (source !== state.source) return // a newer source was loaded meanwhile
    const info = result && result.info
    if (!info) return
    const parts = []
    if (info.video) {
      parts.push(`${info.video.codec} ${info.video.width}×${info.video.height}`)
      if (info.video.fps) parts.push(`${Math.round(info.video.fps * 100) / 100}fps`)
    } else if (info.audio) {
      parts.push(info.audio.codec)
      if (info.audio.hz) parts.push(`${(info.audio.hz / 1000).toFixed(1)}kHz`)
    }
    if (info.bitrate) parts.push(`${info.bitrate}kbps`)
    if (parts.length) document.title = `vidcut — ${parts.join(', ')}`
  }).catch(() => { /* metadata is optional */ })
}

/* ---- waveform (audio-only sources) ---- */

const wave = new Wave(els.wave)

/* The visualizer attaches lazily and only for native (file://)
 * sources: routing a cross-origin stream element through a
 * MediaElementSource would be muted by Chromium's taint rules. */
function updateAudioOnly(force) {
  const audioOnly = force !== undefined ? force : (state.ready && els.player.videoHeight === 0)
  if (audioOnly === state.audioOnly) return
  state.audioOnly = audioOnly
  if (audioOnly) {
    if (!state.streamMode) wave.attach(els.player)
    wave.show()
  } else {
    wave.hide()
  }
}

/* ---- modal sheets (merge / record) ---- */

const sheets = { merge: els.mergeSheet, record: els.recordSheet }

function openSheet(name) {
  const sheet = sheets[name]
  if (!sheet) return
  for (const other of Object.keys(sheets)) sheets[other].hidden = other !== name
  sheet.hidden = false
}

function closeSheet(name) {
  const sheet = sheets[name]
  if (sheet) sheet.hidden = true
}

function closeSheets() {
  for (const name of Object.keys(sheets)) sheets[name].hidden = true
}

/* The sheet backdrop doubles as its own mask. */
for (const name of Object.keys(sheets)) {
  sheets[name].addEventListener('click', e => {
    if (e.target === sheets[name] && !state.busy) closeSheet(name)
  })
}

/* ---- feature modules ---- */

const merge = createMergeSheet({
  ipcRenderer, els, state, path, loadFile,
  setStatus, setBusy, syncEnabled, openSheet, closeSheet,
})

const record = createRecordSheet({
  ipcRenderer, els, state, path,
  setStatus, syncEnabled, openSheet, closeSheet,
})

/* ---- boot ---- */

syncEnabled()
render()

/* Debug/test hook — the smoke test (scripts/electron-smoke.js)
 * drives the real UI through this surface. */
window.vidcut = {
  state, loadFile, pathFromFile, markStart, markEnd, seekTo, setRate,
  parseTime, formatTime, openSheet, closeSheet, sheets, wave,
  merge, record,
}
