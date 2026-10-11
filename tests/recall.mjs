import assert from 'node:assert/strict'
import {
  createRecallCommand,
  createRecallTool,
  extractRecallFileOperations,
  findRecallFileMatches,
  indexRecallSession,
  isOmMemoryId,
  OM_RECALL_TODO,
  parseRecallCommandInput,
  parseRecallDrillDown,
  recallSession,
  registerRecallCommand,
  registerRecallTool,
  renderRecallFileDrillDown,
} from '../lib/index.js'

const generatedContent = Array.from(
  { length: 45 },
  (_, index) => `generated line ${index + 1}${index === 35 ? ' SecretNeedle' : ''}`,
).join('\n')

const messages = [
  {
    id: 'u1', role: 'user', source: { kind: 'user' },
    content: [{ type: 'text', text: 'Fix parser behavior and retain TranscriptOnlyTerm' }],
  },
  {
    id: 'a1', role: 'assistant', source: { kind: 'model', provider: 'openai', model: 'gpt-5' },
    content: [{ type: 'tool-call', id: 'call-read', name: 'Read', arguments: JSON.stringify({ file_path: 'src/parser.ts' }) }],
  },
  {
    id: 'r1', role: 'user', source: { kind: 'tool', callId: 'call-read' },
    content: [{ type: 'tool-result', toolCallId: 'call-read', content: [{ type: 'text', text: 'const parser = broken;' }] }],
  },
  {
    id: 'a2', role: 'assistant', source: { kind: 'model', provider: 'openai', model: 'gpt-5' },
    content: [{ type: 'tool-call', id: 'call-write', name: 'Write', arguments: {
      path: 'src/generated.ts',
      content: generatedContent,
    } }],
  },
  {
    id: 'a3', role: 'assistant', source: { kind: 'model', provider: 'openai', model: 'gpt-5' },
    content: [{ type: 'tool-call', id: 'call-edit', name: 'Edit', arguments: JSON.stringify({
      filePath: 'src/parser.ts',
      edits: [{ oldText: 'const parser = broken;', newText: 'const brandNewFunction = fixed;' }],
    }) }],
  },
  {
    id: 'a4', role: 'assistant', source: { kind: 'model', provider: 'openai', model: 'gpt-5' },
    content: [
      { type: 'tool-call', id: 'call-config-src', name: 'Write', arguments: {
        path: 'src/feature/config.ts', content: 'export const config = "alpha"',
      } },
      { type: 'tool-call', id: 'call-config-test', name: 'Write', arguments: {
        path: 'tests/feature/config.ts', content: 'export const config = "beta"',
      } },
    ],
  },
  {
    id: 'a5', role: 'assistant', source: { kind: 'model', provider: 'openai', model: 'gpt-5' },
    content: [{ type: 'tool-call', id: 'call-branch', name: 'Write', arguments: {
      path: 'src/branch-only.ts', content: 'export const BranchSecretOnly = true',
    } }],
  },
  {
    id: 'a6', role: 'assistant', source: { kind: 'model', provider: 'openai', model: 'gpt-5' },
    content: [{ type: 'text', text: 'Parser fixed.' }],
  },
]

const session = {
  events: messages.map((message, seq) => ({ seq, type: 'message', message })),
  deriveEventMessage(event) { return event.message ?? null },
  lineageSeqs: [0, 1, 2, 3, 4, 5, 7],
}

const makeTextSession = (events) => ({
  events,
  deriveEventMessage(event) { return event.message ?? null },
  lineageSeqs: events.map((event) => event.seq),
})

