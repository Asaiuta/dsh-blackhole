import assert from 'node:assert/strict'
import {
  createRecallTool,
  recallSession,
  registerRecallTool,
} from '../lib/index.js'

const messages = [
  {
    id: 'u1', role: 'user', source: { kind: 'user' },
    content: [{ type: 'text', text: 'Fix parser behavior' }],
  },
  {
    id: 'a1', role: 'assistant', source: { kind: 'model', provider: 'openai', model: 'gpt-5' },
    content: [{ type: 'tool-call', id: 'call-1', name: 'read', arguments: JSON.stringify({ file_path: 'src/parser.ts' }) }],
  },
  {
    id: 'r1', role: 'user', source: { kind: 'tool', callId: 'call-1' },
    content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'const parser = broken;' }] }],
  },
  {
    id: 'a2', role: 'assistant', source: { kind: 'model', provider: 'openai', model: 'gpt-5' },
    content: [{ type: 'text', text: 'Parser fixed.' }],
  },
]
const session = {
  events: messages.map((message, seq) => ({ seq, type: 'message', message })),
  deriveEventMessage(event) { return event.message ?? null },
  lineageSeqs: [0, 1, 2, 3],
}

const search = recallSession(session, { query: 'parser' })
assert.ok(search.total >= 2)
assert.match(search.text, /#0/)
console.log('OK: recall text search and paging index')

const regex = recallSession(session, { query: '/parser/g', offset: 1, limit: 1 })
assert.equal(regex.entries.length, 1)
assert.ok(regex.entries[0].text.toLowerCase().includes('parser'))
console.log('OK: regex search resets global lastIndex and supports offset/limit')

const file = recallSession(session, { query: '#1:src/parser.ts' })
assert.equal(file.total, 1)
assert.match(file.text, /src\/parser\.ts/)
console.log('OK: recall #N:path drill-down')

const touched = recallSession(session, { mode: 'touched' })
assert.match(touched.text, /src\/parser\.ts/) 
console.log('OK: recall touched-files mode')

const limitedScope = recallSession({ ...session, lineageSeqs: [0, 3] }, { query: 'parser' })
assert.ok(!limitedScope.text.includes('#1'))
console.log('OK: recall lineage scope')

const definition = createRecallTool(() => session)
const value = await definition.execute({ query: '#1' }, {})
assert.match(value.text, /src\/parser\.ts/)
let registered = false
registerRecallTool({ register(tool) { registered = tool.name === 'recall'; return () => {} } }, () => session)
assert.equal(registered, true)
console.log('OK: dsh-tools-compatible recall registration seam')

console.log('ALL RECALL TESTS PASSED')
