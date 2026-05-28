// app/merger.js
const { basename } = require('path')

module.exports = class {

  constructor() {
    this.container = $(`
      <div class="merger" style="background: var(--bg-glass-panel); backdrop-filter: blur(12px); border: 1px solid var(--accent-cyan-border-idle); color: var(--text-secondary); font-family: var(--font-body);">
        <div class="content">
          <div class="title" style="color: var(--text-cyan-active); font-family: var(--font-display); font-size: 1.2rem; margin-bottom: 1rem; text-transform: uppercase;">File List</div><ol></ol>
        </div>
        <div class="footer" style="display: flex; gap: 0.5rem; justify-content: flex-end; margin-top: 1.5rem;">
          <button class="hud-button merge">Merge</button>
          <button class="hud-button cancel">Cancel</button>
        </div>
      </div>
    `)

    this.fileList = this.container.$('ol')
    this.mergeBtn = this.container.$('button.merge')
    this.cancelBtn = this.container.$('button.cancel')
    document.body.appendChild(this.container)

    this.mergeBtn.onclick = () => {
      this.onmerge()
    }
    this.cancelBtn.onclick = () => {
      this.container.style.display = 'none'
    }
  }

  setFileList(filePaths) {
    this.container.style.display = 'flex'
    this.fileList.innerHTML = ''

    filePaths.forEach(filePath => {
      this.fileList.appendChild($('<li>' + basename(filePath) + '</li>'))
    })
  }

}
