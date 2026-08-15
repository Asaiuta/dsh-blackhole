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
  readonly text: string
  readonly files: readonly string[]
  readonly toolCallIds: readonly string[]
}

export interface RecallResult {
  readonly text: string
  readonly entries: readonly RecallEntry[]
  readonly total: number
  readonly page: number
  readonly totalPages: number
}

export interface RecallToolDefinition {
  readonly name: 'recall'
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly output: {
    readonly schema: Record<string, unknown>
    readonly render: (value: unknown) => readonly { type: 'text'; text: string }[]
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
const PATH_KEYS = ['path', 'file_path', 'filePath', 'file', 'filename', 'target'] as const

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined

const asText = (value: unknown): string => typeof value === 'string' ? value : ''

const flattenBlocks = (blocks: readonly BlackholeBlock[] | undefined): string =>
  (blocks ?? []).map((block) => {
    if (block.type === 'text' || block.type === 'reasoning') return asText(block.text)
    if (block.type === 'tool-result') return flattenBlocks(block.content)
    if (block.type === 'image') return '[image]'
    if (block.type === 'document') return '[document]'
    return ''
  }).filter(Boolean).join('\n')

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

const renderMessage = (message: BlackholeMessage, seq: number): { text: string; files: string[]; toolCallIds: string[] } => {
  const role = message.role === 'assistant' ? 'assistant' : 'user'
  const lines: string[] = [`[${role}]`]
  const files: string[] = []
  const toolCallIds: string[] = []
  for (const block of message.content ?? []) {
    if (block.type === 'text' || block.type === 'reasoning') {
      const text = asText(block.text).trim()
      if (text) lines.push(text)
      continue
    }
    if (block.type === 'tool-call') {
      const name = typeof block.name === 'string' ? block.name : 'unknown'
      const args = parseArgs(block.arguments)
      const path = filePathFromBlock(block)
      if (path !== undefined) files.push(path)
      if (typeof block.id === 'string') toolCallIds.push(block.id)
      const argumentText = args === undefined ? asText(block.arguments) : JSON.stringify(args)
      lines.push(`* ${name}${argumentText ? ` ${argumentText}` : ''}`)
      continue
    }
    if (block.type === 'tool-result') {
      const toolCallId = typeof block.toolCallId === 'string' ? block.toolCallId : ''
      if (toolCallId) toolCallIds.push(toolCallId)
      lines.push(`[tool-result${block.isError ? ' error' : ''}] ${flattenBlocks(block.content) || '(empty)'}`)
      continue
    }
    if (block.type === 'image' || block.type === 'document') lines.push(`[${block.type}]`)
  }
  lines.push(`(seq ${seq})`)
  return { text: lines.join('\n'), files: [...new Set(files)], toolCallIds: [...new Set(toolCallIds)] }
}

/** Build the durable searchable index from a DSH session. */
export function indexRecallSession(session: RecallSession): RecallEntry[] {
  return session.events.flatMap((event) => {
    if (!Number.isSafeInteger(event.seq)) return []
    const message = session.deriveEventMessage(event)
    if (message === null) return []
    const rendered = renderMessage(message, event.seq)
    return [{
      seq: event.seq,
      id: typeof message.id === 'string' ? message.id : `seq-${event.seq}`,
      message,
      ...rendered,
    }]
  })
}

const normalizeQuery = (query: string | undefined): string => (query ?? '').trim()

const isRegexQuery = (query: string): boolean => /^\/.+\/[a-z]*$/i.test(query)

const regexFromQuery = (query: string): RegExp | undefined => {
  if (!isRegexQuery(query)) return undefined
  const match = query.match(/^\/(.+)\/([a-z]*)$/i)
  if (!match) return undefined
  try {
    return new RegExp(match[1], match[2].includes('i') ? match[2] : `${match[2]}i`)
  } catch {
    return undefined
  }
}

const termsOf = (query: string): string[] => query.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []

/** Small BM25-like ranker with deterministic tie-breaking by durable seq. */
export function rankRecallEntries(entries: readonly RecallEntry[], query: string): RecallEntry[] {
  const normalized = normalizeQuery(query)
  if (!normalized) return [...entries]
  const regex = regexFromQuery(normalized)
  if (regex !== undefined) return entries.filter((entry) => {
    // `/.../g` and `/.../y` carry mutable lastIndex between test() calls.
    // Reset it so search results do not depend on entry ordering or prior use.
    regex.lastIndex = 0
    return regex.test(entry.text)
  })

  const terms = termsOf(normalized)
  if (terms.length === 0) return []
  const documentFrequency = new Map<string, number>()
  const tokenSets = entries.map((entry) => new Set(termsOf(entry.text)))
  for (const tokenSet of tokenSets) for (const term of terms) if (tokenSet.has(term)) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1)
  const averageLength = entries.length === 0 ? 1 : entries.reduce((sum, entry) => sum + termsOf(entry.text).length, 0) / entries.length
  const scored = entries.map((entry, index) => {
    const tokens = termsOf(entry.text)
    const counts = new Map<string, number>()
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1)
    const score = terms.reduce((total, term) => {
      const frequency = counts.get(term) ?? 0
      if (frequency === 0) return total
      const idf = Math.log(1 + (entries.length - (documentFrequency.get(term) ?? 0) + 0.5) / ((documentFrequency.get(term) ?? 0) + 0.5))
      const lengthNorm = 1 + 0.75 * (tokens.length / Math.max(1, averageLength) - 1)
      return total + idf * ((frequency * 2.2) / (frequency + 1.2 * lengthNorm))
    }, 0) + (entry.text.toLocaleLowerCase().includes(normalized.toLocaleLowerCase()) ? 1 : 0)
    return { entry, score, index }
  })
  return scored.filter((item) => item.score > 0).sort((a, b) => b.score - a.score || a.index - b.index).map((item) => item.entry)
}

