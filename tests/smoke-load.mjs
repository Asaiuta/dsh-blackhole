/**
 * Runtime smoke test: compose the engine through the real loader, exactly like
 * the official compaction-basic loader-composition spec, and assert that
 * `ctx.compaction` resolves to our engine.
 *
 * Run: node tests/smoke-load.mjs
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjection from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import Engine from '../lib/index.js'
import * as BlackholeCommands from '../lib/commands-plugin.js'

const root = await mkdtemp(join(tmpdir(), 'dsh-blackhole-'))
const configPath = join(root, 'cordis.yml')
await writeFile(configPath, `[
  { id: llm, name: '@deepseek-ai/dsh-llm' },
  { id: session, name: '@deepseek-ai/dsh-session' },
  { id: session-projection, name: '@deepseek-ai/dsh-session-projection' },
  { id: token-meter, name: '@deepseek-ai/dsh-token-meter' },
  { id: timer, name: '@deepseek-ai/cordis-plugin-timer' },
  { id: dsh-blackhole, name: dsh-blackhole, config: {
    endpoints: [
      { provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY' },
      { provider: '*', model: '*', baseUrl: 'https://gateway.example.com/v1', apiKeyEnv: 'MY_GW_KEY' }
    ],
    timeoutMs: 30000,
    fallbackToLlm: true,
    auto: true
  } },
  { id: blackhole-commands, name: 'dsh-blackhole/commands' }
]\n`)

const context = new Context()
context.baseUrl = pathToFileURL(root).href + '/'
await context.plugin(Loader)
context.loader.builtins.include = Include
const modules = new Map([
  ['@deepseek-ai/cordis-plugin-timer', (await import('@deepseek-ai/cordis-plugin-timer')).default],
  ['@deepseek-ai/dsh-llm', LlmRuntime],
  ['@deepseek-ai/dsh-session', SessionStore],
  // The rc.2 token meter declares `static inject = ['sessionProjections']`,
  // so the projection registry must be part of the composition or the meter
  // (and with it our engine's `inject = ['llm', 'tokenMeter', 'sessions']`)
  // never resolves and `ctx.compaction` stays undefined.
  ['@deepseek-ai/dsh-session-projection', SessionProjection],
  ['@deepseek-ai/dsh-token-meter', TokenMeter],
  ['dsh-blackhole', Engine],
  ['dsh-blackhole/commands', BlackholeCommands],
])
// The commands registry must exist BEFORE the loader starts: the
// blackhole-commands plugin declares `inject = ['commands', 'compaction']`,
// so cordis defers its start until the registry is provided — the official
// host plane mounts dsh-commands the same way, ahead of the preset groups.
let recallCommandMounted = 0
let modeCommandMounted = 0
let recallCommandUnmounted = 0
let modeCommandUnmounted = 0
const removeCommands = context.provide('commands', {
  register(definition) {
    if (definition.name === 'blackhole-recall') recallCommandMounted += 1
    if (definition.name === 'blackhole-mode') modeCommandMounted += 1
    return () => {
      if (definition.name === 'blackhole-recall') recallCommandUnmounted += 1
      if (definition.name === 'blackhole-mode') modeCommandUnmounted += 1
    }
  },
})
context.loader.internal = {
  version: 'v2',
  async import(specifier) {
    if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
    return modules.get(specifier)
  },
}
await context.loader.create({
  name: 'cordis:include',
  config: { path: pathToFileURL(configPath).href },
})
await context.loader.await()

for (const entry of context.loader.entries()) {
  console.log('entry:', entry.options.id ?? entry.options.name, '| fiber:', entry.fiber !== undefined, '| disabled:', entry.disabled, entry.error ? `| ERROR: ${entry.error.stack ?? entry.error}` : '')
}

const engine = context.get('compaction')
if (!engine) throw new Error('ctx.compaction did not resolve')
if (!(engine instanceof Engine)) {
  throw new Error(`ctx.compaction is not our engine: ${engine.constructor.name}`)
}
console.log(`OK: ctx.compaction → ${engine.constructor.name}`)
console.log(`    endpoints: ${JSON.stringify(engine.endpoints.map((e) => e.label))}`)
console.log(`    stateDir: ${engine.state?.dir ?? '(disabled)'}`)
assert.equal(typeof context.get('responsesCompactionReplay')?.replayHistory, 'function')
console.log('OK: adapter-facing Responses replay service is provided')

// The optional dsh-tools service may be loaded after the compaction engine.
// Verify the engine's service observer registers recall then releases it when
// the late provider disappears, without making dsh-tools a hard dependency.
let recallRegistered = 0
let recallUnregistered = 0
const removeTools = context.provide('tools', {
  register(definition) {
    if (definition.name === 'recall') recallRegistered += 1
    return () => { recallUnregistered += 1 }
  },
})
assert.equal(recallRegistered, 1)
removeTools()
assert.equal(recallUnregistered, 1)
console.log('OK: late dsh-tools service mounts and disposes recall')

// The commands plugin registered during loader startup (inject-gated: it
// waited for the pre-start registry above), so both commands are already
// mounted. Cordis disposer semantics: a plain-object service's disposer
// fires only when the owning fiber is disposed — removing the registry
// service itself does NOT unregister the command definitions (they ride on
// the plugin's effect, released at plugin-fiber teardown at the bottom).
assert.equal(recallCommandMounted, 1)
assert.equal(modeCommandMounted, 1)
removeCommands()
assert.equal(recallCommandUnmounted, 0)
assert.equal(modeCommandUnmounted, 0)
console.log('OK: /blackhole-recall + /blackhole-mode registered via the commands plugin')

// A sibling isolation scope must not steal the root plugin's registration.
// Cordis dispatches internal/service with a scope filter; this protects a
// profile that hosts separate tools/commands registries for another agent.
let isolatedToolRegistered = 0
const isolatedTools = context.isolate('tools')
const removeIsolatedTools = isolatedTools.provide('tools', {
  register(definition) {
    if (definition.name === 'recall') isolatedToolRegistered += 1
    return () => {}
  },
})
assert.equal(isolatedToolRegistered, 0)
assert.equal(recallRegistered, 1)
await removeIsolatedTools()

let isolatedCommandRegistered = 0
const isolatedCommands = context.isolate('commands')
const removeIsolatedCommands = isolatedCommands.provide('commands', {
  register(definition) {
    if (definition.name === 'blackhole-recall' || definition.name === 'blackhole-mode') {
      isolatedCommandRegistered += 1
    }
    return () => {}
  },
})
assert.equal(isolatedCommandRegistered, 0)
assert.equal(recallCommandMounted, 1)
await removeIsolatedCommands()
console.log('OK: sibling tools/commands scopes stay isolated from the plugin')

// Re-mount both services and leave them present. Disposing the plugin fiber
// must release the recall tool registration exactly once as part of plugin
// teardown; the commands plugin stays retired (one-shot registration).
context.provide('tools', {
  register(definition) {
    if (definition.name === 'recall') recallRegistered += 1
    return () => { recallUnregistered += 1 }
  },
})
context.provide('commands', {
  register(definition) {
    if (definition.name === 'blackhole-recall' || definition.name === 'blackhole-mode') {
      recallCommandMounted += 1
    }
    return () => {
      if (definition.name === 'blackhole-recall' || definition.name === 'blackhole-mode') {
        recallCommandUnmounted += 1
      }
    }
  },
})
assert.equal(recallRegistered, 2)
assert.equal(recallCommandMounted, 1)

await context.fiber.dispose()
assert.equal(recallUnregistered, 2)
assert.equal(recallCommandUnmounted, 1)
assert.equal(modeCommandUnmounted, 1)
console.log('OK: plugin teardown releases the recall tool registration')
await rm(root, { recursive: true, force: true })
console.log('OK: loader composition + engine mount verified')
