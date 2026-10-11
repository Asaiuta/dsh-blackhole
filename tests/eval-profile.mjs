// Composition profile for the REAL session fixture: where the shadow tokens
// sit, where the checkpoint tokens go, what gets truncated/elided, and how
// much tool-call redundancy exists.  Read-only analysis — no assertions.
// This is the evidence base for selection-work priorities; re-run it after
// each optimization to watch the composition move.
//
// Run: node tests/eval-profile.mjs   (DSH_EVAL_SESSION pins a transcript)

import {
  compileInstantRegion,
  compressBash,
  countTokens,
  DEFAULT_INSTANT_OPTIONS,
  DEFAULT_TOOL_KEY_FIELDS,
  estimateEntryTokens,
  joinInstantEntries,
  parseToolArguments,
  pickToolKeyArg,
  sanitize,
  stripSelfTalkPrefix,
  truncateTokens,
} from '../lib/index.js'
import { buildRealSession } from './eval-fixtures.mjs'

const fixture = buildRealSession()
if (fixture === null) {
  console.error('no real session available (set DSH_EVAL_SESSION)')
  process.exit(2)
}
const nodes = fixture.nodes
const fmt = (n) => String(Math.round(n)).padStart(7)
console.log(`real session: ${nodes.length} nodes, ${fixture.sourceFile}`)

// ── 1. shadow composition (block-level, serialized/4 estimator) ────────────
const blockTokens = (block) => Math.ceil(JSON.stringify(block).length / 4)
const shadow = { userText: 0, userOther: 0, toolResult: 0, assistantText: 0, reasoning: 0, toolArgs: 0, other: 0 }
const textBlocks = { assistant: [], user: [] } // { tokens } for truncation stats
for (const { message } of nodes) {
  if (message.content === undefined) continue
  const isLegacyResult = message.role === 'user' && message.content[0]?.type === 'tool-result'
  for (const block of message.content) {
    if (isLegacyResult) {
      shadow.toolResult += blockTokens(block)
      continue
    }
    if (message.role === 'user' && block.type === 'text') {
      shadow.userText += blockTokens(block)
      textBlocks.user.push({ tokens: countTokens(sanitize(block.text ?? '')) })
    } else if (message.role === 'user') {
      shadow.userOther += blockTokens(block)
    } else if (message.role === 'assistant') {
      if (block.type === 'text') {
        shadow.assistantText += blockTokens(block)
        textBlocks.assistant.push({ tokens: countTokens(sanitize(block.text ?? '')) })
      } else if (block.type === 'reasoning') {
        shadow.reasoning += blockTokens(block)
      } else if (block.type === 'tool-call') {
        shadow.toolArgs += blockTokens(block)
      } else {
        shadow.other += blockTokens(block)
      }
    }
  }
}
const shadowTotal = Object.values(shadow).reduce((a, b) => a + b, 0)
console.log('\n== shadow composition ==')
for (const [key, value] of Object.entries(shadow)) {
  console.log(`  ${key.padEnd(14)} ${fmt(value)}  (${(100 * value / shadowTotal).toFixed(1)}%)`)
}

// ── 2. checkpoint composition (by entry kind, source role for text) ────────
const compiled = compileInstantRegion(nodes, DEFAULT_INSTANT_OPTIONS, 65536)
const roleBySeq = new Map(nodes.map(({ seq, message }) => [seq, message.role]))
const ckpt = {}
const textByRole = { user: 0, assistant: 0 }
for (const entry of compiled.entries) {
  const tokens = estimateEntryTokens(entry.text)
  ckpt[entry.kind] = (ckpt[entry.kind] ?? 0) + tokens
  if (entry.kind === 'text') {
    const role = roleBySeq.get(entry.seq) ?? 'unknown'
    textByRole[role] = (textByRole[role] ?? 0) + tokens
  }
}
const ckptTotal = compiled.entries.reduce((sum, e) => sum + estimateEntryTokens(e.text), 0)
console.log('\n== checkpoint composition ==')
for (const [kind, value] of Object.entries(ckpt)) {
  console.log(`  ${kind.padEnd(14)} ${fmt(value)}  (${(100 * value / ckptTotal).toFixed(1)}%)`)
}

// ── 3. truncation & elision losses ──────────────────────────────────────────
const budget = { assistant: DEFAULT_INSTANT_OPTIONS.textTokens, user: DEFAULT_INSTANT_OPTIONS.userTextTokens }
const losses = { assistantDroppedBlocks: 0, assistantDroppedTokens: 0, userDroppedBlocks: 0, userDroppedTokens: 0 }
for (const [role, blocks] of Object.entries(textBlocks)) {
  for (const { tokens } of blocks) {
    if (tokens > budget[role]) {
      losses[`${role}DroppedBlocks`] += 1
      losses[`${role}DroppedTokens`] += tokens - budget[role]
    }
  }
}
console.log('\n== per-block truncation losses (head-kept, tail-cut) ==')
console.log(`  assistant: ${losses.assistantDroppedBlocks}/${textBlocks.assistant.length} blocks over ${budget.assistant} tokens, ~${fmt(losses.assistantDroppedTokens)} tokens dropped (mids, head+tail kept)`)
console.log(`  user     : ${losses.userDroppedBlocks}/${textBlocks.user.length} blocks over ${budget.user} tokens, ~${fmt(losses.userDroppedTokens)} tokens dropped (mids, head+tail kept)`)
console.log(`  reasoning: fully elided by design, ${fmt(shadow.reasoning)} shadow tokens behind it`)

