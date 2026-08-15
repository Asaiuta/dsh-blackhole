/**
 * Content-level differential: run the REAL pi-blackhole brief compiler
 * (pinned 49ab560) and this package's VCC-style compiler on identical
 * conversation vectors, and report where the compressed *content* diverges.
 *
 * Unlike tests/equivalence/differential.mjs (protocol shape), this suite
 * compares the actual checkpoint text produced by each compiler.
 *
 * Run: node tests/equivalence/build-blackhole.mjs && node tests/equivalence/differential-brief.mjs
 */
import * as blackhole from './blackhole-brief-bundle.mjs'
import {
  compileInstantRegion,
  joinInstantEntries,
  DEFAULT_INSTANT_OPTIONS,
} from '../../lib/index.js'

// ─────────────────────────────────────────────────────────────────────────
// Shared input: pi Message shape (what pi-blackhole's normalize() reads).
// The same vector is converted to DSH RawMessage shape for this package.
// ─────────────────────────────────────────────────────────────────────────
const vectors = {
  'V1 long user text (>256 words)': [
    { role: 'user', content: 'Fix the parser. '.repeat(120) },
  ],
  'V2 assistant text with self-talk prefix': [
    { role: 'user', content: 'why is it failing?' },
    { role: 'assistant', content: 'Hmm, actually, well, the parser fails because the tokenizer splits surrogate pairs. We need to handle high and low surrogates explicitly before slicing. '.repeat(12) },
  ],
  'V3 multiline bash with cd && pipe tail': [
    { role: 'bashExecution', command: 'cd /repo/src && npm test -- --grep parser | tail -20', output: 'PASS', exitCode: 0 },
  ],
  'V4 Read tool + successful result (white-list arg)': [
    { role: 'assistant', content: [{ type: 'toolCall', name: 'Read', arguments: { file_path: '/repo/src/parser.ts' } }] },
    { role: 'toolResult', toolName: 'Read', content: 'export const parse = (src) => {...}', isError: false },
  ],
  'V5 tool error keeps error body': [
    { role: 'assistant', content: [{ type: 'toolCall', name: 'bash', arguments: { command: 'npm run build' } }] },
    { role: 'toolResult', toolName: 'bash', content: 'Command failed: exit code 1\nfatal: syntax error in src/parser.ts line 42', isError: true },
  ],
  'V6 thinking blocks elided by both': [
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'private chain-of-thought about the fix', redacted: true }, { type: 'text', text: 'Fixed it.' }] },
  ],
  'V7 repeated identical tool calls x3': [
    { role: 'assistant', content: [
      { type: 'toolCall', name: 'Grep', arguments: { pattern: 'surrogate' } },
      { type: 'toolCall', name: 'Grep', arguments: { pattern: 'surrogate' } },
      { type: 'toolCall', name: 'Grep', arguments: { pattern: 'surrogate' } },
    ] },
  ],
  'V8 ten tool calls in one turn (cap 8)': [
    { role: 'assistant', content: Array.from({ length: 10 }, (_, i) => ({ type: 'toolCall', name: 'Read', arguments: { file_path: `/repo/src/file${i}.ts` } })) },
  ],
  'V9 empty user message': [
    { role: 'user', content: '' },
    { role: 'user', content: 'real question' },
  ],
  'V10 image message': [
    { role: 'user', content: [{ type: 'text', text: 'what does this show?' }, { type: 'image', mimeType: 'image/png' }] },
  ],
  'V11 skill tag collapse': [
    { role: 'user', content: '<skill name="python">long skill body that should collapse entirely</skill>\ncontinue' },
  ],
  'V12 mixed real session': [
    { role: 'user', content: 'the compaction plugin is broken' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'debug the hybrid routing', redacted: true }, { type: 'text', text: 'Let me check the routing code.' }] },
    { role: 'assistant', content: [{ type: 'toolCall', name: 'Read', arguments: { file_path: 'src/hybrid.ts' } }] },
    { role: 'toolResult', toolName: 'Read', content: 'export class RoutingCompactionEngine ...', isError: false },
    { role: 'assistant', content: [{ type: 'toolCall', name: 'bash', arguments: { command: 'cd /repo && npx tsc --noEmit' } }] },
    { role: 'toolResult', toolName: 'bash', content: 'error TS2307: cannot find module', isError: true },
    { role: 'assistant', content: [{ type: 'toolCall', name: 'Edit', arguments: { file_path: 'src/hybrid.ts', oldText: 'x', newText: 'y' } }] },
    { role: 'toolResult', toolName: 'Edit', content: 'src/hybrid.ts updated', isError: false },
    { role: 'assistant', content: 'Now the fallback is instant and remote is routed. Hmm, actually we should test it.' },
  ],
}

