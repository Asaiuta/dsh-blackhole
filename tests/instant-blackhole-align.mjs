/**
 * Regression tests for the pi-blackhole brief-rule alignment
 * (pinned upstream 49ab560; see tests/equivalence/BRIEF-DIFF.md).
 *
 * Run: node tests/instant-blackhole-align.mjs
 */
import assert from 'node:assert/strict'
import {
  compileInstantRegion,
  joinInstantEntries,
  compressBash,
  collapseSkillText,
  stripSelfTalkPrefix,
  DEFAULT_INSTANT_OPTIONS,
} from '../lib/index.js'

const compile = (messages, options = {}) => {
  const nodes = messages.map((message, index) => ({ seq: index, message }))
  const compiled = compileInstantRegion(nodes, { ...DEFAULT_INSTANT_OPTIONS, ...options }, 100000)
  return joinInstantEntries(compiled.entries)
}

const user = (text, id = `u${Math.random()}`) => ({
  id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }],
})
const assistant = (blocks, id = `a${Math.random()}`) => ({
  id, role: 'assistant', source: { kind: 'model', provider: 'openai', model: 'gpt-5' }, content: blocks,
})
const toolResult = (toolCallId, text, isError = false, name = 'tool') => ({
  id: `r${Math.random()}`, role: 'user', source: { kind: 'tool', callId: toolCallId }, content: [
    { type: 'tool-result', toolCallId, name, isError, content: [{ type: 'text', text }] },
  ],
})
const toolCall = (id, name, args) => ({ type: 'tool-call', id, name, arguments: JSON.stringify(args) })

// ── 1. failed tool results keep `[tool_error]` with first line ────────────
{
  const out = compile([
    assistant([toolCall('c1', 'bash', { command: 'npm run build' })]),
    toolResult('c1', 'Command failed: exit code 1\nfatal: syntax error line 42', true, 'bash'),
  ])
  assert.match(out, /\[tool_error\] bash \(seq 1\)\nCommand failed: exit code 1/)
  assert.ok(!out.includes('fatal: syntax error'))
  console.log('OK: failed tool result keeps [tool_error] name + first line')
}
{
  // Successful results stay pointer-only.
  const out = compile([
    assistant([toolCall('c2', 'bash', { command: 'npm run build' })]),
    toolResult('c2', 'build ok', false, 'bash'),
  ])
  assert.ok(!out.includes('[tool_error]'))
  assert.match(out, /-> result 1/)
  console.log('OK: successful tool result stays pointer-only')
}

// ── 2. bash compression (cd-strip, pipe tail, cap) ────────────────────────
assert.equal(compressBash('cd /repo/src && npm test | tail -20'), 'npm test')
assert.equal(compressBash('cat a\ncat b\ncat c'), 'cat a; cat b; cat c')
assert.equal(compressBash('cd x && ' + 'y '.repeat(200)).length <= 120, true)
{
  const out = compile([assistant([toolCall('c3', 'bash', { command: 'cd /repo && npm test | head -5' })])])
  assert.match(out, /\* bash "npm test" \(seq 0\)/)
  assert.ok(!out.includes('cd /repo'))
  console.log('OK: bash one-liner is cd/pipe compressed and capped')
}

// ── 3. capitalized Read/Edit/Write keep their path argument ───────────────
{
  const out = compile([
    assistant([toolCall('c4', 'Read', { file_path: '/repo/src/parser.ts' })]),
    toolResult('c4', '...', false, 'Read'),
  ])
  assert.match(out, /\* Read "\/repo\/src\/parser\.ts" \(seq 0 -> result 1\)/)
  console.log('OK: capitalized Read keeps file_path (path-key fallback)')
}

// ── 4. skill blocks collapse to `[skill: name]` ───────────────────────────
assert.equal(collapseSkillText('<skill name="python">body body</skill>\ncontinue'), '[skill: python]\ncontinue')
{
  const out = compile([user('<skill name="python">long body</skill>\ncontinue')])
  assert.match(out, /\[skill: python\] continue/)
  assert.ok(!out.includes('long body'))
  console.log('OK: skill blocks collapse to [skill: name]')
}

// ── 5. self-talk prefix stripped from assistant text ──────────────────────
assert.equal(stripSelfTalkPrefix('Hmm, actually, we should test.'), 'we should test.')
{
  const out = compile([user('why?'), assistant([{ type: 'text', text: 'Hmm, actually, well, we should test.' }])])
  assert.match(out, /we should test\./)
  assert.ok(!out.includes('Hmm, actually'))
  console.log('OK: self-talk prefixes stripped from assistant text')
}

