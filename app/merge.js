/* vidcut merge sheet — file list, add/remove, merge dispatch.
 *
 * THE panel: this sheet's ancestor in the original app rendered
 * expanded on init and pushed the flexbox around until closed.
 * Here it is `hidden` in markup and only ever revealed by explicit
 * user action — the failure is structurally impossible, not merely
 * patched around. The merge job runs through the shared busy lock
 * (single ffmpeg slot, same as every other tool). */

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
    setBusy(true, { label: 'Merging…', progress: false }) // concat copy: indeterminate
    setStatus(`Merging ${files.length} files — ${path.basename(output)}…`)

    const result = await ipcRenderer.invoke('job:start', {
      kind: 'merge',
      inputs: [...files],
      output,
    })

    if (result && result.ok) {
      state.lastOutput = output
      setStatus(`Merged ${files.length} files into ${path.basename(output)}.`, 'ok')
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
    openSheet('merge')
  })

  return {
    addFiles,
    clear: () => { files = []; render() },
    files: () => [...files],
    open: () => { render(); openSheet('merge') },
    close: () => closeSheet('merge'),
    mergeNow,
  }
}
