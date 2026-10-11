// Checkpoint-quality eval for the instant (deterministic) compiler.
//
// Unlike tests/instant-regression.mjs (exact-output assertions), this eval
// MEASURES checkpoint quality against fixture sessions and enforces baseline
// floors: token compression ratio, entity survival (verbatim vs `#N`-pointed),
// pointer integrity, and determinism.  Future selection work (cross-turn
// dedup, importance weighting, budget reallocation) must keep or improve the
// measured numbers — a regression here fails the eval.
//
// Run: node tests/eval-quality.mjs   (after `node build.mjs`)

import assert from 'node:assert/strict'
import {
  compileInstantRegion,
  DEFAULT_INSTANT_OPTIONS,
  estimateEntryTokens,
  estimateMessagesTokens,
  joinInstantEntries,
} from '../lib/index.js'
import { buildCodingSession, buildLongSession, buildRealSession } from './eval-fixtures.mjs'

// Baseline floors, set ~10% above the first measured run.  Tighten, never
// loosen: a number moving the wrong way is exactly what this eval exists to catch.
// `real-session` floors are deliberately loose: its numbers depend on whatever
// transcript the machine provides (pin one via DSH_EVAL_SESSION for a stable
// baseline), so it guards against catastrophic failure, not drift.
const THRESHOLDS = {
  'coding-session': { maxRatio: 0.35, minVerbatimRecall: 1, minPointedRecall: 1, maxIntegrityViolations: 0 },
  'long-session-cap': { maxRatio: 0.2, minVerbatimRecall: 1, maxIntegrityViolations: 0, maxCheckpointTokens: 1264 },
  'real-session': { maxRatio: 0.5, minVerbatimRecall: 1, maxIntegrityViolations: 0 },
}

const REFS = {
  seq: /seq (\d+)/g, // pointers, truncation markers, single-elision notes
  span: /seqs (\d+)-(\d+)/g, // elision spans `seqs a-b`
  result: /-> result (\d+)/g, // tool-result pointers on call one-liners
}

/** All seqs the compiled text lets the model navigate to via `#N` recall. */
function collectRefs(text) {
  const refs = new Set()
  for (const m of text.matchAll(REFS.seq)) refs.add(Number(m[1]))
  for (const m of text.matchAll(REFS.span)) for (let s = Number(m[1]); s <= Number(m[2]); s++) refs.add(s)
  const resultRefs = new Set()
  for (const m of text.matchAll(REFS.result)) {
    resultRefs.add(Number(m[1]))
    refs.add(Number(m[1]))
  }
  return { refs, resultRefs }
}

function evaluate(fixture, maxTokens) {
  const options = { ...DEFAULT_INSTANT_OPTIONS }
  const first = compileInstantRegion(fixture.nodes, options, maxTokens)
  const second = compileInstantRegion(fixture.nodes, options, maxTokens)
  const deterministic = JSON.stringify(first) === JSON.stringify(second)

  const joined = joinInstantEntries(first.entries)
  const checkpointTokens = first.entries.reduce((sum, entry) => sum + estimateEntryTokens(entry.text), 0)
  const shadowTokens = estimateMessagesTokens(fixture.nodes.map((node) => node.message))
  const ratio = checkpointTokens / shadowTokens

  const { refs, resultRefs } = collectRefs(joined)
  const maxSeq = fixture.nodes.length
  // Escape hatch for REAL transcripts: sessions can legitimately QUOTE the
  // pointer syntax in their content (this repo's own sessions discuss
  // `(seq N)` formats).  A ref is not a violation when its literal appears
  // in the source messages; synthetic fixtures never do this, so they stay
  // strictly checked.
  const sourceMentions = new Set()
  for (const node of fixture.nodes) {
    const serialized = JSON.stringify(node.message)
    for (const m of serialized.matchAll(/seq (\d+)/g)) sourceMentions.add(Number(m[1]))
    for (const m of serialized.matchAll(/result (\d+)/g)) sourceMentions.add(Number(m[1]))
  }
  let violations = 0
  for (const ref of refs) if ((ref < 1 || ref > maxSeq) && !sourceMentions.has(ref)) violations += 1
  for (const ref of resultRefs) {
    if (sourceMentions.has(ref)) continue
    const message = fixture.nodes[ref - 1]?.message
    // Accept both vocabulary shapes: first-class tool-role messages (rc.2)
    // and legacy user messages leading with a tool-result block.
    const isResultMessage = message?.role === 'tool' || message?.content?.[0]?.type === 'tool-result'
    if (!isResultMessage) violations += 1
  }

  const verbatim = fixture.entities.filter((e) => e.tier === 'verbatim')
  const pointed = fixture.entities.filter((e) => e.tier === 'pointed')
  const verbatimPassed = verbatim.filter((e) => joined.includes(e.needle))
  const pointedPassed = pointed.filter((e) => refs.has(e.seq))

  // Findings (unreferenced tool-result seqs) are computed by the caller from
  // `refsAll`; they are printed, not asserted — they quantify the known
  // recall gaps that future selection work should shrink.

  return {
    name: fixture.name,
    shadowTokens,
    checkpointTokens,
    ratio,
    entries: first.entries.length,
    verbatim: `${verbatimPassed.length}/${verbatim.length}`,
    pointed: `${pointedPassed.length}/${pointed.length}`,
    refs: refs.size,
    violations,
    integrity: violations === 0 ? 'OK' : `${violations} BAD`,
    determinism: deterministic ? 'OK' : 'MISMATCH',
    capped: first.capped,
    stats: first.stats,
    joined,
    refsAll: refs,
    passedVerbatim: verbatimPassed.length === verbatim.length,
    passedPointed: pointedPassed.length === pointed.length,
  }
}

