<div align="center">
       ─── ⊰ 💀 • - ⦑ VID-CUT // 4NDR0666OS ⦒ - • 💀 ⊱ ───
</div>

<div align="center">
  <a href="https://github.com/4ndr0666/vidcut" target="_blank">
    <img src="app/assets/vidcut.png" alt="Vidcut" />
  </a>
</div>

**Vid-Cut** is a hyper-optimized, lossless video cutter, merger, and Wayland-native screen recorder built exclusively for modern Linux environments (with Arch Linux and Wayland first-class support). Built on a minimal, high-performance core, this repository features a heavily styled, terminal-inspired "Electric-Glass" UI and native integrations for `wf-recorder` under Wayland compositors (Hyprland, Sway).

Cuts are **lossless by default**: segments are stream-copied into a new container with zero re-encoding (instant execution, no quality degradation). If the source stream cannot be copied directly, Vid-Cut automatically falls back to a fast compatibility re-encode. For exotic containers or codecs the native player cannot parse, the engine falls back to a **live transcode stream** so you can preview, scrub, and mark points before cutting.

---

## 📖 TABLE OF CONTENTS

1. [Core Capabilities & Features](#1-core-capabilities--features)
2. [Architecture & Design Philosophy](#2-architecture--design-philosophy)
3. [System Requirements & Dependencies](#3-system-requirements--dependencies)
4. [Installation & Setup](#4-installation--setup)
5. [Quick Start & User Guide](#5-quick-start--user-guide)
6. [Development & Build Instructions](#6-development--build-instructions)
7. [API Reference & Internal Modules](#7-api-reference--internal-modules)
8. [The UI Directive: 3LECTRIC_GLASS_SPEC](#8-the-ui-directive-3lectric_glass_spec)
9. [Golden Reference: Superset Protocol](#9-golden-reference-superset-protocol)
10. [Troubleshooting & FAQ](#10-troubleshooting--faq)

---

## 1. CORE CAPABILITIES & FEATURES

* **Flawless Lossless Cutting:** Utilizes FFmpeg stream copying (`-vcodec copy -acodec copy`) combined with accurate seeking parameters (`-accurate_seek`, `-avoid_negative_ts 1`) to slice video files without re-encoding, avoiding quality degradation and frame-freeze artifacts.
* **Precise Speed Control Validation:** Dynamic playback rate adjustment from `0.2x` to `2.0x` in fine `0.1x` increments, enabling surgical precision when marking segment boundaries.
* **Wayland-Native Screen Recording:** Deprecates legacy X11 grabs in favor of a direct internal `child_process` spawn of `wf-recorder`. Uses `libx264`, `qp=0` for lossless visual capture, and native audio capture mapping to PulseAudio/PipeWire sinks.
* **Transcoding & Format Extraction:** One-click conversion to `mp4` (H.264, `crf 18` for near-lossless output at `veryfast` preset), audio extraction to `mp3` (retaining source bitrate up to 320k), and instant frame captures to high-quality `.jpg`.
* **Zero-Friction Merging:** Uses FFmpeg's `concat` demuxer to stitch together multiple media files without full re-renders.
* **Audio Waveform Visualization:** Integrated HTML5 Canvas visualizer that natively renders a matrix-cyan audio waveform when audio-only files are ingested.

---

## 2. ARCHITECTURE & DESIGN PHILOSOPHY

### The Arch / Wayland Focus
Cross-platform compatibility often breeds bloat. Vid-Cut is unapologetically optimized for Linux environments, with deep integration for Arch Linux and Wayland compositors. By eliminating unnecessary platform wrappers, the application payload remains lightweight and execution paths are linear.

### Security Posture & IPC Isolation
Vid-Cut operates under `nodeIntegration: true` and `contextIsolation: false` for a local-only, offline workflow. Untrusted strings (file names, ffmpeg output) are rendered exclusively via `textContent`, and every OS-level action (dialogs, jobs, recording, help) routes through IPC to the main process. The main process supervises every child process: jobs are terminated cleanly on quit, the recorder receives a SIGINT grace period to finalize its container, and stream sockets are destroyed on exit.

### The Electric Glass Aesthetic
The user interface is dictated by the **3LECTRIC_GLASS_SPEC**. It features deep background translucency, backdrop blurring, stark monospaced typography, and high-contrast Cyan matrix glows.

---

## 3. SYSTEM REQUIREMENTS & DEPENDENCIES

### Environment
* **Platform:** Linux (Arch Linux / EndeavourOS recommended; Windows supported via fallback).
* **Node.js:** Node.js 20.x or 22.x (see `.nvmrc`).
* **Display Server:** Wayland required for native screen recording (`wf-recorder`).
* **Compositor:** Hyprland, Sway, or any `wlroots`-compatible compositor.

### System Packages (Arch Linux)
While core binary dependencies are packaged in `app/bin`, system packages ensure full compatibility with external capture tools:

```bash
# Core execution & Wayland capture tools
sudo pacman -S ffmpeg mediainfo nodejs npm wf-recorder slurp
yay -S libxcrypt-compat nvm
```

## 4. INSTALLATION & SETUP

### Standard Setup

```bash
# Clone the repository
git clone [https://github.com/4ndr0666/vidcut.git](https://github.com/4ndr0666/vidcut.git)
cd vidcut

# Install dependencies
npm install

# Launch application
npm start
```

### Pre-Compiled Package (`debtap` for Arch Linux)

```bash
npm run build:linux
cd dist
debtap vidcut_*_amd64.deb
sudo pacman -U vidcut-*.pkg.tar.zst
```

## 5. QUICK START & USER GUIDE

| Action | How |
| --- | --- |
| Open Video | Drag & drop anywhere into the window, or click Open video…  |
| Play / Pause | Click the video viewport, or press Space  |
| Seek | Click or drag the timeline; ← / → (±1.0 s, Shift ±0.1 s); Home / End  |
| Mark Clip Start | I, or [ ✂ Start ] — or type a timecode into the start field  |
| Mark Clip End | O, or [ ✂ End ] — or type a timecode into the end field  |
| Jump to Bounds | [ / ], or use the navigation chevron buttons  |
| Playback Speed | Use ⏪ / ⏩ around the rate chip (0.2×–2.0×); click the chip to reset to 1.0×  |
| Lossless Cut | Click [ FLAWLESS CUT ] → select destination  |
| Capture Frame | Click Capture → saves current frame as high-quality JPG  |
| Extract Audio | Click Extract Audio → saves audio stream as MP3 (VBR best)  |
| Convert Clip | Click Convert → re-encodes the segment as a compatibility MP4  |
| Merge Files | Click Merge Files… → select 2+ files → execute Merge  |
| Record Screen | Click Record… → Start (Wayland via wf-recorder); minimizes to tray  |
| Fullscreen | Double-click the video viewport  |
| Mute | Press M  |
| Close Panel / Modal | Press Escape  |
Timecode fields accept `SS.mmm`, `MM:SS.mmm` or `HH:MM:SS.mmm`; pressing `Enter` seeks directly to the specified frame.


> **Keyframe Notice:** Stream copying begins at the nearest keyframe preceding your marked start point. A lossless cut may include fractions of a second before the exact mark. If strict frame-accuracy is required, use **Convert** to force a full re-render.
>
>

## 6. ARCHITECTURE & MODULE MAP

| File | Role |
| --- | --- |
| app/main.js | Window lifecycle, native dialogs, system tray, IPC surface, and clean quit orchestration.  |
| app/ffmpeg.js | Core job slot: cut, convert, extract, capture, merge, metadata probes, and progress parsing.  |
| app/recorder.js | wf-recorder supervisor (owned by main process — SIGINT clean finalize, SIGKILL escalation).  |
| app/server.js | Local streaming-transcode server (127.0.0.1:4725) for formats unplayable by native DOM video.  |
| app/renderer.js | Core UI engine: drag & drop, player state, timeline management, speed controls, sheets manager.  |
| app/merge.js | Dedicated merge sheet logic (hidden in markup until explicitly toggled).  |
| app/record.js | Dedicated record sheet and timer modal.  |
| app/wave.js | Audio-only HTML5 Canvas waveform visualizer (lazily attached, DPR-aware, matrix-cyan output).  |
| app/index.html + app/main.css | Structural implementation of the 3LECTRIC_GLASS layout.  |

### Layout Invariants

- `#stage` is the only flexible container.
- `<video>` is absolutely positioned with `object-fit: contain` (prevents control bar displacement or unprompted window expansion).
- Toolbar controls wrap on small viewports rather than overflowing.
- Minimum window floor is pinned to `520×480` to keep controls accessible.
- Glyphs are inline stroked SVGs (`.icon-svg`, `stroke: currentColor`) rather than unicode codepoints to prevent system emoji font substitution.


## 7. THE UI DIRECTIVE: 3LECTRIC_GLASS_SPEC
All interface additions must adhere strictly to the **3LECTRIC_GLASS_SPEC**.


```css
:root {
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
}
```

- **Panels:** Must use `--bg-glass-panel` combined with `backdrop-filter: blur(12px)`.
- **Buttons (`.hud-button`):** Transparent borders on idle, glowing cyan borders on hover (`--accent-cyan-border-hover`), deep cyan background with box-shadow glow on active.
- **Dropzone:** The center `Ψ` (Psi) glyph is an inline SVG linked to CSS stroke variables, never a rasterized bitmap.


## 8. GOLDEN REFERENCE: SUPERSET PROTOCOL
This repository enforces the **Superset Protocol**. Any revision or refactoring must maintain full backward compatibility and must never regress or drop existing functional logic.


### Audit Verification Checklist

1. **Segment Validation:** Logic updates must be verified against prior stable feature blocks.
2. **Diff Validation:** Ensure git diffs strictly represent enhancements, fixes, or optimizations.
3. **Zero Omission Policy:** Dropping known edge-case fixes, bounds checks (such as playback rate thresholds), or error guards is classified as an immediate build failure.


## 9. TROUBLESHOOTING & FAQ
**Q: Screen recording fails to start or creates a 0-byte file.**


- **A:** Verify you are running an active Wayland session (`echo $WAYLAND_DISPLAY`). Ensure `wf-recorder` is installed. If running under a non-wlroots compositor (e.g. GNOME/Mutter), `wf-recorder` may fail without custom portal overrides.

**Q: Video playback stutters heavily or CPU usage spikes.**


- **A:** For exotic formats not natively supported by the HTML5 video element, Vid-Cut spins up a local stream server (`app/server.js`) to live-transcode via FFmpeg. This is CPU-intensive. Where possible, source files encoded in standard H.264/AAC provide the smoothest performance.

**Q: Cut videos have frozen frames at the start.**


- **A:** This happens when cutting highly compressed inter-frame codecs without an immediate keyframe. Vid-Cut mitigates this with `-accurate_seek` and `-avoid_negative_ts 1`. If an exact frame is required, run **Convert** instead of **Cut** to transcode the boundary frames.

**Q: Segfaults when reading MPEG-TS (`.ts`) files.**


- **A:** The legacy bundled static FFmpeg build may segfault on certain `.ts` streams. If you work heavily with `.ts` files, install system FFmpeg and point or link the binary into `app/bin/ffmpeg`.


## 10. DEVELOPMENT & TESTING

- `npm test` — Run offline pipeline tests: cut, convert, extract, capture, merge, and metadata probe.
- `node scripts/test-server.js` — Test offline streaming server fallbacks.
- `xvfb-run -a -s "-screen 0 1920x1080x24" npm run smoke` — Headless integration test driving the IPC layer across multiple window geometries.


### LICENSE
Copyright (c) 2024-2026 4ndr0666.

This project is licensed under the MIT License. See the [LICENSE](https://www.google.com/search?q=LICENSE) file for details.
