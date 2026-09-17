/* vidcut record sheet — wf-recorder control surface.
 *
 * The recorder itself lives in the MAIN process (see app/recorder.js):
 * this module only dispatches start/stop over IPC and renders state
 * changes from the recorder:started / recorder:stopped /
 * recorder:failed events — the same events that drive the tray, so
 * the UI can never disagree with the actual process. While recording,
 * the window hides to a blinking tray icon; clicking the tray (or
 * reopening this sheet) shows the live wall-clock timer. */

module.exports = function createRecordSheet(ctx) {
  const {
    ipcRenderer, els, state, path,
    setStatus, syncEnabled, openSheet, closeSheet,
  } = ctx

  const elapsedEl = document.getElementById('record-elapsed')
  const startBtn = document.getElementById('record-start-btn')
  const stopBtn = document.getElementById('record-stop-btn')
  const closeBtn = document.getElementById('record-close-btn')

  let recording = false
  let startedAt = 0
  let timer = null

  function fmtElapsed(ms) {
    const centiseconds = Math.floor(ms / 10) % 100
    const totalSeconds = Math.floor(ms / 1000)
    const seconds = totalSeconds % 60
    const minutes = Math.floor(totalSeconds / 60) % 60
    const hours = Math.floor(totalSeconds / 3600)
    const pad = value => String(value).padStart(2, '0')
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(centiseconds)}`
  }

  function startTimer(from) {
    startedAt = from || Date.now()
    stopTimer()
    timer = setInterval(() => {
      elapsedEl.textContent = fmtElapsed(Date.now() - startedAt)
    }, 100)
    elapsedEl.textContent = fmtElapsed(Date.now() - startedAt)
  }

  function stopTimer() {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  function setLive(flag) {
    recording = flag
    els.recordSheet.classList.toggle('live', flag)
    startBtn.hidden = flag
    stopBtn.hidden = !flag
  }

  async function begin() {
    if (recording) return
    const result = await ipcRenderer.invoke('recorder:start')
    if (!result || !result.ok) {
      setStatus(`Recording failed: ${(result && result.error) || 'unknown error'}`, 'err')
      return
    }
    // State confirmation arrives via 'recorder:started'; set the UI
    // optimistically so the sheet reads live immediately.
    setLive(true)
    startTimer(Date.now())
    setStatus(`Recording — ${path.basename(result.output)} (window hidden to the tray).`)
  }

  async function finish() {
    if (!recording) return
    stopBtn.disabled = true
    stopTimer()
    setStatus('Finalizing recording…')
    await ipcRenderer.invoke('recorder:stop')
    stopBtn.disabled = false
    // Outcome surfaces through 'recorder:stopped' / 'recorder:failed'.
  }

  ipcRenderer.on('recorder:started', (_event, payload) => {
    setLive(true)
    startTimer(Date.now())
    if (payload && payload.output) {
      setStatus(`Recording — ${path.basename(payload.output)} (window hidden to the tray).`)
    }
  })

  ipcRenderer.on('recorder:stopped', (_event, payload) => {
    setLive(false)
    stopTimer()
    elapsedEl.textContent = '00:00:00.00'
    if (payload && payload.output) {
      state.lastOutput = payload.output
      setStatus(`Saved recording ${path.basename(payload.output)}.`, 'ok')
    } else {
      setStatus('Recording finished.')
    }
    syncEnabled()
  })

  ipcRenderer.on('recorder:failed', (_event, message) => {
    setLive(false)
    stopTimer()
    elapsedEl.textContent = '00:00:00.00'
    setStatus(`Recording failed: ${message}`, 'err')
    syncEnabled()
  })

  startBtn.addEventListener('click', begin)
  stopBtn.addEventListener('click', finish)
  closeBtn.addEventListener('click', () => closeSheet('record'))

  /* Toolbar entry: reflect any recording already in flight (e.g. the
   * sheet reopened from the tray) before revealing. */
  els.recordBtn.addEventListener('click', async () => {
    const status = await ipcRenderer.invoke('recorder:status')
    setLive(!!(status && status.active))
    if (status && status.active && status.startedAt) {
      startTimer(status.startedAt)
    } else {
      stopTimer()
      elapsedEl.textContent = '00:00:00.00'
    }
    openSheet('record')
  })

  return {
    begin,
    finish,
    isLive: () => recording,
    open: () => openSheet('record'),
    close: () => closeSheet('record'),
  }
}
