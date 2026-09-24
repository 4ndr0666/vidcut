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
  muteBtn: $('mute-btn'),
  iconSound: $('icon-sound'),
  iconMuted: $('icon-muted'),
  mergeBtn: $('merge-btn'),
  recordBtn: $('record-btn'),
  helpBtn: $('help-btn'),
  status: $('status'),
  progressWrap: $('progress'),
  progressFill: $('progress-fill'),
  showBtn: $('show-btn'),
  mergeSheet: $('merge-sheet'),
  recordSheet: $('record-sheet'),
  scrubOverlay: $('scrub-overlay'),
  scrubTime: $('scrub-time'),
  scrubFill: $('scrub-fill'),
  shortcutsSheet: $('shortcuts-sheet'),
  keysRepoBtn: $('keys-repo-btn'),
  keysCloseBtn: $('keys-close-btn'),
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
  zoom: 1,           // video magnification (mouse wheel / = / -), 1×–6×
  panX: 0,           // Ctrl+drag pan offset (px), clamped to the zoom overflow
  panY: 0,
  frameDur: null,    // seconds per frame (probe; 1/30 fallback) — arrow frame-stepping
  muted: false,      // MUTE toggle: silent preview + silent video outputs
  chapters: [],      // probe-parsed chapter starts — the 2–9 number keys
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
      els.flagIn.title = `Clip start ${fmt(state.clipStart)} — drag to adjust`
      els.flagOut.title = `Clip end ${fmt(state.clipEnd)} — drag to adjust`
    } else {
      els.selInfo.textContent = 'end must come after start'
      els.selInfo.classList.add('invalid')
    }
  }

  renderChapterTicks()
}

/* Chapter ticks — thin cyan notches on the timeline at each chapter
 * start, so the number keys have something visible to aim at. The
 * signature guard keeps this free on the timeupdate hot path: the
 * DOM is only rebuilt when the chapter count or the duration moves
 * (a stream-mode duration can still be growing). */
let tickSig = ''

