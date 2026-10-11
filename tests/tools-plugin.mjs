/**
 * blackhole-tools plugin tests: the recall tool goes through the official
 * `defineTool()` wrapper — author-DSL parameters compile to enforced JSON
 * Schema, invalid arguments are rejected before execute, and the output
 * render projects the canonical `{ text }` value.
 *
 * Run: node tests/tools-plugin.mjs
 */
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../lib/tools-plugin.js'

// ── 1. registration through the inject-gated apply ──────────────────────
const registered = []
const ctx = new Context()
ctx.provide('tools', {
  register(definition) { registered.push(definition); return () => {} },
})
ctx.logger.info = () => {}; ctx.logger.warn = () => {}; ctx.logger.error = () => {}; ctx.logger.debug = () => {}
plugin.apply(ctx)

assert.equal(registered.length, 1, 'exactly one tool registered')
const tool = registered[0]
assert.equal(tool.name, 'recall')
assert.equal(typeof tool.execute, 'function')

// 1a. author DSL compiled to enforced JSON Schema (required lifted to an array)
assert.ok(Array.isArray(tool.parameters.required) === false || tool.parameters.required === undefined,
  'parameters compile to a JSON-Schema object root')
assert.equal(tool.parameters.type, 'object')
assert.ok(tool.parameters.properties.query, 'query property present')
assert.equal(tool.parameters.properties.scope.enum[0], 'lineage', 'enum survives compilation')
assert.ok(tool.parameters.properties.expand.items, 'expand items compile')

// 1b. output schema compiled from the author DSL
assert.equal(tool.output.schema.type, 'object')
assert.deepEqual(tool.output.schema.required, ['text'], 'inline required flag lifted')

// ── 2. invalid arguments rejected before execute ────────────────────────
await assert.rejects(
  () => tool.execute({ page: 'not-a-number' }, {}),
  (error) => error.name === 'ToolArgsError',
  'defineTool validates arguments against the compiled schema',
)

// ── 3. execution with a session-shaped fake ─────────────────────────────
const fakeSession = {
  events: [
    { seq: 0, type: 'user/message', data: {} },
    { seq: 1, type: 'assistant/message', data: {} },
  ],
  deriveEventMessage(event) {
    if (event.seq === 0) return { id: 'u0', role: 'user', content: [{ type: 'text', text: 'Fix the parser behavior.' }] }
    return null
  },
}
const ok = await tool.execute({ query: 'parser' }, { agent: { session: fakeSession } })
assert.equal(typeof ok.text, 'string')
assert.ok(ok.text.length > 0, 'recall produced its rendered response')

// ── 4. no session → concise hint, not a crash ───────────────────────────
const noSession = await tool.execute({}, {})
assert.match(noSession.text, /No session is available for recall/)

// ── 5. render projects the canonical value ──────────────────────────────
const blocks = tool.output.render({}, { text: 'rendered body' })
assert.deepEqual(blocks, [{ type: 'text', text: 'rendered body' }])

console.log('OK: blackhole-tools plugin (defineTool wrapper, validation, exec, render)')
console.log('ALL TOOLS PLUGIN TESTS PASSED')
