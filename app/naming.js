/* vidcut — save-name suggestion: idempotent and ascending.
 *
 * The default name a save dialog offers must never collide with an
 * existing file, so the user is never confronted with an "overwrite?"
 * prompt for a name they did not choose. Rules:
 *
 *   clip [cut].mp4     free      → use it as-is (idempotent)
 *   clip [cut].mp4     taken     → clip [cut] 2.mp4, then  3, 4, …
 *   clip [cut] 2.mp4   taken     → continue the counter: 3, 4, …
 *
 * A trailing " N" on the basename is treated as the counter itself,
 * so re-saving against an already-counted default ascends instead of
 * stacking a second number ("… 2 2.mp4" never happens).
 *
 * Pure Node (fs + path only) so it stays unit-testable offline. */

const fs = require('fs')
const path = require('path')

function exists(p) {
  try { return fs.existsSync(p) } catch (e) { return false }
}

function nextFreePath(p) {
  if (typeof p !== 'string' || !p) return p
  if (!exists(p)) return p

  const dir = path.dirname(p)
  const ext = path.extname(p)
  const base = path.basename(p, ext)
  const counted = /^(.*) (\d+)$/.exec(base)
  const stem = counted ? counted[1] : base
  let n = counted ? Number(counted[2]) + 1 : 2

  for (;; n++) {
    const candidate = path.join(dir, `${stem} ${n}${ext}`)
    if (!exists(candidate)) return candidate
  }
}

module.exports = { nextFreePath }