function renderChapterTicks() {
  const duration = effDuration() || 0
  const sig = `${state.chapters.length}:${duration.toFixed(2)}`
  if (sig === tickSig) return
  tickSig = sig

  for (const tick of Array.from(els.timeline.querySelectorAll('.chapter-tick'))) tick.remove()
  if (!state.chapters.length || duration <= 0) return

  state.chapters.forEach((chapter, i) => {
    if (!Number.isFinite(chapter.start) || chapter.start <= 0 || chapter.start >= duration) return
    const tick = document.createElement('div')
    tick.className = 'chapter-tick'
    tick.style.left = (chapter.start / duration * 100).toFixed(3) + '%'
    const named = chapter.title ? ` — ${chapter.title}` : ''
    const key = i < 9 ? ` · key ${i + 1}` : ''
    tick.title = `Chapter ${i + 1}${named} · ${fmt(chapter.start)}${key}`
    els.timeline.appendChild(tick)
  })
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
  state.frameDur = null // the new source's frame grid arrives with its probe
  state.chapters = []  // same for its chapters — ticks rebuild on probe
  tickSig = ''         // force the tick rebuild path to run clean
  undoStack.length = 0 // a new source starts a new history — bounds
  redoStack.length = 0 // from the previous video are not undoable

  closeSheets()
  setRate(1)
  resetZoom()
  hideScrubHud() // a stale HUD from the previous source must not linger
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

/* Dual-mode seek: nudges the element can genuinely serve natively
 * are served natively; anything else re-opens the stream at the
 * target (a new request — the old encode dies with it). The native
 * gate rides seekable, NOT buffered: a chunked live transcode can
 * report buffered data yet an empty seekable range, and assigning
 * currentTime there clamps the playhead to 0 — the re-open path is
 * the one that always lands where the user asked. */
function seekTo(seconds) {
  if (!state.ready) return
  const duration = effDuration() || 0
  let target = Math.max(0, seconds)
  if (duration > 0) target = Math.min(target, duration)

  if (state.streamMode) {
    const local = target - state.streamStart
    const seekable = els.player.seekable
    let send = -1
    for (let i = 0; i < seekable.length; i++) send = Math.max(send, seekable.end(i))
    if (local >= 0 && send > 0 && local <= send - 0.2) {
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

/* ---- MUTE — one switch, both ends of the pipeline ----
 *
 * While the toggle is on, what you HEAR is what you GET: the preview
 * plays silent, and every video file vidcut writes (Cut / Convert /
 * Merge) drops its audio stream. Extract Audio is exempt — it IS the
 * audio; Capture writes an image. The state survives source changes
 * on purpose: it is an output preference, not a per-file action. */
function setMuteIcon() {
  els.iconSound.hidden = state.muted
  els.iconMuted.hidden = !state.muted
  els.muteBtn.setAttribute('aria-pressed', state.muted ? 'true' : 'false')
}

function toggleMute() {
  state.muted = !state.muted
  els.player.muted = state.muted // WYSIWYG: the preview tells you the state
  setMuteIcon()
  setStatus(
    state.muted
      ? (state.audioOnly
          ? 'Muted — preview silent (audio-only source: outputs are unchanged).'
          : 'Muted — preview silent and Cut / Convert / Merge write silent video.')
      : 'Audio on.',
    state.muted ? '' : 'ok',
  )
}

els.muteBtn.addEventListener('click', toggleMute)
setMuteIcon() // align the icon with the markup's default (off)

/* Single click toggles play; double click toggles fullscreen (the
 * 220 ms timer keeps the two from fighting each other). A Ctrl+
 * gesture on the stage never counts as either — panMoved swallows
 * the click AND the double-click that follow a pan release. */
let clickTimer = null
els.player.addEventListener('click', () => {
  if (panMoved) { panMoved = false; return }
  if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; return }
  clickTimer = setTimeout(() => { clickTimer = null; togglePlay() }, 220)
})
els.player.addEventListener('dblclick', () => {
  if (panMoved) { panMoved = false; return }
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

/* ---- draggable clip flags (the start/end "nibblets") ----
 *
 * The green/orange flags are grabbable: pointer-down on a flag drags
 * that clip bound instead of scrubbing (stopPropagation keeps the
 * timeline's own scrub handler out of it). The bound follows the
 * pointer through the same ratio math as seeking; the inputs, the
 * region bar and the sel-info readout update live through render(). */

let dragFlag = null // 'in' | 'out' while a flag drag is live

for (const which of ['in', 'out']) {
  const flag = which === 'in' ? els.flagIn : els.flagOut

  flag.addEventListener('pointerdown', e => {
    if (!state.ready || e.button !== 0) return
    e.preventDefault()
    e.stopPropagation() // never also start a timeline scrub
    pushUndo() // one snapshot per drag gesture, not per pixel
    dragFlag = which
    try { flag.setPointerCapture(e.pointerId) } catch (err) { /* continue uncaptured */ }
    flag.classList.add('dragging')
    document.body.classList.add('flag-dragging')
  })

  flag.addEventListener('pointermove', e => {
    if (dragFlag !== which) return
    const t = pointerTime(e)
    if (which === 'in') state.clipStart = t
    else state.clipEnd = t
    render()
  })

  const endFlagDrag = () => {
    if (dragFlag !== which) return
    dragFlag = null
    flag.classList.remove('dragging')
    document.body.classList.remove('flag-dragging')
    syncEnabled() // the Cut button may have just become valid
  }
  flag.addEventListener('pointerup', endFlagDrag)
  flag.addEventListener('lostpointercapture', endFlagDrag)
}

/* ---- clip marking, segment inputs & navigation ---- */

/* ---- undo / redo (Ctrl+Z · Ctrl+Shift+Z · Ctrl+Y) ----
 *
 * The undoable surface is the clip geometry — the marks are the one
 * thing here where a slip (a grabbed flag, a mistyped timecode, a
 * stray I over a carefully placed start) silently destroys careful
 * placement. Every bounds-changing gesture snapshots the previous
 * geometry first: discrete marks, input edits (coalesced per typing
 * burst), and flag drags (one snapshot per gesture, not per pixel).
 * Seeks, zoom, rate and mute are navigation and preference — not
 * undoable. A new source clears both stacks. */

const UNDO_MAX = 100
const undoStack = [] // prior geometries, newest on top
const redoStack = [] // geometries undone since the last push

function pushUndo(coalesceKey) {
  const top = undoStack[undoStack.length - 1]
  if (top && coalesceKey !== undefined && top.key === coalesceKey && Date.now() - top.at < 900) {
    top.at = Date.now() // one undo per typing burst, not per keystroke
    return
  }
  if (top && top.clipStart === state.clipStart && top.clipEnd === state.clipEnd) return
  undoStack.push({ key: coalesceKey, at: Date.now(), clipStart: state.clipStart, clipEnd: state.clipEnd })
  if (undoStack.length > UNDO_MAX) undoStack.shift()
  redoStack.length = 0 // a fresh edit forks history — redo dies
}

function undoMarks() {
  if (!undoStack.length) { setStatus('Nothing to undo — the clip marks are already as they were.'); return }
  redoStack.push({ clipStart: state.clipStart, clipEnd: state.clipEnd })
  const entry = undoStack.pop()
  state.clipStart = entry.clipStart
  state.clipEnd = entry.clipEnd
  syncEnabled()
  render()
  setStatus(`Undo — clip marks ${fmt(state.clipStart)} → ${fmt(state.clipEnd)}.`)
}

function redoMarks() {
  if (!redoStack.length) { setStatus('Nothing to redo.'); return }
  undoStack.push({ key: undefined, at: Date.now(), clipStart: state.clipStart, clipEnd: state.clipEnd })
  const entry = redoStack.pop()
  state.clipStart = entry.clipStart
  state.clipEnd = entry.clipEnd
  syncEnabled()
  render()
  setStatus(`Redo — clip marks ${fmt(state.clipStart)} → ${fmt(state.clipEnd)}.`)
}

function markStart() {
  if (!state.ready) return
  pushUndo()
  state.clipStart = Math.min(Math.max(effTime(), 0), effDuration())
  syncEnabled()
  render()
}

function markEnd() {
  if (!state.ready) return
  pushUndo()
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
  pushUndo(which) // coalesced: one undo per typing burst
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

/* ---- video zoom & pan (wheel or = / − to magnify, Ctrl+drag to move) ----
 *
 * Wheel up magnifies the picture itself (a CSS scale on the
 * element — object-fit already letterboxed it), wheel down shrinks
 * back. 1× is the floor, 6× the ceiling, ×1.25 per notch. Once
 * magnified, Ctrl+left-drag slides the picture around inside the
 * stage; the pan is clamped to the scaled element's overflow so the
 * frame can never be dragged off-screen. Zoom AND pan reset with
 * each new source and with Ctrl+0. */

const ZOOM_MIN = 1
const ZOOM_MAX = 6
const ZOOM_STEP = 1.25

function resetZoom() {
  state.zoom = 1
  state.panX = 0
  state.panY = 0
  els.player.style.transform = ''
  updatePanCursor()
}

/* The element fills the stage, so scale(z) overflows it by exactly
 * (z−1)/2 of the stage per side — that is the pan's hard ceiling. */
function panBounds() {
  if (state.zoom <= 1) return { x: 0, y: 0 }
  return {
    x: (els.stage.clientWidth * (state.zoom - 1)) / 2,
    y: (els.stage.clientHeight * (state.zoom - 1)) / 2,
  }
}

function clampPan() {
  const bounds = panBounds()
  state.panX = Math.min(Math.max(state.panX, -bounds.x), bounds.x)
  state.panY = Math.min(Math.max(state.panY, -bounds.y), bounds.y)
}

function applyTransform() {
  els.player.style.transform = state.zoom > 1
    ? `translate(${Math.round(state.panX)}px, ${Math.round(state.panY)}px) scale(${state.zoom})`
    : ''
}

function applyZoom() {
  clampPan() // zooming out shrinks the travel range — re-clamp
  applyTransform()
  setStatus(`Zoom ${state.zoom.toFixed(2).replace(/\.?0+$/, '')}×`)
  updatePanCursor()
}

/* One notch in either direction — shared by the wheel and the
 * = / − keys, so both feel identical. */
function zoomBy(mult) {
  if (!state.ready) return
  const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(state.zoom * mult * 100) / 100))
  if (next === state.zoom) return
  state.zoom = next
  applyZoom()
}

els.stage.addEventListener('wheel', e => {
  if (!state.ready) return
  e.preventDefault()
  zoomBy(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP)
}, { passive: false })

/* ---- Ctrl+left-drag: pan the magnified picture ---- */

let panDrag = null   // { id, lastX, lastY } while a pan is live
let panMoved = false // the following click is a pan release, not a toggle
let ctrlHeld = false // grab-cursor affordance while Ctrl is down

function updatePanCursor() {
  els.stage.classList.toggle('pan-ready', state.ready && state.zoom > 1 && ctrlHeld)
}

window.addEventListener('keydown', e => {
  if (e.key === 'Control') { ctrlHeld = true; updatePanCursor() }
})
window.addEventListener('keyup', e => {
  if (e.key === 'Control') { ctrlHeld = false; updatePanCursor() }
})
window.addEventListener('blur', () => { // never strand a stale grab cursor
  ctrlHeld = false
  updatePanCursor()
})

els.stage.addEventListener('pointerdown', e => {
  if (!state.ready || e.button !== 0 || !(e.ctrlKey || e.metaKey)) return
  panMoved = true // a Ctrl+click never doubles as play/pause
  if (state.zoom <= 1) {
    // nothing to move yet — say so instead of ignoring the gesture
    setStatus('Zoom in first (wheel or =) — Ctrl+drag moves the magnified picture.')
    return
  }
  e.preventDefault()
  panDrag = { id: e.pointerId, lastX: e.clientX, lastY: e.clientY }
  try { els.stage.setPointerCapture(e.pointerId) } catch (err) { /* continue */ }
  els.stage.classList.add('panning')
})

els.stage.addEventListener('pointermove', e => {
  if (!panDrag || e.pointerId !== panDrag.id) return
  const dx = e.clientX - panDrag.lastX
  const dy = e.clientY - panDrag.lastY
  panDrag.lastX = e.clientX
  panDrag.lastY = e.clientY
  if (dx || dy) panMoved = true
  state.panX += dx
  state.panY += dy
  clampPan()
  applyTransform()
})

const endPanDrag = e => {
  if (!panDrag || (e && e.pointerId !== undefined && e.pointerId !== panDrag.id)) return
  panDrag = null
  els.stage.classList.remove('panning')
}
els.stage.addEventListener('pointerup', endPanDrag)
els.stage.addEventListener('lostpointercapture', endPanDrag)

/* ---- keyboard ---- */

/* Arrow scrubbing — two instruments on one key pair:
 *
 *   tap (press + release, no auto-repeat): frame-by-frame. Every
 *        discrete press steps EXACTLY ONE frame on the media's own
 *        frame grid (probe-supplied, 30 fps fallback).
 *   hold (auto-repeat events): tactile scrub. The step per repeat
 *        grows with how long the key has been held — 0.1 s, 0.5 s,
 *        1 s, 2 s, 5 s — so a hold travels far without ever leaping
 *        to a chapter mark or the end of the video. Shift pins the
 *        step at 0.05 s and never accelerates (trim-fine).
 *
 * A tap pauses playback and LEAVES it paused — that is the frame
 * inspection workflow; a held burst resumes playback on release
 * (the established tactile contract). In both cases the scrub HUD
 * lingers 3.5 s after release so the user can keep tapping frames
 * before it fades. Stream mode accumulates the target and commits
 * it once, on release — the same contract as dragging the timeline. */
const SCRUB_FINE = 0.05
const SCRUB_TIERS = [
  [500, 0.1], [1500, 0.5], [3000, 1], [5000, 2], [Infinity, 5],
]
const SCRUB_HUD_LINGER = 3500 // ms the HUD outlives the release

let scrubKey = null        // 'ArrowLeft' | 'ArrowRight' while held
let scrubBegan = 0         // Date.now() when the burst started
let scrubWasPlaying = false
let scrubTarget = null     // stream mode: absolute target, committed on release
let scrubRepeats = 0       // auto-repeat events seen — tap (0) vs hold (>0)
let scrubHudTimer = null   // the 3.5 s linger timeout

/* Scrub HUD — realtime visual feedback while an arrow is held or
 * tapped: the timestamp the scrub is heading toward (Cinzel
 * Decorative #15FFFF) plus a miniature timeline whose fill mirrors
 * the playhead ratio. After release it lingers SCRUB_HUD_LINGER so
 * subsequent frame taps keep their context. */
function showScrubHud() {
  if (scrubHudTimer) { clearTimeout(scrubHudTimer); scrubHudTimer = null }
  els.scrubOverlay.classList.add('on')
}

function updateScrubHud(seconds) {
  els.scrubTime.textContent = fmt(seconds)
  const duration = effDuration() || 0
  const ratio = duration > 0 ? Math.min(1, Math.max(0, seconds / duration)) : 0
  els.scrubFill.style.width = (ratio * 100).toFixed(1) + '%'
}

function hideScrubHud() {
  if (scrubHudTimer) { clearTimeout(scrubHudTimer); scrubHudTimer = null }
  els.scrubOverlay.classList.remove('on')
}

function lingerScrubHud() {
  if (scrubHudTimer) { clearTimeout(scrubHudTimer); scrubHudTimer = null }
  scrubHudTimer = setTimeout(() => {
    scrubHudTimer = null
    els.scrubOverlay.classList.remove('on')
  }, SCRUB_HUD_LINGER)
}

/* One-off seek feedback (number keys, Home/End, Shift+Home/End):
 * light the same HUD at the destination and let it linger — every
 * keyboard seek answers the same way the arrows do. */
function flashHud(seconds) {
  showScrubHud()
  updateScrubHud(seconds)
  lingerScrubHud()
}

function scrubStep() {
  const held = Date.now() - scrubBegan
  for (const [until, step] of SCRUB_TIERS) {
    if (held < until) return step
  }
  return SCRUB_TIERS[SCRUB_TIERS.length - 1][1]
}

/* Exactly one frame on the media's frame grid — the unit of
 * frame-by-frame stepping. round() snaps an off-grid playhead
 * (e.g. after a click-seek) so repeated taps never accumulate
 * drift. */
function frameStep(dir, from) {
  const fd = state.frameDur || 1 / 30
  const duration = effDuration() || 0
  const frames = Math.round(from / fd) + dir
  return Math.min(Math.max(frames * fd, 0), duration)
}

function scrubByKey(key, fine, repeat) {
  if (!state.ready) return
  if (scrubKey !== key) { // a fresh burst: pause, arm the HUD
    scrubKey = key
    scrubBegan = Date.now()
    scrubRepeats = 0
    scrubWasPlaying = !els.player.paused
    if (scrubWasPlaying) els.player.pause() // 'pause' event syncs the icon
    scrubTarget = null
    showScrubHud()
  }
  const dir = key === 'ArrowRight' ? 1 : -1
  let step = null // null → discrete press → one frame
  if (repeat) {
    scrubRepeats++
    step = fine ? SCRUB_FINE : scrubStep()
  }
  if (state.streamMode) {
    const from = scrubTarget === null ? effTime() : scrubTarget
    const duration = effDuration() || 0
    scrubTarget = step === null
      ? frameStep(dir, from)
      : Math.min(Math.max(from + dir * step, 0), duration)
    els.timeCur.textContent = fmt(scrubTarget)
    updateScrubHud(scrubTarget)
  } else {
    const duration = effDuration() || 0
    const target = step === null
      ? frameStep(dir, effTime())
      : Math.min(Math.max(effTime() + dir * step, 0), duration)
    seekTo(target)
    updateScrubHud(target)
  }
}

function endScrubKey() {
  if (scrubTarget !== null) seekTo(scrubTarget) // stream: commit once
  // A held burst returns to playback; a frame-step tap stays
  // paused — subsequent taps continue the frame-by-frame walk.
  const resume = scrubWasPlaying && scrubRepeats > 0
  scrubKey = null
  scrubTarget = null
  scrubWasPlaying = false
  scrubRepeats = 0
  lingerScrubHud()
  if (resume && state.ready) {
    const attempt = els.player.play()
    if (attempt && typeof attempt.catch === 'function') attempt.catch(() => {})
  }
}

window.addEventListener('keyup', e => {
  if (scrubKey === null || e.key !== scrubKey) return
  endScrubKey()
})

/* A mouse-clicked button never keeps DOM focus: focus left behind on
 * a button is what let Space re-click "Open video…" right after a
 * load. Only mouse-driven clicks (detail > 0) release focus, so the
 * keyboard path (Tab + Enter) still works as expected. */
document.addEventListener('click', e => {
  if (!e.detail) return
  const button = e.target && e.target.closest && e.target.closest('button')
  if (button) button.blur()
})

/* Which modal sheet (if any) currently owns the keyboard. */
function currentSheet() {
  for (const name of Object.keys(sheets)) if (!sheets[name].hidden) return name
  return null
}

/* Enter inside a sheet runs that sheet's primary action — the same
 * button the mouse would click (Merge / Start-Stop recording / the
 * cheat sheet just closes). */
function sheetPrimary() {
  const name = currentSheet()
  if (name === 'merge') { merge.mergeNow(); return }
  if (name === 'record') { if (record.isLive()) record.finish(); else record.begin(); return }
  if (name === 'shortcuts') closeSheet('shortcuts')
}

/* Number keys: 1 = video start and 0 = video end, ALWAYS; 2–9 jump
 * to chapter starts when the container carries them. The HUD flashes
 * the destination, same feedback contract as the arrow keys. */
function seekByDigit(digit) {
  if (!state.ready) return
  let target = null
  if (digit === '0') target = effDuration()
  else {
    const chapter = state.chapters[Number(digit) - 1]
    target = chapter ? chapter.start : (digit === '1' ? 0 : null)
  }
  if (target === null || !Number.isFinite(target)) return
  seekTo(target)
  flashHud(target)
}

window.addEventListener('keydown', e => {
  // Four accelerators the map owns: O (open), 0 (zoom+pan reset),
  // Z (undo) and Shift+Z / Y (redo). Every OTHER Ctrl/Cmd/Alt combo
  // belongs to the OS and devtools (Ctrl+R reload must not open the
  // record sheet).
  if ((e.ctrlKey || e.metaKey) && !e.altKey) {
    const k = e.key.toLowerCase()
    if (k === 'o') {
      e.preventDefault()
      if (!state.busy) openDialog()
      return
    }
    if (k === '0') {
      e.preventDefault()
      resetZoom()
      setStatus('Zoom reset to 1× — picture centered.')
      return
    }
    if (k === 'z') {
      e.preventDefault()
      if (e.shiftKey) redoMarks()
      else undoMarks()
      return
    }
    if (k === 'y') {
      e.preventDefault()
      redoMarks()
      return
    }
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return
  const target = e.target
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return

  // A modal sheet owns the keyboard: Escape (or ?) closes it, Enter
  // runs its primary action, m/r still re-target which sheet is open.
  // Everything else stays suspended — no tool can fire behind a mask.
  const sheet = currentSheet()
  if (sheet) {
    if (e.key === 'Escape' || e.key === '?') { e.preventDefault(); closeSheets(); return }
    if (e.key === 'Enter') {
      if (target && target.tagName === 'BUTTON') return // a focused sheet button keeps Enter
      e.preventDefault()
      sheetPrimary()
      return
    }
    if (e.key !== 'm' && e.key !== 'r') return
    // fall through: m/r switch the open sheet
  }

  switch (e.key) {
    case ' ':
      // Hardcoded to play/pause. preventDefault also cancels the
      // browser's own spacebar activation of a focused button, so
      // Space can never re-click "Open video…" or any other button —
      // not at init, not mid-load, not after a click.
      e.preventDefault()
      togglePlay()
      break
    case 'Enter':
      // A focused button keeps Enter (it clicks); everywhere else it cuts.
      if (target && target.tagName === 'BUTTON') return
      e.preventDefault()
      startCut()
      break
    case '[': setRate(els.player.playbackRate - 0.1); break
    case ']': setRate(els.player.playbackRate + 0.1); break
    case 'Backspace':
      e.preventDefault() // never navigate history — the chip reset owns it
      setRate(1)
      break
    case '=': case '+': zoomBy(ZOOM_STEP); break
    case '-': case '_': zoomBy(1 / ZOOM_STEP); break
    case 'ArrowLeft': e.preventDefault(); scrubByKey('ArrowLeft', e.shiftKey, e.repeat); break
    case 'ArrowRight': e.preventDefault(); scrubByKey('ArrowRight', e.shiftKey, e.repeat); break
    case 'Home': {
      const t = e.shiftKey ? state.clipStart : 0
      seekTo(t)
      flashHud(t)
      break
    }
    case 'End': {
      const t = e.shiftKey ? state.clipEnd : effDuration()
      seekTo(t)
      flashHud(t)
      break
    }
    case '?': openSheet('shortcuts'); break
    case 'Escape':
      // No sheet open: Escape IS the Cancel button while a job runs.
      if (state.busy) ipcRenderer.invoke('job:cancel')
      break
    default: {
      if (e.key >= '0' && e.key <= '9') { seekByDigit(e.key); break }
      const k = e.key.toLowerCase()
      if (k === 'i') markStart()
      else if (k === 'o') markEnd()
      else if (k === 'u') toggleMute()
      else if (k === 's') startTool('capture')
      else if (k === 'a') startTool('extract')
      else if (k === 'c') startTool('convert')
      else if (k === 'm') openSheet('merge')
      else if (k === 'r') openSheet('record')
      else if (k === 'f') {
        if (state.lastOutput && !state.busy) ipcRenderer.invoke('shell:show', state.lastOutput)
      }
    }
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

  const silent = state.muted && !state.audioOnly // an audio-only cut keeps its audio
  const result = await ipcRenderer.invoke('job:start', {
    kind: 'cut',
    input: state.source,
    output,
    start,
    duration,
    muted: silent,
  })

  if (result && result.ok) {
    state.lastOutput = output
    els.progressFill.style.width = '100%'
    setStatus(
      `Saved ${path.basename(output)} — ${
        result.mode === 'reencode'
          ? 're-encoded (the source could not be copied losslessly)'
          : 'lossless copy'
      }${silent ? ' · silent' : ''}.`,
      'ok',
    )
  } else {
    setStatus(`Cut failed: ${(result && result.error) || 'unknown error'}`, 'err')
  }
  setBusy(false)
}

/* The three clip tools share the busy lock, progress channel and
 * job pipeline; capture works on the playhead, extract/convert on
 * the marked clip. Screenshots are zero-friction: they skip the
 * save dialog entirely and land straight in ~/Pictures/screenshots
 * under the app-wide idempotent naming (main owns dir + name). */
async function startTool(kind) {
  if (state.busy) return
  if (kind !== 'capture' && !clipValid()) return
  if (kind === 'capture' && !state.ready) return

  const extname = path.extname(state.source)
  const base = path.basename(state.source, extname) || 'clip'
  const dir = path.dirname(state.source)

  let output
  if (kind === 'capture') {
    const result = await ipcRenderer.invoke('capture:save', state.source)
    if (!result || !result.ok) {
      setStatus(`Capture failed: ${(result && result.error) || 'could not resolve the screenshots folder'}`, 'err')
      return
    }
    output = result.output
  } else {
    const defaults = kind === 'extract'
      ? {
          title: 'Extract audio as…',
          defaultPath: path.join(dir, `${base} [audio].mp3`),
          filters: [{ name: 'MP3 audio', extensions: ['mp3'] }],
        }
      : {
          title: 'Convert clip as…',
          defaultPath: path.join(dir, `${base} [mp4].mp4`),
          filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
        }
    output = await ipcRenderer.invoke('dialog:save', defaults)
    if (!output) return // canceled
  }

  const labels = { capture: 'Capturing…', extract: 'Extracting…', convert: 'Converting…' }
  setBusy(true, { label: labels[kind], progress: kind !== 'capture' })
  if (kind === 'capture') setStatus(`Capturing frame — ${path.basename(output)}…`)
  else setStatus(`${labels[kind].replace('…', '')} ${fmt(state.clipEnd - state.clipStart)} — ${path.basename(output)}…`)

  const job = { kind, input: state.source, output }
  if (kind === 'capture') job.at = effTime()
  else {
    job.start = state.clipStart
    job.duration = state.clipEnd - state.clipStart
    // MUTE follows the toggle for the video-writing tools; extract is
    // exempt by definition (it exists to produce the audio).
    if (kind === 'convert') job.muted = state.muted && !state.audioOnly
  }

  const result = await ipcRenderer.invoke('job:start', job)

  if (result && result.ok) {
    state.lastOutput = output
    els.progressFill.style.width = '100%'
    const done = {
      capture: `Saved frame ${path.basename(output)} — ${path.dirname(output)}`,
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

/* Help IS the cheat sheet now — every keybind, in-app. The repo link
 * moved inside it (help:open still owns the fixed URL). */
els.helpBtn.addEventListener('click', () => openSheet('shortcuts'))
els.keysRepoBtn.addEventListener('click', () => ipcRenderer.invoke('help:open'))
els.keysCloseBtn.addEventListener('click', () => closeSheet('shortcuts'))

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
    els.cutBtn.textContent = 'Cut (Enter)'
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
    // The frame grid behind arrow-key frame stepping (the 30 fps
    // fallback stands until the probe lands — it is cached + fast).
    if (info.video && Number.isFinite(info.video.fps) && info.video.fps > 0) {
      state.frameDur = 1 / info.video.fps
    }
    // Chapter starts behind the 2–9 number keys (and the timeline
    // ticks). 1 (video start) and 0 (video end) work regardless.
    state.chapters = Array.isArray(info.chapters)
      ? info.chapters.filter(c => c && Number.isFinite(c.start) && c.start >= 0)
      : []
    renderChapterTicks()
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

/* ---- modal sheets (merge / record / shortcuts) ---- */

const sheets = { merge: els.mergeSheet, record: els.recordSheet, shortcuts: els.shortcutsSheet }

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
  merge, record, toggleMute,
  undoMarks, redoMarks, resetZoom, zoomBy, panBounds,
}
