/**
 * Hybrid engine smoke test: the dual-pipeline router on one seam.
 *
 * Covers:
 *   1. the deterministic local compiler (unit level);
 *   2. seq resolution against a fake session event log;
 *   3. remote success for an OpenAI-routed target (local fake HTTP endpoint);
 *   4. remote failure → instant fallback (default mode);
 *   5. no endpoint match → instant, no network;
 *   6. fallbackMode 'llm' → remote failure → native LLM summarizer;
 *   7. legacy fallbackToLlm:false → instant, no LLM call.
 *
 * Run: node tests/hybrid-smoke.mjs
 */
import { createServer } from 'node:http'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import {
  compileInstantRegion, joinInstantEntries, resolveRegionSeqs,
  DEFAULT_INSTANT_OPTIONS, RoutingCompactionEngine,
} from '../lib/index.js'

// ── 1. local compiler (unit) ────────────────────────────────────────────
const nodes = [
  { seq: 0, message: { id: 'm0', role: 'user', content: [
    { type: 'text', text: 'Fix the parser. '.repeat(600) }, // long enough to truncate
  ] } },
  { seq: 1, message: { id: 'm1', role: 'assistant', content: [
    { type: 'reasoning', text: 'thinking quietly' },
    { type: 'text', text: 'On it.' },
    { type: 'tool-call', id: 'call_1', name: 'bash', arguments: '{"command":"ls -la"}' },
    { type: 'tool-call', id: 'call_2', name: 'grep', arguments: '{"pattern":"parser"}' },
  ] } },
  { seq: 2, message: { id: 'm2', role: 'user', source: { kind: 'tool', callId: 'call_1' }, content: [
    { type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'src/parser.ts' }] },
  ] } },
  { seq: 3, message: { id: 'm3', role: 'assistant', content: [
    { type: 'text', text: 'Fixed.' },
  ] } },
]
const compiled = compileInstantRegion(nodes, DEFAULT_INSTANT_OPTIONS, 20000)
const text = joinInstantEntries(compiled.entries)
assert.ok(text.includes('[user]\n'), 'role header for user opens')
assert.ok(text.includes('...(truncated from seq 0)'), 'user text truncated with seq pointer')
assert.ok(!text.includes('thinking quietly'), 'reasoning elided by default')
assert.ok(text.includes('On it.'), 'assistant text kept')
assert.ok(text.includes('* bash "ls -la" (seq 1 -> result 2)'), 'tool one-liner with result pointer')
assert.ok(text.includes('* grep "parser" (seq 1)'), 'second tool call, no result yet')
assert.ok(text.includes('Fixed.'), 'later assistant text kept')
assert.equal(compiled.stats.toolCalls, 2)
assert.equal(compiled.stats.toolResults, 1)
assert.equal(compiled.stats.reasoningElided, 1)
assert.equal(compiled.capped, false)
console.log('OK: compiler unit (headers, truncation, tool pointers, reasoning elision)')

