/* vidcut waveform — frequency visualizer for audio-only sources.
 *
 * The MediaElementSource is attached lazily on first use and ONLY
 * for native (file://) playback: routing the element through Web
 * Audio is irreversible, and a cross-origin stream (the http
 * transcode fallback) would be muted by Chromium's taint rules — so
 * streams never attach. The canvas tracks the stage size with
 * devicePixelRatio crispness and draws mirrored bars blooming from
 * the center out, cyan on glass. */

class Wave {
  constructor(canvas) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')
    this.audioContext = null
    this.analyser = null
    this.data = null
    this.attached = false
    this.visible = false
    this.playing = false
    this.width = 0
    this.height = 0
    this.BARS = 64 // bars per side of the mirror

    this._onResize = () => { if (this.visible) this.resize() }
    window.addEventListener('resize', this._onResize)
  }

  /* Irreversible: once attached, the element's audio flows through
   * the graph (analyser → destination). Call only for same-origin
   * (file://) playback. */
  attach(element) {
    if (this.attached) return
    this.attached = true
    this.audioContext = new AudioContext()
    const source = this.audioContext.createMediaElementSource(element)
    this.analyser = this.audioContext.createAnalyser()
    this.analyser.fftSize = 256
    source.connect(this.analyser)
    this.analyser.connect(this.audioContext.destination)
    this.data = new Uint8Array(this.analyser.frequencyBinCount)
  }

  play() {
    if (!this.attached || !this.visible) return
    if (this.audioContext.state === 'suspended') this.audioContext.resume()
    if (this.playing) return
    this.playing = true
    this.dance()
  }

  pause() {
    this.playing = false
  }

  show() {
    this.visible = true
    this.canvas.hidden = false
    this.resize()
  }

  hide() {
    this.visible = false
    this.playing = false
    this.canvas.hidden = true
  }

  isActive() {
    return this.visible
  }

  destroy() {
    window.removeEventListener('resize', this._onResize)
    this.hide()
  }

  /* Size the backing store to the actual stage (not a fixed 1024x600),
   * keeping devicePixelRatio crispness. */
  resize() {
    const parent = this.canvas.parentElement
    if (!parent) return
    const rect = parent.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    const dpr = window.devicePixelRatio || 1
    this.canvas.width = Math.round(rect.width * dpr)
    this.canvas.height = Math.round(rect.height * dpr)
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    this.width = rect.width
    this.height = rect.height
  }

  dance() {
    if (!this.playing || !this.visible || !this.attached) return
    this.analyser.getByteFrequencyData(this.data)
    this.visualize(this.data)
    requestAnimationFrame(() => this.dance())
  }

  visualize(freq) {
    const width = this.width
    const height = this.height
    this.ctx.clearRect(0, 0, width, height)
    if (!width || !height) return

    const bars = this.BARS
    const step = Math.max(1, Math.floor(freq.length / bars))
    const slot = width / (bars * 2)
    const barWidth = Math.max(1, slot - 2)

    for (let i = 0; i < bars; i++) {
      let sum = 0
      for (let k = 0; k < step; k++) sum += freq[i * step + k] || 0
      const value = sum / step / 255
      if (value <= 0.004) continue

      const barHeight = Math.max(2, value * height * 0.5)
      const y = (height - barHeight) / 2
      const alpha = (0.35 + 0.65 * (i / bars)).toFixed(3)
      this.ctx.fillStyle = `rgba(0, 229, 255, ${alpha})`
      // Mirrored pair: low frequencies bloom from the center out.
      this.ctx.fillRect(width / 2 - (i + 1) * slot + 1, y, barWidth, barHeight)
      this.ctx.fillRect(width / 2 + i * slot + 1, y, barWidth, barHeight)
    }
  }
}

module.exports = Wave
