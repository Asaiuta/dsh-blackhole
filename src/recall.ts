/**
 * DSH recall/search seam adapted from pi-blackhole's unified recall tool.
 *
 * The core is runtime-independent: it indexes the durable DSH session event
 * log through `deriveEventMessage()`.  `registerRecallTool()` deliberately
 * accepts a structural registry instead of importing dsh-tools, allowing the
 * same package to run against DSH profiles where that optional package is
 * supplied by the host.
 */

import type { BlackholeBlock, BlackholeMessage } from './blackhole-summary.ts'
import { deriveSessionMessage, readSessionEvents } from './session-access.ts'
import type { SessionEventSource } from './session-access.ts'
import {
  extractRecallFileOperations,
  findRecallFileMatches,
  isRecallFileMutationTool,
  parseRecallDrillDown,
  recallFileSearchText,
  renderRecallFileDrillDown,
} from './recall-files.ts'
import type { RecallFileMatch, RecallFileOperation } from './recall-files.ts'
import {
  capRecallOutput,
  clipRecallUtf8,
  MAX_RECALL_OUTPUT_BYTES,
  recallUtf8ByteLength,
} from './recall-output.ts'
import { recallQueryTerms, recallRegexFromQuery } from './recall-regex.ts'

export type { RecallDrillDown, RecallFileMatch, RecallFileOperation } from './recall-files.ts'

export type RecallScope = 'lineage' | 'all'
export type RecallMode = 'hybrid' | 'file' | 'touched'

export interface RecallEvent {
  readonly seq: number
  readonly type?: string
  readonly data?: unknown
}

export interface RecallSession {
  readonly events: readonly RecallEvent[]
  readonly deriveEventMessage: (event: unknown) => BlackholeMessage | null
  /** Optional host-provided active-lineage projection. */
  readonly lineageSeqs?: readonly number[]
}

export interface RecallQuery {
  readonly query?: string
  readonly expand?: readonly number[]
  readonly page?: number
  /** Zero-based result offset, useful when a host wants cursor paging. */
  readonly offset?: number
  /** Maximum result count after `offset`; defaults to the standard page size. */
  readonly limit?: number
  readonly scope?: RecallScope
  readonly mode?: RecallMode
}

export interface RecallEntry {
  readonly seq: number
  readonly id: string
  readonly message: BlackholeMessage
  /** Compact transcript rendering used in ordinary ranked result pages. */
  readonly text: string
  /** Explicit #N rendering: full prose/results, with file bodies still redacted. */
  readonly expandedText: string
  readonly files: readonly string[]
  /** Original content-bearing Write/Edit arguments for file search/drill-down. */
  readonly fileOperations: readonly RecallFileOperation[]
  /** Search corpus: rendered transcript plus bounded file-operation content. */
  readonly searchText: string
  readonly toolCallIds: readonly string[]
  readonly fileMatches?: readonly RecallFileMatch[]
}

export interface RecallResult {
  readonly text: string
  readonly entries: readonly RecallEntry[]
  readonly total: number
  readonly page: number
  readonly totalPages: number
}

/**
 * OM memory ids are intentionally reserved for a future ledger integration.
 * Keeping the predicate here lets the tool/command fail clearly instead of
 * silently treating an OM id as an ordinary transcript search.
 */
export const isOmMemoryId = (query: string | undefined): boolean => /^[a-f0-9]{12}$/u.test((query ?? '').trim())

export const OM_RECALL_TODO =
  'OM 回读在 dsh-blackhole 中暂未实现：12 位 observation/reflection ID 尚未建立索引。' +
  '请使用 #N、#N:path，或以文本/正则查询转录内容。'

export interface RecallToolDefinition {
  readonly name: 'recall'
  readonly description: string
  /** dsh-tools author-DSL property map (inline `required` flags, whitelisted keys only). */
  readonly parameters: Record<string, unknown>
  readonly output: {
    /** dsh-tools author-DSL value schema. */
    readonly schema: Record<string, unknown>
    readonly render: (args: unknown, value: unknown) => readonly { type: 'text'; text: string }[]
  }
  readonly execute: (args: unknown, exec: unknown) => Promise<{ text: string }>
}

