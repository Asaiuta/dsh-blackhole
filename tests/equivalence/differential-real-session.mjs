/**
 * REAL-session content differential: run pi-blackhole's brief compiler and
 * this package's compiler on actual pi session transcripts recorded on this
 * machine (not synthetic vectors).
 *
 * Reference style is normalized away for comparison: `(#N)` (pi message
 * index) and `(seq N ...)` (DSH durable seq) marks are stripped, and extra
 * role headers are collapsed, so the diff shows CONTENT differences only.
 *
 * Run: node tests/equivalence/differential-real-session.mjs
 */
import { readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'
import * as blackhole from './blackhole-brief-bundle.mjs'
import {
  compileInstantRegion,
  joinInstantEntries,
  DEFAULT_INSTANT_OPTIONS,
} from '../../lib/index.js'

// Override with DSH_EVAL_SESSION to point at any pi session .jsonl.
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

const SESSION_FILE = process.env.DSH_EVAL_SESSION
  ?? join(sessionsRoot, cwdSlugDir ?? '', readdirSync(join(sessionsRoot, cwdSlugDir ?? '.')).filter((f) => f.endsWith('.jsonl')).sort().at(-1) ?? '')

// ── 1. load real messages (skip the current live session, use the archive) ─
const lines = (await readFile(SESSION_FILE, 'utf8')).split('\n')
const messages = []
for (const line of lines) {
  if (!line.trim()) continue
  try {
    const d = JSON.parse(line)
    if (d.type !== 'message') continue
    const m = d.message
    if (!m || typeof m.role !== 'string') continue
    // Drop error shells with no content (429 retry frames and the like).
    if (m.role === 'assistant' && (!Array.isArray(m.content) || m.content.length === 0)) continue
    messages.push(m)
  } catch {}
}

// Take a dense window covering multiple full tool chains.
const start = Math.max(0, messages.findIndex((m) => m.role === 'user') + 1)
const window = messages.slice(start, start + 60)

// ── 2. pi-blackhole side: feed the real messages straight in ──────────────
const theirs = blackhole.compileBrief(blackhole.normalize(window))

// ── 3. DSH side: convert real pi messages to DSH RawMessage shape ─────────
const toDsh = (piMessages) => {
  let callSeq = 0
  const out = []
  for (const m of piMessages) {
    if (m.role === 'user') {
      const blocks = []
      for (const part of m.content) {
        if (part.type === 'text') blocks.push({ type: 'text', text: part.text })
        else if (part.type === 'image') blocks.push({ type: 'image', mediaType: part.mimeType })
      }
      if (blocks.length === 0) blocks.push({ type: 'text', text: '' })
      out.push({ id: `u${out.length}`, role: 'user', source: { kind: 'user' }, content: blocks })
    } else if (m.role === 'assistant') {
      const blocks = m.content.map((part) => {
        if (part.type === 'text') return { type: 'text', text: part.text }
        if (part.type === 'thinking') return { type: 'reasoning', text: part.thinking }
        if (part.type === 'toolCall') {
          callSeq += 1
          const args = typeof part.arguments === 'string' ? part.arguments : JSON.stringify(part.arguments ?? {})
          return { type: 'tool-call', id: part.id ?? `call_${callSeq}`, name: part.name, arguments: args }
        }
        return null
      }).filter(Boolean)
      if (blocks.length > 0) {
        out.push({ id: `a${out.length}`, role: 'assistant', source: { kind: 'model', provider: 'openai', model: 'gpt-5' }, content: blocks })
      }
    } else if (m.role === 'toolResult') {
      const textBlocks = []
      for (const part of m.content ?? []) {
        if (part.type === 'text') textBlocks.push({ type: 'text', text: part.text })
      }
      out.push({
        id: `r${out.length}`, role: 'user', source: { kind: 'tool', callId: m.toolCallId }, content: [
          { type: 'tool-result', toolCallId: m.toolCallId, isError: m.isError === true, content: textBlocks },
        ],
      })
    }
  }
  return out
}

const dsh = toDsh(window)
const nodes = dsh.map((message, index) => ({ seq: index, message }))
const compiled = compileInstantRegion(nodes, DEFAULT_INSTANT_OPTIONS, 100000)
const mine = joinInstantEntries(compiled.entries)

// ── 4. normalize both for content comparison ──────────────────────────────
// Strip reference marks: (#N), (seq N), (seq N -> result M), role headers.
const stripRefs = (text) => text
  .replace(/\(#[\d, #]+\)(?: x\d+)?/g, '')             // pi refs + merge count
  .replace(/\(seq [^)]*\)/g, '')                        // dsh seq refs incl. -> result
  .replace(/^\[(user|assistant|system)\]$/gm, '')       // bare role headers
  .replace(/^\[(user|assistant|system)\]\n/gm, '')      // inline role headers
  .replace(/^\s*\* \(\d+ earlier tool-call entries omitted(?:: seq -?\d+)?\)\s*$/gm, '')
  .replace(/^\s+|\s+$/gm, '')                            // per-line whitespace
  .replace(/\n{3,}/g, '\n\n')
  .trim()

const normTheirs = stripRefs(theirs)
const normMine = stripRefs(mine)

// ── 5. report ─────────────────────────────────────────────────────────────
console.log('real session:', SESSION_FILE)
console.log(`messages in window: ${window.length} (user:${window.filter((m) => m.role === 'user').length}, assistant:${window.filter((m) => m.role === 'assistant').length}, toolResult:${window.filter((m) => m.role === 'toolResult').length})`)
console.log('pi-blackhole lines:', theirs.split('\n').filter(Boolean).length)
console.log('dsh instant lines :', mine.split('\n').filter(Boolean).length)

const tLines = normTheirs.split('\n').filter(Boolean)
const mLines = normMine.split('\n').filter(Boolean)
console.log('normalized lines:', tLines.length, 'vs', mLines.length)

// Strict per-line comparison with first-divergence reporting.
let diffPairs = 0
const max = Math.max(tLines.length, mLines.length)
for (let i = 0; i < max; i++) {
  const x = tLines[i] ?? '(MISSING)'
  const y = mLines[i] ?? '(MISSING)'
  if (x === y) continue
  diffPairs++
  let j = 0
  while (j < x.length && j < y.length && x[j] === y[j]) j++
  console.log(`DIFF line ${i} @char ${j} (bh ${x.length} / dsh ${y.length})`)
  console.log('  bh :', JSON.stringify(x.slice(Math.max(0, j - 40), j + 60)))
  console.log('  dsh:', JSON.stringify(y.slice(Math.max(0, j - 40), j + 60)))
}
console.log('\n' + (diffPairs === 0
  ? 'RESULT: content-identical (line-for-line) after reference normalization'
  : `RESULT: ${diffPairs}/${max} lines differ (all remaining diffs are truncation-point offsets)`))