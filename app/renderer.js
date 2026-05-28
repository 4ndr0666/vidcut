// app/renderer.js
const electron = require('electron')
const ffmpeg = require('./ffmpeg')
const videoEnhanced = require('./video')
const Player = require('./player')
const Merger = require('./merger')
const Recorder = require('./recorder')

// Feature buttons
const openFileBtn = $('#open-file')
const captureBtn = $('.capture')
const extractBtn = $('.extract')
const convertBtn = $('.convert')
const cutBtn = $('.cut')
const openFilesBtn = $('.open-files')
const openRecordBtn = $('.open-record')
const helpBtn = $('.help')
const slowDownBtn = $('.slow-down')
const speedUpBtn = $('.speed-up')

// Components
const { dialog } = require('@electron/remote')
const video = Object.assign($('video'), videoEnhanced)
const player = new Player(video)
const merger = new Merger()
const recorder = new Recorder()

/* --------------------------------------------------------
 * Open file events
 * ----------------------------------------------------- */

openFileBtn.ondragover = function() {
  return false
}

openFileBtn.ondragenter = function(e) {
  e.preventDefault()
  this.classList.add('ondrag')
}

openFileBtn.ondragleave = function(e) {
  e.preventDefault()
  this.classList.remove('ondrag')
}

openFileBtn.ondrop = function(e) {
  e.preventDefault()
  const path = e.dataTransfer.files[0].path
  if (path) video.setSource(path)
}

openFileBtn.onclick = async function() {
  const { canceled, filePaths } = await openFileDialog()
  if (!canceled && filePaths && filePaths.length == 1) {
    video.setSource(filePaths[0])
  }
}

openFilesBtn.onclick = async function() {
  const { canceled, filePaths } = await openFileDialog(true)
  if (!canceled && filePaths && filePaths.length > 1) {
    video.sources = filePaths
    merger.setFileList(filePaths)
  }
}

openRecordBtn.onclick = function() {
  recorder.show()
}

/* --------------------------------------------------------
 * Feature Events
 * ----------------------------------------------------- */

captureBtn.onclick = function() {
  ffmpeg.captureImage(video)
}

extractBtn.onclick = function() {
  ffmpeg.extractAudio(video, player.getSegmentStartTime(), player.getSegmentEndTime())
}

convertBtn.onclick = function() {
  ffmpeg.convertVideo(video.source, player.getSegmentStartTime(), player.getSegmentEndTime())
}

cutBtn.onclick = function() {
  ffmpeg.cutVideo(video.source, player.getSegmentStartTime(), player.getSegmentEndTime())
}

helpBtn.onclick = function() {
  electron.shell.openExternal('https://github.com/4ndr0666/vidcut')
}

slowDownBtn.onclick = function() {
  if (video.playbackRate > 0.25) {
    video.playbackRate -= 0.25;
    console.log(`Playback Rate: ${video.playbackRate}x`);
  }
}

speedUpBtn.onclick = function() {
  if (video.playbackRate < 4.0) {
    video.playbackRate += 0.25;
    console.log(`Playback Rate: ${video.playbackRate}x`);
  }
}

/* --------------------------------------------------------
 * Player Events
 * ----------------------------------------------------- */

player.onload = function() {
  openFileBtn.style.opacity = 0
  cutBtn.disabled = false
  captureBtn.disabled = false
  extractBtn.disabled = false
  convertBtn.disabled = false
  slowDownBtn.disabled = false
  speedUpBtn.disabled = false
}

player.onerror = function() {
  openFileBtn.style.opacity = 1
  cutBtn.disabled = true
  captureBtn.disabled = true
  extractBtn.disabled = true
  convertBtn.disabled = true
  slowDownBtn.disabled = true
  speedUpBtn.disabled = true
}

/* --------------------------------------------------------
 * Merger Events
 * ----------------------------------------------------- */

merger.onmerge = function() {
  ffmpeg.mergeVideos(video.sources)
}

/* --------------------------------------------------------
 * Private Methods
 * ----------------------------------------------------- */