// ─────────────────────────────────────────────────────────────────────────
// pi Message → DSH RawMessage conversion (semantic identity preserved)
// ─────────────────────────────────────────────────────────────────────────
let callSeq = 0
const toDsh = (msgs) => {
  callSeq = 0
  const out = []
  for (const m of msgs) {
    if (m.role === 'user') {
      if (typeof m.content === 'string') {
        out.push({ id: `u${out.length}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: m.content }] })
      } else {
        const blocks = []
        for (const part of m.content) {
          if (part.type === 'text') blocks.push({ type: 'text', text: part.text })
          else if (part.type === 'image') blocks.push({ type: 'image', mediaType: part.mimeType ?? 'image/png' })
        }
        out.push({ id: `u${out.length}`, role: 'user', source: { kind: 'user' }, content: blocks })
      }
    } else if (m.role === 'assistant') {
      if (typeof m.content === 'string') {
        out.push({ id: `a${out.length}`, role: 'assistant', source: { kind: 'model', provider: 'openai', model: 'gpt-5' }, content: [{ type: 'text', text: m.content }] })
      } else {
        const blocks = m.content.map((part) => {
          if (part.type === 'text') return { type: 'text', text: part.text }
          if (part.type === 'thinking') return { type: 'reasoning', text: part.thinking }
          if (part.type === 'toolCall') {
            callSeq += 1
            return { type: 'tool-call', id: `call_${callSeq}`, name: part.name, arguments: JSON.stringify(part.arguments ?? {}) }
          }
          return { type: 'text', text: '' }
        })
        out.push({ id: `a${out.length}`, role: 'assistant', source: { kind: 'model', provider: 'openai', model: 'gpt-5' }, content: blocks })
      }
    } else if (m.role === 'toolResult') {
      // Real DSH shape: ToolResultBlock has toolCallId + isError + content,
      // NO name — the compiler must resolve the name via the correlated call.
      out.push({
        id: `r${out.length}`, role: 'user', source: { kind: 'tool', callId: `call_${callSeq}` }, content: [
          { type: 'tool-result', toolCallId: `call_${callSeq}`, isError: m.isError, content: [{ type: 'text', text: m.content ?? '' }] },
        ],
      })
    } else if (m.role === 'bashExecution') {
      callSeq += 1
      out.push({
        id: `a${out.length}`, role: 'assistant', source: { kind: 'model', provider: 'openai', model: 'gpt-5' }, content: [
          { type: 'tool-call', id: `call_${callSeq}`, name: 'bash', arguments: JSON.stringify({ command: m.command }) },
        ],
      })
      out.push({
        id: `r${out.length}`, role: 'user', source: { kind: 'tool', callId: `call_${callSeq}` }, content: [
          { type: 'tool-result', toolCallId: `call_${callSeq}`, isError: false, content: [{ type: 'text', text: m.output ?? '' }] },
        ],
      })
    }
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────
// Run both compilers on the same vectors and report divergence
// ─────────────────────────────────────────────────────────────────────────
const summary = []
for (const [name, msgs] of Object.entries(vectors)) {
  const theirs = blackhole.compileBrief(blackhole.normalize(msgs))

  const dsh = toDsh(msgs)
  const nodes = dsh.map((message, index) => ({ seq: index, message }))
  const compiled = compileInstantRegion(nodes, DEFAULT_INSTANT_OPTIONS, 100000)
  const mine = joinInstantEntries(compiled.entries)

  console.log('='.repeat(88))
  console.log(`## ${name}`)
  console.log('─'.repeat(88))
  console.log('[pi-blackhole]')
  console.log(theirs === '' ? '(empty)' : theirs)
  console.log('[dsh instant]')
  console.log(mine === '' ? '(empty)' : mine)
  console.log()

  const tLines = theirs.split('\n').filter(Boolean)
  const mLines = mine.split('\n').filter(Boolean)
  summary.push({
    name,
    theirs: tLines.length,
    mine: mLines.length,
    sameLineCount: tLines.length === mLines.length,
  })
}

console.log('#'.repeat(88))
console.log('SUMMARY: line counts per compiler')
for (const s of summary) {
  console.log(`  ${s.sameLineCount ? '=' : '!'} ${s.name.padEnd(48)} blackhole:${String(s.theirs).padStart(2)} lines | instant:${String(s.mine).padStart(2)} lines`)
}
console.log('#'.repeat(88))