// ── 6. identical tool one-liners merge into `... xN` ──────────────────────
{
  const out = compile([assistant([
    toolCall('m1', 'Grep', { pattern: 'surrogate' }),
    toolCall('m2', 'Grep', { pattern: 'surrogate' }),
    toolCall('m3', 'Grep', { pattern: 'surrogate' }),
  ])])
  assert.match(out, /\* Grep "surrogate" \(seq 0, seq 0, seq 0\) x3/)
  assert.equal((out.match(/\* Grep/g) ?? []).length, 1)
  console.log('OK: identical tool one-liners merge with xN count')
}

// ── 7. per-turn tool cap keeps tail, note marks omission ──────────────────
// Deliberate deviation from upstream, data-backed: upstream caps per
// [assistant] section, but tool results never break a section, so a real
// agentic chain is one section and the cap chops most of it (37/152 rows on
// the profiled real session) with results pointer-invisible.  Here a turn is
// ONE assistant message (a run of entries sharing one seq) and the omission
// note carries that seq so the dropped calls stay #N-navigable.
{
  const calls = Array.from({ length: 10 }, (_, i) => toolCall(`t${i}`, 'Read', { file_path: `/f${i}.ts` }))
  const out = compile([assistant(calls)])
  assert.match(out, /\[assistant\]\n\* \(2 earlier tool-call entries omitted: seq \d+\)/)
  assert.match(out, /\/f2\.ts/)
  assert.match(out, /\/f9\.ts/)
  assert.ok(!out.includes('f0.ts') && !out.includes('f1.ts'))
  console.log('OK: per-turn tool cap keeps tail 8 + omission note with seq pointer')
}
{
  // Real agentic shape: many calls across consecutive assistant messages.
  // Upstream (per-section) would drop 2 rows here; per-message keeps them all.
  const messages = []
  for (let i = 0; i < 10; i++) messages.push(assistant([toolCall(`t${i}`, 'Read', { file_path: `/f${i}.ts` })]))
  const out = compile(messages)
  assert.ok(!out.includes('omitted'), 'calls spread across messages must not trip the per-message cap')
  assert.equal((out.match(/\* Read /g) ?? []).length, 10)
  console.log('OK: per-message cap does not fire on a cross-message call chain')
}
{
  // Cross-segment last-wins merge (deliberate deviation #3): the same base
  // across user turns collapses to the LAST occurrence; every member call seq
  // rides along in the refs, and the last member keeps its `-> result`
  // pointer.  Upstream merges adjacent rows only.
  const out = compile([
    assistant([toolCall('a1', 'Read', { file_path: '/same.ts' })]),
    toolResult('a1', 'stale contents'),
    user('go on'),
    assistant([toolCall('b1', 'Read', { file_path: '/same.ts' })]),
    toolResult('b1', 'fresh contents'),
  ])
  assert.equal((out.match(/\* Read /g) ?? []).length, 1)
  assert.match(out, /\* Read "\/same\.ts" \(seq \d+, seq \d+ -> result \d+\) x2/)
  assert.ok(out.includes('go on'))
  console.log('OK: cross-segment repeats merge last-wins with combined refs')
}

// ── 8. image mime kept in label ───────────────────────────────────────────
{
  const out = compile([{
    id: 'img-msg', role: 'user', source: { kind: 'user' },
    content: [{ type: 'text', text: 'what?' }, { type: 'image', mediaType: 'image/png' }],
  }])
  assert.match(out, /\[image: image\/png\] \(seq 0\)/)
  console.log('OK: image label keeps mime type')
}

// ── 9. whitespace flattened on untruncated text (VCC brief style) ─────────
{
  const out = compile([user('line one\n  line two\n\tline three')])
  assert.match(out, /line one line two line three/)
  console.log('OK: untruncated text whitespace is flattened')
}

// ── 10. tool-error interrupts segments; next [assistant] re-opens ─────────
{
  const out = compile([
    user('start'),
    assistant([toolCall('e1', 'bash', { command: 'npx tsc' })]),
    toolResult('e1', 'error TS2307', true, 'bash'),
    assistant([{ type: 'text', text: 'fixed' }]),
  ])
  assert.match(out, /\[tool_error\] bash \(seq 2\)\nerror TS2307\n\[assistant\]\nfixed/)
  console.log('OK: tool-error segment interrupts the role stream')
}

console.log('ALL BLACKHOLE-ALIGN TESTS PASSED')
