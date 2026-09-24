/* GUP v5.2 verification driver for vidcut.
 *
 * Runs the protocol's own atomizer (golden_unit_hash.py) on every
 * changed JS pair against the proven baseline commit, then enforces
 * the intended semantic gate: every CHANGED or NEW unit must carry an
 * accepted review record (verdict + rationale) in the review JSON.
 * Any MISSING baseline unit is a hard fail.
 *
 * NOTE ON TOOLING: the protocol's gup_validate.py reads a 'comparison'
 * key while golden_unit_hash.py emits 'diff', which vacates its
 * semantic check. This driver restores the intended enforcement on
 * the real hash output; gup_inventory.py (repo fingerprint) is used
 * as-is. Mechanical hashing is never presented as semantic proof.
 *
 * Usage: node scripts/gup-verify.js <baseline-commit> [review.json]
 *   (default baseline 20401be = v2.6.0, review gup-review-2.7.0.json) */

const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')

/* The protocol package may live in either known location — resolve,
 * never hard-code a single environment's path. */
function resolveHashScript() {
  const candidates = [
    process.env.GUP_HASH_SCRIPT,
    '/home/z/my-project/upload/gup-extracted/scripts/golden_unit_hash.py',
    '/home/z/my-project/skills/golden-unit-protocol-v5.2/scripts/golden_unit_hash.py',
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  console.error('GUP FAIL: golden_unit_hash.py not found (set GUP_HASH_SCRIPT)')
  process.exit(2)
}

const BASELINE = process.argv[2] || '20401be'
const REVIEW = process.argv[3] || path.join(__dirname, 'gup-review-2.7.0.json')
const PAIRS = ['ffmpeg.js', 'renderer.js', 'main.js', 'merge.js'] // JS pairs with a baseline

const review = JSON.parse(fs.readFileSync(REVIEW, 'utf8'))
if (review.protocol !== 'GUP v5.2') {
  console.error('GUP FAIL: review protocol must be GUP v5.2')
  process.exit(1)
}

const HASH = resolveHashScript()
const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'gup-verify-'))
const diff = []
let missing = []

/* The atomizer exits 1 on MISSING units (by design) while still
 * emitting the full JSON diff on stdout — a non-zero exit is data,
 * not a crash. Only an unparseable stdout is fatal here. */
function runAtomizer(baselinePath, candidatePath, file) {
  let out
  try {
    out = execFileSync('python3', [
      HASH, '--baseline', baselinePath, '--candidate', candidatePath,
      '--language', 'js',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    out = (error.stdout || '')
    if (!out.trim()) {
      console.error(`GUP FAIL: atomizer produced no output for ${file}`)
      process.exit(2)
    }
  }
  return JSON.parse(out)
}

for (const file of PAIRS) {
  const baselinePath = path.join(tmp, file)
  fs.writeFileSync(baselinePath, execFileSync(
    'git', ['-C', ROOT, 'show', `${BASELINE}:app/${file}`], { encoding: 'utf8' }))
  const result = runAtomizer(baselinePath, path.join(ROOT, 'app', file), file)
  for (const verdict of result.diff) {
    verdict.unit = `${file.replace(/\.js$/, '')}.${verdict.unit}`
    diff.push(verdict)
    if (verdict.verdict === 'MISSING') missing.push(verdict.unit)
  }
}

const counts = { UNCHANGED: 0, CHANGED: 0, NEW: 0, MISSING: 0 }
for (const v of diff) counts[v.verdict]++

const unreviewed = diff
  .filter(v => v.verdict === 'CHANGED' || v.verdict === 'NEW')
  .filter(v => !review.units[v.unit])

const badRecords = Object.entries(review.units)
  .filter(([, data]) => data.verdict !== 'PASS' && data.verdict !== 'ACCEPTED_SUPERSET')
  .map(([unit]) => unit)

const noRationale = Object.entries(review.units)
  .filter(([, data]) => !data.rationale || !String(data.rationale).trim())
  .map(([unit]) => unit)

console.log(`baseline: ${BASELINE}  candidate: working tree`)
console.log(`units: ${counts.UNCHANGED} UNCHANGED  ${counts.CHANGED} CHANGED  ${counts.NEW} NEW  ${counts.MISSING} MISSING`)

/* Replacement-integrity clause (protocol §alignment): a MISSING unit
 * is a hard fail UNLESS its review record declares an accepted
 * replacement AND names a replacement unit that actually exists in
 * the candidate manifest AS A NEW UNIT (a renamed successor is by
 * definition new) — the old unit must be superseded by a real,
 * reviewed successor, not merely excused. */
const candidateUnits = new Set(diff.map(v => v.unit))
const newUnits = new Set(diff.filter(v => v.verdict === 'NEW').map(v => v.unit))
const unexcused = missing.filter(unit => {
  const record = review.units[unit]
  if (!record || record.verdict !== 'ACCEPTED_SUPERSET') return true
  const named = Object.keys(review.units).filter(name =>
    name !== unit && String(record.rationale).includes(name.replace(/^.*\./, '')))
  return !named.some(name => newUnits.has(name) && candidateUnits.has(name))
})

let failed = false
if (unexcused.length) {
  console.error('GUP FAIL: MISSING baseline units without a verified replacement — ' + unexcused.join(', '))
  failed = true
}
if (missing.length) {
  console.log('missing-with-verified-replacement (rename/hoist): ' + missing.join(', '))
}
if (unreviewed.length) {
  console.error('GUP FAIL: CHANGED/NEW units without an accepted review record — ' +
    unreviewed.map(v => v.unit).join(', '))
  failed = true
}
if (badRecords.length) {
  console.error('GUP FAIL: units without an accepted verdict — ' + badRecords.join(', '))
  failed = true
}
if (noRationale.length) {
  console.error('GUP FAIL: units without rationale — ' + noRationale.join(', '))
  failed = true
}

const proof = {
  protocol: 'GUP v5.2',
  baseline: BASELINE,
  candidate: 'vidcut ' + (JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version) + ' working tree',
  atomized_pairs: PAIRS,
  counts,
  diff,
  review_record: REVIEW,
  result: failed ? 'FAIL' : 'PASS',
}

const stem = path.basename(REVIEW, '.json').replace(/^gup-review-/, '')
const proofPath = path.join(__dirname, `gup-proof-${stem}.json`)
fs.writeFileSync(proofPath, JSON.stringify(proof, null, 2) + '\n')
console.log(`architectural + semantic gate: ${failed ? 'FAIL' : 'PASS'} (${Object.keys(review.units).length} review records)`)
console.log('proof artifact: ' + proofPath)
process.exit(failed ? 1 : 0)