export interface RecallToolRegistry {
  register: (definition: RecallToolDefinition) => (() => void) | void
}

export interface RecallToolContext {
  readonly session?: RecallSession
}

const PAGE_SIZE = 5
const DEFAULT_RECENT = 25
const USER_TEXT_PREVIEW_CHARS = 300
const TOOL_RESULT_PREVIEW_CHARS = 200
const TOOL_ARGS_PREVIEW_CHARS = 300
const SEARCH_BLOCK_CHARS = 10_240
/** Keep pathological `limit`/`expand` requests from building huge strings. */
const MAX_RESULT_ENTRIES = 100
const MAX_EXPANSION_ENTRIES = 50
const MAX_FILE_MATCH_NOTES = 100
const PATH_KEYS = ['path', 'file_path', 'filePath', 'file', 'filename', 'target'] as const
const FILE_CONTENT_KEYS = [
  'content', 'contents', 'edits', 'oldText', 'old_text', 'newText', 'new_text',
  'patch', 'diff', 'body', 'source',
] as const

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined

const asText = (value: unknown): string => typeof value === 'string' ? value : ''

const sliceChars = (text: string, maxChars: number): string => {
  if (text.length <= maxChars) return text
  let end = Math.max(0, maxChars)
  const trailingCodeUnit = text.charCodeAt(end - 1)
  if (trailingCodeUnit >= 0xd800 && trailingCodeUnit <= 0xdbff) end -= 1
  return text.slice(0, end)
}

const clipChars = (text: string, maxChars: number): string =>
  text.length <= maxChars ? text : `${sliceChars(text, maxChars)}…`

const flattenBlocks = (
  blocks: readonly BlackholeBlock[] | undefined,
  maxChars = Number.POSITIVE_INFINITY,
): string => {
  const parts: string[] = []
  let remaining = maxChars
  for (const block of blocks ?? []) {
    if (remaining <= 0) break
    const separatorChars = parts.length === 0 ? 0 : 1
    const available = Math.max(0, remaining - separatorChars)
    let text = ''
    if (block.type === 'text' || block.type === 'reasoning') text = asText(block.text)
    else if (block.type === 'tool-result') text = flattenBlocks(block.content, available)
    else if (block.type === 'image') text = '[image]'
    else if (block.type === 'document') text = '[document]'
    if (!text) continue
    const visible = sliceChars(text, available)
    if (!visible) break
    parts.push(visible)
    remaining -= separatorChars + visible.length
    if (visible.length < text.length) break
  }
  return parts.join('\n')
}

const parseArgs = (value: unknown): Record<string, unknown> | undefined => {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value !== 'string') return undefined
  try {
    return asRecord(JSON.parse(value))
  } catch {
    return undefined
  }
}

const filePathFromBlock = (block: BlackholeBlock): string | undefined => {
  if (block.type !== 'tool-call') return undefined
  const args = parseArgs(block.arguments)
  if (args === undefined) return undefined
  for (const key of PATH_KEYS) {
    if (typeof args[key] === 'string' && args[key].trim()) return (args[key] as string).replaceAll('\\', '/')
  }
  return undefined
}

const searchArguments = (
  args: Record<string, unknown> | undefined,
  rendered: string,
  toolName: string,
): string => {
  const mutationTool = isRecallFileMutationTool(toolName)
  if (args === undefined) {
    // A malformed JSON argument can still contain a complete file body. Do
    // not put raw Write/Edit arguments into the transcript/search corpus when
    // they cannot be parsed and therefore cannot be indexed as a file op.
    return mutationTool
      ? '[file arguments omitted; invalid tool-call JSON]'
      : rendered
  }
  const projected = { ...args }
  let redacted = false
  if (mutationTool) {
    for (const key of FILE_CONTENT_KEYS) {
      if (projected[key] === undefined) continue
      projected[key] = '[file content indexed separately]'
      redacted = true
    }
  }
  // Mutation tools occasionally use a provider-specific body key. Hide any
  // unrecognised payload rather than leaking it into ordinary recall.
  if (!redacted && mutationTool) {
    const visibleKeys = new Set<string>(PATH_KEYS)
    const conservative = { ...projected }
    for (const [key, value] of Object.entries(conservative)) {
      if (visibleKeys.has(key)) continue
      if (typeof value === 'string' || Array.isArray(value) || typeof value === 'object') {
        conservative[key] = '[file content indexed separately]'
        redacted = true
      }
    }
    if (redacted) return JSON.stringify(conservative)
  }
  return redacted ? JSON.stringify(projected) : rendered
}

