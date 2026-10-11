/**
 * /blackhole-mode command tests: argument parsing, controller flips, sticky
 * override persistence (survives a fresh engine instance, reset restores the
 * config defaults, corrupt files are ignored), and the engine-level runtime
 * gates (remote off stops remote attempts and drops the persisted replacement
 * history on the next local checkpoint; a chain switch to `llm` routes the
 * fallback to the native summarizer).
 *
 * Run: node tests/mode-command.mjs
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import {
  clearRuntimeModeOverride,
  createModeCommand,
  loadRuntimeModeOverride,
  MODE_COMMAND_NAME,
  parseModeCommandInput,
  registerModeCommand,
  RoutingCompactionEngine,
  RUNTIME_MODE_FILE,
  saveRuntimeModeOverride,
} from '../lib/index.js'
import * as BlackholeCommands from '../lib/commands-plugin.js'

// ── 1. parsing ──────────────────────────────────────────────────────────
assert.deepEqual(parseModeCommandInput(''), { action: 'status' })
assert.deepEqual(parseModeCommandInput('   '), { action: 'status' })
assert.deepEqual(parseModeCommandInput('instant'), { action: 'mode', mode: 'instant' })
assert.deepEqual(parseModeCommandInput('Instant-Then-Llm'), { action: 'mode', mode: 'instant-then-llm' })
assert.deepEqual(parseModeCommandInput('llm'), { action: 'mode', mode: 'llm' })
assert.deepEqual(parseModeCommandInput('reset'), { action: 'reset' })
assert.deepEqual(parseModeCommandInput('remote'), { action: 'remote' })
assert.deepEqual(parseModeCommandInput('remote on'), { action: 'remote', enabled: true })
assert.deepEqual(parseModeCommandInput(' remote off '), { action: 'remote', enabled: false })
assert.equal(parseModeCommandInput('remote sideways').action, 'invalid')
assert.equal(parseModeCommandInput('turbo').action, 'invalid')
assert.equal(parseModeCommandInput('instant llm').action, 'invalid')
console.log('OK: parseModeCommandInput (status / mode / remote / reset / invalid)')

// ── 2. override persistence primitives ──────────────────────────────────
const scratch = await mkdtemp(join(tmpdir(), 'dsh-blackhole-mode-file-'))
try {
  assert.equal(loadRuntimeModeOverride(scratch), undefined, 'missing file → undefined')
  await writeFile(join(scratch, RUNTIME_MODE_FILE), '{not json')
  assert.equal(loadRuntimeModeOverride(scratch), undefined, 'corrupt file → undefined')
  await writeFile(join(scratch, RUNTIME_MODE_FILE), JSON.stringify({
    fallbackMode: 'warp', remoteEnabled: 'yes', bogus: true,
  }))
  assert.equal(loadRuntimeModeOverride(scratch), undefined, 'no valid fields → undefined')
  assert.equal(saveRuntimeModeOverride(scratch, { fallbackMode: 'llm', remoteEnabled: false }), true)
  const saved = loadRuntimeModeOverride(scratch)
  assert.equal(saved?.fallbackMode, 'llm')
  assert.equal(saved?.remoteEnabled, false)
  assert.equal(typeof saved?.savedAt, 'string')
  assert.equal(loadRuntimeModeOverride(undefined), undefined, 'no dir → undefined')
  assert.equal(saveRuntimeModeOverride(undefined, {}), false)
  assert.equal(clearRuntimeModeOverride(undefined), false)
  assert.equal(clearRuntimeModeOverride(scratch), true)
  assert.equal(loadRuntimeModeOverride(scratch), undefined)
  console.log('OK: runtime override file (load / save / clear, corrupt + foreign files ignored)')
} finally {
  await rm(scratch, { recursive: true, force: true })
}

// ── 3. controller seam (unit, no engine) ────────────────────────────────
const controller = {
  fallbackMode: 'instant',
  remoteEnabled: true,
  endpointLine: 'openai/gpt-5 → fake',
  getFallbackMode() { return this.fallbackMode },
  getFallbackModeDefault() { return 'instant' },
  setFallbackMode(mode) { this.fallbackMode = mode },
  isRemoteEnabled() { return this.remoteEnabled },
  isRemoteEnabledDefault() { return true },
  setRemoteEnabled(enabled) { this.remoteEnabled = enabled },
  resetRuntimeMode() { this.fallbackMode = 'instant'; this.remoteEnabled = true },
  describeEndpoints() { return this.endpointLine },
}
const registered = []
const disposer = registerModeCommand(
  { register(definition) { registered.push(definition); return () => {} } },
  controller,
)
assert.equal(registered.length, 1)
assert.equal(registered[0].name, MODE_COMMAND_NAME)
assert.equal(typeof disposer, 'function')
const command = registered[0]

const status = await command.handler({ rawInput: '' })
assert.equal(status.kind, 'success')
assert.match(status.text, /回退链：instant/)
assert.match(status.text, /远端 Responses 压缩：已启用/)
assert.doesNotMatch(status.text, /运行时覆盖/)

const toLlm = await command.handler({ rawInput: 'llm' })
assert.equal(controller.fallbackMode, 'llm')
assert.match(toLlm.text, /回退链已切换为 llm/)
const after = await command.handler({ rawInput: '' })
assert.match(after.text, /回退链：llm/)
assert.match(after.text, /运行时覆盖；配置默认：instant/)

const remoteOff = await command.handler({ rawInput: 'remote off' })
assert.equal(controller.remoteEnabled, false)
assert.match(remoteOff.text, /已禁用/)
const remoteStatus = await command.handler({ rawInput: 'remote' })
assert.match(remoteStatus.text, /当前已禁用/)
const remoteOn = await command.handler({ rawInput: 'remote on' })
assert.equal(controller.remoteEnabled, true)
assert.match(remoteOn.text, /已重新启用/)

const reset = await command.handler({ rawInput: 'reset' })
assert.equal(controller.fallbackMode, 'instant')
assert.equal(controller.remoteEnabled, true)
assert.match(reset.text, /回到配置默认/)

const invalid = await command.handler({ rawInput: 'turbo' })
assert.equal(invalid.kind, 'error')
assert.match(invalid.text, /未知模式 "turbo"/)
console.log('OK: /blackhole-mode handler flips the controller (unit seam)')

// ── 4. engine-level: sticky overrides + runtime gates ───────────────────
let remoteHits = 0
const server = createServer((req, res) => {
  remoteHits += 1
  req.resume()
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const events = [
      { type: 'response.output_item.done', item: { type: 'compaction', encrypted_content: 'opaque' } },
      { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 1 } } },
    ]
    for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`)
    res.end('data: [DONE]\n\n')
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const { port } = server.address()

const dir = await mkdtemp(join(tmpdir(), 'dsh-blackhole-mode-engine-'))
try {
  const stubCtx = () => {
    const commands = []
    const context = new Context()
    context.provide('commands', { register(definition) { commands.push(definition); return () => {} } })
    context.logger.info = () => {}
    context.logger.warn = () => {}
    context.logger.debug = () => {}
    context.logger.error = () => {}
    return { context, commands }
  }
  const endpoint = {
    provider: 'openai', model: 'gpt-5',
    baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k', label: 'fake',
  }
  const fakeAgent = (provider, model) => ({
    id: 'mode-sess',
    options: {},
    session: {
      id: 'mode-sess',
      events: [],
      deriveEventMessage() { return null },
      requestHeader() { return { config: { provider, model } } },
    },
  })
  const messages = [
    { id: 'u0', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Hello there. '.repeat(400) }] },
  ]
  const modeCommandOf = (engine) => engine
  const summarize = (engine, agent) => engine.summarize({ system: 'sys', tools: [], messages }, agent)

  // 4a. gate off → instant, zero network, no persisted remote state,
  //     and the switch itself persists into the state dir
  const first = stubCtx()
  const engine = new RoutingCompactionEngine(first.context, {
    auto: false,
    endpoints: [endpoint],
    stateDir: dir,
  })
  const modeCommand = first.commands.find((definition) => definition.name === MODE_COMMAND_NAME)
  assert.ok(modeCommand === undefined, 'the engine alone no longer registers commands')
  // Commands live in the dedicated inject-gated plugin (official
  // dsh-command-compact shape); run its apply against the composed context.
  BlackholeCommands.apply(first.context)
  const modeCommandDef = first.commands.find((definition) => definition.name === MODE_COMMAND_NAME)
  assert.ok(modeCommandDef, '/blackhole-mode registered via the commands plugin')
  const off = await modeCommandDef.handler({ rawInput: 'remote off' })
  assert.match(off.text, /已禁用/)
  const instant = await summarize(engine, fakeAgent('openai', 'gpt-5'))
  assert.equal(instant.provider, 'instant')
  assert.equal(remoteHits, 0)
  assert.equal(await engine.state.load('mode-sess'), undefined)
  const persistedOverride = loadRuntimeModeOverride(dir)
  assert.equal(persistedOverride?.fallbackMode, 'instant')
  assert.equal(persistedOverride?.remoteEnabled, false)

  // 4b. gate on → remote v2 succeeds and persists the replacement history
  const on = await modeCommandDef.handler({ rawInput: 'remote on' })
  assert.match(on.text, /已重新启用/)
  const remote = await summarize(engine, fakeAgent('openai', 'gpt-5'))
  assert.equal(remote.provider, 'fake')
  assert.equal(remoteHits, 1)
  const persisted = await engine.state.load('mode-sess')
  assert.ok(persisted, 'remote replacement history persisted')
  assert.equal(persisted.replacementHistory.at(-1).encrypted_content, 'opaque')

  // 4c. gate off again → the next local checkpoint removes the persisted history
  await modeCommandDef.handler({ rawInput: 'remote off' })
  const instantAgain = await summarize(engine, fakeAgent('openai', 'gpt-5'))
  assert.equal(instantAgain.provider, 'instant')
  assert.equal(await engine.state.load('mode-sess'), undefined)
  console.log('OK: runtime remote gate (off → instant + history dropped; on → remote v2)')

  // 4d. sticky across "restarts": a fresh engine over the same state dir
  //     re-applies the override, and reset returns to the config defaults
  const restarted = stubCtx()
  const engine2 = new RoutingCompactionEngine(restarted.context, {
    auto: false,
    endpoints: [endpoint],
    stateDir: dir,
  })
  BlackholeCommands.apply(restarted.context)
  const modeCommand2 = restarted.commands.find((definition) => definition.name === MODE_COMMAND_NAME)
  const restartedStatus = await modeCommand2.handler({ rawInput: '' })
  assert.match(restartedStatus.text, /远端 Responses 压缩：已禁用（运行时覆盖；配置默认：已启用）/)
  const resetResult = await modeCommand2.handler({ rawInput: 'reset' })
  assert.match(resetResult.text, /回到配置默认/)
  assert.equal(loadRuntimeModeOverride(dir), undefined)
  const engine3 = stubCtx()
  new RoutingCompactionEngine(engine3.context, { auto: false, endpoints: [endpoint], stateDir: dir })
  BlackholeCommands.apply(engine3.context)
  const freshStatus = await engine3.commands.find((definition) => definition.name === MODE_COMMAND_NAME)
    .handler({ rawInput: '' })
  assert.match(freshStatus.text, /远端 Responses 压缩：已启用/)
  assert.doesNotMatch(freshStatus.text, /运行时覆盖/)
  console.log('OK: sticky override survives a fresh engine; reset restores config defaults')

  // 4e. chain switch to `llm` → remote failure routes to the native summarizer
  //     (fresh state dir so the gate state from 4a-4c does not leak in)
  let llmCalls = 0
  const failing = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end('boom')
    })
  })
  await new Promise((resolve) => failing.listen(0, '127.0.0.1', resolve))
  const llmDir = await mkdtemp(join(tmpdir(), 'dsh-blackhole-mode-llm-'))
  const second = stubCtx()
  const llmEngine = new RoutingCompactionEngine(second.context, {
    auto: false,
    endpoints: [{ ...endpoint, baseUrl: `http://127.0.0.1:${failing.address().port}/v1` }],
    stateDir: llmDir,
  })
  BlackholeCommands.apply(second.context)
  const llmModeCommand = second.commands.find((definition) => definition.name === MODE_COMMAND_NAME)
  await llmModeCommand.handler({ rawInput: 'llm' })
  second.context.llm = {
    async *stream() {
      llmCalls += 1
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'LLM MODE SUMMARY' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'LLM MODE SUMMARY' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const viaLlm = await summarize(llmEngine, fakeAgent('openai', 'gpt-5'))
  assert.equal(viaLlm.provider, 'openai')
  assert.ok(viaLlm.summary[0].text.includes('LLM MODE SUMMARY'))
  assert.equal(llmCalls, 1)
  console.log('OK: runtime chain switch to llm (remote 500 → native LLM summarizer)')
  failing.close()
  await rm(llmDir, { recursive: true, force: true })
} finally {
  server.close()
  await rm(dir, { recursive: true, force: true })
}
