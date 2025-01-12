# Vid-Cut

[Flawless-Cut](https://github.com/metadream/app-flawless-cut) with some custom additions.

![Software Interface](https://raw.githubusercontent.com/metadream/app-flawless-cut/master/screenshot.png)

## Upgraded Feature

- Irrdescent glowing buttons
- Speed control for precise cutting

## Standard Factory Features

- Losslessly cut video/audio in common formats (fast)
- Losslessly merge video/audio clips of the same encoding format (fast)
- Lossy cut video/audio and convert to MP4 format (slow)
- Lossy cut or extract audio from video and convert to MP3 format (slow)
- Capture video frames as pictures with the smallest file and highest quality
- Record output of screen and microphone
- Visualization of audio sound waves

## Supported Formats

Since Vid-Cut is based on Chromium core and HTML5 video player, not all ffmpeg supported formats are supported directly. In order to use this application faster and smoother, the following formats/codecs should generally be imported: MP4, MOV, WebM, MKV, OGG, WAV, MP3, AAC, H264, Theora, VP8, VP9\. Related for more information on Chromium's supported formats/codecs, see <https://www.chromium.org/audio-video。>

For formats not supported by Chromium, Vid-Cut uses fast real-time transcoding and playback technology, which allows play all videos which ffmpeg can be decoded, and the cut result is still lossless. But unfortunately, especially in the case of large video files, the efficiency of this method (accurately in terms of tracking fluency) is still not the same as the native support format.

## Develop and Build

### 1. Install NODE & NPM

### 2. Install Dependencies

```
export ELECTRON_MIRROR="https://npm.taobao.org/mirrors/electron/"
npm install
```

### 3. Run and Debug

```
npm start
```

If you have problems when opening video files, try the following commands:

```
chmod +x app/bin/*
sudo apt install -y libmediainfo-dev
```

### 4. Build by Platform

```
npm run build:linux
npm run build:win
```