const indexed = indexRecallSession(session)
assert.equal(indexed.find((entry) => entry.seq === 1).fileOperations.length, 0)
assert.deepEqual(indexed.find((entry) => entry.seq === 3).fileOperations.map((operation) => operation.path), ['src/generated.ts'])
assert.match(indexed.find((entry) => entry.seq === 4).fileOperations[0].content, /brandNewFunction/)
const combinedOperation = extractRecallFileOperations({
  role: 'assistant',
  content: [{ type: 'tool-call', name: 'Edit', arguments: {
    path: 'src/combined.ts',
    content: 'base content',
    edits: [{ oldText: 'before', newText: 'after' }],
  } }],
})[0]
assert.match(combinedOperation.content, /base content/)
assert.match(combinedOperation.content, /before/)
assert.match(combinedOperation.content, /after/)
const boundedSession = {
  events: [{ seq: 0, message: {
    role: 'assistant',
    content: [{ type: 'tool-call', name: 'Write', arguments: {
      path: 'src/large.ts', content: `${'x'.repeat(20_000)}NeedleAfterSearchCap`,
    } }],
  } }],
  deriveEventMessage(event) { return event.message ?? null },
}
const boundedEntry = indexRecallSession(boundedSession)[0]
assert.ok(Buffer.byteLength(boundedEntry.searchText, 'utf8') < 11 * 1024)
assert.doesNotMatch(boundedEntry.searchText, /NeedleAfterSearchCap/)
assert.doesNotMatch(boundedEntry.text, /NeedleAfterSearchCap/)
assert.match(boundedEntry.fileOperations[0].content, /NeedleAfterSearchCap/)
assert.equal(findRecallFileMatches(boundedEntry.fileOperations, 'NeedleAfterSearchCap').length, 0)
const pathlessEntry = indexRecallSession({
  events: [{ seq: 1, message: {
    role: 'assistant',
    content: [{ type: 'tool-call', name: 'Write', arguments: { content: 'PATHLESS_SECRET_BODY' } }],
  } }],
  deriveEventMessage(event) { return event.message ?? null },
})[0]
assert.doesNotMatch(pathlessEntry.text, /PATHLESS_SECRET_BODY/)
const malformedWriteEntry = indexRecallSession({
  events: [{ seq: 2, message: {
    role: 'assistant',
    content: [{ type: 'tool-call', name: 'Write', arguments: '{"content":"MALFORMED_SECRET_BODY"' }],
  } }],
  deriveEventMessage(event) { return event.message ?? null },
})[0]
assert.doesNotMatch(malformedWriteEntry.text, /MALFORMED_SECRET_BODY/)
assert.doesNotMatch(malformedWriteEntry.searchText, /MALFORMED_SECRET_BODY/)
console.log('OK: real Write/Edit arguments become searchable file operations')

