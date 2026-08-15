// Entity-level fidelity audit: which hard facts survive compaction?
// Run: node tests/equivalence/entity-fidelity.mjs
import { readFileSync, readdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import * as bh from './blackhole-brief-bundle.mjs'
import { compileInstantRegion, joinInstantEntries, DEFAULT_INSTANT_OPTIONS } from '../../lib/index.js'

// Session discovery: the pi session dir for the current working directory
// (i.e. the --slug-- folder under ~/.pi/agent/sessions). Point DSH_EVAL_SESSION
// at any pi session .jsonl to evaluate a different transcript.
const sessionsRoot = join(homedir(), '.pi', 'agent', 'sessions')
const cwdSlugDir = readdirSync(sessionsRoot, { withFileTypes: true })
  .find((d) => d.isDirectory() && d.name.includes(basename(process.cwd())))?.name
if (!cwdSlugDir && !process.env.DSH_EVAL_SESSION) {
  console.error('no session dir matching cwd; set DSH_EVAL_SESSION to a pi session .jsonl')
  process.exit(2)
}

const dir = join(cwdSlugDir ?? sessionsRoot)
const file = process.env.DSH_EVAL_SESSION
  ?? join(sessionsRoot, cwdSlugDir ?? '', readdirSync(join(sessionsRoot, cwdSlugDir ?? '.')).filter((f) => f.endsWith('.jsonl')).sort().at(-1) ?? '')

const messages = []
for (const line of readFileSync(file, 'utf8').split('\n')) {
  if (!line.trim()) continue
  try {
    const d = JSON.parse(line)
    if (d.type !== 'message') continue
    const m = d.message
    if (!m || typeof m.role !== 'string') continue
    if (m.role === 'assistant' && (!Array.isArray(m.content) || m.content.length === 0)) continue
    messages.push(m)
  } catch {}
}

// ── outputs ──
const theirs = bh.compileBrief(bh.normalize(messages))

let callSeq = 0
const dsh = []
for (const m of messages) {
  if (m.role === 'user') {
    const blocks = m.content.filter((p) => p.type === 'text').map((p) => ({ type: 'text', text: p.text }))
    if (!blocks.length) blocks.push({ type: 'text', text: '' })
    dsh.push({ id: 'u' + dsh.length, role: 'user', source: { kind: 'user' }, content: blocks })
  } else if (m.role === 'assistant') {
    const blocks = m.content.map((p) => {
      if (p.type === 'text') return { type: 'text', text: p.text }
      if (p.type === 'thinking') return { type: 'reasoning', text: p.thinking }
      if (p.type === 'toolCall') {
        callSeq++
        return { type: 'tool-call', id: p.id ?? 'c' + callSeq, name: p.name, arguments: typeof p.arguments === 'string' ? p.arguments : JSON.stringify(p.arguments ?? {}) }
      }
      return null
    }).filter(Boolean)
    if (blocks.length) dsh.push({ id: 'a' + dsh.length, role: 'assistant', source: { kind: 'model', provider: 'o', model: 'g' }, content: blocks })
  } else if (m.role === 'toolResult') {
    const tb = (m.content ?? []).filter((p) => p.type === 'text').map((p) => ({ type: 'text', text: p.text }))
    dsh.push({ id: 'r' + dsh.length, role: 'user', source: { kind: 'tool', callId: m.toolCallId }, content: [{ type: 'tool-result', toolCallId: m.toolCallId, isError: m.isError === true, content: tb }] })
  }
}
const compiled = compileInstantRegion(dsh.map((m, i) => ({ seq: i, message: m })), DEFAULT_INSTANT_OPTIONS, 100000)
const mine = joinInstantEntries(compiled.entries)

// ── entity extraction ──
const ENTITY_RE = /(?:[A-Za-z0-9_@.-]+\/)*[A-Za-z0-9_@.-]+\.[A-Za-z0-9_@.-]+/g
const URL_RE = /https?:\/\/[^\s)"']+/g
const collect = (text) => {
  const s = new Set()
  for (const m of text.matchAll(ENTITY_RE)) if (m[0].length > 5) s.add(m[0])
  for (const m of text.matchAll(URL_RE)) s.add(m[0])
  return s
}

const userEnts = new Set()
const asstEnts = new Set()
const toolEnts = new Set()
const errEnts = new Set()
for (const m of messages) {
  if (m.role === 'user') {
    for (const p of m.content) if (p.type === 'text') for (const e of collect(p.text)) userEnts.add(e)
  } else if (m.role === 'assistant') {
    for (const p of m.content) {
      if (p.type === 'text') for (const e of collect(p.text)) asstEnts.add(e)
      else if (p.type === 'toolCall') for (const e of collect(JSON.stringify(p.arguments ?? {}))) toolEnts.add(e)
    }
  } else if (m.role === 'toolResult') {
    for (const p of m.content ?? []) {
      if (p.type === 'text') {
        for (const e of collect(p.text)) toolEnts.add(e)
        if (m.isError === true) for (const e of collect(p.text)) errEnts.add(e)
      }
    }
  }
}

const report = (label, ents, out) => {
  const kept = [...ents].filter((e) => out.includes(e))
  const pct = ents.size ? ((kept.length / ents.size) * 100).toFixed(0) : 'n/a'
  console.log(`  ${label}: ${ents.size} entities → kept ${kept.length} (${pct}%)`)
  if (label.startsWith('tools')) {
    console.log('    kept sample  :', kept.slice(0, 6).join(' | '))
    console.log('    lost sample  :', [...ents].filter((e) => !out.includes(e)).slice(0, 6).join(' | '))
  }
}

console.log('=== entity-level fidelity (real session, 285 messages) ===')
report('user-text   ', userEnts, theirs)
report('assistant-tx', asstEnts, theirs)
report('tools+result', toolEnts, theirs)
report('tool-errors ', errEnts, theirs)
console.log('\n── same numbers for instant output ──')
report('user-text   ', userEnts, mine)
report('assistant-tx', asstEnts, mine)
report('tools+result', toolEnts, mine)
report('tool-errors ', errEnts, mine)

// ── error lines: first line of each error kept? ──
const errMsgs = []
for (const m of messages) {
  if (m.role === 'toolResult' && m.isError === true) {
    const t = (m.content ?? []).filter((p) => p.type === 'text').map((p) => p.text).join(' ')
    errMsgs.push(t.split('\n')[0].slice(0, 150))
  }
}
console.log('\nreal tool errors:', errMsgs.length)
for (const e of errMsgs.slice(0, 5)) {
  const inBh = theirs.includes(e) || theirs.includes(e.slice(0, 60))
  console.log(`  ${inBh ? 'KEPT ' : 'LOST '} ${e.slice(0, 90)}`)
}
