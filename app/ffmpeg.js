const { execFile } = require('child_process')
const stringToStream = require('string-to-stream')
const path = require('path')

// Arch Linux exclusively relies on system binaries
const ffmpeg = path.join(__dirname, 'bin/ffmpeg')
const mediainfo = path.join(__dirname, 'bin/mediainfo')

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

// Native Wayland Screen Recording Spawner
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

    return ffmpegCommand([
      '-ss', segment.start, '-t', segment.duration, '-accurate_seek', '-i', videoPath,
      '-vcodec', 'copy', '-acodec', 'copy', '-avoid_negative_ts', 1, '-y', outputFile
    ])
  },

  convertVideo(videoPath, startTime, endTime) {
    const outputFile = formatOutputFile(videoPath, startTime, endTime, '.mp4')
    const segment = parseSegment(startTime, endTime)
    if (!segment) return

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

  // Completely stripped of win32 gdigrab runtime scaffolding
  async recordVideo(outputPath) {
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
  },

  fastCodec(videoPath, fileSize, startTime) {
    return ffmpegCommand([
      '-ss', startTime, '-i', videoPath, '-preset:v', 'ultrafast',
      '-f', 'mp4', '-frag_duration', 1000000, 'pipe:1',
    ], {
      encoding: 'buffer', maxBuffer: Number(fileSize),
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
          mediaTrack.forEach(track => mediaInfo[track['@type']] = track)
          resolve(mediaInfo)
        }
      })
    })
  }
}
