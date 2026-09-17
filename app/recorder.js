/* vidcut — wf-recorder supervision in the main process (Wayland
 * screen capture). The child is owned HERE, never by the renderer,
 * so a window reload or close can never orphan a running recording.
 *
 * Lifecycle: start() spawns wf-recorder with -f <output>; stop()
 * sends SIGINT — the only signal wf-recorder finalizes its container
 * with (stdin 'q' is an ffmpeg-ism that does nothing here) — and
 * escalates to SIGKILL after 3 s. State changes surface through
 * 'started' / 'stopped' / 'failed' events, never through polling.
 *
 * Paradigm: main-process orchestrator; failures reset the machine. */

const { spawn } = require('child_process')
const path = require('path')
const EventEmitter = require('events')

const STOP_ESCALATE_MS = 3000

class Recorder extends EventEmitter {
  constructor() {
    super()
    this.proc = null
    this.output = null
    this.startedAt = 0
    this.stopping = false
    this.escalate = null
    this.pendingStop = null
  }

  isActive() {
    return !!this.proc
  }

  status() {
    return this.proc
      ? { active: true, output: this.output, startedAt: this.startedAt }
      : { active: false, output: this.output || null, startedAt: 0 }
  }

  /* Resolves once the recorder has been spawned. A missing binary
   * surfaces asynchronously as a 'failed' event (spawn errors are
   * delivered via the process 'error' event), so the renderer always
   * drives its state machine from the events, not from this promise. */
  start(outputDir) {
    if (this.proc) return Promise.reject(new Error('Already recording'))

    const now = new Date()
    const pad = value => String(value).padStart(2, '0')
    const stamp = pad(now.getFullYear() % 100) + pad(now.getMonth() + 1) + pad(now.getDate()) +
      '-' + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds())
    this.output = path.join(outputDir, `box-${stamp}.mp4`)
    this.stopping = false
    this.startedAt = Date.now()

    let proc
    try {
      proc = spawn('wf-recorder', [
        '--audio', '--no-damage', '--framerate', '60',
        '-c', 'libx264', '-p', 'qp=0', '-f', this.output,
      ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    } catch (error) {
      this.output = null
      return Promise.reject(error)
    }
    this.proc = proc

    // Drain — a full stderr pipe stalls wf-recorder mid-capture.
    proc.stderr.on('data', () => {})

    proc.on('error', error => {
      const message = error && error.code === 'ENOENT'
        ? 'wf-recorder not found. Install it with: sudo pacman -S wf-recorder (Wayland only)'
        : String((error && error.message) || error)
      this.reset()
      this.emit('failed', message)
    })

    proc.on('close', code => {
      const wasStopping = this.stopping
      const output = this.output
      this.reset()
      if (wasStopping || code === 0) {
        this.emit('stopped', { output })
      } else {
        this.emit('failed', `wf-recorder exited with code ${code}`)
      }
      if (this.resolveStop) {
        const resolve = this.resolveStop
        this.resolveStop = null
        this.pendingStop = null
        resolve({ ok: true, output })
      }
    })

    return Promise.resolve({ output: this.output })
  }

  /* SIGINT finalize; SIGKILL escalation after 3 s guarantees no
   * zombie recorder can outlive the app. Idempotent. */
  stop() {
    if (!this.proc) return Promise.resolve({ ok: false, error: 'Not recording' })
    if (this.pendingStop) return this.pendingStop

    this.stopping = true
    this.pendingStop = new Promise(resolve => { this.resolveStop = resolve })
    try { this.proc.kill('SIGINT') } catch (e) { /* already gone */ }
    this.escalate = setTimeout(() => {
      if (this.proc) {
        try { this.proc.kill('SIGKILL') } catch (e) { /* already gone */ }
      }
    }, STOP_ESCALATE_MS)
    return this.pendingStop
  }

  /* Quit-time best effort: SIGINT so the container can finalize. */
  destroy() {
    if (this.escalate) {
      clearTimeout(this.escalate)
      this.escalate = null
    }
    if (this.proc) {
      try { this.proc.kill('SIGINT') } catch (e) { /* already gone */ }
    }
  }

  reset() {
    if (this.escalate) {
      clearTimeout(this.escalate)
      this.escalate = null
    }
    this.proc = null
    this.stopping = false
    this.startedAt = 0
  }
}

module.exports = new Recorder()