function openFileDialog(multiple = false) {
  return dialog.showOpenDialog({
    properties: ['openFile', multiple ? 'multiSelections' : false],
    filters: [
      { name: 'Media Files', extensions: [
        '3gp', 'asf', 'avi', 'dat', 'flv',
        'mkv', 'mov', 'mp4', 'mpg', 'mpeg', 'ogg', 'rm', 'rmvb', 'vob', 'wmv',
        'aac', 'ape', 'alac', 'flac', 'mp3', 'wav'
      ]},
      { name: 'All Files', extensions: ['*'] }
    ]
  })
}

// app/ffmpeg.js
const { execFile } = require('child_process')
const stringToStream = require('string-to-stream')
const path = require('path')

const postfix = process.platform == 'win32' ? '.exe' : '';
const ffmpeg = path.join(__dirname, 'bin/ffmpeg' + postfix)
const mediainfo = path.join(__dirname, 'bin/mediainfo' + postfix)

function ffmpegCommand(args, options) {
  loading(true)
  const process = execFile(ffmpeg, args, options, (error, _stdout, stderr) => {
    if (stderr instanceof Buffer) return

    loading(false)
    if (error) {
      error = error.toString().trim()
      error = error.substring(error.lastIndexOf('\n') + 1)
      error = error.substring(error.lastIndexOf(':') + 1)
      alert(error)
    }
  })

  process.stderr.on('data', stderr => {
    const match = / time\=(\d{2}:\d{2}:\d{2}\.\d{2,3}) /.exec(stderr)
    if (match) {
      process.ontimeupdate && process.ontimeupdate(match[1])

      const index = args.indexOf('-t')
      if (index > -1) {
        const duration = args[index + 1]
        const progress = Math.round((parseDuration(match[1]) / duration) * 100)
        loading(progress)
      }
    }
  })
  return process
}

function wfRecorderCommand(args, options) {
  loading(true)
  const process = execFile('wf-recorder', args, options, (error, _stdout, stderr) => {
    loading(false)
    if (error && !error.killed) {
      alert(`wf-recorder error: ${error.message}`)
    }
  })
  return process
}

function parseSegment(startTime, endTime) {
  const start = parseDuration(startTime)
  const end = parseDuration(endTime)
  if (start >= end) {
    alert('Start time cannot be later than end time')
    return false
  }
  return {
    start, duration: end - start
  }
}

function formatOutputFile(videoPath, startTime, endTime, extname) {
  const suffix = ('-' + startTime + '-' + endTime).replace(/:/g, '.')
  return videoPath + suffix + (extname || path.extname(videoPath))
}

