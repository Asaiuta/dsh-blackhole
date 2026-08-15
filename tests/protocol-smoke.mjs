/**
 * Protocol smoke test: DSH→Responses conversion, request shape, SSE parsing,
 * and a full end-to-end remote compaction against a local HTTP server that
 * answers like a Responses compaction endpoint.
 *
 * Run: node tests/protocol-smoke.mjs
 */
import { createServer } from 'node:http'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  dshMessagesToResponseItems, buildCompactionRequestBody, parseSseData, parseCompactionV2Events,
  callResponsesCompactionV2, buildReplacementHistory, mapCompactionUsage,
  parseRemoteCompactionDetails, reconstructRemoteCompactionHistory,
} from '../lib/index.js'

// --- 1. DSH message conversion -----------------------------------------
const messages = [
  { id: 'm1', role: 'user', source: { kind: 'model-writer' }, content: [
    { type: 'text', text: 'Fix the bug in parser' },
    { type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png', bytes: 10, width: 1, height: 1 } },
  ] },
  { id: 'm2', role: 'assistant', source: { kind: 'model', id: 'r1', createdAt: 0, model: 'gpt-5' }, content: [
    { type: 'reasoning', text: 'thinking about the parse tree' },
    { type: 'text', text: 'Found it' },
    { type: 'tool-call', id: 'call_1', name: 'bash', arguments: '{"cmd":"ls"}' },
  ] },
  { id: 'm3', role: 'user', source: { kind: 'tool', callId: 'call_1' }, content: [
    { type: 'tool-result', toolCallId: 'call_1', content: [
      { type: 'text', text: 'src/parser.ts' },
      { type: 'image', attachment: { attachmentId: 'a2', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } },
    ] },
  ] },
]
const items = dshMessagesToResponseItems(messages)
assert.equal(items[0].type, 'message')
assert.match(items[0].content[0].text, /^Fix the bug in parser/)
assert.match(items[0].content[1].text, /image content omitted/)
assert.equal(items[1].type, 'reasoning')
assert.equal(items[2].type, 'message')
assert.equal(items[2].content[0].text, 'Found it')
assert.equal(items[3].type, 'function_call')
assert.equal(items[3].call_id, 'call_1')
assert.equal(items[4].type, 'function_call_output')
assert.equal(items[4].output, 'src/parser.ts\n[image]')
console.log('OK: DSH message → Responses items')

// --- 2. request body shape ---------------------------------------------
const body = buildCompactionRequestBody({ model: 'gpt-5', input: items, instructions: 'sys', tools: [] })
assert.deepEqual(body.input[body.input.length - 1], { type: 'compaction_trigger' })
assert.equal(body.instructions, 'sys')
assert.equal(body.stream, true)
assert.equal(body.store, false)
console.log('OK: request body (compaction_trigger last, stream, store:false)')

// --- 3. SSE parsing -----------------------------------------------------
const sse = [
  { type: 'response.created', response: { id: 'r_1' } },
  { type: 'response.output_text.done', text: 'Remote summary: parser fixed.' },
  { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Remote summary: parser fixed.' }] } },
  { type: 'response.output_item.done', item: { type: 'compaction', encrypted_content: 'opaque-blob' } },
  { type: 'response.completed', response: { usage: { input_tokens: 1200, output_tokens: 90, input_tokens_details: { cached_tokens: 300 } } } },
].map((e) => `data: ${JSON.stringify(e)}`).join('\n\n') + '\n\ndata: [DONE]\n\n'

const events = parseSseData(sse)
assert.equal(events.length, 5)
const parsed = parseCompactionV2Events(events)
assert.equal(parsed.summaryText, 'Remote summary: parser fixed.')
assert.equal(parsed.compactionItem.type, 'compaction')
assert.equal(parsed.compactionItem.encrypted_content, 'opaque-blob')
const usage = mapCompactionUsage(parsed.usage)
assert.equal(usage.inputTokens, 900)
assert.equal(usage.outputTokens, 90)
assert.equal(usage.cacheReadTokens, 300)
assert.equal(parseCompactionV2Events([
  { type: 'response.output_text.delta', delta: 'Delta summary.' },
  { type: 'response.output_item.done', item: { type: 'compaction', encrypted_content: 'delta-only' } },
  { type: 'response.completed', response: {} },
]).summaryText, 'Delta summary.')
console.log('OK: SSE parse + summary extraction + usage mapping')

// --- 4. replacement history budget --------------------------------------
const history = buildReplacementHistory(
  [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'a'.repeat(400) }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'b'.repeat(400) }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'c'.repeat(400) }] },
  ],
  { type: 'compaction', encrypted_content: 'blob' },
  100, // fits exactly the newest message
)
assert.equal(history.length, 2)
assert.equal(history[0].content[0].text, 'c'.repeat(400))
assert.equal(history[1].type, 'compaction')
console.log('OK: replacement history (newest-first retention + opaque item)')

