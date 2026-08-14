/**
 * Differential test: run the REAL algal/pi-openai-server-compaction code
 * (bundled from its main-branch source, pi deps stubbed) against this port on
 * identical vectors and assert protocol equivalence.
 *
 * Run: node .diff-labs/differential.mjs
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import * as algal from './algal-bundle.mjs'
import * as mine from '../../lib/index.js'

const norm = (x) => JSON.parse(JSON.stringify(x))
const results = []

async function check(name, fn) {
  try {
    await fn()
    results.push(['PASS', name])
    console.log(`PASS ${name}`)
  } catch (e) {
    results.push(['FAIL', name])
    console.log(`FAIL ${name}\n  ${String(e.message ?? e).split('\n').slice(0, 6).join('\n  ')}`)
  }
}

// =====================================================================
// V1: request body
// =====================================================================
await check('V1 request body equivalent', () => {
  const input = [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
    { type: 'function_call', name: 'bash', call_id: 'c1', arguments: '{"cmd":"ls"}' },
  ]
  const a = algal.buildRemoteCompactionRequestBody({
    model: { id: 'gpt-5.4', provider: 'openai', api: 'openai-responses' }, input, instructions: 'sys', tools: [{ type: 'function', name: 'bash' }],
    parallelToolCalls: true, sessionId: 's1',
  })
  const b = mine.buildCompactionRequestBody({ model: 'gpt-5.4', input, instructions: 'sys', tools: [{ type: 'function', name: 'bash' }], sessionId: 's1' })
  assert.deepEqual(norm(b), norm(a))
})

// =====================================================================
// V2: replacement history
// =====================================================================
await check('V2 replacement history equivalent', () => {
  const input = [
    { type: 'message', role: 'user', content: [] }, // empty — dropped by both
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'a'.repeat(400) }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'b'.repeat(400) }] },
    { type: 'message', role: 'user', content: [ // image exempt from budget in both
      { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
      { type: 'input_text', text: 'desc-of-image' },
    ] },
  ]
  const compaction = { type: 'compaction', encrypted_content: 'blob' }
  const a = algal.buildRemoteCompactionV2History(input, compaction)
  const b = mine.buildReplacementHistory(input, compaction, 20000)
  assert.deepEqual(b, a)
})

await check('V2b 20K boundary equivalent (truncation)', () => {
  const big = (ch) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text: ch.repeat(30_000) }] })
  const input = [big('a'), big('b'), big('c')]
  const compaction = { type: 'compaction', encrypted_content: 'blob' }
  const a = algal.buildRemoteCompactionV2History(input, compaction)
  const b = mine.buildReplacementHistory(input, compaction, 20_000)
  assert.deepEqual(b, a)
  assert.equal(a.length, 4)
  assert.equal(a[0].content[0].text.length, 20_000)
})

await check('V2c image exemption at the boundary equivalent', () => {
  const input = [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'x'.repeat(90_000) }] },
    { type: 'message', role: 'user', content: [ // 7800 tokens text + image (exempt)
      { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
      { type: 'input_text', text: 'y'.repeat(31_200) },
    ] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'z'.repeat(1_000) }] },
  ]
  const compaction = { type: 'compaction', encrypted_content: 'blob' }
  assert.deepEqual(
    mine.buildReplacementHistory(input, compaction, 20_000),
    algal.buildRemoteCompactionV2History(input, compaction),
  )
})

// =====================================================================
// V3: SSE event parsing — success + every error path
// =====================================================================
const goodEvents = [
  { type: 'response.created', response: { id: 'r_1' } },
  { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Summary.' }] } },
  { type: 'response.output_item.done', item: { type: 'compaction', encrypted_content: 'enc' } },
  { type: 'response.completed', response: { usage: { input_tokens: 1000, output_tokens: 80, input_tokens_details: { cached_tokens: 200, cache_creation_tokens: 50 } } } },
]

await check('V3 compaction item + usage + summary text', () => {
  const a = algal.parseRemoteCompactionV2Events(norm(goodEvents))
  const b = mine.parseCompactionV2Events(norm(goodEvents))
  assert.deepEqual(norm(b.compactionItem), norm(a.compactionItem))
  const u = mine.mapCompactionUsage(goodEvents[3].response.usage)
  assert.equal(u.inputTokens, 1000 - 200 - 50)
  assert.equal(u.outputTokens, 80)
  assert.equal(u.cacheReadTokens, 200)
  assert.equal(u.cacheWriteTokens, 50)
  assert.equal(b.summaryText, 'Summary.')
})

await check('V3a error event equivalent', () => {
  const events = norm(goodEvents).concat([{ type: 'error', message: 'boom' }])
  assert.throws(() => algal.parseRemoteCompactionV2Events(events), /boom/)
  assert.throws(() => mine.parseCompactionV2Events(events), /boom/)
})

await check('V3b response.failed equivalent', () => {
  const events = norm(goodEvents).concat([{ type: 'response.failed', response: { error: { message: 'server-side fail' } } }])
  assert.throws(() => algal.parseRemoteCompactionV2Events(events), /server-side fail/)
  assert.throws(() => mine.parseCompactionV2Events(events), /server-side fail/)
})

await check('V3c missing completed equivalent', () => {
  const events = [goodEvents[0], goodEvents[1], goodEvents[2]]
  assert.throws(() => algal.parseRemoteCompactionV2Events(norm(events)), /before response\.completed/)
  assert.throws(() => mine.parseCompactionV2Events(norm(events)), /before response\.completed/)
})

await check('V3d missing compaction item equivalent', () => {
  const events = [goodEvents[0], goodEvents[1], goodEvents[3]]
  assert.throws(() => algal.parseRemoteCompactionV2Events(norm(events)), /exactly one compaction item, got 0/)
  assert.throws(() => mine.parseCompactionV2Events(norm(events)), /exactly one compaction item, got 0/)
})

await check('V3e duplicate compaction items equivalent', () => {
  const events = [goodEvents[0], goodEvents[2], goodEvents[2], goodEvents[3]]
  assert.throws(() => algal.parseRemoteCompactionV2Events(norm(events)), /exactly one compaction item, got 2/)
  assert.throws(() => mine.parseCompactionV2Events(norm(events)), /exactly one compaction item, got 2/)
})

// =====================================================================
// V4: message conversion (semantic projection, pi model vs DSH model)
// =====================================================================
await check('V4 message conversion equivalent', () => {
  const piMessages = [
    { id: 'm1', role: 'user', timestamp: 1, content: [{ type: 'text', text: 'hello' }] },
    {
      id: 'm2', role: 'assistant', timestamp: 2, content: [
        { type: 'thinking', thinkingSignature: JSON.stringify({ type: 'reasoning', summary: [{ type: 'summary_text', text: 'think' }] }), thinking: [] },
        { type: 'text', text: 'Found', textSignature: undefined },
        { type: 'toolCall', id: 'call_1|0', name: 'bash', arguments: { cmd: 'ls' } },
      ],
    },
    { id: 'm3', role: 'toolResult', toolCallId: 'call_1|0', content: 'src/parser.ts', timestamp: 3 },
  ]
  const dshMessages = [
    { id: 'd1', role: 'user', source: { kind: 'model-writer' }, content: [{ type: 'text', text: 'hello' }] },
    {
      id: 'd2', role: 'assistant', source: { kind: 'model', id: 'r1', createdAt: 0, model: 'gpt-5.4' }, content: [
        { type: 'reasoning', text: 'think' },
        { type: 'text', text: 'Found' },
        { type: 'tool-call', id: 'call_1', name: 'bash', arguments: '{"cmd":"ls"}' },
      ],
    },
    { id: 'd3', role: 'user', source: { kind: 'tool', callId: 'call_1' }, content: [
      { type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'src/parser.ts' }] },
    ] },
  ]
  assert.deepEqual(norm(mine.dshMessagesToResponseItems(dshMessages)), norm(algal.messagesToResponseItems(piMessages)))
})

await check('V4a empty user message dropped by both', () => {
  const a = algal.messageToResponseItems({ id: 'x', role: 'user', timestamp: 1, content: [] })
  const b = mine.dshMessageToResponseItems({ id: 'x', role: 'user', source: { kind: 'model-writer' }, content: [] })
  assert.deepEqual(b, a)
  assert.equal(b.length, 0)
})

await check('V4b tool-call id |suffix stripped by both', () => {
  const pi = algal.messageToResponseItems({ id: 'm', role: 'assistant', timestamp: 1, content: [
    { type: 'text', text: '', textSignature: undefined },
    { type: 'toolCall', id: 'call_9|7', name: 'bash', arguments: {} },
  ] })
  const dsh = mine.dshMessageToResponseItems({ id: 'm', role: 'assistant', source: { kind: 'model', id: 'r', createdAt: 0, model: 'm' }, content: [
    { type: 'text', text: '' },
    { type: 'tool-call', id: 'call_9|7', name: 'bash', arguments: '{}' },
  ] })
  assert.deepEqual(norm(dsh), norm(pi))
})

// =====================================================================
// V5: identity headers — same installation id + session, same header set
// =====================================================================
const awaitServer = (server) => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve(server.address().port))
})

await check('V5 identity headers equivalent', async () => {
  const codexHome = join(tmpdir(), `codesxhome-${randomUUID()}`)
  mkdirSync(codexHome, { recursive: true })
  const prev = process.env.CODEX_HOME
  process.env.CODEX_HOME = codexHome
  try {
    const model = { provider: 'openai', api: 'openai-responses', id: 'gpt-5.4' }
    const a = algal.buildRemoteCompactionHeaders({ model, apiKey: 'test-key', sessionId: 's1' })
    const installationId = readFileSync(join(codexHome, 'installation_id'), 'utf8').trim()
    let captured
    const server = createServer((req, res) => {
      captured = { ...req.headers }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end('data: [DONE]\n\n')
    })
    const port = await awaitServer(server)
    await mine.callResponsesCompactionV2({
      endpoint: { provider: 'openai', model: '*', baseUrl: `http://127.0.0.1:${port}/v1`, apiKeyEnv: 'T', label: 't', headers: {}, sendIdentityHeaders: true },
      apiKey: 'test-key', model: 'gpt-5.4', input: [], sessionId: 's1', timeoutMs: 3000, retainedMessageTokenBudget: 20000,
      installationId,
    }).catch(() => {})
    server.close()

    const expected = {
      authorization: 'Bearer test-key',
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'x-codex-installation-id': installationId,
      'x-codex-window-id': 's1:0',
      session_id: 's1',
      'x-codex-beta-features': 'remote_compaction_v2',
    }
    assert.deepEqual(a, expected)
    for (const [k, v] of Object.entries(expected)) {
      assert.equal(String(captured[k.toLowerCase()] ?? ''), v, `wire header ${k}`)
    }

    // endpoint headers override identity headers (upstream merge order)
    let captured2
    const server2 = createServer((req, res) => { captured2 = req.headers; res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: [DONE]\n\n') })
    const port2 = await awaitServer(server2)
    await mine.callResponsesCompactionV2({
      endpoint: { provider: 'openai', model: '*', baseUrl: `http://127.0.0.1:${port2}/v1`, apiKeyEnv: 'T', label: 't', headers: { 'x-codex-installation-id': 'user-provided' }, sendIdentityHeaders: true },
      apiKey: 'test-key', model: 'gpt-5.4', input: [], sessionId: 's1', timeoutMs: 3000, retainedMessageTokenBudget: 20000,
      installationId,
    }).catch(() => {})
    server2.close()
    assert.equal(captured2['x-codex-installation-id'], 'user-provided')
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = prev
    rmSync(codexHome, { recursive: true, force: true })
  }
})

// =====================================================================
// V6: full protocol sequence against a local endpoint
// =====================================================================
function respondCompaction(res, body) {
  const events = [
    { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Server-side summary.' }] } },
    { type: 'response.output_item.done', item: { type: 'compaction', encrypted_content: 'server-enc' } },
    { type: 'response.completed', response: { usage: { input_tokens: 500, output_tokens: 40, input_tokens_details: { cached_tokens: 100 } } } },
  ]
  for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`)
  res.end('data: [DONE]\n\n')
}

await check('V6 round-trip: request bodies + artifacts equivalent', async () => {
  const input = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'conversation so far' }] }]
  const instructions = 'You are a coding agent. Be terse.'
  const installationId = randomUUID()
  const model = { provider: 'openai', api: 'openai-responses', id: 'gpt-5.4' }

  // URL normalization: for a direct OpenAI model without a baseUrl the
  // upstream resolves the official endpoint (its eligibility gate requires
  // host === api.openai.com, so a local gateway cannot pass it — that gate is
  // the automated-detection half of the port difference; ours is config-driven
  // and has no host restriction).
  assert.equal(
    algal.remoteCompactionV2EndpointUrl({ provider: 'openai', api: 'openai-responses', id: 'gpt-5.4' }),
    'https://api.openai.com/v1/responses',
  )

  // algal's internal sequence: endpoint URL + headers + body + SSE parse + usage + history
  let algalBody
  const serverA = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => { algalBody = JSON.parse(raw); respondCompaction(res) })
  })
  const portA = await awaitServer(serverA)
  assert.throws(
    () => algal.remoteCompactionV2EndpointUrl({ ...model, baseUrl: `http://127.0.0.1:${portA}/v1` }),
    /not supported for this model/,
  )
  const urlA = `http://127.0.0.1:${portA}/v1/responses`
  const headersA = algal.buildRemoteCompactionHeaders({ model: { ...model }, apiKey: 'test-key', sessionId: 's1' })
  headersA['x-codex-installation-id'] = installationId
  const respA = await fetch(urlA, {
    method: 'POST', headers: headersA,
    body: JSON.stringify(algal.buildRemoteCompactionRequestBody({
      model: { id: 'gpt-5.4', provider: 'openai', api: 'openai-responses' }, input, instructions, tools: [], parallelToolCalls: true, sessionId: 's1',
    })),
  })
  const rawA = await respA.text()
  // parseSseData is private upstream; use the identical block/data/[DONE] rule
  const eventsA = rawA.replace(/\r\n/g, '\n').split('\n\n')
    .flatMap((block) => {
      const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n').trim()
      if (!data || data === '[DONE]') return []
      try { return [JSON.parse(data)] } catch { return [] }
    })
  const resultA = algal.parseRemoteCompactionV2Events(eventsA)
  serverA.close()

  // our single call against a second local endpoint
  let mineBody
  const serverB = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => { mineBody = JSON.parse(raw); respondCompaction(res) })
  })
  const portB = await awaitServer(serverB)
  const resultB = await mine.callResponsesCompactionV2({
    endpoint: { provider: 'openai', model: '*', baseUrl: `http://127.0.0.1:${portB}/v1`, apiKeyEnv: 'T', label: 't', headers: {}, sendIdentityHeaders: true },
    apiKey: 'test-key', model: 'gpt-5.4', input: norm(input), instructions, tools: [], sessionId: 's1',
    timeoutMs: 5000, retainedMessageTokenBudget: 20000, installationId,
  })
  serverB.close()

  assert.deepEqual(norm(mineBody), norm(algalBody), 'request bodies')
  assert.deepEqual(
    norm(resultB.replacementHistory),
    norm(algal.buildRemoteCompactionV2History(input, resultA.compactionItem)),
    'replacement history',
  )
  assert.equal(resultB.usage.inputTokens, 400)
  assert.equal(resultB.usage.outputTokens, 40)
  assert.equal(resultB.usage.cacheReadTokens, 100)
  assert.equal(resultB.summaryText, 'Server-side summary.')
})

const failed = results.filter(([r]) => r === 'FAIL').length
if (failed > 0) {
  console.log(`\n${failed} DIFFERENTIAL FAILURE(S)`)
  process.exit(1)
}
console.log('\nALL DIFFERENTIAL TESTS PASSED')