const parseDrillDown = (query: string): { seq: number; path?: string; offset?: number; limit?: number } | undefined => {
  const match = query.match(/^#(\d+)(?::(.+))?$/)
  if (!match) return undefined
  let path = match[2]
  let offset: number | undefined
  let limit: number | undefined
  if (path?.endsWith(':full')) path = path.slice(0, -5)
  else {
    const page = path?.match(/^(.*):(\d+):(\d+)$/)
    if (page) {
      path = page[1]
      offset = Number(page[2])
      limit = Number(page[3])
    }
  }
  return { seq: Number(match[1]), path: path?.trim() || undefined, offset, limit }
}

const formatTouched = (entries: readonly RecallEntry[]): string => {
  const files = new Map<string, number[]>()
  for (const entry of entries) for (const file of entry.files) files.set(file, [...(files.get(file) ?? []), entry.seq])
  if (files.size === 0) return 'No touched files found.'
  return [...files.entries()].map(([file, seqs]) => `- ${file} (seqs ${seqs.join(', ')})`).join('\n')
}

/** Execute one recall query against a DSH session. */
export function recallSession(session: RecallSession, params: RecallQuery = {}): RecallResult {
  const allEntries = indexRecallSession(session)
  const allowedSeqs = params.scope === 'all' || session.lineageSeqs === undefined
    ? undefined
    : new Set(session.lineageSeqs)
  const scoped = allowedSeqs === undefined ? allEntries : allEntries.filter((entry) => allowedSeqs.has(entry.seq))
  const mode = params.mode ?? 'hybrid'
  if (mode === 'touched') {
    return { text: formatTouched(scoped), entries: scoped, total: scoped.length, page: 1, totalPages: 1 }
  }

  const query = normalizeQuery(params.query)
  const drillDown = parseDrillDown(query)
  if (drillDown !== undefined) {
    const entry = scoped.find((candidate) => candidate.seq === drillDown.seq)
    if (entry === undefined) {
      return { text: `No session entry ${drillDown.seq} is available in the selected scope.`, entries: [], total: 0, page: 1, totalPages: 1 }
    }
    if (drillDown.path !== undefined && !entry.files.some((file) => file.toLocaleLowerCase().includes(drillDown.path!.toLocaleLowerCase()))) {
      return { text: `Entry ${drillDown.seq} has no file matching ${drillDown.path}.`, entries: [], total: 0, page: 1, totalPages: 1 }
    }
    const lines = entry.text.split('\n')
    const start = Math.max(0, drillDown.offset ?? 0)
    const end = drillDown.limit === undefined ? lines.length : start + Math.max(0, drillDown.limit)
    return { text: lines.slice(start, end).join('\n'), entries: [entry], total: 1, page: 1, totalPages: 1 }
  }

  const candidates = mode === 'file' ? scoped.filter((entry) => entry.files.length > 0) : scoped
  const ranked = query ? rankRecallEntries(candidates, query) : candidates.slice(-DEFAULT_RECENT)
  const expanded = (params.expand ?? []).flatMap((seq) => candidates.filter((entry) => entry.seq === seq))
  const merged = [...new Map([...ranked, ...expanded].map((entry) => [entry.seq, entry])).values()]
  const explicitOffset = Number.isFinite(params.offset) ? Math.max(0, Math.floor(params.offset!)) : undefined
  const explicitLimit = Number.isFinite(params.limit) ? Math.max(1, Math.floor(params.limit!)) : undefined
  const page = Math.max(1, params.page ?? 1)
  const pageSize = explicitLimit ?? PAGE_SIZE
  const offset = explicitOffset ?? ((page - 1) * pageSize)
  const totalPages = Math.max(1, Math.ceil(merged.length / pageSize))
  const pageEntries = merged.slice(offset, offset + pageSize)
  const header = query
    ? `${merged.length} matches${params.scope === 'all' ? ' (scope: all)' : ''}`
    : `Recent session entries${params.scope === 'all' ? ' (scope: all)' : ''}`
  const nextPage = offset + pageSize < merged.length ? `\n--- Use offset:${offset + pageSize} limit:${pageSize} for more results ---` : ''
  const text = `${header}\n\n${pageEntries.map((entry) => `#${entry.seq}\n${entry.text}`).join('\n\n') || 'No matching session entries.'}${nextPage}`
  return { text, entries: pageEntries, total: merged.length, page, totalPages }
}

const recallParameters: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    query: { type: 'string', description: 'Text/regex search; #N expands an entry; #N:path drills down with optional :offset:limit.' },
    expand: { type: 'array', items: { type: 'integer' }, description: 'Durable seq numbers to expand.' },
    page: { type: 'integer', minimum: 1, description: '1-based result page.' },
    offset: { type: 'integer', minimum: 0, description: 'Zero-based result offset.' },
    limit: { type: 'integer', minimum: 1, description: 'Maximum results after offset.' },
    scope: { type: 'string', enum: ['lineage', 'all'], description: 'Search active lineage or all available session events.' },
    mode: { type: 'string', enum: ['hybrid', 'file', 'touched'], description: 'Search all content, file-bearing entries, or aggregate touched files.' },
  },
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
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      render: (value) => {
        const rendered = asRecord(value)?.text
        return [{ type: 'text', text: typeof rendered === 'string' ? rendered : String(value) }]
      },
    },
    async execute(args, exec) {
      const session = getSession(exec)
      if (session === undefined) return { text: 'No session is available for recall.' }
      const result = recallSession(session, (asRecord(args) ?? {}) as RecallQuery)
      return { text: result.text }
    },
  }
}

/** Register recall into a host dsh-tools registry. */
export function registerRecallTool(
  registry: RecallToolRegistry,
  getSession: (exec: unknown) => RecallSession | undefined,
): (() => void) | void {
  return registry.register(createRecallTool(getSession))
}
