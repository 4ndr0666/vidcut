// app/recorder.js
const electron = require('electron')
const outputPath = require('@electron/remote').getGlobal('desktop')
const ffmpeg = require('./ffmpeg')

module.exports = class {
  constructor() {
    this.container = $(`
      <div class="recorder" style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); display: none; align-items: center; justify-content: center; z-index: 100;">
        <div style="background: var(--bg-glass-panel); backdrop-filter: blur(12px); border: 1px solid var(--accent-cyan-border-idle); padding: 2rem; display: flex; flex-direction: column; align-items: center; gap: 1rem; box-shadow: 0 0 20px rgba(0, 229, 255, 0.1);">
          <div class="duration" style="font-family: var(--font-display); font-size: 2rem; color: var(--accent-cyan); text-shadow: 0 0 10px var(--glow-cyan-active);">00:00:00.00</div>
          <div style="display: flex; gap: 1rem;">
            <button class="hud-button start">Start</button>
            <button class="hud-button stop" style="display: none;">Stop</button>
          </div>
        </div>
      </div>
    `)

    this.duration = this.container.$('.duration')
    this.startBtn = this.container.$('button.start')
    this.stopBtn = this.container.$('button.stop')
    document.body.appendChild(this.container)

    this.container.onclick = e => this.onmaskclick(e)
    this.startBtn.onclick = () => this.createProcess()
    this.stopBtn.onclick = () => this.exitProcess()
  }

  async createProcess() {
    this.startBtn.disabled = true
    this.process = await ffmpeg.recordVideo(outputPath)

    this.process.ontimeupdate = res => {
      this.duration.innerHTML = res
      if (!this.started) {
        this.started = true
        this.startBtn.style.display = 'none'
        this.stopBtn.style.display = 'block'
        this.container.onclick = null
        electron.ipcRenderer.send('create-tray')
      }
    }
    this.process.on('exit', () => {
      this.started = false
      this.startBtn.disabled = false
      this.startBtn.style.display = 'block'
      this.stopBtn.style.display = 'none'
      this.container.onclick = e => this.onmaskclick(e)
    })
  }

  exitProcess() {
    this.process.stdin.write('q')
    electron.ipcRenderer.send('remove-tray')
  }

  onmaskclick(e) {
    if (e.currentTarget === e.target) {
      this.container.style.display = 'none'
    }
  }

  show() {
    this.container.style.display = 'flex'
  }

}