module.exports = {

  cutVideo(videoPath, startTime, endTime) {
    const outputFile = formatOutputFile(videoPath, startTime, endTime)
    const segment = parseSegment(startTime, endTime)
    if (!segment) return

    // -i 放在 -ss 之前表示不使用关键帧技术；-i 放在 -ss 之后表示使用关键帧技术
    // 不使用关键帧剪切后视频开头可能存在几秒定格画面；使用关键帧截取速度快，但时间不精确，
    // 并且如果结尾不是关键帧，则可能出现一段空白（参数 avoid_negative_ts 可解决）
    return ffmpegCommand([
      '-ss', segment.start, '-t', segment.duration, '-accurate_seek', '-i', videoPath,
      '-vcodec', 'copy', '-acodec', 'copy', '-avoid_negative_ts', 1, '-y', outputFile
    ])
  },

  convertVideo(videoPath, startTime, endTime) {
    const outputFile = formatOutputFile(videoPath, startTime, endTime, '.mp4')
    const segment = parseSegment(startTime, endTime)
    if (!segment) return

    // crf=18 is very close to lossless
    return ffmpegCommand([
      '-i', videoPath, '-ss', segment.start, '-t', segment.duration,
      '-c:v', 'libx264', '-preset:v', 'veryfast', '-crf', 18, '-y', outputFile
    ])
  },

  extractAudio(video, startTime, endTime) {
    const segment = parseSegment(startTime, endTime)
    if (!segment) return

    const bitrate = video.getMetadata('Audio.BitRate')
    const args = bitrate ? (bitrate > 320000 ? ['-b:a', '320k'] : ['-b:a', bitrate]) : ['-q:a', 0]
    const outputFile = formatOutputFile(video.source, startTime, endTime, '.mp3')

    return ffmpegCommand([
      '-ss', segment.start, '-t', segment.duration, '-i', video.source,
      ...args, '-vn', '-y', outputFile
    ])
  },

  captureImage(video) {
    const currentTime = formatDuration(video.getCurrentTime())
    const outputFile = formatOutputFile(video.source, currentTime, 1, '.jpg')
    return ffmpegCommand([
      '-ss', currentTime, '-i', video.source, '-vframes', 1,
      '-f', 'mjpeg', '-q:v', 2, '-y', outputFile
    ])
  },

  mergeVideos(videoPaths) {
    const outputFile = videoPaths[0] + '-merged' + path.extname(videoPaths[0])
    const process = ffmpegCommand([
      '-f', 'concat', '-safe', '0', '-protocol_whitelist', 'file,pipe',
      '-i', '-', '-c', 'copy', '-y', outputFile,
    ])

    const videoList = videoPaths.map(path => "file '" + path + "'").join('\n')
    stringToStream(videoList).pipe(process.stdin)
    return process
  },

  async recordVideo(outputPath) {
    if (process.platform === 'linux' && process.env.WAYLAND_DISPLAY) {
      const timestamp = (new Date()).toISOString().replace(/[-:T]/g, '').slice(2, 14);
      const outputFile = path.join(outputPath, `box-${timestamp}.mp4`);
      
      return wfRecorderCommand([
        '--audio', 
        '--no-damage', 
        '--framerate', '60', 
        '-c', 'libx264', 
        '-p', 'qp=0', 
        '-f', outputFile
      ]);
    } else {
      const outputFile = outputPath + '\\screen-record-' + (new Date()).format() + '.mp4'
      const audioDevice = await this.getAudioDevice()
      const audioArgs = audioDevice ? ['-f', 'dshow', '-i', 'audio=' + audioDevice] : []

      return ffmpegCommand([
        '-f', 'gdigrab', '-i', 'desktop', ...audioArgs,
        '-c:v', 'libx264', '-c:a', 'aac', '-q:a', 0,
        '-y', outputFile
      ])
    }
  },

  fastCodec(videoPath, fileSize, startTime) {
    // -frag_duration: Create fragments that are duration microseconds long.
    return ffmpegCommand([
      '-ss', startTime, '-i', videoPath, '-preset:v', 'ultrafast',
      '-f', 'mp4', '-frag_duration', 1000000, 'pipe:1',
    ], {
      encoding: 'buffer', maxBuffer: Number(fileSize),
    })
  },

  getAudioDevice() {
    return new Promise(resolve => {
      execFile(ffmpeg, ['-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], (_error, _stdout, stderr) => {
        const lines = stderr.split('\n')
        lines.some((line, i) => {
          let match = /^\[dshow.+\] DirectShow audio devices$/.exec(line.trim())
          if (match) {
            match = /^\[dshow.+\] +"(.+)"$/.exec(lines[i+1].trim())
            if (match) resolve(match[1])
            return true
          }
        })
      })
    })
  },

  getMediaInfo(videoPath) {
    return new Promise(resolve => {
      execFile(mediainfo, [videoPath, '--Output=JSON'], (error, stdout) => {
        if (error) {
          alert('Get media information failed')
          return
        }
        if (stdout.trim()) {
          const mediaTrack = JSON.parse(stdout).media.track
          const mediaInfo = {}
          // @type: General, Video, Audio, ...
          mediaTrack.forEach(track => mediaInfo[track['@type']] = track)
          resolve(mediaInfo)
        }
      })
    })
  }

}