// cap elision: tiny cap drops the oldest tool rows first
const capped = compileInstantRegion(nodes, DEFAULT_INSTANT_OPTIONS, 60)
assert.equal(capped.capped, true)
assert.ok(capped.stats.elidedRows >= 1)
assert.match(joinInstantEntries(capped.entries), /\[.+elided: /)
console.log('OK: compiler cap (oldest rows elided, note prepended)')

// reasoning kept with includeReasoning
const withReasoning = compileInstantRegion(
  nodes,
  { ...DEFAULT_INSTANT_OPTIONS, includeReasoning: true },
  20000,
)
assert.ok(joinInstantEntries(withReasoning.entries).includes('thinking quietly'))
console.log('OK: compiler includeReasoning')

// ── 2. seq resolution ───────────────────────────────────────────────────
const eventMessages = [
  { id: 'm0', role: 'user', content: [] },
  { id: 'm1', role: 'assistant', content: [] },
  { id: 'm2', role: 'user', content: [] },
]
const session = {
  id: 'sess-1',
  events: eventMessages.map((message, seq) => ({ seq, type: 'message', message })),
  deriveEventMessage(event) { return event.message ?? null },
  requestHeader() { return { config: { provider: 'openai', model: 'gpt-5' } } },
}
const seqs = resolveRegionSeqs(session, eventMessages)
assert.deepEqual(seqs, [0, 1, 2])
assert.equal(resolveRegionSeqs(session, [{ id: 'ghost', role: 'user', content: [] }])[0], -1)
console.log('OK: resolveRegionSeqs (id → durable seq, unknown → -1)')

// ── helper: fake agent over the fake session ────────────────────────────
const fakeAgent = (provider, model) => ({
  id: 'sess-1',
  options: {},
  session: {
    ...session,
    requestHeader() { return { config: { provider, model } } },
  },
})
const longMessages = eventMessages.map((message, index) => ({
  ...message,
  content: [{ type: 'text', text: `Message number ${index}: ${'y'.repeat(5000)}` }],
}))

const stubCtx = (llm) => {
  const context = new Context()
  if (llm !== undefined) context.llm = llm
  context.logger.info = () => {}
  context.logger.warn = () => {}
  context.logger.debug = () => {}
  context.logger.error = () => {}
  return context
}

const instantProvider = async (engine, agent, messages) => {
  const result = await engine.summarize({ system: 'sys', tools: [], messages }, agent)
  assert.equal(result.provider, 'instant')
  assert.equal(result.model, 'vcc-compiler')
  return result.summary[0].text
}

// ── 3. remote success (OpenAI target + local fake endpoint) ─────────────
const remoteSeen = {}
const server = createServer((req, res) => {
  let raw = ''
  req.on('data', (chunk) => { raw += chunk })
  req.on('end', () => {
    remoteSeen.body = JSON.parse(raw)
    remoteSeen.auth = req.headers.authorization
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const events = [
      { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Remote summary: parser fixed.' }] } },
      { type: 'response.output_item.done', item: { type: 'compaction', encrypted_content: 'opaque' } },
      { type: 'response.completed', response: { usage: { input_tokens: 900, output_tokens: 40 } } },
    ]
    for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`)
    res.end('data: [DONE]\n\n')
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const { port } = server.address()

const dir = await mkdtemp(join(tmpdir(), 'dsh-blackhole-hybrid-'))
const engine = new RoutingCompactionEngine(stubCtx(), {
  auto: false,
  endpoints: [{ provider: 'openai', model: 'gpt-5', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k', label: 'fake' }],
  stateDir: dir,
})

const remote = await engine.summarize(
  { system: 'sys', tools: [], messages: longMessages },
  fakeAgent('openai', 'gpt-5'),
)
assert.equal(remote.provider, 'fake') // label defaults to baseUrl host
assert.equal(remote.summary[0].text, 'Remote summary: parser fixed.')
assert.equal(remoteSeen.auth, 'Bearer k')
assert.equal(remoteSeen.body.input.at(-1).type, 'compaction_trigger')
console.log('OK: OpenAI target → remote v2 success (state saved, no local compile)')

const replayTail = [
  { id: 'tail-u', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue from the remote checkpoint.' }] },
  { id: 'tail-a', role: 'assistant', source: { kind: 'model', provider: 'openai', model: 'gpt-5' }, content: [{ type: 'text', text: 'Continuing.' }] },
]
await engine.summarize(
  { system: 'sys', tools: [], messages: replayTail },
  fakeAgent('openai', 'gpt-5'),
)
assert.ok(remoteSeen.body.input.some((item) => item.type === 'compaction' && item.encrypted_content === 'opaque'))
assert.ok(remoteSeen.body.input.some((item) => item.type === 'message' && item.content?.some((part) => part.text === 'Continue from the remote checkpoint.')))
console.log('OK: next remote compaction replays opaque history + completed trailing turn')

// ── 3b. official compaction-only response stays a remote success ─────────
// The Responses API may return only an opaque compaction item.  There is no
// readable assistant message to project, but that is still a valid remote
// compaction and must not be mistaken for a failed request / instant fallback.
const compactionOnly = createServer((req, res) => {
  req.resume()
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const events = [
      { type: 'response.output_item.done', item: { type: 'compaction', encrypted_content: 'opaque-only' } },
      { type: 'response.completed', response: { usage: { input_tokens: 901, output_tokens: 1 } } },
    ]
    for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`)
    res.end('data: [DONE]\n\n')
  })
})
await new Promise((resolve) => compactionOnly.listen(0, '127.0.0.1', resolve))
const engineOnly = new RoutingCompactionEngine(stubCtx(), {
  auto: false,
  endpoints: [{ provider: 'openai', model: 'gpt-5', baseUrl: `http://127.0.0.1:${compactionOnly.address().port}/v1`, apiKey: 'k', label: 'fake-only' }],
  stateDir: dir,
})
const opaqueOnly = await engineOnly.summarize(
  { system: 'sys', tools: [], messages: longMessages },
  fakeAgent('openai', 'gpt-5'),
)
assert.equal(opaqueOnly.provider, 'fake-only')
assert.equal(opaqueOnly.model, 'gpt-5')
assert.match(opaqueOnly.summary[0].text, /^Remote Responses compaction applied for openai\/gpt-5/)
assert.equal((await engineOnly.state.load('sess-1')).replacementHistory.at(-1).encrypted_content, 'opaque-only')
console.log('OK: remote compaction-only response → portable remote checkpoint (no instant fallback)')

// ── 4. remote failure → instant (default fallbackMode) ──────────────────
const failing = createServer((req, res) => {
  req.resume()
  req.on('end', () => {
    res.writeHead(500, { 'content-type': 'text/plain' })
    res.end('boom')
  })
})
await new Promise((resolve) => failing.listen(0, '127.0.0.1', resolve))
const engine2 = new RoutingCompactionEngine(stubCtx(), {
  auto: false,
  endpoints: [{ provider: 'openai', model: 'gpt-5', baseUrl: `http://127.0.0.1:${failing.address().port}/v1`, apiKey: 'k', label: 'fake' }],
  stateDir: dir,
})
const fallback = await engine2.summarize(
  { system: 'sys', tools: [], messages: longMessages },
  fakeAgent('openai', 'gpt-5'),
)
assert.equal(fallback.provider, 'instant')
assert.ok(fallback.summary[0].text.includes('seq 0'))
assert.equal(await engine2.state.load('sess-1'), undefined)
console.log('OK: remote 500 → instant fallback (zero model calls)')

// ── 5. no endpoint match → instant, no network ──────────────────────────
const engine3 = new RoutingCompactionEngine(stubCtx(), {
  auto: false,
  endpoints: [{ provider: 'openai', model: 'gpt-5', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k', label: 'fake' }],
  stateDir: dir,
})
const local = await engine3.summarize(
  { system: 'sys', tools: [], messages: longMessages },
  fakeAgent('deepseek', 'deepseek-chat'),
)
assert.equal(local.provider, 'instant')
assert.ok(local.summary[0].text.includes('Message number'))
console.log('OK: deepseek target → instant, no remote attempt')

// ── 6. fallbackMode 'llm' → remote failure → native LLM ─────────────────
let llmCalls = 0
const llmEngine = new RoutingCompactionEngine(stubCtx({
  async *stream() {
    llmCalls += 1
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'LLM FALLBACK SUMMARY' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'LLM FALLBACK SUMMARY' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
}), {
  auto: false,
  fallbackMode: 'llm',
  endpoints: [{ provider: 'openai', model: 'gpt-5', baseUrl: `http://127.0.0.1:${failing.address().port}/v1`, apiKey: 'k', label: 'fake' }],
  stateDir: dir,
})
const llmResult = await llmEngine.summarize(
  { system: 'sys', tools: [], messages: longMessages },
  fakeAgent('openai', 'gpt-5'),
)
assert.equal(llmResult.provider, 'openai')
assert.equal(llmResult.model, 'gpt-5')
assert.ok(llmResult.summary[0].text.includes('LLM FALLBACK SUMMARY'))
assert.equal(llmResult.llmStreamCall, true)
assert.equal(llmCalls, 1)
console.log('OK: fallbackMode "llm" → remote failure → native LLM summarizer')

// ── 7. legacy fallbackToLlm:false → instant, no LLM call ────────────────
const legacyEngine = new RoutingCompactionEngine(stubCtx(), {
  auto: false,
  fallbackToLlm: false,
  endpoints: [{ provider: 'openai', model: 'gpt-5', baseUrl: `http://127.0.0.1:${failing.address().port}/v1`, apiKey: 'k', label: 'fake' }],
  stateDir: dir,
})
const legacy = await legacyEngine.summarize(
  { system: 'sys', tools: [], messages: longMessages },
  fakeAgent('openai', 'gpt-5'),
)
assert.equal(legacy.provider, 'instant')
console.log('OK: legacy fallbackToLlm:false → instant (compat mapping)')

// ── 8. invalid fallbackMode rejected at construction ────────────────────
assert.throws(() => new RoutingCompactionEngine(stubCtx(), { auto: false, fallbackMode: 'bogus' }))
console.log('OK: invalid fallbackMode rejected')

server.close()
failing.close()
compactionOnly.close()
await rm(dir, { recursive: true, force: true })
console.log('ALL HYBRID TESTS PASSED')
