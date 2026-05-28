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