<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Roboto+Mono:wght@500&family=Orbitron:wght@700&display=swap" rel="stylesheet">
    <link rel="stylesheet" type="text/css" href="./main.css">
  </head>

  <body>
    <main>
      <video></video><canvas></canvas>
      <div id="open-file">
        <svg class="glyph-icon" viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">
          <path class="glyph-ring-1" d="M 64,12 A 52,52 0 1 1 63.9,12 Z" />
          <path class="glyph-ring-2" d="M 64,20 A 44,44 0 1 1 63.9,20 Z" />
          <path class="glyph-hex" d="M64 30 L91.3 47 L91.3 81 L64 98 L36.7 81 L36.7 47 Z" />
          <text x="64" y="67" text-anchor="middle" dominant-baseline="middle" font-size="56" font-weight="700">Ψ</text>
        </svg>
        <span>Initialize Video Source</span>
      </div>
    </main>

    <div class="toolbar">
      <div class="timeline">
        <span id="currentTime">00:00:00.000</span> / <span id="duration">00:00:00.000</span>
        <div id="segment"></div>
        <div id="progress"></div>
      </div>

      <div class="controls">
        <button class="hud-button video-start" title="To the start of video" disabled>|◀</button>
        <button class="hud-button segment-start" title="To the start of segment" disabled>[</button>
        <input id="segment-start-time" maxlength="12" value="00:00:00.000" disabled/>
        <button class="hud-button cut-start" title="Cut the start of segment" disabled>✂ Start</button>
        
        <button class="hud-button slow-down" title="Decrease playback rate" disabled>⏪</button>
        <button class="hud-button play" disabled>▶</button>
        <button class="hud-button speed-up" title="Increase playback rate" disabled>⏩</button>
        
        <button class="hud-button cut-end" title="Cut the end of segment" disabled>✂ End</button>
        <input id="segment-end-time" maxlength="12" value="00:00:00.000" disabled/>
        <button class="hud-button segment-end" title="To the end of segment" disabled>]</button>
        <button class="hud-button video-end" title="To the end of video" disabled>▶|</button>
      </div>

      <div class="features">
        <button class="hud-button capture" title="Capture Frame as JPG" disabled>Capture</button>
        <button class="hud-button extract" title="Extract Audio as MP3" disabled>Extract</button>
        <button class="hud-button convert" title="Convert Segment as MP4" disabled>Convert</button>
        <button class="hud-button cut" title="Lossless Cut" disabled>FLAWLESS CUT</button>
        <button class="hud-button open-files" title="Open Videos to Merge">Merge Files</button>
        <button class="hud-button open-record" title="Record Screen">Record</button>
        <button class="hud-button help" title="Online Help">Help</button>
      </div>
    </div>

    <script src="./renderer.js"></script>
  </body>
</html>

/* app/main.css */
:root {
  /* Foundations */
  --bg-dark-base: #050A0F;
  --bg-glass-panel: rgba(10, 19, 26, 0.25);
  
  /* The Cyan Matrix */
  --accent-cyan: #00E5FF;
  --text-cyan-active: #67E8F9;
  --text-secondary: #8892B0;
  --accent-cyan-border-idle: rgba(0, 229, 255, 0.2);
  --accent-cyan-border-hover: rgba(0, 229, 255, 0.5);
  --accent-cyan-bg-hover: rgba(0, 229, 255, 0.05);
  --accent-cyan-bg-active: rgba(0, 229, 255, 0.2);
  --glow-cyan-active: rgba(0, 229, 255, 0.6);
  
  /* Typography */
  --font-body: 'Roboto Mono', monospace;
  --font-display: 'Orbitron', sans-serif;
}

body {
  margin: 0;
  padding: 0;
  background-color: var(--bg-dark-base);
  color: var(--text-cyan-active);
  font-family: var(--font-body);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  height: 100vh;
}

/* Main Viewport */
main {
  flex-grow: 1;
  position: relative;
  display: flex;
  justify-content: center;
  align-items: center;
  background: #000;
}

video {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

/* Drop Zone & Glyph Integration */
#open-file {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1.5rem;
  padding: 3rem 5rem;
  background: var(--bg-glass-panel);
  border: 1px solid var(--accent-cyan-border-idle);
  backdrop-filter: blur(8px);
  transition: all 0.3s ease;
  z-index: 10;
  cursor: pointer;
}

#open-file span {
  font-family: var(--font-display);
  font-size: 1.25rem;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.1em;
  transition: color 0.3s ease;
}

