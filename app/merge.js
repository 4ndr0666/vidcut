/* vidcut merge sheet — file list, add/remove, work dir, merge dispatch.
 *
 * THE panel: this sheet's ancestor in the original app rendered
 * expanded on init and pushed the flexbox around until closed.
 * Here it is `hidden` in markup and only ever revealed by explicit
 * user action — the failure is structurally impossible, not merely
 * patched around. The merge job runs through the shared busy lock
 * (single ffmpeg slot, same as every other tool).
 *
 * The work dir row is display-only state owned by main (settings +
 * statfs); the merge engine receives the setting via job:start
 * injection, so this sheet can never drift from what runs. */

module.exports = function createMergeSheet(ctx) {
  const {
    ipcRenderer, els, state, path, loadFile,
    setStatus, setBusy, openSheet, closeSheet,
  } = ctx

  let files = []

  const listEl = document.getElementById('merge-list')
  const addBtn = document.getElementById('merge-add-btn')
  const clearBtn = document.getElementById('merge-clear-btn')
  const startBtn = document.getElementById('merge-start-btn')
  const closeBtn = document.getElementById('merge-close-btn')
  const workdirLabel = document.getElementById('workdir-label')
  const workdirChangeBtn = document.getElementById('workdir-change-btn')
  const workdirResetBtn = document.getElementById('workdir-reset-btn')

  /* Same formatter the engine's preflight uses, so the sheet and
   * the error messages speak one language. */
  function humanBytes(n) {
    if (!Number.isFinite(n) || n < 0) return '?'
    const units = ['B', 'KB', 'MB', 'GB', 'TB']
    let value = n
    let unit = 0
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
    return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
  }

  async function renderWorkDir() {
    const res = await ipcRenderer.invoke('workdir:get')
    const dir = res && res.ok ? res.dir : null
    const free = res && res.ok ? res.free : null
    if (dir) {
      workdirLabel.textContent = `Temp files: ${dir}${Number.isFinite(free) ? ` · ${humanBytes(free)} free` : ''}`
      workdirLabel.title = dir
      workdirResetBtn.hidden = false
    } else {
      workdirLabel.textContent = 'Temp files: beside the output (default)'
      workdirLabel.title = 'Merge preprocessing writes its temp files next to the merged output'
      workdirResetBtn.hidden = true
    }
  }

  async function pickWorkDir() {
    if (state.busy) return
    const res = await ipcRenderer.invoke('workdir:pick')
    if (res && res.ok && !res.canceled) renderWorkDir()
  }

  async function resetWorkDir() {
    if (state.busy) return
    await ipcRenderer.invoke('workdir:reset')
    renderWorkDir()
  }

  function render() {
    listEl.textContent = ''
    files.forEach((file, index) => {
      const li = document.createElement('li')
      const name = document.createElement('span')
      // textContent: file names are untrusted input — this page runs
      // in a privileged context (nodeIntegration).
      name.className = 'merge-name'
      name.textContent = path.basename(file)
      name.title = file
      const remove = document.createElement('button')
      remove.className = 'merge-x'
      remove.type = 'button'
      remove.textContent = '✕'
      remove.title = 'Remove from the merge list'
      remove.addEventListener('click', () => {
        files.splice(index, 1)
        render()
      })
      li.appendChild(name)
      li.appendChild(remove)
      listEl.appendChild(li)
    })
    startBtn.disabled = files.length < 2
    startBtn.textContent = files.length < 2 ? 'Merge (2+ files)' : `Merge ${files.length} files`
  }

  function addFiles(paths) {
    let added = 0
    for (const filePath of paths) {
      if (typeof filePath === 'string' && filePath && !files.includes(filePath)) {
        files.push(filePath)
        added++
      }
    }
    if (added) render()
    return added
  }

  async function pickFiles() {
    const paths = await ipcRenderer.invoke('dialog:open-multi')
    if (paths && paths.length) addFiles(paths)
  }

  async function mergeNow() {
    if (state.busy) return
    if (files.length < 2) {
      setStatus('Select at least two files to merge.', 'err')
      return
    }

    const first = files[0]
    const extname = path.extname(first)
    const ext = extname.slice(1).toLowerCase() || 'mp4'
    const base = path.basename(first, extname) || 'merged'

    const output = await ipcRenderer.invoke('dialog:save', {
      title: 'Save merged video as…',
      defaultPath: path.join(path.dirname(first), `${base} [merged].${ext}`),
      filters: [
        { name: `${ext.toUpperCase()} file`, extensions: [ext] },
        { name: 'All files', extensions: ['*'] },
      ],
    })
    if (!output) return // canceled

    closeSheet('merge')
    // Progress is real on both paths now: the copy concat reports
    // time= over the joined duration, the normalize path maps every
    // per-file step plus the final concat into one fraction.
    setBusy(true, { label: 'Merging…', progress: true })
    setStatus(`Merging ${files.length} files — ${path.basename(output)}${state.muted ? ' (silent)' : ''}…`)

    // MUTE applies here too: while the toggle is on, the merged file
    // is written without its audio streams.
    const result = await ipcRenderer.invoke('job:start', {
      kind: 'merge',
      inputs: [...files],
      output,
      muted: !!state.muted,
    })

    if (result && result.ok) {
      state.lastOutput = output
      // The merge engine reports its own story: which path ran
      // (copy / normalize), what was re-encoded, what was skipped.
      const total = files.length
      const parts = [`Merged ${result.merged || total} of ${total} files into ${path.basename(output)} — `]
      if (result.mode === 'normalize') {
        parts.push(`normalized (re-encoded ${result.reencoded || 0} of ${result.merged || total}${state.muted ? ', silent' : ''}).`)
      } else {
        parts.push(`lossless copy${state.muted ? ', silent' : ''}.`)
      }
      const skipped = Array.isArray(result.skipped) ? result.skipped : []
      if (skipped.length) {
        parts.push(` Skipped: ${skipped.map(s => path.basename(s.file || '?') + ' (' + (s.reason || 'failed') + ')').join(', ')}.`)
      }
      setStatus(parts.join(''), skipped.length ? '' : 'ok')
    } else {
      setStatus(`Merge failed: ${(result && result.error) || 'unknown error'}`, 'err')
    }
    setBusy(false)
    files = []
    render()
  }

  addBtn.addEventListener('click', pickFiles)
  clearBtn.addEventListener('click', () => { files = []; render() })
  startBtn.addEventListener('click', mergeNow)
  closeBtn.addEventListener('click', () => { if (!state.busy) closeSheet('merge') })
  workdirChangeBtn.addEventListener('click', pickWorkDir)
  workdirResetBtn.addEventListener('click', resetWorkDir)

  /* Toolbar entry: multi-pick, then reveal the sheet. A single pick
   * behaves as a regular open (original behavior). */
  els.mergeBtn.addEventListener('click', async () => {
    if (state.busy) return
    const paths = await ipcRenderer.invoke('dialog:open-multi')
    if (!paths || !paths.length) return
    if (paths.length === 1) {
      loadFile(paths[0])
      return
    }
    addFiles(paths)
    open()
  })

  function open() {
    render()
    renderWorkDir()
    openSheet('merge')
  }

  return {
    addFiles,
    clear: () => { files = []; render() },
    files: () => [...files],
    open,
    close: () => closeSheet('merge'),
    mergeNow,
    renderWorkDir,
  }
}
