import assert from 'node:assert/strict'
import {
  compileInstantRegion,
  DEFAULT_INSTANT_OPTIONS,
  estimateMessagesTokens,
  joinInstantEntries,
} from '../lib/index.js'

const nodes = [
  {
    seq: 1,
    message: {
      id: 'm1',
      role: 'user',
      content: [{ type: 'text', text: 'old '.repeat(500) }],
    },
  },
  {
    seq: 2,
    message: {
      id: 'm2',
      role: 'assistant',
      content: [{ type: 'text', text: 'new '.repeat(500) }],
    },
  },
]

const capped = compileInstantRegion(nodes, DEFAULT_INSTANT_OPTIONS, 120)
assert.equal(capped.capped, true)
assert.ok(capped.stats.elidedRows > 0)
assert.ok(capped.entries.length < 2, 'capped output must not retain deleted rows')
assert.ok(!joinInstantEntries(capped.entries).includes('old old old'))
assert.equal(capped.stats.entries, capped.entries.length)
console.log('OK: instant cap removes elided entries from output')

const toolCall = {
  id: 'tool-call',
  role: 'assistant',
  content: [{
    type: 'tool-call',
    id: 'call-1',
    name: 'bash',
    arguments: JSON.stringify({ command: 'x'.repeat(10_000) }),
  }],
}
const toolResult = {
  id: 'tool-result',
  role: 'user',
  content: [{
    type: 'tool-result',
    toolCallId: 'call-1',
    content: [{ type: 'text', text: 'y'.repeat(10_000) }],
  }],
}
assert.ok(
  estimateMessagesTokens([toolCall, toolResult]) > 4_000,
  'structured tool content must participate in token estimation',
)
console.log('OK: instant token estimate includes tool arguments and nested results')

console.log('ALL INSTANT REGRESSION TESTS PASSED')
