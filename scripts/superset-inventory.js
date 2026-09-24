/* Superset inventory: assert every feature shipped from v2.0.0
 * through v2.7.0 is present and wired in the current tree. Each row
 * names the feature, the release that introduced it, and the marker
 * that proves the implementation exists where it always lived.
 * A missing marker = CRITICAL (silent regression per the superset
 * protocol). Run: node scripts/superset-inventory.js */

const fs = require('fs')
const path = require('path')

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
const app = {
  renderer: read('app/renderer.js'),
  ffmpeg: read('app/ffmpeg.js'),
  main: read('app/main.js'),
  merge: read('app/merge.js'),
  record: read('app/record.js'),
  recorder: read('app/recorder.js'),
  server: read('app/server.js'),
  naming: read('app/naming.js'),
  wave: read('app/wave.js'),
  html: read('app/index.html'),
  css: read('app/main.css'),
}

const INVENTORY = [
  // v2.0.0 — the minimal core
  ['cut: copy → re-encode fallback', 'ffmpeg', "buildArgs({ ...job, output: part }, false)"],
  ['cut: input-seek geometry (-ss before -i)', 'ffmpeg', "'-ss', job.start.toFixed(3)"],
  ['cut: selective maps + mute (-an)', 'ffmpeg', "args.push('-map', '0:v:0?', '-an')"],
  ['naming: idempotent nextFreePath', 'naming', 'function nextFreePath(p)'],
  ['single-flight job slot', 'ffmpeg', "throw new Error('A job is already running')"],

  // v2.1.0 — re-integrated feature set
  ['convert tool', 'ffmpeg', 'function convertArgs(job)'],
  ['extract audio (mp3 q0)', 'ffmpeg', "'-c:a', 'libmp3lame', '-q:a', '0'"],
  ['capture frame (mjpeg q2)', 'ffmpeg', "'-f', 'mjpeg', '-q:v', '2'"],
  ['merge engine (ffx-style)', 'ffmpeg', 'async function merge(job, onProgress)'],
  ['stream fallback server', 'server', 'async function open(source'],
  ['fastCodec live transcode', 'ffmpeg', 'function fastCodec(videoPath, startTime)'],
  ['wayland recorder', 'recorder', 'wf-recorder'],
  ['record sheet + tray', 'main', 'createTray()'],
  ['lastSaveDir persistence', 'main', 'settings.lastSaveDir'],
  ['waveform canvas', 'wave', 'canvas'],
  ['zoom (wheel)', 'renderer', 'zoomBy'],
  ['probe cache (FIFO 16)', 'ffmpeg', 'PROBE_CACHE_MAX = 16'],

  // v2.2.0 — icon spec
  ['inline stroke SVG icons', 'html', 'class="icon-svg"'],

  // v2.3.x
  ['hardcoded Space toggle', 'renderer', "case ' ':"],
  ['scrub engine (tiers, fine)', 'renderer', 'SCRUB_FINE'],
  ['scrub HUD overlay', 'html', 'id="scrub-overlay"'],
  ['HUD linger 3.5s', 'renderer', 'SCRUB_HUD_LINGER'],

  // v2.4.0
  ['frame-step (tap = 1 frame)', 'renderer', 'frameStep'],
  ['screenshots dir (no dialog)', 'main', 'screenshotsDir()'],
  ['seekTo gated on seekable', 'renderer', 'seekTo('],

  // v2.5.0
  ['chapters parsed from probe', 'ffmpeg', 'Chapter #\\d+:\\d+: start'],
  ['chapter ticks', 'renderer', 'chapter-tick'],
  ['number keys seek', 'renderer', 'seekByDigit'],
  ['MUTE toggle (U)', 'html', 'id="mute-btn"'],
  ['shortcuts sheet', 'html', 'id="shortcuts-sheet"'],
  ['modal key gating', 'renderer', 'function currentSheet() {'],

  // v2.6.0
  ['merge fast/normalize planner', 'ffmpeg', 'function planMerge(entries, muted)'],
  ['moov atom walk', 'ffmpeg', 'function checkMoov(file'],
  ['anullsrc injection', 'ffmpeg', 'anullsrc=channel_layout=stereo'],
  ['atomic merge publish', 'ffmpeg', 'function publishPart(part, output)'],
  ['Ctrl+drag pan', 'renderer', 'panX'],
  ['undo/redo stacks', 'renderer', 'undoStack'],

  // v2.7.0 — this revision
  ['atomic validated writers', 'ffmpeg', 'async function validSegmentOutput(file'],
  ['partPath working names', 'ffmpeg', 'function partPath(output)'],
  ['jpeg SOI/EOI validation', 'ffmpeg', 'function checkJpeg(file)'],
  ['genpts copy insurance', 'ffmpeg', "'-fflags', '+genpts'"],
  ['work dir preflight', 'ffmpeg', 'function ensureWorkspace(dir, files)'],
  ['work dir IPC contract', 'main', "ipcMain.handle('workdir:set'"],
  ['work dir UI row', 'html', 'id="workdir-row"'],
  ['work dir sheet render', 'merge', 'renderWorkDir'],
]

let missing = 0
for (const [feature, file, marker] of INVENTORY) {
  if (!app[file].includes(marker)) {
    console.log(`  MISSING  ${feature}  (${file}: ${marker})`)
    missing++
  }
}
console.log(`superset inventory: ${INVENTORY.length - missing}/${INVENTORY.length} features present`)
process.exit(missing ? 1 : 0)