const search = recallSession(session, { query: 'parser' })
assert.ok(search.total >= 3)
assert.match(search.text, /#0/)
const duplicateTermSearch = recallSession(session, { query: 'parser parser' })
assert.ok(duplicateTermSearch.entries.some((entry) => entry.seq === 1))
console.log('OK: duplicate query terms keep BM25-like recall stable')
console.log('OK: hybrid recall indexes transcript, tool calls, and tool results')

const exactEntry = recallSession(session, { query: '#1' })
assert.deepEqual(exactEntry.entries.map((entry) => entry.seq), [1])
assert.match(exactEntry.text, /src\/parser\.ts/)
assert.doesNotMatch(exactEntry.text, /const parser = broken;/)
assert.equal(recallSession(session, { query: 'SecretNeedle' }).text.includes(generatedContent), false)
console.log('OK: #N expands exactly one durable entry')
console.log('OK: ordinary and #N views redact full Write bodies while file search remains available')

const wrappedRegex = recallSession(session, { query: '/secretneedle/', mode: 'file' })
assert.deepEqual(wrappedRegex.entries.map((entry) => entry.seq), [3])
assert.match(wrappedRegex.text, /SecretNeedle/)
const rawRegex = recallSession(session, { query: 'SecretNeedle|does-not-exist', mode: 'file' })
assert.deepEqual(rawRegex.entries.map((entry) => entry.seq), [3])
const globalRegex = recallSession(session, { query: '/parser/g', offset: 1, limit: 1 })
assert.equal(globalRegex.entries.length, 1)
assert.equal(globalRegex.page, 2)
const offsetPage = recallSession(session, { query: 'parser', offset: 10, limit: 5 })
assert.equal(offsetPage.page, 3)
const unsafeRegex = recallSession(boundedSession, { query: '/(x+)+$/' })
assert.equal(typeof unsafeRegex.text, 'string')
const ambiguousRegexSession = makeTextSession([{
  seq: 12,
  message: { role: 'assistant', content: [{ type: 'text', text: `${'x'.repeat(80)}y` }] },
}])
const unsafeStart = performance.now()
recallSession(ambiguousRegexSession, { query: '/(x|xx)+$/' })
assert.ok(performance.now() - unsafeStart < 500)
const boundedBacktrackingPattern = '/a{0,100}a{0,100}a{0,100}a{0,100}a{0,100}a{0,100}a{0,100}a{0,100}$/'
const boundedBacktrackingStart = performance.now()
recallSession(makeTextSession([{
  seq: 14,
  message: { role: 'assistant', content: [{ type: 'text', text: `${'a'.repeat(800)}!` }] },
}]), { query: boundedBacktrackingPattern })
assert.ok(performance.now() - boundedBacktrackingStart < 500)
console.log('OK: wrapped/raw regex is case-insensitive by default and resets global lastIndex')

const editSearch = recallSession(session, { query: 'brandNewFunction', mode: 'file' })
assert.deepEqual(editSearch.entries.map((entry) => entry.seq), [4])
const fileOnly = recallSession(session, { query: 'TranscriptOnlyTerm', mode: 'file' })
assert.equal(fileOnly.total, 0)
const forcedExpansion = recallSession(session, { query: 'no-such-file-token', mode: 'file', expand: [0] })
assert.deepEqual(forcedExpansion.entries.map((entry) => entry.seq), [0])
console.log('OK: file-only search uses file bodies while explicit expansion remains authoritative')

const expandedResultSession = makeTextSession([{
  seq: 10,
  message: {
    role: 'assistant',
    content: [{ type: 'tool-result', toolCallId: 'expanded-result', content: [{ type: 'text', text: 'R'.repeat(500) }] }],
  },
}])
const expandedResult = recallSession(expandedResultSession, { query: 'no-match', expand: [10] })
assert.ok(expandedResult.text.includes('R'.repeat(400)))
console.log('OK: explicit expand renders the full prose/result view')

const preview = recallSession(session, { query: '#3:src/generated.ts' })
assert.match(preview.text, /generated line 30/)
assert.doesNotMatch(preview.text, /generated line 31/)
assert.match(preview.text, /#3:src\/generated\.ts:30/)
const full = recallSession(session, { query: '#3:src/generated.ts:full' })
assert.match(full.text, /generated line 45/)
assert.match(recallSession(session, { query: '#3:src/generated.ts:FULL' }).text, /generated line 45/)
const singleOffset = recallSession(session, { query: '#3:src/generated.ts:30' })
assert.match(singleOffset.text, /Lines 31-45 \(of 45\)/)
const offsetLimit = recallSession(session, { query: '#3:src/generated.ts:10:5' })
assert.match(offsetLimit.text, /Lines 11-15 \(of 45\)/)
assert.match(offsetLimit.text, /#3:src\/generated\.ts:15:5/)
const autoFile = recallSession(session, { query: '#3:file' })
assert.match(autoFile.text, /generated line 1/)
assert.match(recallSession(session, { query: '#3:FILE' }).text, /generated line 1/)
const invalidDrillDown = recallSession(session, { query: '#3:file:10:0' })
assert.match(invalidDrillDown.text, /Invalid recall drill-down syntax/)
console.log('OK: #N:path preview/full/offset/limit and #N:file auto-selection')

const samePathSession = makeTextSession([
  ...session.events,
  {
    seq: 8,
    message: {
      role: 'assistant',
      content: [
        { type: 'tool-call', name: 'Edit', arguments: { filePath: 'src/repeat.ts', oldText: 'before one', newText: 'first-edit' } },
        { type: 'tool-call', name: 'Edit', arguments: { filePath: 'src/repeat.ts', oldText: 'before two', newText: 'second-edit' } },
      ],
    },
  },
])
const samePathDrillDown = recallSession(samePathSession, { query: '#8:src/repeat.ts' })
assert.match(samePathDrillDown.text, /first-edit/)
assert.match(samePathDrillDown.text, /second-edit/)
console.log('OK: repeated edits on one path remain jointly drillable')

const pageSession = makeTextSession(Array.from({ length: 7 }, (_, seq) => ({
  seq,
  message: {
    role: 'assistant',
    content: [{ type: 'text', text: seq === 6 ? 'outside-page-query' : `page-query entry ${seq}` }],
  },
})))
const fullPageExpansion = recallSession(pageSession, { query: 'page-query', expand: [6], limit: 5 })
assert.ok(fullPageExpansion.entries.some((entry) => entry.seq === 6))
assert.match(fullPageExpansion.text, /#6/)
console.log('OK: explicit expansion survives a full ranked result page')

const longLineSession = makeTextSession([{
  seq: 9,
  message: {
    role: 'assistant',
    content: [{ type: 'tool-call', name: 'Write', arguments: { path: 'src/long-line.ts', content: 'L'.repeat(60_000) } }],
  },
}])
const longLineOffset = recallSession(longLineSession, { query: '#9:src/long-line.ts:0:1' })
assert.ok(Buffer.byteLength(longLineOffset.text, 'utf8') < 53 * 1024)
const longLineFull = recallSession(longLineSession, { query: '#9:src/long-line.ts:full' })
assert.match(longLineFull.text, /cannot continue within that line/)
assert.doesNotMatch(longLineFull.text, /Use #9:src\/long-line\.ts:0:30/)
const largeLinesSession = makeTextSession([{
  seq: 13,
  message: {
    role: 'assistant',
    content: [{ type: 'tool-call', name: 'Write', arguments: {
      path: 'src/large-lines.ts',
      content: Array.from({ length: 30 }, (_, index) => `${index}:${'M'.repeat(3_000)}`).join('\n'),
    } }],
  },
}])
const largeLinesPage = recallSession(largeLinesSession, { query: '#13:src/large-lines.ts:0:30' })
assert.doesNotMatch(largeLinesPage.text, /Lines 1-30/)
const largeLinesNext = largeLinesPage.text.match(/large-lines\.ts:(\d+):30/)
assert.ok(largeLinesNext)
assert.ok(Number(largeLinesNext[1]) > 0 && Number(largeLinesNext[1]) < 30)
const hugeResultSession = makeTextSession([{
  seq: 11,
  message: {
    role: 'assistant',
    content: [{ type: 'tool-result', toolCallId: 'huge-result', content: [{ type: 'text', text: 'Q'.repeat(60_000) }] }],
  },
}])
const hugeExact = recallSession(hugeResultSession, { query: '#11' })
assert.ok(Buffer.byteLength(hugeExact.text, 'utf8') <= 50 * 1024)
assert.match(hugeExact.text, /truncated at 50KB/)
const cjkResult = recallSession(makeTextSession([{
  seq: 15,
  message: {
    role: 'assistant',
    content: [{ type: 'tool-result', content: [{ type: 'text', text: '界'.repeat(60_000) }] }],
  },
}]), { query: '#15' })
assert.ok(Buffer.byteLength(cjkResult.entries[0].expandedText, 'utf8') <= 50 * 1024)
console.log('OK: offset drill-down also enforces the UTF-8 display cap')

const multiFile = recallSession(session, { query: '#5:file' })
assert.match(multiFile.text, /has 2 file operations/)
assert.match(multiFile.text, /src\/feature\/config\.ts/)
assert.match(multiFile.text, /tests\/feature\/config\.ts/)
const ambiguous = recallSession(session, { query: '#5:config.ts' })
assert.match(ambiguous.text, /2 file operations matching/)
const specific = recallSession(session, { query: '#5:src/feature' })
assert.match(specific.text, /alpha/)
const readOnly = recallSession(session, { query: '#1:file' })
assert.match(readOnly.text, /No file content found/)
console.log('OK: multi-file entries report ambiguity instead of choosing silently')

assert.deepEqual(parseRecallDrillDown('#3:C:/repo/generated.ts:20:10'), {
  seq: 3, pathPattern: 'C:/repo/generated.ts', full: false, offset: 20, limit: 10,
})
assert.equal(parseRecallDrillDown('#3:file:10:0'), undefined)
console.log('OK: drill-down parser preserves drive-letter paths and rejects invalid limits')

const limitedBranch = recallSession(session, { query: '#6:branch-only.ts' })
assert.match(limitedBranch.text, /outside the selected scope/)
const allBranches = recallSession(session, { query: '#6:branch-only.ts', scope: 'all' })
assert.match(allBranches.text, /BranchSecretOnly/)
const limitedSearch = recallSession(session, { query: 'BranchSecretOnly', mode: 'file' })
assert.equal(limitedSearch.total, 0)
const allSearch = recallSession(session, { query: 'BranchSecretOnly', mode: 'file', scope: 'all' })
assert.deepEqual(allSearch.entries.map((entry) => entry.seq), [6])
console.log('OK: active-lineage scope is default and scope:all enables branch recall')

const touched = recallSession(session, { mode: 'touched' })
assert.match(touched.text, /src\/parser\.ts/)
assert.doesNotMatch(touched.text, /branch-only/)
const touchedAll = recallSession(session, { mode: 'touched', scope: 'all' })
assert.match(touchedAll.text, /branch-only/)
console.log('OK: touched-files mode follows the selected scope')

const readOnlySession = makeTextSession([{
  seq: 0,
  message: {
    role: 'assistant',
    content: [{ type: 'tool-call', name: 'Read', arguments: { path: 'src/read-only.ts' } }],
  },
}])
const readOnlyTouched = recallSession(readOnlySession, { mode: 'touched' })
assert.equal(readOnlyTouched.total, 0)
assert.doesNotMatch(readOnlyTouched.text, /read-only\.ts/)
const readWithBodySession = makeTextSession([{
  seq: 1,
  message: {
    role: 'assistant',
    content: [{ type: 'tool-call', name: 'Read', arguments: {
      path: 'src/read-with-body.ts', content: 'read output is not a write operation',
    } }],
  },
}])
const readWithBody = indexRecallSession(readWithBodySession)[0]
assert.equal(readWithBody.fileOperations.length, 0)
assert.equal(recallSession(readWithBodySession, { mode: 'touched' }).total, 0)
assert.match(recallSession(readWithBodySession, { query: 'read output' }).text, /read output/)
assert.match(recallSession(readWithBodySession, { query: '#1' }).text, /read output/)
console.log('OK: read-only tool calls do not appear as touched files')

const touchedPageSession = makeTextSession(Array.from({ length: 7 }, (_, seq) => ({
  seq,
  message: {
    role: 'assistant',
    content: [{ type: 'tool-call', name: 'Write', arguments: {
      path: `src/touched-${seq}.ts`, content: `body-${seq}`,
    } }],
  },
})))
const touchedPageOne = recallSession(touchedPageSession, { mode: 'touched' })
assert.equal(touchedPageOne.total, 7)
assert.equal(touchedPageOne.totalPages, 2)
assert.match(touchedPageOne.text, /touched-0\.ts/)
assert.doesNotMatch(touchedPageOne.text, /touched-6\.ts/)
const touchedPageTwo = recallSession(touchedPageSession, { mode: 'touched', page: 2 })
assert.match(touchedPageTwo.text, /touched-5\.ts/)
assert.match(touchedPageTwo.text, /touched-6\.ts/)
assert.doesNotMatch(touchedPageTwo.text, /touched-0\.ts/)
console.log('OK: touched-files mode paginates paths independently')

const boundedPageSession = makeTextSession(Array.from({ length: 150 }, (_, seq) => ({
  seq,
  message: { role: 'assistant', content: [{ type: 'text', text: `bounded-result ${seq}` }] },
})))
const boundedPage = recallSession(boundedPageSession, { query: 'bounded-result', limit: 10_000 })
assert.equal(boundedPage.entries.length, 100)
const boundedExpand = recallSession(boundedPageSession, {
  query: 'no-ranked-match',
  expand: Array.from({ length: 80 }, (_, seq) => seq),
})
assert.equal(boundedExpand.entries.length, 50)
assert.match(boundedExpand.text, /first 50 explicit expansions/)
const boundedMixedPage = recallSession(boundedPageSession, {
  query: 'bounded-result',
  limit: 100,
  expand: Array.from({ length: 50 }, (_, index) => index + 100),
})
assert.equal(boundedMixedPage.entries.length, 100)
const boundedTouched = recallSession(makeTextSession(Array.from({ length: 150 }, (_, seq) => ({
  seq,
  message: { role: 'assistant', content: [{ type: 'tool-call', name: 'Write', arguments: {
    path: `src/bounded-${seq}.ts`, content: `bounded-${seq}`,
  } }] },
}))), { mode: 'touched', limit: 10_000 })
assert.equal(boundedTouched.entries.length, 100)
console.log('OK: pathological page and expansion counts are bounded')

const matches = findRecallFileMatches(indexed[3].fileOperations, '/secretneedle/')
assert.equal(matches[0].lineCount, 1)
assert.match(matches[0].snippet, /SecretNeedle/)
assert.match(findRecallFileMatches(indexed[3].fileOperations, 'SecretNeedle|missing')[0].snippet, /SecretNeedle/)
console.log('OK: file match metadata includes matching-line counts and snippets')

const hugeBody = Array.from({ length: 900 }, (_, index) => `${String(index).padStart(4, '0')} ${'界'.repeat(40)}`).join('\n')
const hugeFull = renderRecallFileDrillDown(99, [{ path: 'src/huge.ts', tool: 'Write', content: hugeBody }], {
  seq: 99, pathPattern: 'file', full: true,
})
assert.match(hugeFull, /file exceeds 50KB display limit/)
assert.ok(Buffer.byteLength(hugeFull, 'utf8') < 53 * 1024)
console.log('OK: full file output is capped by UTF-8 bytes without splitting characters')

assert.equal(isOmMemoryId('abcdef123456'), true)
assert.equal(isOmMemoryId('ABCDEF123456'), false)
const om = recallSession(session, { query: 'abcdef123456' })
assert.equal(om.text, OM_RECALL_TODO)
assert.equal(recallSession(session, { query: 'abcdef123456', mode: 'touched' }).text, OM_RECALL_TODO)
assert.equal(recallSession({
  events: [{ seq: 0 }],
  deriveEventMessage() { throw new Error('OM lookup must not index the session') },
}, { query: 'abcdef123456' }).text, OM_RECALL_TODO)
console.log('OK: exact lowercase OM ids return the explicit integration TODO')

const parsedCommand = parseRecallCommandInput(' SecretNeedle MODE:FILE SCOPE:ALL PAGE:2 offset:5 limit:3 ')
assert.deepEqual(parsedCommand, {
  query: 'SecretNeedle', page: 2, offset: 5, limit: 3, scope: 'all', mode: 'file',
})
assert.deepEqual(parseRecallCommandInput('page:all'), { query: 'page:all' })
const command = createRecallCommand()
const commandResult = await command.handler({ rawInput: 'SecretNeedle mode:file', agent: { session } })
assert.equal(commandResult.kind, 'success')
assert.match(commandResult.text, /#3/)
const commandOm = await command.handler({ rawInput: 'abcdef123456', agent: { session } })
assert.deepEqual(commandOm, { kind: 'success', text: OM_RECALL_TODO })
assert.deepEqual(await command.handler({ rawInput: '', agent: {} }), {
  kind: 'error', text: '当前没有可用于回读的会话。',
})
let commandRegistered = false
let commandDisposed = false
const disposeCommand = registerRecallCommand({ register(definition) {
  commandRegistered = definition.name === 'blackhole-recall'
  return () => { commandDisposed = true }
} })
disposeCommand()
assert.equal(commandRegistered, true)
assert.equal(commandDisposed, true)
console.log('OK: /blackhole-recall parsing, execution, OM TODO, and registry seam')

const definition = createRecallTool(() => session)
const value = await definition.execute({ query: '#3:file' }, {})
assert.match(value.text, /src\/generated\.ts/)
assert.match((await definition.execute({ query: 42, page: 1.5, expand: 'invalid' }, {})).text, /Recent session entries/)
let toolRegistered = false
let toolDisposed = false
const disposeTool = registerRecallTool({ register(tool) {
  toolRegistered = tool.name === 'recall'
  return () => { toolDisposed = true }
} }, () => session)
disposeTool()
assert.equal(toolRegistered, true)
assert.equal(toolDisposed, true)
console.log('OK: dsh-tools-compatible recall execution and registration seam')

console.log('ALL RECALL TESTS PASSED')
