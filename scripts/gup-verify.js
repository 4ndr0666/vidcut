/* GUP v5.2 verification driver for the vidcut 2.1.0 re-integration.
 *
 * Runs the protocol's own atomizer (golden_unit_hash.py) on every
 * changed JS pair against the proven baseline commit, then enforces
 * the intended semantic gate: every CHANGED or NEW unit must carry an
 * accepted review record (verdict + rationale) in gup-review-2.1.0.json.
 * Any MISSING baseline unit is a hard fail.
 *
 * NOTE ON TOOLING: the protocol's gup_validate.py reads a 'comparison'
 * key while golden_unit_hash.py emits 'diff', which vacates its
 * semantic check. This driver restores the intended enforcement on
 * the real hash output; gup_inventory.py (repo fingerprint) is used
 * as-is. Mechanical hashing is never presented as semantic proof.
 *
 * Usage: node scripts/gup-verify.js <baseline-commit> [review.json] */

const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const HASH = '/home/z/my-project/skills/golden-unit-protocol-v5.2/scripts/golden_unit_hash.py'
const BASELINE = process.argv[2] || '5323e9b'
const REVIEW = process.argv[3] || path.join(__dirname, 'gup-review-2.1.0.json')
const PAIRS = ['ffmpeg.js', 'renderer.js', 'main.js'] // JS pairs with a baseline

const review = JSON.parse(fs.readFileSync(REVIEW, 'utf8'))
if (review.protocol !== 'GUP v5.2') {
  console.error('GUP FAIL: review protocol must be GUP v5.2')
  process.exit(1)
}

const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'gup-verify-'))
const diff = []
let missing = []

for (const file of PAIRS) {
  const baselinePath = path.join(tmp, file)
  fs.writeFileSync(baselinePath, execFileSync(
    'git', ['-C', ROOT, 'show', `${BASELINE}:app/${file}`], { encoding: 'utf8' }))
  const out = execFileSync('python3', [
    HASH, '--baseline', baselinePath, '--candidate', path.join(ROOT, 'app', file),
    '--language', 'js',
  ], { encoding: 'utf8' })
  const result = JSON.parse(out)
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

let failed = false
if (missing.length) {
  console.error('GUP FAIL: MISSING baseline units — ' + missing.join(', '))
  failed = true
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
  candidate: 'vidcut 2.1.0 working tree',
  atomized_pairs: PAIRS,
  counts,
  diff,
  review_record: REVIEW,
  result: failed ? 'FAIL' : 'PASS',
}

const proofPath = path.join(__dirname, 'gup-proof-2.1.0.json')
fs.writeFileSync(proofPath, JSON.stringify(proof, null, 2) + '\n')
console.log(`architectural + semantic gate: ${failed ? 'FAIL' : 'PASS'} (${Object.keys(review.units).length} review records)`)
console.log('proof artifact: ' + proofPath)
process.exit(failed ? 1 : 0)
