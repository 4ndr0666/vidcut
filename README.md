# ⚡ VID-CUT : ARCH LINUX / WAYLAND EDITION ⚡

```text
       :::     ::: ::::::::::: :::::::::         ::::::::  :::    ::: ::::::::::: 
      :+:     :+:     :+:     :+:    :+:       :+:    :+: :+:    :+:     :+:      
     +:+     +:+     +:+     +:+    +:+       +:+        +:+    +:+     +:+       
    +#+     +:+     +#+     +#+    +:+       +#+        +#+    +:+     +#+        
    +#+   +#+      +#+     +#+    +#+       +#+        +#+    +#+     +#+         
    #+#+#+#       #+#     #+#    #+#       #+#    #+# #+#    #+#     #+#          
      ###     ########### #########         ########   ########      ###          

```

**Vid-Cut** is a hyper-optimized, lossless video cutter, merger, and Wayland-native screen recorder built exclusively for Arch Linux environments. Originally a fork of Flawless-Cut, this repository has undergone a total architectural overhaul to strip away legacy Windows bloated logic, replacing it with a heavily styled, terminal-inspired "Electric-Glass" UI and native integrations for `wf-recorder` under Wayland compositors (like Hyprland and Sway).

---

## 📖 TABLE OF CONTENTS

1. [Core Capabilities & Features](https://www.google.com/search?q=%231-core-capabilities--features)
2. [Architecture & Design Philosophy](https://www.google.com/search?q=%232-architecture--design-philosophy)
3. [System Requirements & Dependencies](https://www.google.com/search?q=%233-system-requirements--dependencies)
4. [Installation & Setup](https://www.google.com/search?q=%234-installation--setup)
5. [Quick Start & User Guide](https://www.google.com/search?q=%235-quick-start--user-guide)
6. [Development & Build Instructions](https://www.google.com/search?q=%236-development--build-instructions)
7. [API Reference & Internal Modules](https://www.google.com/search?q=%237-api-reference--internal-modules)
8. [The UI Directive: 3LECTRIC_GLASS_SPEC](https://www.google.com/search?q=%238-the-ui-directive-3lectric_glass_spec)
9. [Golden Reference: Superset Protocol](https://www.google.com/search?q=%239-golden-reference-superset-protocol)
10. [Troubleshooting & FAQ](https://www.google.com/search?q=%2310-troubleshooting--faq)

---

## 1. CORE CAPABILITIES & FEATURES

* **Flawless Lossless Cutting:** Utilizes FFmpeg stream copying (`-vcodec copy -acodec copy`) combined with accurate seeking parameters (`-accurate_seek`, `-avoid_negative_ts 1`) to slice video files instantly without re-encoding, avoiding quality degradation and frame-freeze artifacts.
* **Precise Speed Control Validation:** Custom speed-tweaking logic allows dynamic playback rate adjustment from `0.2x` to `2.0x` in fine `0.1x` increments, enabling surgical precision when marking segment start and end points.
* **Wayland-Native Screen Recording:** Deprecates standard X11 grabs in favor of a direct internal `child_process` spawn of `wf-recorder`. Uses `libx264`, `qp=0` for lossless visual capture, and native audio capture mapping to standard PulseAudio/PipeWire sinks.
* **Transcoding & Format Extraction:** One-click conversion to `mp4` (H.264, `crf 18` for near-lossless output at `veryfast` preset), audio extraction to `mp3` (retaining source bitrate up to 320k), and instant frame captures to high-quality `.jpg`.
* **Zero-Friction Merging:** Uses FFmpeg's `concat` demuxer to instantly string together multiple media files bypassing full re-renders.
* **Audio Waveform Visualization:** Integrated HTML5 Canvas visualizer that natively renders a matrix-cyan audio waveform when audio-only files are ingested.

---

## 2. ARCHITECTURE & DESIGN PHILOSOPHY

### The Arch / Wayland Exclusivity

Cross-platform compatibility often breeds mediocrity and bloat. Vid-Cut is unapologetically optimized for Arch Linux and Wayland. By stripping `process.platform == 'win32'` checks, eliminating `.exe` binary packaging, and burning down `gdigrab`/`dshow` Windows recording implementations, the application payload is significantly lighter and the execution paths are completely linear.

### Security Context

Vid-Cut operates under `nodeIntegration: true` and `contextIsolation: false`, utilizing `@electron/remote`. This is a deliberate design choice for a personal, local-only application. It allows frictionless IPC, direct DOM-to-Node.js bindings (such as invoking `child_process.execFile` directly from `renderer.js`), and rapid iterative development without the boilerplate of a heavily segregated Preload Context Bridge.

### The Electric Glass Aesthetic

The user interface is dictated by the **3LECTRIC_GLASS_SPEC**. This replaces standard, dull desktop application themes with a hostile, cyberpunk-adjacent aesthetic featuring deep background translucency, backdrop blurring, stark monospaced typography, and high-contrast Cyan matrix glows.

---

## 3. SYSTEM REQUIREMENTS & DEPENDENCIES

Because Vid-Cut hooks directly into the host operating system's binary layer, specific system-level dependencies are required before initializing the Electron runtime.

### Operating System

* **Distribution:** Arch Linux (or Arch-based derivatives like EndeavourOS).
* **Display Server:** Wayland (X11 is no longer supported for the screen recording module).
* **Compositor:** Hyprland, Sway, or any `wlroots`-based compositor (required for `wf-recorder` screen geometry selection).

### System Packages

You must install the following packages via `pacman` and the AUR:

```bash
# Core execution dependencies
sudo pacman -S ffmpeg mediainfo nodejs npm

# Wayland screen recording dependencies
sudo pacman -S wf-recorder slurp

# Arch Linux specific node/electron build compatibilities
yay -S libxcrypt-compat nvm

```

*Note: Ensure your `nvm` environment is properly sourced in your `.bashrc` or `.zshrc` prior to executing npm installs.*

---

## 4. INSTALLATION & SETUP

### Option A: Manual Source Setup (Recommended for Devs)

1. **Clone the Repository:**
```bash
git clone [https://github.com/4ndr0666/vidcut.git](https://github.com/4ndr0666/vidcut.git)
cd vidcut

```


2. **Configure Node Version:**
Vid-Cut is tested against Node `v18.x` and `v20.x`.
```bash
nvm install 20
nvm use 20

```


3. **Install NPM Dependencies:**
This will pull down the Electron binary and necessary builder tools.
```bash
npm install

```



### Option B: Pre-Compiled Installation (`debtap`)

If you choose to run the build script (`npm run build:linux`), Electron-Builder will generate a `.deb` file in the `dist/` directory. Since we are on Arch Linux, we utilize `debtap` from the AUR to convert and install this package natively.

1. **Install Debtap:**
```bash
yay -S debtap
sudo debtap -u # Update debtap database

```


2. **Build and Convert:**
```bash
npm run build:linux
cd dist
debtap vidcut_1.0.1_amd64.deb
sudo pacman -U vidcut-1.0.1-1-x86_64.pkg.tar.zst

```



*(Optional) Electron Mirror Configuration:*
If you encounter network timeouts fetching the Electron binaries during `npm install`, you can utilize the Taobao mirror:

```bash
export ELECTRON_MIRROR="[https://npm.taobao.org/mirrors/electron/](https://npm.taobao.org/mirrors/electron/)"
npm install

```

---

## 5. QUICK START & USER GUIDE

Launch the application in development mode to access the main HUD:

```bash
npm start

```

### 🎬 Initializing Media

Upon launch, you will be greeted by the `Ψ` (Psi) glyph dropzone. You can initialize media via three vectors:

1. **Drag and Drop:** Drag any valid `.mp4`, `.mkv`, `.avi`, or `.mp3` file directly onto the glass panel.
2. **File Explorer:** Click the central panel to invoke the native file dialog.
3. **Merge Mode:** Click the `MERGE FILES` button on the bottom toolbar to select multiple files for rapid concatenation.

### ✂️ Precision Cutting Protocol

1. Load a video into the viewport.
2. Use the **Play/Pause** (`▶`) button or the `SPACE` bar to begin playback.
3. Utilize the **Fast** (`⏩`) and **Slow** (`⏪`) buttons to adjust the playback rate. Dropping to `0.2x` speed allows you to find the exact frame required for a flawless cut.
4. Hit **`[ ✂ Start ]`** to mark the beginning of the segment. The timeline will visually update with a cyan-bordered overlay to represent the isolated chunk.
5. Hit **`[ ✂ End ]`** to mark the conclusion of the segment.
6. Press the giant cyan **`[ FLAWLESS CUT ]`** button. The application will instantly dump the cut file into the same directory as the source file, appending the timestamps to the filename.

### 🎥 Native Screen Recording (Wayland)

1. Click the **`[ Record ]`** button on the bottom right of the HUD.
2. A glassmorphism modal will drop down from the top of the window displaying a `00:00:00.00` timer.
3. Click **Start**. The app will immediately dispatch `wf-recorder` to capture your Wayland display.
4. The application will minimize to the system tray, and the icon will pulse to indicate an active recording state.
5. Click the tray icon to restore the window, and click **Stop**. The resulting `.mp4` is deposited directly onto your Desktop using the `box-YYMMDD-HHMMSS.mp4` naming convention.

### ⌨️ Keyboard Shortcuts

* `SPACE`: Toggle Play / Pause.
* `LEFT ARROW`: Seek backward by 1.0 second.
* `RIGHT ARROW`: Seek forward by 1.0 second.
* *Note: Timeline click-seeking is also fully supported.*

---

## 6. DEVELOPMENT & BUILD INSTRUCTIONS

### Running in Dev Mode

```bash
npm start

```

*Note: If you need to debug the renderer process, uncomment `mainWindow.webContents.openDevTools()` in `app/main.js` prior to starting.*

### Building the Distributable

To package the application into a standalone binary / installer, use the electron-builder target defined in `package.json`:

```bash
npm run build:linux

```

This routine packages the source code, bundles the local Node.js environment, and outputs a Debian package in the `/dist` folder.

---

## 7. API REFERENCE & INTERNAL MODULES

Vid-Cut's architecture is divided into discrete class-based modules to isolate functionality. Below is a detailed mapping of the internal APIs for future auditing and extension.

### `app/ffmpeg.js` (Core Engine)

This is the bridge between the Electron Node context and the host operating system's binaries.

* **`ffmpegCommand(args, options)`**: Core wrapper around `child_process.execFile`. Injects loading UI state, handles stream parsing for the progress bar via Regex (`/ time\=(\d{2}:\d{2}:\d{2}\.\d{2,3}) /`), and routes `stderr` to error dialogues.
* **`cutVideo(videoPath, startTime, endTime)`**: Executes the lossless cut. Uses `-accurate_seek` prior to the input flag and `-avoid_negative_ts 1` post-input to ensure frame-perfect slicing without leading blank space.
* **`convertVideo(videoPath, startTime, endTime)`**: Transcoding wrapper utilizing `libx264`, `-preset:v veryfast`, and `-crf 18`.
* **`recordVideo(outputPath)`**: The Arch/Wayland specific capture function. Spawns `wf-recorder` mapping `--audio`, `--no-damage`, `--framerate 60`, `-c libx264`, and `-p qp=0`.

### `app/player.js` (Video & Timeline State)

Manages the HTML5 `<video>` element bindings, timeline rendering, and user input mapping.

* **`constructor(video)`**: Binds all DOM elements (`currentTime`, `duration`, `segment`, `progress`). Initializes the `Wave` instance for audio files.
* **Speed Bounds Mapping**: Prevents playback rates outside the logical scope:
```javascript
slowDownBtn.onclick = () => { if (video.playbackRate > 0.2) video.playbackRate -= 0.1; };
speedUpBtn.onclick = () => { if (video.playbackRate < 2.0) video.playbackRate += 0.1; };

```


* **`showMetadataOnTitle()`**: Parses the JSON object returned from `mediainfo` to display Format, Framerate, Bitrate, and Sampling Rate directly in the OS window title bar.

### `app/video.js` (HTTP Streaming Server)

Handles media files that HTML5 `<video>` cannot natively parse.

* **`createServer()`**: Spins up a local Node HTTP server (`http://127.0.0.1:4725`) on the fly.
* **`transcode()`**: Triggers `ffmpeg.fastCodec` (`-preset:v ultrafast -f mp4 -frag_duration 1000000`) and pipes the raw `stdout` buffer directly to the local HTTP server, effectively tricking the DOM into playing unsupported container formats via a real-time fragmented mp4 stream.

### `app/wave.js` (Audio Visualization)

* **`_init()`**: Sets up the Web Audio API context (`AudioContext`, `createMediaElementSource`, `createAnalyser`).
* **`_visualize(freqByteData)`**: Renders a dynamic frequency histogram onto the `<canvas>`. Color mapping has been forced to `--accent-cyan` (`#00E5FF`) to comply with the application's global design directive.

---

## 8. THE UI DIRECTIVE: 3LECTRIC_GLASS_SPEC

Vid-Cut operates under a strict, immutable UI directive known as the **3LECTRIC_GLASS_SPEC**. Any future PRs or modifications must adhere to these design parameters. Standard opaque web styling is strictly forbidden.

### Core Variables (`:root`)

```css
  --bg-dark-base: #050A0F;
  --bg-glass-panel: rgba(10, 19, 26, 0.25);
  --accent-cyan: #00E5FF;
  --text-cyan-active: #67E8F9;
  --text-secondary: #8892B0;
  --accent-cyan-border-idle: rgba(0, 229, 255, 0.2);
  --accent-cyan-border-hover: rgba(0, 229, 255, 0.5);
  --accent-cyan-bg-hover: rgba(0, 229, 255, 0.05);
  --accent-cyan-bg-active: rgba(0, 229, 255, 0.2);
  --glow-cyan-active: rgba(0, 229, 255, 0.6);
  --font-body: 'Roboto Mono', monospace;
  --font-display: 'Orbitron', sans-serif;

```

### Glassmorphism Implementation

All structural panels must utilize a translucent background (`--bg-glass-panel`) combined with `backdrop-filter: blur(12px)`. This grounds the application into the user's desktop environment. A fallback `@supports not (backdrop-filter: blur(1px))` is provided in `main.css` for headless environments.

### The `.hud-button` Protocol

Standard `<button>` elements are overridden by the `.hud-button` class.

* **Idle:** Transparent borders, secondary text color, faint dark background.
* **Hover:** Cyan borders materialize (`--accent-cyan-border-hover`), text turns cyan.
* **Active/Pressed:** Deep cyan background, stark cyan text, and a massive `box-shadow` glow matrix (`0 0 15px var(--glow-cyan-active)`).
* **Disabled:** Opacity dropped to `0.2` with `cursor: not-allowed`.

### Glyph Rendering

The initialization screen features the `Ψ` icon. This is NEVER rendered as a rasterized PNG. It is an inline SVG mapped dynamically to the CSS `--text-secondary` and `--accent-cyan` stroke values, ensuring infinite scaling and immediate visual feedback on drag-and-drop events.

---

## 9. GOLDEN REFERENCE: SUPERSET PROTOCOL

To ensure no features are ever lost during automated or manual refactoring, this repository is governed by the **Superset Protocol**.

Before any code is merged to `master`, it must pass a rigorous regression check against the known "Golden Checkpoint".

### Checkpoint Manifest (v1.0.1-enhanced)

```json
{
  "version": "1.0.1-enhanced",
  "timestamp": "2026-05-28",
  "overall_project_status": "VALIDATED_SUPERSET",
  "segments_verified": 12,
  "regressions_detected": 0
}

```

### Verification Workflow

When auditing or updating a file (e.g., modifying `app/player.js` to add a feature):

1. **Hash the Segment:** Generate a SHA-256 hash of the modified logic block.
2. **Diff Validation:** Ensure the diff ONLY shows additions (Enhancements) or identical logic (Superset).
3. **Fail on Omission:** If a previously known bugfix, edge-case handler, or internal signature (like the `video.playbackRate > 0.2` boundary check) is missing in the new code, the build is flagged as a **CRITICAL FAILURE** and the merge is rejected.

You must not trust visual review alone. You must trust the segment hashes.

---

## 10. TROUBLESHOOTING & FAQ

**Q: Screen recording fails to start or creates a 0-byte file.**

* **A:** Verify you are running a Wayland session (`echo $WAYLAND_DISPLAY`). Ensure `wf-recorder` is installed on your system. If you are using a compositor other than wlroots-based (e.g., GNOME/Mutter), `wf-recorder` may not be compatible, and you will need to rely on DBus/XDG-Desktop-Portal integrations outside the scope of this app.

**Q: Video playback stutters heavily, or CPU usage spikes on file load.**

* **A:** The HTML5 `<video>` tag does not support all containers (like `.mkv` containing HEVC). Vid-Cut gracefully degrades by establishing a local node server (`app/video.js`) and live-transcoding the file via `ffmpeg fastCodec`. This process is CPU intensive. For optimal performance, only work with native `.mp4` (H.264/AAC) files.

**Q: Cut videos have 1-2 seconds of frozen frames at the beginning.**

* **A:** This is a known artifact of attempting to cut video streams without re-encoding, depending on where the nearest I-frame (Keyframe) is located relative to your cut point. Vid-Cut mitigates this heavily using `-accurate_seek` and `-avoid_negative_ts`, but if surgical precision is required on a highly compressed file, use the **[ Convert ]** button instead of **[ Flawless Cut ]** to force a re-render.

**Q: How do I change the default output directory?**

* **A:** By default, outputs (cut videos, mp3s, frames) are saved directly adjacent to the source file. Screen recordings are saved to the OS Desktop path retrieved via `app.getPath('desktop')`. To modify this, you must edit the `getGlobal('desktop')` assignment in `app/recorder.js`.

---

### LICENSE

Copyright (c) 2024-2026 4ndr0666.

This project is licensed under the MIT License. See the [LICENSE](https://www.google.com/search?q=LICENSE) file for details.

### AUTHOR

**4ndr0666** Email: 01_dolorloftier@icloud.com

Repository: [github:4ndr0666/vidcut](https://github.com/4ndr0666/vidcut)