const displayArguments = (
  args: Record<string, unknown> | undefined,
  rendered: string,
  path: string | undefined,
  seq: number,
  toolName: string,
): string => {
  const indexed = searchArguments(args, rendered, toolName)
  const redaction = '[file content indexed separately]'
  const visible = path === undefined
    ? indexed.replaceAll(redaction, '[file content omitted; no file path]')
    : indexed.replaceAll(redaction, `[file content omitted; use #${seq}:${path}]`)
  return clipChars(visible, TOOL_ARGS_PREVIEW_CHARS)
}

/** Build the lossless prose/result rendering only when #N/expand asks for it. */
const renderExpandedMessage = (message: BlackholeMessage, seq: number): string => {
  const role = message.role === 'assistant' ? 'assistant' : 'user'
  const lines: string[] = []
  let remainingBytes = MAX_RECALL_OUTPUT_BYTES
  const pushLine = (line: string): boolean => {
    const separatorBytes = lines.length === 0 ? 0 : recallUtf8ByteLength('\n')
    const available = Math.max(0, remainingBytes - separatorBytes)
    const visible = clipRecallUtf8(line, available)
    if (!visible) return false
    lines.push(visible)
    remainingBytes -= separatorBytes + recallUtf8ByteLength(visible)
    return visible.length === line.length
  }
  pushLine(`[${role}]`)
  for (const block of message.content ?? []) {
    if (remainingBytes <= 0) break
    if (block.type === 'text' || block.type === 'reasoning') {
      const text = asText(block.text).trim()
      if (text && !pushLine(text)) break
      continue
    }
    if (block.type === 'tool-call') {
      const name = typeof block.name === 'string' ? block.name : 'unknown'
      const args = parseArgs(block.arguments)
      const path = filePathFromBlock(block)
      const argumentText = args === undefined ? asText(block.arguments) : JSON.stringify(args)
      const visibleArguments = displayArguments(args, argumentText, path, seq, name)
      if (!pushLine(`* ${name}${visibleArguments ? ` ${visibleArguments}` : ''}`)) break
      continue
    }
    if (block.type === 'tool-result') {
      const resultText = flattenBlocks(block.content, remainingBytes) || '(empty)'
      if (!pushLine(`[tool-result${block.isError ? ' error' : ''}] ${resultText}`)) break
      continue
    }
    if ((block.type === 'image' || block.type === 'document') && !pushLine(`[${block.type}]`)) break
  }
  pushLine(`(seq ${seq})`)
  return lines.join('\n')
}