function printRow(r) {
  const name = r.name.padEnd(17)
  const shadow = String(r.shadowTokens).padStart(6)
  const ckpt = String(r.checkpointTokens).padStart(5)
  const ratio = r.ratio.toFixed(3).padStart(6)
  console.log(
    `${name} shadow=${shadow}  ckpt=${ckpt}  ratio=${ratio}  entries=${String(r.entries).padStart(3)}  ` +
    `verbatim=${r.verbatim}  pointed=${r.pointed}  refs=${String(r.refs).padStart(3)} integrity=${r.integrity}  ` +
    `determinism=${r.determinism}  capped=${r.capped ? 'yes' : 'no'}`,
  )
}

const fixtures = [buildCodingSession(), buildLongSession()]
let realSession = null
try {
  realSession = buildRealSession()
} catch (error) {
  console.log(`real-session      SKIP (load failed: ${String(error).slice(0, 120)})`)
}
if (realSession !== null) fixtures.push(realSession)
const results = []

console.log('== dsh-blackhole checkpoint quality eval ==')
for (const fixture of fixtures) {
  const maxTokens = fixture.capTokens ?? 65536
  const result = evaluate(fixture, maxTokens)
  results.push(result)
  printRow(result)
  if (fixture.sourceFile !== undefined) console.log(`  source: ${fixture.sourceFile}`)

  const thresholds = THRESHOLDS[fixture.name]
  assert.ok(thresholds !== undefined, `missing thresholds for fixture ${fixture.name}`)
  assert.ok(result.ratio <= thresholds.maxRatio, `${fixture.name}: compression ratio ${result.ratio.toFixed(3)} > ${thresholds.maxRatio}`)
  assert.ok(result.passedVerbatim, `${fixture.name}: verbatim entity lost — ${fixture.entities.filter((e) => e.tier === 'verbatim' && !result.joined.includes(e.needle)).map((e) => e.label).join(', ')}`)
  if (thresholds.minPointedRecall !== undefined) {
    assert.ok(result.passedPointed, `${fixture.name}: pointed entity lost — ${fixture.entities.filter((e) => e.tier === 'pointed' && !result.refsAll.has(e.seq)).map((e) => e.label).join(', ')}`)
  }
  assert.equal(result.violations, thresholds.maxIntegrityViolations, `${fixture.name}: pointer integrity violations`)
  assert.equal(result.determinism, 'OK', `${fixture.name}: compilation must be deterministic`)
  if (thresholds.maxCheckpointTokens !== undefined) {
    assert.ok(result.checkpointTokens <= thresholds.maxCheckpointTokens, `${fixture.name}: capped checkpoint ${result.checkpointTokens} > ${thresholds.maxCheckpointTokens}`)
  }
  // Structured counters must match the fixture's deterministic shape — guards
  // against silent branch rot (e.g. a block type quietly losing its handler).
  for (const [key, expected] of Object.entries(fixture.expectations ?? {})) {
    assert.equal(result.stats[key], expected, `${fixture.name}: stats.${key} = ${result.stats[key]}, expected ${expected}`)
  }
}

// ── findings (printed, not asserted) ────────────────────────────────────────
// Three-tier pointer visibility per tool result:
//   pointed    — its own seq is referenced (`-> result M`);
//   superseded — its seq is not, but its CALL row survives (inside a merged
//                row), so recall via the call reaches it: a duplicate whose
//                later run supersedes it;
//   blind      — neither is referenced: no navigable path at all.
const isToolResultMessage = (message) =>
  message.role === 'tool' || message.content?.[0]?.type === 'tool-result'
for (const [index, fixture] of fixtures.entries()) {
  const result = results[index]
  const resultSeqByCallId = new Map()
  fixture.nodes.forEach(({ seq, message }) => {
    if (message.role === 'tool' && typeof message.toolCallId === 'string') resultSeqByCallId.set(message.toolCallId, seq)
    if (message.role === 'user' && message.content?.[0]?.type === 'tool-result') {
      resultSeqByCallId.set(message.content[0].toolCallId, seq)
    }
  })
  const callSeqByResultSeq = new Map()
  fixture.nodes.forEach(({ seq, message }) => {
    if (message.role !== 'assistant') return
    for (const block of message.content ?? []) {
      if (block.type !== 'tool-call') continue
      const resultSeq = resultSeqByCallId.get(block.id)
      if (resultSeq !== undefined) callSeqByResultSeq.set(resultSeq, seq)
    }
  })
  const lost = []
  const superseded = []
  for (let seq = 1; seq <= fixture.nodes.length; seq++) {
    const message = fixture.nodes[seq - 1].message
    if (!isToolResultMessage(message) || result.refsAll.has(seq)) continue
    const callSeq = callSeqByResultSeq.get(seq)
    if (callSeq !== undefined && result.refsAll.has(callSeq)) superseded.push(seq)
    else lost.push(seq)
  }
  result.unreferencedResults = lost
  result.supersededResults = superseded
}
const findings = results
  .filter((r) => r.unreferencedResults.length > 0 || r.supersededResults.length > 0)
if (findings.length > 0) {
  console.log('== findings ==')
  for (const r of findings) {
    console.log(`- ${r.name}: ${r.unreferencedResults.length} blind tool-result seq(s)` +
      (r.unreferencedResults.length > 0 ? ` (${r.unreferencedResults.join(', ')}) — no navigable path even via their call rows` : ''))
    if (r.supersededResults.length > 0) {
      console.log(`  + ${r.supersededResults.length} superseded duplicate result(s) — their call rows survive inside merged rows`)
    }
  }
}

console.log('EVAL BASELINE PASSED')