// --- 5. end-to-end against a local fake endpoint ------------------------
const seen = {}
const server = createServer((req, res) => {
  let raw = ''
  req.on('data', (chunk) => { raw += chunk })
  req.on('end', () => {
    seen.req = JSON.parse(raw)
    seen.auth = req.headers.authorization
    seen.ct = req.headers['content-type']
    seen.url = req.url
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const eventsFor = [
      { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Server-side summary.' }] } },
      { type: 'response.output_item.done', item: { type: 'compaction', encrypted_content: 'server-encrypted' } },
      { type: 'response.completed', response: { usage: { input_tokens: 100, output_tokens: 20 } } },
    ]
    for (const e of eventsFor) res.write(`data: ${JSON.stringify(e)}\n\n`)
    res.end('data: [DONE]\n\n')
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const { port } = server.address()

const dir = await mkdtemp(join(tmpdir(), 'dsh-blackhole-state-'))
const { RemoteCompactionStateStore } = await import('../lib/index.js')
const store = new RemoteCompactionStateStore(dir)
await store.save({
  sessionId: 's1', replacedAt: new Date().toISOString(), provider: 'openai', model: 'gpt-5',
  endpoint: 'http://127.0.0.1', summaryText: 'Server-side summary.',
  replacementHistory: [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'retained' }] },
    { type: 'compaction', encrypted_content: 'server-encrypted' },
  ],
})
const loaded = await store.load('s1')
assert.equal(loaded.replacementHistory.at(-1).encrypted_content, 'server-encrypted')
assert.equal(await store.loadForTarget({ sessionId: 's1', provider: 'openai', model: 'gpt-5' }), undefined)

const result = await callResponsesCompactionV2({
  endpoint: {
    provider: 'openai', model: '*', baseUrl: `http://127.0.0.1:${port}/v1`, apiKeyEnv: 'X', label: 'fake', headers: {},
  },
  apiKey: 'test-key',
  model: 'gpt-5',
  input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
  sessionId: 's1',
  timeoutMs: 5000,
  retainedMessageTokenBudget: 20000,
})
assert.equal(result.summaryText, 'Server-side summary.')
assert.equal(result.replacementHistory.at(-1).type, 'compaction')
assert.equal(seen.url, '/v1/responses')
assert.equal(seen.auth, 'Bearer test-key')
assert.equal(seen.ct, 'application/json')
assert.equal(seen.req.input.at(-1).type, 'compaction_trigger')
assert.equal(seen.req.prompt_cache_key, 's1')
assert.equal(result.usage.inputTokens, 100)
assert.equal(result.details.version, 2)
assert.equal(result.details.modelKey, 'openai:openai-responses:gpt-5')
assert.ok(parseRemoteCompactionDetails(result.details))
assert.equal(parseRemoteCompactionDetails({
  ...result.details,
  replacementHistory: [{ type: 'evil', payload: 'must not replay' }],
}), undefined)
const explicitPathResult = await callResponsesCompactionV2({
  endpoint: {
    provider: 'openai', model: '*', baseUrl: `http://127.0.0.1:${port}/v1/responses`, apiKeyEnv: 'X', label: 'fake', headers: {},
  },
  apiKey: 'test-key', model: 'gpt-5',
  input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello again' }] }],
  timeoutMs: 5000, retainedMessageTokenBudget: 20000,
})
assert.equal(explicitPathResult.summaryText, 'Server-side summary.')
assert.equal(seen.url, '/v1/responses')
console.log('OK: explicit /responses endpoint path is not doubled')
await store.save({
  sessionId: 's1', replacedAt: new Date().toISOString(), provider: 'openai', model: 'gpt-5',
  endpoint: `http://127.0.0.1:${port}/v1/responses`, summaryText: result.summaryText,
  replacementHistory: result.replacementHistory, details: result.details,
})
const targetState = await store.loadForTarget({
  sessionId: 's1', provider: 'openai', model: 'gpt-5', endpoint: `http://127.0.0.1:${port}/v1/responses`,
})
assert.equal(targetState.details.modelKey, 'openai:openai-responses:gpt-5')
assert.equal((await store.replayHistory({
  sessionId: 's1', provider: 'openai', model: 'gpt-5',
  trailingMessages: [
    { id: 'u', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'tail request' }] },
    { id: 'a', role: 'assistant', source: { kind: 'model', provider: 'openai', model: 'gpt-5' }, content: [{ type: 'text', text: 'tail response' }] },
  ],
})).at(-1).content[0].text, 'tail response')
const preparedReplay = await store.prepareInput({
  sessionId: 's1', provider: 'openai', model: 'gpt-5',
  endpoint: `http://127.0.0.1:${port}/v1/responses`,
  trailingMessages: [
    { id: 'u2', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'adapter turn' }] },
  ],
})
assert.equal(preparedReplay[0].type, 'message')
assert.equal(preparedReplay[1].type, 'compaction')
assert.equal(preparedReplay.at(-1).content[0].text, 'adapter turn')
console.log('OK: adapter prepareInput returns owned opaque window + trailing DSH messages')
const preparedForeign = await store.prepareInput({
  sessionId: 's1', provider: 'deepseek', model: 'deepseek-chat',
  trailingMessages: [
    { id: 'foreign', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'foreign route' }] },
  ],
})
assert.equal(preparedForeign.some((item) => item.type === 'compaction'), false)
assert.equal(preparedForeign.at(-1).content[0].text, 'foreign route')
console.log('OK: adapter prepareInput fails closed on foreign provider/model')