const renderMessage = (message: BlackholeMessage, seq: number): {
  text: string
  getExpandedText: () => string
  files: string[]
  fileOperations: RecallFileOperation[]
  searchText: string
  toolCallIds: string[]
} => {
  const role = message.role === 'assistant' ? 'assistant' : 'user'
  const lines: string[] = [`[${role}]`]
  const searchLines: string[] = [`[${role}]`]
  const files: string[] = []
  const toolCallIds: string[] = []
  for (const block of message.content ?? []) {
    if (block.type === 'text' || block.type === 'reasoning') {
      const text = asText(block.text).trim()
      if (text) {
        lines.push(clipChars(text, USER_TEXT_PREVIEW_CHARS))
        searchLines.push(clipChars(text, SEARCH_BLOCK_CHARS))
      }
      continue
    }
    if (block.type === 'tool-call') {
      const name = typeof block.name === 'string' ? block.name : 'unknown'
      const args = parseArgs(block.arguments)
      const path = filePathFromBlock(block)
      if (path !== undefined) files.push(path)
      if (typeof block.id === 'string') toolCallIds.push(block.id)
      const argumentText = args === undefined ? asText(block.arguments) : JSON.stringify(args)
      const indexedArguments = searchArguments(args, argumentText, name)
      const visibleArguments = displayArguments(args, argumentText, path, seq, name)
      lines.push(`* ${name}${visibleArguments ? ` ${visibleArguments}` : ''}`)
      searchLines.push(`* ${name}${indexedArguments ? ` ${clipChars(indexedArguments, SEARCH_BLOCK_CHARS)}` : ''}`)
      continue
    }
    if (block.type === 'tool-result') {
      const toolCallId = typeof block.toolCallId === 'string' ? block.toolCallId : ''
      if (toolCallId) toolCallIds.push(toolCallId)
      const resultText = flattenBlocks(block.content, SEARCH_BLOCK_CHARS) || '(empty)'
      const resultPrefix = `[tool-result${block.isError ? ' error' : ''}] `
      lines.push(`${resultPrefix}${clipChars(resultText, TOOL_RESULT_PREVIEW_CHARS)}`)
      searchLines.push(`${resultPrefix}${clipChars(resultText, SEARCH_BLOCK_CHARS)}`)
      continue
    }
    if (block.type === 'image' || block.type === 'document') {
      lines.push(`[${block.type}]`)
      searchLines.push(`[${block.type}]`)
    }
  }
  lines.push(`(seq ${seq})`)
  searchLines.push(`(seq ${seq})`)
  const text = lines.join('\n')
  const fileOperations = extractRecallFileOperations(message)
  return {
    text,
    getExpandedText: () => renderExpandedMessage(message, seq),
    files: [...new Set([...files, ...fileOperations.map((operation) => operation.path)])],
    fileOperations,
    searchText: `${searchLines.join('\n')}\n${recallFileSearchText(fileOperations)}`.trim(),
    toolCallIds: [...new Set(toolCallIds)],
  }
}

/** Build the durable searchable index from a DSH session. */
export function indexRecallSession(session: RecallSession): RecallEntry[] {
  return session.events.flatMap((event) => {
    if (!Number.isSafeInteger(event.seq)) return []
    const message = session.deriveEventMessage(event)
    if (message === null) return []
    const rendered = renderMessage(message, event.seq)
    let expandedText: string | undefined
    const entry: RecallEntry = {
      seq: event.seq,
      id: typeof message.id === 'string' ? message.id : `seq-${event.seq}`,
      message,
      text: rendered.text,
      get expandedText() {
        expandedText ??= rendered.getExpandedText()
        return expandedText
      },
      files: rendered.files,
      fileOperations: rendered.fileOperations,
      searchText: rendered.searchText,
      toolCallIds: rendered.toolCallIds,
    }
    // Keep bulk serialization of RecallResult.entries from materializing up
    // to 100 full 50 KB expansions. Callers can still access the property
    // directly when they explicitly need it.
    Object.defineProperty(entry, 'expandedText', { enumerable: false })
    return [entry]
  })
}

const normalizeQuery = (query: string | undefined): string => (query ?? '').trim()

