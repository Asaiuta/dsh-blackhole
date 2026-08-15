import assert from 'node:assert/strict'
import {
  compileBlackholeSummary,
  previousCheckpointSummary,
} from '../lib/index.js'

const messages = [
  {
    id: 'u1',
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text: 'Implement the parser fix. Please never modify tests.' }],
  },
  {
    id: 'a1',
    role: 'assistant',
    source: { kind: 'model', provider: 'openai', model: 'gpt-5' },
    content: [
      {
        type: 'tool-call',
        id: 'call-1',
        name: 'edit',
        arguments: JSON.stringify({ file_path: 'src/parser.ts' }),
      },
      { type: 'text', text: 'The parser is still broken.' },
    ],
  },
  {
    id: 'r1',
    role: 'user',
    source: { kind: 'tool', callId: 'call-1' },
    content: [{
      type: 'tool-result',
      toolCallId: 'call-1',
      isError: true,
      content: [{ type: 'text', text: 'tests failed' }],
    }],
  },
]

const summary = compileBlackholeSummary({ messages, seqs: [10, 11, 12], maxTokens: 2_000 })
assert.match(summary, /\[Session Goal\]/)
assert.match(summary, /\[Files And Changes\]/)
assert.match(summary, /Modified: src\/parser\.ts/)
assert.match(summary, /\[Outstanding Context\]/)
assert.match(summary, /still broken/i)
assert.match(summary, /\[User Preferences\]/)
assert.match(summary, /recall/)
assert.match(summary, /seq 11 -> result 12/)
console.log('OK: structured summary sections, pointers, and recall footer')

const checkpoint = {
  id: 'checkpoint',
  role: 'user',
  source: { kind: 'plugin', plugin: 'compact' },
  content: [{ type: 'text', text: '[Session Goal]\n- Existing goal\n\n---\n\nold brief' }],
}
assert.equal(previousCheckpointSummary([messages[0], checkpoint]), '[Session Goal]\n- Existing goal\n\n---\n\nold brief')
const merged = compileBlackholeSummary({
  messages: [checkpoint, ...messages],
  seqs: [9, 10, 11, 12],
  previousSummary: previousCheckpointSummary([checkpoint]),
  maxTokens: 2_000,
})
assert.match(merged, /Existing goal/)
assert.match(merged, /Implement the parser fix/)
console.log('OK: previous checkpoint summary is merged without losing fresh context')

const transcriptOnly = compileBlackholeSummary({
  messages: [
    { id: 'a2', role: 'assistant', source: { kind: 'model', provider: 'openai', model: 'gpt-5' }, content: [{ type: 'text', text: 'A fresh assistant-only fact.' }] },
  ],
  previousSummary: '[Session Goal]\n- keep the parser goal\n\n---\n\n[assistant]\nold transcript',
})
assert.match(transcriptOnly, /A fresh assistant-only fact\./)
console.log('OK: assistant-only fresh transcript survives checkpoint merge')

console.log('ALL BLACKHOLE SUMMARY TESTS PASSED')