// ── 4. tool-call redundancy ─────────────────────────────────────────────────
const calls = []
const resultSeqByCallId = new Map()
nodes.forEach(({ seq, message }) => {
  if (message.role === 'user' && message.content[0]?.type === 'tool-result') {
    resultSeqByCallId.set(message.content[0].toolCallId, seq)
  }
})
nodes.forEach(({ seq, message }) => {
  if (message.role !== 'assistant') return
  for (const block of message.content) {
    if (block.type === 'tool-call') calls.push({ seq, id: block.id, name: block.name, arguments: block.arguments })
  }
})
const baseOf = (callRow) => {
  if (callRow.name === 'bash' || callRow.name === 'Bash') {
    const parsed = parseToolArguments(callRow.arguments)
    return compressBash(parsed !== null && typeof parsed.command === 'string' ? parsed.command : '', 120)
  }
  return pickToolKeyArg(callRow.name, parseToolArguments(callRow.arguments), DEFAULT_TOOL_KEY_FIELDS) ?? `* ${callRow.name}`
}
const groups = new Map()
for (const callRow of calls) {
  const base = baseOf(callRow)
  if (!groups.has(base)) groups.set(base, [])
  groups.get(base).push(callRow)
}
let repeatGroups = 0
let extraRows = 0
let adjacentMerged = 0
let repeatResultTokens = 0
for (const [, members] of groups) {
  if (members.length < 2) continue
  repeatGroups += 1
  extraRows += members.length - 1
  for (let i = 1; i < members.length; i++) {
    if (members[i].seq - members[i - 1].seq <= 2) adjacentMerged += 1
  }
  // token mass sitting behind all-but-last repeats' results (recall redundancy)
  for (const member of members.slice(0, -1)) {
    const resultSeq = resultSeqByCallId.get(member.id)
    if (resultSeq === undefined) continue
    const message = nodes[resultSeq - 1]?.message
    const body = message?.content?.[0]?.content ?? message?.content ?? []
    for (const block of body) repeatResultTokens += blockTokens(block)
  }
}
console.log('\n== tool-call redundancy ==')
console.log(`  calls: ${calls.length}, distinct bases: ${groups.size}, repeat groups: ${repeatGroups}`)
console.log(`  extra rows from repeats: ${extraRows} (of which ${adjacentMerged} adjacent — already merged today; ${extraRows - adjacentMerged} cross-turn rows each costing a full one-liner)`)
console.log(`  shadow result tokens behind all-but-last repeats: ~${fmt(repeatResultTokens)}`)

// ── 5. pointer visibility of results (three tiers) ──────────────────────────
const { refs } = { refs: collectRefsPublic(joinInstantEntries(compiled.entries)) }
const isResult = (message) => message.role === 'tool' || message.content?.[0]?.type === 'tool-result'
// call row seq per result seq — a result whose own pointer died but whose
// call row survives (inside a merged row) is still reachable via the call.
const callSeqByResultSeq = new Map()
for (const callRow of calls) {
  const resultSeq = resultSeqByCallId.get(callRow.id)
  if (resultSeq !== undefined) callSeqByResultSeq.set(resultSeq, callRow.seq)
}
let resultsTotal = 0
let resultsPointed = 0
let resultsSuperseded = 0
let resultsBlind = 0
for (let seq = 1; seq <= nodes.length; seq++) {
  if (!isResult(nodes[seq - 1].message)) continue
  resultsTotal += 1
  if (refs.has(seq)) resultsPointed += 1
  else {
    const callSeq = callSeqByResultSeq.get(seq)
    if (callSeq !== undefined && refs.has(callSeq)) resultsSuperseded += 1
    else resultsBlind += 1
  }
}
console.log('\n== pointer visibility ==')
console.log(`  tool results: ${resultsTotal} — pointed ${resultsPointed}, superseded duplicates (call row survives merged) ${resultsSuperseded}, blind ${resultsBlind}`)
console.log(`  stats: elidedToolRows=${compiled.stats.elidedToolRows}, elidedRows=${compiled.stats.elidedRows}, toolErrors=${compiled.stats.toolErrors}, capped=${compiled.capped}`)

function collectRefsPublic(text) {
  const refs = new Set()
  for (const m of text.matchAll(/seq (\d+)/g)) refs.add(Number(m[1]))
  for (const m of text.matchAll(/seqs (\d+)-(\d+)/g)) for (let s = Number(m[1]); s <= Number(m[2]); s++) refs.add(s)
  for (const m of text.matchAll(/-> result (\d+)/g)) refs.add(Number(m[1]))
  return refs
}