const parseEntryReference = (query: string): number | undefined => {
  const match = query.match(/^#(\d+)$/u)
  if (match === null) return undefined
  const seq = Number(match[1])
  return Number.isSafeInteger(seq) && seq >= 0 ? seq : undefined
}

const termsOf = (query: string): string[] => recallQueryTerms(query).map((term) => term.toLocaleLowerCase())

/** Small BM25-like ranker with deterministic tie-breaking by durable seq. */
export function rankRecallEntries(
  entries: readonly RecallEntry[],
  query: string,
  mode: RecallMode = 'hybrid',
): RecallEntry[] {
  const normalized = normalizeQuery(query)
  if (!normalized) return [...entries]
  const regex = recallRegexFromQuery(normalized)
  const corpusOf = (entry: RecallEntry): string => mode === 'file'
    ? recallFileSearchText(entry.fileOperations)
    : entry.searchText
  if (regex !== undefined) return entries.filter((entry) => {
    // `/.../g` and `/.../y` carry mutable lastIndex between test() calls.
    // Reset it so search results do not depend on entry ordering or prior use.
    regex.lastIndex = 0
    return regex.test(corpusOf(entry))
  })

  const terms = [...new Set(termsOf(normalized))]
  if (terms.length === 0) return []
  const documentFrequency = new Map<string, number>()
  const tokenSets = entries.map((entry) => new Set(termsOf(corpusOf(entry))))
  for (const tokenSet of tokenSets) for (const term of terms) if (tokenSet.has(term)) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1)
  const averageLength = entries.length === 0 ? 1 : entries.reduce((sum, entry) => sum + termsOf(corpusOf(entry)).length, 0) / entries.length
  const scored = entries.map((entry, index) => {
    const corpus = corpusOf(entry)
    const tokens = termsOf(corpus)
    const counts = new Map<string, number>()
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1)
    const score = terms.reduce((total, term) => {
      const frequency = counts.get(term) ?? 0
      if (frequency === 0) return total
      const idf = Math.log(1 + (entries.length - (documentFrequency.get(term) ?? 0) + 0.5) / ((documentFrequency.get(term) ?? 0) + 0.5))
      const lengthNorm = 1 + 0.75 * (tokens.length / Math.max(1, averageLength) - 1)
      return total + idf * ((frequency * 2.2) / (frequency + 1.2 * lengthNorm))
    }, 0) + (corpus.toLocaleLowerCase().includes(normalized.toLocaleLowerCase()) ? 1 : 0)
    return { entry, score, index }
  })
  return scored.filter((item) => item.score > 0).sort((a, b) => b.score - a.score || a.index - b.index).map((item) => item.entry)
}

interface TouchedFile {
  readonly path: string
  readonly refs: readonly { seq: number; tools: readonly string[] }[]
}

const touchedFilesOf = (entries: readonly RecallEntry[]): TouchedFile[] => {
  const files = new Map<string, { seq: number; tools: Set<string> }[]>()
  for (const entry of entries) for (const operation of entry.fileOperations) {
    const refs = files.get(operation.path) ?? []
    const existing = refs.find((ref) => ref.seq === entry.seq)
    if (existing === undefined) refs.push({ seq: entry.seq, tools: new Set([operation.tool]) })
    else existing.tools.add(operation.tool)
    files.set(operation.path, refs)
  }
  return [...files.entries()].map(([path, refs]) => ({
    path,
    refs: refs.map((ref) => ({ seq: ref.seq, tools: [...ref.tools] })),
  }))
}

const formatTouched = (
  entries: readonly RecallEntry[],
  params: Pick<RecallQuery, 'page' | 'offset' | 'limit'>,
): { text: string; total: number; page: number; totalPages: number; entrySeqs: readonly number[] } => {
  const files = touchedFilesOf(entries)
  if (files.length === 0) return { text: 'No touched files found.', total: 0, page: 1, totalPages: 1, entrySeqs: [] }
  const requestedLimit = params.limit
  const pageSize = typeof requestedLimit === 'number' && Number.isSafeInteger(requestedLimit) && requestedLimit > 0
    ? Math.min(MAX_RESULT_ENTRIES, requestedLimit)
    : PAGE_SIZE
  const explicitOffset = typeof params.offset === 'number' && Number.isSafeInteger(params.offset) && params.offset >= 0
    ? params.offset
    : undefined
  const requestedPage = params.page
  const page = explicitOffset === undefined
    ? (typeof requestedPage === 'number' && Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1)
    : Math.floor(explicitOffset / pageSize) + 1
  const offset = explicitOffset ?? ((page - 1) * pageSize)
  const totalPages = Math.max(1, Math.ceil(files.length / pageSize))
  const visible = files.slice(offset, offset + pageSize)
  const lines = visible.map((file) => {
    const refs = file.refs.map((ref) => `#${ref.seq} (${ref.tools.join(', ')})`).join(', ')
    return `- ${file.path} — ${refs}`
  })
  const nextPage = offset + pageSize < files.length
    ? `\n--- Use page:${page + 1} limit:${pageSize} or offset:${offset + pageSize} limit:${pageSize} for more files ---`
    : ''
  const entrySeqs = [...new Set(visible.flatMap((file) => file.refs.map((ref) => ref.seq)))]
  return {
    text: `Page ${page}/${totalPages} (${files.length} total files)\n\n${lines.join('\n') || 'No touched files on this page.'}${nextPage}`,
    total: files.length,
    page,
    totalPages,
    entrySeqs,
  }
}