.glyph-icon {
  width: 80px;
  height: 80px;
  fill: none;
  stroke: var(--text-secondary);
  stroke-width: 3;
  stroke-linecap: round;
  stroke-linejoin: round;
  transition: all 0.3s ease;
}

.glyph-icon text {
  fill: var(--text-secondary);
  stroke: none;
  font-family: var(--font-display);
  transition: fill 0.3s ease;
}

.glyph-ring-1 { stroke-dasharray: 21.78 21.78; stroke-width: 2; }
.glyph-ring-2 { stroke-dasharray: 10 10; stroke-width: 1.5; opacity: 0.7; }

#open-file.ondrag, #open-file:hover {
  border-color: var(--accent-cyan);
  box-shadow: 0 0 20px var(--glow-cyan-active);
  background: var(--accent-cyan-bg-hover);
}

#open-file.ondrag span, #open-file:hover span {
  color: var(--accent-cyan);
}

#open-file.ondrag .glyph-icon, #open-file:hover .glyph-icon {
  stroke: var(--accent-cyan);
  filter: drop-shadow(0 0 8px var(--glow-cyan-active));
}

#open-file.ondrag .glyph-icon text, #open-file:hover .glyph-icon text {
  fill: var(--accent-cyan);
}

/* Bottom Toolbar Glass Panel */
.toolbar {
  background: var(--bg-glass-panel);
  backdrop-filter: blur(12px);
  border-top: 1px solid var(--accent-cyan-border-idle);
  padding: 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

/* Timeline */
.timeline {
  display: flex;
  align-items: center;
  font-size: 0.875rem;
  color: var(--text-secondary);
  position: relative;
  height: 24px;
}

#currentTime, #duration {
  color: var(--text-cyan-active);
  font-weight: 700;
  margin: 0 0.75rem;
}

#progress, #segment {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  height: 4px;
  border-radius: 2px;
  pointer-events: none;
}

#progress {
  left: 0;
  background-color: var(--accent-cyan);
  box-shadow: 0 0 8px var(--glow-cyan-active);
  z-index: 2;
}

#segment {
  background-color: rgba(0, 229, 255, 0.2);
  border: 1px solid var(--accent-cyan-border-idle);
  z-index: 1;
}

/* HUD Buttons */
.hud-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0.5rem 1rem;
  border: 1px solid transparent;
  font-family: var(--font-body);
  font-weight: 500;
  font-size: 0.875rem;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--text-secondary);
  background-color: rgba(0, 0, 0, 0.3);
  cursor: pointer;
  transition: all 300ms ease-in-out;
}

.hud-button:hover:not(:disabled) {
  color: var(--accent-cyan);
  border-color: var(--accent-cyan-border-hover);
  background-color: var(--accent-cyan-bg-hover);
}

.hud-button:active:not(:disabled), .hud-button.active {
  color: var(--text-cyan-active);
  background-color: var(--accent-cyan-bg-active);
  border-color: var(--accent-cyan);
  box-shadow: 0 0 15px var(--glow-cyan-active);
}

.hud-button:disabled {
  opacity: 0.2;
  cursor: not-allowed;
}

.hud-button:focus {
  outline: 2px solid var(--accent-cyan);
  outline-offset: 2px;
}

/* Prominent cut button */
.hud-button.cut {
  color: var(--accent-cyan);
  border-color: var(--accent-cyan-border-idle);
  font-family: var(--font-display);
}

/* HUD Input Fields */
input[type="text"], input[id^="segment"] {
  background: rgba(0, 0, 0, 0.6);
  border: 1px solid var(--accent-cyan-border-idle);
  color: var(--text-cyan-active);
  font-family: var(--font-body);
  padding: 0.5rem;
  text-align: center;
  width: 130px;
}

input:focus {
  outline: 2px solid var(--accent-cyan);
  outline-offset: 2px;
}

.controls, .features {
  display: flex;
  justify-content: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

/* Contingency Fallback */
@supports not (backdrop-filter: blur(1px)) {
  .toolbar, #open-file {
    background: rgba(10, 19, 26, 0.95);
  }
}
