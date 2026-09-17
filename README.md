<div align="center">
       ─── ⊰ 💀 • - ⦑ VID-CUT // 4NDR0666OS ⦒ - • 💀 ⊱ ───
</div>

**vidcut** is a lossless video toolkit: cut clips, merge files, extract audio, capture frames, convert segments and record your screen — built on a proven minimal core.

Cuts are **lossless by default**: the segment is stream-copied into a new container with no re-encoding (instant, no quality loss). If the source cannot be stream-copied, vidcut automatically falls back to a fast compatibility re-encode and tells you which mode it used. Sources the player cannot decode at all (AVI, exotic codecs…) fall back to a **live transcode stream** so you can still preview and mark them before cutting.

---

## Requirements

- Linux (or Windows), a display, and Node.js 22 (see `.nvmrc`)
- `ffmpeg` is bundled in `app/bin` — nothing else to install

## Run

```bash
npm install
npm start
```

## Usage

| Action | How |
| --- | --- |
| Open a video | Drag & drop anywhere in the window, or **Open video…** |
| Play / pause | Click the video, or `Space` |
| Seek | Click or drag the timeline; `←`/`→` (±1 s, `Shift` ±0.1 s); `Home`/`End` |
| Mark clip start | `I`, or **Start** — or type a timecode into the start field |
| Mark clip end | `O`, or **End** — or type a timecode into the end field |
| Jump to clip bounds | `[` / `]`, or the chevron buttons (bar-arrow buttons for the video ends) |
| Speed | the rewind / forward buttons either side of the rate chip (0.2×–2.0×); click the chip to reset to 1.0× |
| Cut (lossless) | **Cut** → choose where to save |
| Capture a frame | **Capture** → saves the current frame as a JPG |
| Extract audio | **Extract Audio** → saves the clip's audio as MP3 (VBR best) |
| Convert clip | **Convert** → re-encodes the clip as a compatibility MP4 |
| Merge files | **Merge Files…** → pick 2+ files → **Merge** |
| Record screen | **Record…** → Start (Wayland, via wf-recorder); the window hides to a blinking tray, click the tray to get it back |
| Help | **Help** → opens the repository |
| Fullscreen | Double-click the video |
| Mute | `M` |
| Close a panel | `Escape` |

Timecode fields accept `SS.mmm`, `MM:SS.mmm` or `HH:MM:SS.mmm`; `Enter` jumps the playhead there.

The output keeps the first video and first audio track of the source, and its container matches the source's extension — that is what keeps the default cut lossless. A fresh load always selects the full duration, so **Cut** with untouched marks copies the whole file.

> Stream copy starts at the keyframe nearest your start mark, so a lossless clip can begin slightly earlier than the exact frame you marked. That is the trade-off for instant, quality-free cutting; the automatic re-encode fallback covers sources where copy is impossible.

> **Known limitation:** the bundled ffmpeg 4.3.1 static build segfaults reading MPEG-TS (`.ts`) files. Replace `app/bin/ffmpeg` with a current build if you need `.ts` sources; everything else (.mp4/.mkv/.avi/.webm/…) is handled fine.

## Architecture

| File | Role |
| --- | --- |
| `app/main.js` | Window lifecycle, native dialogs, tray, IPC surface, quit orchestration |
| `app/ffmpeg.js` | The one job slot: cut / convert / extract / capture / merge + metadata probe, progress, cancel |
| `app/recorder.js` | wf-recorder supervision (spawned and owned by main — SIGINT finalize, SIGKILL escalation) |
| `app/server.js` | Local streaming-transcode server for sources the player cannot decode |
| `app/renderer.js` | Core UI: drag & drop, player, timeline, clip marking, tools, speed, sheets manager |
| `app/merge.js`, `app/record.js` | The merge and record sheets (hidden in markup; only explicit user action reveals them) |
| `app/wave.js` | Audio-only waveform visualizer (lazily attached, DPR-aware) |
| `app/index.html` + `app/main.css` | The 3LECTRIC_GLASS layout |

Security posture is unchanged and deliberate: `nodeIntegration: true`, `contextIsolation: false` — a local-only, offline application. Untrusted strings (file names, ffmpeg output) are rendered exclusively via `textContent`, and every OS-level action (dialogs, jobs, recording, help) goes through IPC to the main process. The main process owns every child: jobs are killed on quit, the recorder gets a SIGINT grace to finalize its container, and the stream server's sockets are destroyed.

Layout invariants worth knowing if you restyle: `#stage` is the only flexible area, the `<video>` is absolutely positioned with `object-fit: contain` (it can never push the toolbar or force a window resize), control rows wrap instead of overflowing, modal sheets are `hidden` in markup and can never render on init, and the window is floored at 520×480 so the full control stack always fits. Every toolbar glyph is an inline stroked SVG (`.icon-svg`, `stroke: currentColor`) — never a unicode media symbol, because emoji-presentation codepoints render through the system color-emoji font and ignore CSS color, which is how off-spec yellow icons creep into a HUD. The chrome is symmetric by construction: brand / filename / Open in the top bar, mirrored nav clusters flanking the segment inputs, the selection readout centered between them and Cut, and the speed segment joined into one pill.

## Development

- `npm test` — offline pipeline tests: cut / convert / extract / capture / merge / probe (real fixtures, real ffmpeg)
- `node scripts/test-server.js` — offline streaming-server tests
- `xvfb-run -a -s "-screen 0 1920x1080x24" npm run smoke` — boots the real app headlessly and drives it through its real IPC surface (layout invariants, sheets-hidden-at-boot, stream fallback, recorder ENOENT path, five window sizes)

## License

MIT — see [LICENSE](LICENSE).