/** Execute one recall query against a DSH session. */
export function recallSession(session: RecallSession, params: RecallQuery = {}): RecallResult {
  const mode = params.mode ?? 'hybrid'
  const query = normalizeQuery(params.query)
  if (isOmMemoryId(query)) {
    return { text: OM_RECALL_TODO, entries: [], total: 0, page: 1, totalPages: 1 }
  }
  const allEntries = indexRecallSession(session)
  const allowedSeqs = params.scope === 'all' || session.lineageSeqs === undefined
    ? undefined
    : new Set(session.lineageSeqs)
  const scoped = allowedSeqs === undefined ? allEntries : allEntries.filter((entry) => allowedSeqs.has(entry.seq))
  if (mode === 'touched') {
    const touched = formatTouched(scoped, params)
    const entrySeqs = new Set(touched.entrySeqs)
    const entries = scoped.filter((entry) => entrySeqs.has(entry.seq)).slice(0, MAX_RESULT_ENTRIES)
    return {
      text: capRecallOutput(touched.text),
      entries,
      total: touched.total,
      page: touched.page,
      totalPages: touched.totalPages,
    }
  }

  const entryReference = parseEntryReference(query)
  if (entryReference !== undefined) {
    const entry = scoped.find((candidate) => candidate.seq === entryReference)
    if (entry === undefined) {
      return { text: `Cannot expand indices outside the selected scope: ${entryReference}. Use scope:'all' to reach other branches.`, entries: [], total: 0, page: 1, totalPages: 1 }
    }
    return {
      text: capRecallOutput(`#${entry.seq}\n${entry.expandedText}`),
      entries: [entry],
      total: 1,
      page: 1,
      totalPages: 1,
    }
  }

  const drillDown = parseRecallDrillDown(query)
  if (drillDown === undefined && /^#\d+:/u.test(query)) {
    return {
      text: 'Invalid recall drill-down syntax. Use #N:path, #N:path:full, #N:path:offset, or #N:path:offset:limit.',
      entries: [],
      total: 0,
      page: 1,
      totalPages: 1,
    }
  }
  if (drillDown !== undefined) {
    const entry = scoped.find((candidate) => candidate.seq === drillDown.seq)
    if (entry === undefined) {
      return { text: `Cannot expand indices outside the selected scope: ${drillDown.seq}. Use scope:'all' to reach other branches.`, entries: [], total: 0, page: 1, totalPages: 1 }
    }
    return {
      text: renderRecallFileDrillDown(entry.seq, entry.fileOperations, drillDown),
      entries: [entry],
      total: 1,
      page: 1,
      totalPages: 1,
    }
  }

  const candidates = mode === 'file' ? scoped.filter((entry) => entry.fileOperations.length > 0) : scoped
  const ranked = query ? rankRecallEntries(candidates, query, mode) : candidates.slice(-DEFAULT_RECENT)
  // Expansion is an explicit request and must not disappear merely because
  // the caller also selected mode:file or supplied a query that did not match.
  const uniqueExpansionTargets = [...new Set(params.expand ?? [])]
  const expansionTargets = uniqueExpansionTargets.slice(0, MAX_EXPANSION_ENTRIES)
  const entriesBySeq = new Map(scoped.map((entry) => [entry.seq, entry]))
  const expanded = expansionTargets.flatMap((seq) => {
    const entry = entriesBySeq.get(seq)
    return entry === undefined ? [] : [entry]
  })
  const merged = [...new Map([...ranked, ...expanded].map((entry) => [entry.seq, entry])).values()]
  const explicitOffset = Number.isFinite(params.offset) ? Math.max(0, Math.floor(params.offset!)) : undefined
  const explicitLimit = Number.isFinite(params.limit)
    ? Math.min(MAX_RESULT_ENTRIES, Math.max(1, Math.floor(params.limit!)))
    : undefined
  const pageSize = explicitLimit ?? PAGE_SIZE
  const requestedPage = params.page
  const page = explicitOffset === undefined
    ? (typeof requestedPage === 'number' && Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1)
    : Math.floor(explicitOffset / pageSize) + 1
  const offset = explicitOffset ?? ((page - 1) * pageSize)
  const totalPages = Math.max(1, Math.ceil(merged.length / pageSize))
  const pagedEntries = merged.slice(offset, offset + pageSize)
  // Explicit expansions supplement search pagination: keep them in the
  // returned page even when the ranked result set already fills that page.
  const allPageEntries = [...new Map([...expanded, ...pagedEntries].map((entry) => [entry.seq, entry])).values()]
  const pageEntries = allPageEntries.slice(0, MAX_RESULT_ENTRIES)
  const expandedSeqs = new Set(expanded.map((entry) => entry.seq))
  const expansionNotice = uniqueExpansionTargets.length > MAX_EXPANSION_ENTRIES
    ? `\n--- Only the first ${MAX_EXPANSION_ENTRIES} explicit expansions are shown; narrow expand for the rest. ---`
    : ''
  const resultNotice = allPageEntries.length > MAX_RESULT_ENTRIES
    ? `\n--- ${allPageEntries.length - MAX_RESULT_ENTRIES} page entries omitted by the ${MAX_RESULT_ENTRIES}-entry response bound; use paging or narrower expand. ---`
    : ''
  const header = query
    ? `${merged.length} matches${params.scope === 'all' ? ' (scope: all)' : ''}`
    : `Recent session entries${params.scope === 'all' ? ' (scope: all)' : ''}`
  const nextPage = offset + pageSize < merged.length ? `\n--- Use offset:${offset + pageSize} limit:${pageSize} for more results ---` : ''
  const decorated = pageEntries.map((entry) => {
    if (query && entry.fileOperations.length > 0) {
      // Do not spread the entry here: `expandedText` is a lazy getter and a
      // spread would eagerly materialize every full tool result on every
      // ordinary search page.
      Object.defineProperty(entry, 'fileMatches', {
        configurable: true,
        enumerable: true,
        value: findRecallFileMatches(entry.fileOperations, query),
        writable: false,
      })
    }
    return entry
  })
  const fileNotes = (entry: RecallEntry): string => {
    if (entry.fileMatches === undefined || entry.fileMatches.length === 0) return ''
    const visibleMatches = entry.fileMatches.slice(0, MAX_FILE_MATCH_NOTES)
    const omitted = entry.fileMatches.length - visibleMatches.length
    return `\n[file matches]\n${visibleMatches.map((match) => `- ${match.path} (${match.tool}, ${match.lineCount} matching lines)${match.snippet === undefined ? '' : `\n  ${match.snippet}`}`).join('\n')}${omitted > 0 ? `\n- ... ${omitted} more file matches omitted; narrow the query.` : ''}`
  }
  const text = capRecallOutput(`${header}\n\n${decorated.map((entry) => `#${entry.seq}\n${expandedSeqs.has(entry.seq) ? entry.expandedText : entry.text}${fileNotes(entry)}`).join('\n\n') || 'No matching session entries.'}${nextPage}${expansionNotice}${resultNotice}`)
  return { text, entries: decorated, total: merged.length, page, totalPages }
}

/**
 * The recall tool's parameter spec, in the dsh-tools author DSL: a bare
 * property map with inline `required` flags. The DSL is a whitelist — no
 * `minimum`/`maximum`/`maxItems` — so numeric bounds are enforced at runtime
 * by `recallQueryFromUnknown()`'s clamps instead.
 */
const recallParameters: Record<string, unknown> = {
  query: { type: 'string', description: 'Text/regex search; #N expands an entry; #N:path drills file content with :full or :offset:limit. 12-char OM ids are TODO.' },
  expand: { type: 'array', items: { type: 'integer' }, description: 'Durable seq numbers to expand.' },
  page: { type: 'integer', description: '1-based result page.' },
  offset: { type: 'integer', description: 'Zero-based result offset.' },
  limit: { type: 'integer', description: 'Maximum results after offset.' },
  scope: { type: 'string', enum: ['lineage', 'all'], description: 'Search active lineage or all available session events.' },
  mode: { type: 'string', enum: ['hybrid', 'file', 'touched'], description: 'Search transcript + file content, file content only, or aggregate touched files.' },
}

/**
 * The recall tool's output spec, in the dsh-tools value-DSL: an explicit
 * object node (unlike the parameters' bare property map, the value root must
 * declare its own type), with inline `required` flags inside `properties`.
 */
const recallOutputSpec: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string', required: true, description: 'Rendered recall response (UTF-8, size-capped).' },
  },
}

