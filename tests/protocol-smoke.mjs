/**
 * Protocol smoke test: DSH→Responses conversion, request shape, SSE parsing,
 * and a full end-to-end remote compaction against a local HTTP server that
 * answers like a Responses compaction endpoint.
 *
 * Run: node tests/protocol-smoke.mjs
 */
import { createServer } from 'node:http'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  dshMessagesToResponseItems, buildCompactionRequestBody, parseSseData, parseCompactionV2Events,
  callResponsesCompactionV2, buildReplacementHistory, mapCompactionUsage,
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
    { type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'src/parser.ts' }] },
  ] },
]
const items = dshMessagesToResponseItems(messages)
assert.equal(items[0].type, 'message')
assert.match(items[0].content[0].text, /^Fix the bug in parser/)
assert.match(items[0].content[0].text, /image content omitted/)
assert.equal(items[1].type, 'reasoning')
assert.equal(items[2].type, 'message')
assert.equal(items[2].content[0].text, 'Found it')
assert.equal(items[3].type, 'function_call')
assert.equal(items[3].call_id, 'call_1')
assert.equal(items[4].type, 'function_call_output')
assert.equal(items[4].output, 'src/parser.ts')
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
  { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Remote summary: parser fixed.' }] } },
  { type: 'response.output_item.done', item: { type: 'compaction', encrypted_content: 'opaque-blob' } },
  { type: 'response.completed', response: { usage: { input_tokens: 1200, output_tokens: 90, input_tokens_details: { cached_tokens: 300 } } } },
].map((e) => `data: ${JSON.stringify(e)}`).join('\n\n') + '\n\ndata: [DONE]\n\n'

const events = parseSseData(sse)
assert.equal(events.length, 4)
const parsed = parseCompactionV2Events(events)
assert.equal(parsed.summaryText, 'Remote summary: parser fixed.')
assert.equal(parsed.compactionItem.type, 'compaction')
assert.equal(parsed.compactionItem.encrypted_content, 'opaque-blob')
const usage = mapCompactionUsage(parsed.usage)
assert.equal(usage.inputTokens, 900)
assert.equal(usage.outputTokens, 90)
assert.equal(usage.cacheReadTokens, 300)
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

const dir = await mkdtemp(join(tmpdir(), 'dsh-compaction-responses-state-'))
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

server.close()
await rm(dir, { recursive: true, force: true })
console.log('OK: full v2 round-trip against local endpoint (headers, path, trigger, usage)')
console.log('ALL PROTOCOL TESTS PASSED')