// Side-by-side comparison on the SAME real session: upstream pi-blackhole's
// brief compiler (vendored, deterministic, no model key) vs this package's
// instant compiler (current code).  One yardstick for both outputs: this
// package's token estimator and the same entity extraction.  The official
// dsh-compaction-basic (LLM one-shot) cannot run keyless — its numbers live
// in tests/equivalence/FIDELITY.md (LLM A/B) and are cited in the report.
//
// Run: node tests/eval-compare.mjs   (DSH_EVAL_SESSION pins a transcript)

import {
  compileInstantRegion,
  DEFAULT_INSTANT_OPTIONS,
  estimateEntryTokens,
  estimateMessagesTokens,
  joinInstantEntries,
} from '../lib/index.js'
import * as bh from './equivalence/blackhole-brief-bundle.mjs'
import { buildRealSession, loadPiMessages } from './eval-fixtures.mjs'

const fixture = buildRealSession()
if (fixture === null) {
  console.error('no real session available (set DSH_EVAL_SESSION)')
  process.exit(2)
}
const piMessages = loadPiMessages(fixture.sourceFile)

// Same shadow yardstick for both sides: our estimator over the converted nodes.
const shadowTokens = estimateMessagesTokens(fixture.nodes.map((node) => node.message))

// ── compile both ────────────────────────────────────────────────────────────
const piBrief = bh.compileBrief(bh.normalize(piMessages))
const ours = compileInstantRegion(fixture.nodes, DEFAULT_INSTANT_OPTIONS, 65536)
const ourBrief = joinInstantEntries(ours.entries)

// ── shared entity extraction (entity-fidelity's classes) ───────────────────
const ENTITY_RE = /(?:[A-Za-z0-9_@.-]+\/)*[A-Za-z0-9_@.-]+\.[A-Za-z0-9_@.-]+/g
const URL_RE = /https?:\/\/[^\s)"']+/g
const collect = (text) => {
  const found = new Set()
  for (const m of text.matchAll(ENTITY_RE)) if (m[0].length > 5) found.add(m[0])
  for (const m of text.matchAll(URL_RE)) found.add(m[0])
  return found
}
const classes = { user: new Set(), assistant: new Set(), tool: new Set(), error: new Set() }
const errorFirstLines = []
for (const m of piMessages) {
  if (m.role === 'user') {
    for (const p of m.content ?? []) if (p.type === 'text') for (const e of collect(p.text)) classes.user.add(e)
  } else if (m.role === 'assistant') {
    for (const p of m.content ?? []) {
      if (p.type === 'text') for (const e of collect(p.text)) classes.assistant.add(e)
      else if (p.type === 'toolCall') for (const e of collect(JSON.stringify(p.arguments ?? {}))) classes.tool.add(e)
    }
  } else if (m.role === 'toolResult') {
    for (const p of m.content ?? []) {
      if (p.type !== 'text') continue
      for (const e of collect(p.text)) classes.tool.add(e)
      if (m.isError === true) {
        for (const e of collect(p.text)) classes.error.add(e)
        errorFirstLines.push(p.text.split('\n')[0].slice(0, 150))
      }
    }
  }
}

const refsOf = (text) => {
  const refs = new Set()
  for (const m of text.matchAll(/seq (\d+)/g)) refs.add(Number(m[1]))
  for (const m of text.matchAll(/seqs (\d+)-(\d+)/g)) for (let s = Number(m[1]); s <= Number(m[2]); s++) refs.add(s)
  for (const m of text.matchAll(/-> result (\d+)/g)) refs.add(Number(m[1]))
  return refs
}

// Our result-visibility tiers (call row reachable = superseded duplicate).
const isResultMessage = (message) => message.role === 'tool' || message.content?.[0]?.type === 'tool-result'
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
const ourRefs = refsOf(ourBrief)
let resultsPointed = 0
let resultsSuperseded = 0
let resultsBlind = 0
const totalResults = fixture.nodes.filter(({ message }) => isResultMessage(message)).length
for (let seq = 1; seq <= fixture.nodes.length; seq++) {
  if (!isResultMessage(fixture.nodes[seq - 1].message)) continue
  if (ourRefs.has(seq)) resultsPointed += 1
  else {
    const callSeq = callSeqByResultSeq.get(seq)
    if (callSeq !== undefined && ourRefs.has(callSeq)) resultsSuperseded += 1
    else resultsBlind += 1
  }
}

// ── report ──────────────────────────────────────────────────────────────────
const pad = (value, width = 9) => String(value).padStart(width)
console.log(`real session: ${piMessages.length} pi messages, ${fixture.nodes.length} nodes, source ${fixture.sourceFile}`)
console.log(`shadow (our yardstick): ~${shadowTokens} tokens\n`)
console.log(`                         ${'pi-blackhole (upstream)'.padEnd(26)} ${'dsh-blackhole (current)'.padEnd(26)}`)
const row = (label, a, b) => console.log(`  ${label.padEnd(24)} ${pad(a)} ${' '.repeat(17)} ${pad(b)}`)
row('output tokens', estimateEntryTokens(piBrief), estimateEntryTokens(ourBrief))
row('output chars', piBrief.length, ourBrief.length)
row('ratio vs shadow', (estimateEntryTokens(piBrief) / shadowTokens).toFixed(3), (estimateEntryTokens(ourBrief) / shadowTokens).toFixed(3))
console.log()
for (const [label, set] of Object.entries(classes)) {
  const keptPi = [...set].filter((e) => piBrief.includes(e)).length
  const keptOurs = [...set].filter((e) => ourBrief.includes(e)).length
  row(`entity recall ${label}`, `${keptPi}/${set.size}`, `${keptOurs}/${set.size}`)
}
const firstLinesPi = errorFirstLines.filter((l) => piBrief.includes(l)).length
const firstLinesOurs = errorFirstLines.filter((l) => ourBrief.includes(l)).length
row('error first lines', `${firstLinesPi}/${errorFirstLines.length}`, `${firstLinesOurs}/${errorFirstLines.length}`)
console.log()
row('refs emitted (#N/seq N)', (piBrief.match(/\(#\d+\)/g) ?? []).length, ourRefs.size)
row('tool rows', (piBrief.match(/^ \* /gm) ?? []).length + (piBrief.match(/^\* /gm) ?? []).length, (ourBrief.match(/^\* /gm) ?? []).length)
row('cap omission notes', (piBrief.match(/earlier tool-call entries omitted/g) ?? []).length, (ourBrief.match(/earlier tool-call entries omitted/g) ?? []).length)
row('truncation markers', (piBrief.match(/\.\.\.\(truncated\)/g) ?? []).length, (ourBrief.match(/\.\.\.\((?:truncated|elided)/g) ?? []).length)
console.log()
console.log(`  result visibility (ours): pointed ${resultsPointed}, superseded ${resultsSuperseded}, blind ${resultsBlind} of ${totalResults}`)
console.log('  result visibility (pi):   no result pointers exist upstream — results are dropped; only error first lines survive inline')