// Legacy artifact (no versioned `details`) is readable for diagnostics but
// must never replay: it predates the ownership contract and could hold a
// provider-private history for some other route.
await store.save({
  sessionId: 'legacy-s', replacedAt: new Date().toISOString(), provider: 'openai', model: 'gpt-5',
  endpoint: `http://127.0.0.1:${port}/v1/responses`, summaryText: 'legacy text',
  replacementHistory: result.replacementHistory, // no `details` on purpose
})
const legacyPrepared = await store.prepareInput({
  sessionId: 'legacy-s', provider: 'openai', model: 'gpt-5',
  endpoint: `http://127.0.0.1:${port}/v1/responses`,
  trailingMessages: [
    { id: 'legacy-u', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'legacy tail' }] },
  ],
})
assert.equal(legacyPrepared.some((item) => item.type === 'compaction'), false)
assert.equal(legacyPrepared.at(-1).content[0].text, 'legacy tail')
assert.equal(await store.replayHistory({
  sessionId: 'legacy-s', provider: 'openai', model: 'gpt-5', trailingMessages: [],
}), undefined)
console.log('OK: legacy artifact (no details) fails closed for replay and prepareInput')

// Endpoint mismatch: the persisted window belongs to a specific Responses
// host; an adapter pointed at another endpoint must not replay it.
const mismatched = await store.prepareInput({
  sessionId: 's1', provider: 'openai', model: 'gpt-5',
  endpoint: 'http://other-host/v1/responses',
  trailingMessages: [
    { id: 'mismatch-u', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'mismatch tail' }] },
  ],
})
assert.equal(mismatched.some((item) => item.type === 'compaction'), false)
assert.equal(mismatched.at(-1).content[0].text, 'mismatch tail')
assert.equal(await store.replayHistory({
  sessionId: 's1', provider: 'openai', model: 'gpt-5',
  endpoint: 'http://other-host/v1/responses', trailingMessages: [],
}), undefined)
console.log('OK: endpoint mismatch fails closed for replay and prepareInput')
assert.equal(await store.replayHistory({
  sessionId: 's1', provider: 'deepseek', model: 'deepseek-chat', trailingMessages: [],
}), undefined)
await store.save({
  sessionId: '../escape', replacedAt: new Date().toISOString(), provider: 'openai', model: 'gpt-5',
  endpoint: 'http://127.0.0.1/v1/responses', summaryText: 'safe', replacementHistory: result.replacementHistory,
  details: result.details,
})
await store.remove('../escape')
assert.ok((await readdir(dir)).includes('..%2Fescape.json.removed'))
console.log('OK: state filenames and remove trash path stay inside stateDir')
assert.equal(reconstructRemoteCompactionHistory({
  details: result.details,
  provider: 'openai',
  model: 'gpt-5',
  trailingMessages: [
    { id: 'a', role: 'assistant', source: { kind: 'model', provider: 'openai', model: 'gpt-5' }, content: [{ type: 'text', text: 'tail' }] },
  ],
}).at(-1).content[0].text, 'tail')
assert.equal(reconstructRemoteCompactionHistory({
  details: result.details,
  provider: 'openai',
  model: 'gpt-5',
  includePending: true,
  trailingMessages: [
    { id: 'u3', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'pending turn' }] },
  ],
}).at(-1).content[0].text, 'pending turn')
assert.equal(reconstructRemoteCompactionHistory({
  details: result.details,
  provider: 'deepseek',
  model: 'deepseek-chat',
  trailingMessages: [],
}), undefined)
console.log('OK: versioned remote details and model-owned history reconstruction')

server.close()
await rm(dir, { recursive: true, force: true })
console.log('OK: full v2 round-trip against local endpoint (headers, path, trigger, usage)')
console.log('ALL PROTOCOL TESTS PASSED')
