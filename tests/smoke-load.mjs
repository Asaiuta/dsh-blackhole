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
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import Engine from '../lib/index.js'

const root = await mkdtemp(join(tmpdir(), 'dsh-compaction-responses-'))
const configPath = join(root, 'cordis.yml')
await writeFile(configPath, `[
  { id: llm, name: '@deepseek-ai/dsh-llm' },
  { id: session, name: '@deepseek-ai/dsh-session' },
  { id: token-meter, name: '@deepseek-ai/dsh-token-meter' },
  { id: timer, name: '@deepseek-ai/cordis-plugin-timer' },
  { id: dsh-compaction-responses, name: dsh-compaction-responses, config: {
    endpoints: [
      { provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY' },
      { provider: '*', model: '*', baseUrl: 'https://gateway.example.com/v1', apiKeyEnv: 'MY_GW_KEY' }
    ],
    timeoutMs: 30000,
    fallbackToLlm: true,
    auto: true
  } }
]\n`)

const context = new Context()
context.baseUrl = pathToFileURL(root).href + '/'
await context.plugin(Loader)
context.loader.builtins.include = Include
const modules = new Map([
  ['@deepseek-ai/cordis-plugin-timer', (await import('@deepseek-ai/cordis-plugin-timer')).default],
  ['@deepseek-ai/dsh-llm', LlmRuntime],
  ['@deepseek-ai/dsh-session', SessionStore],
  ['@deepseek-ai/dsh-token-meter', TokenMeter],
  ['dsh-compaction-responses', Engine],
])
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

await context.fiber.dispose()
await rm(root, { recursive: true, force: true })
console.log('OK: loader composition + engine mount verified')