const recallQueryFromUnknown = (value: unknown): RecallQuery => {
  const record = asRecord(value)
  if (record === undefined) return {}
  const positiveInteger = (candidate: unknown): number | undefined =>
    typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate > 0
      ? candidate
      : undefined
  const nonNegativeInteger = (candidate: unknown): number | undefined =>
    typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 0
      ? candidate
      : undefined
  const expand = Array.isArray(record.expand)
    ? record.expand.slice(0, MAX_EXPANSION_ENTRIES + 1).filter((candidate): candidate is number =>
      typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 0)
    : undefined
  const page = positiveInteger(record.page)
  const offset = nonNegativeInteger(record.offset)
  const limit = positiveInteger(record.limit)
  const scope = record.scope === 'lineage' || record.scope === 'all' ? record.scope : undefined
  const mode = record.mode === 'hybrid' || record.mode === 'file' || record.mode === 'touched'
    ? record.mode
    : undefined
  return {
    ...(typeof record.query === 'string' ? { query: record.query } : {}),
    ...(expand === undefined ? {} : { expand }),
    ...(page === undefined ? {} : { page }),
    ...(offset === undefined ? {} : { offset }),
    ...(limit === undefined ? {} : { limit }),
    ...(scope === undefined ? {} : { scope }),
    ...(mode === undefined ? {} : { mode }),
  }
}

/** Build a dsh-tools-compatible definition without hard-coding its package. */
export function createRecallTool(
  getSession: (exec: unknown) => RecallSession | undefined,
): RecallToolDefinition {
  return {
    name: 'recall',
    description: 'Search durable session history and recover compacted context, file operations, and earlier tool results.',
    parameters: recallParameters,
    output: {
      schema: recallOutputSpec,
      render: (_args, value) => {
        const rendered = asRecord(value)?.text
        return [{ type: 'text', text: typeof rendered === 'string' ? rendered : String(value) }]
      },
    },
    async execute(args, exec) {
      const session = getSession(exec)
      if (session === undefined) return { text: 'No session is available for recall.' }
      const result = recallSession(session, recallQueryFromUnknown(args))
      return { text: result.text }
    },
  }
}

/**
 * Adapt a runtime Session (or a test fake) onto the recall tool's structural
 * `RecallSession` seam. The runtime exposes `snapshotEvents()` plus the
 * module-level projection; fakes answer with an `events` array and an
 * instance method — the adapter normalizes both behind one guard.
 */
export function adaptRecallSession(session: unknown): RecallSession | undefined {
  if (typeof session !== 'object' || session === null) return undefined
  const candidate = session as SessionEventSource
  if (candidate.snapshotEvents === undefined && !Array.isArray(candidate.events)) return undefined
  return {
    events: readSessionEvents(candidate) as readonly RecallEvent[],
    deriveEventMessage: (event) => deriveSessionMessage(candidate, event) as BlackholeMessage | null,
  }
}

/** Register recall into a host dsh-tools registry. */
export function registerRecallTool(
  registry: RecallToolRegistry,
  getSession: (exec: unknown) => RecallSession | undefined,
): (() => void) | void {
  return registry.register(createRecallTool(getSession))
}
