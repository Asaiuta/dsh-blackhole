/**
 * Structured, deterministic summary compiler adapted from pi-blackhole's
 * pi-vcc layer.  The compiler deliberately works on a small structural view
 * of DSH messages so it remains independent from the optional dsh-tools
 * package and can be used by both compaction and recall tests.
 */

import { estimateEntryTokens, truncateTokens } from './instant.ts'

export interface BlackholeBlock {
  readonly type?: string
  readonly text?: string
  readonly id?: string
  readonly name?: string
  readonly arguments?: string | Record<string, unknown>
  readonly toolCallId?: string
  readonly content?: readonly BlackholeBlock[]
  readonly isError?: boolean
  readonly [key: string]: unknown
}

export interface BlackholeMessage {
  readonly id?: string
  readonly role?: string
  readonly content?: readonly BlackholeBlock[]
  readonly source?: {
    readonly kind?: string
    readonly plugin?: string
    readonly [key: string]: unknown
  }
}

export type BlackholeBlockKind =
  | 'user'
  | 'assistant'
  | 'thinking'
  | 'tool-call'
  | 'tool-result'

export interface NormalizedBlackholeBlock {
  readonly kind: BlackholeBlockKind
  readonly text: string
  readonly seq: number
  readonly messageIndex: number
  readonly name?: string
  readonly args?: string | Record<string, unknown>
  readonly callId?: string
  readonly toolCallId?: string
  readonly isError?: boolean
}

export interface BlackholeSummaryInput {
  readonly messages: readonly BlackholeMessage[]
  readonly seqs?: readonly number[]
  readonly previousSummary?: string
  readonly briefTranscript?: string
  readonly maxTokens?: number
  readonly noisePatterns?: readonly RegExp[]
}

export const BLACKHOLE_RECALL_NOTE =
  'The conversation before this point has been compacted into the summary above. ' +
  'Details not captured here — exact code, error messages, file paths — are only recoverable via `recall`. ' +
  'Use `recall` to search the session history. Do not redo work already completed.'

const SECTION_NAMES = [
  'Session Goal',
  'Files And Changes',
  'Commits',
  'Outstanding Context',
  'User Preferences',
] as const

const SUMMARY_SEPARATOR = '\n\n---\n\n'

const DEFAULT_NOISE_TOOLS = new Set([
  'TodoWrite', 'TodoRead', 'ToolSearch', 'WebSearch', 'AskUser',
  'ExitSpecMode', 'GenerateDroid', 'todo/write', 'todo/read',
])

const DEFAULT_NOISE_STRINGS = [
  'Continue from where you left off.',
  'No response requested.',
  'IMPORTANT: TodoWrite was not called yet.',
]

const DEFAULT_NOISE_XML =
  /<(?:system-reminder|ide_opened_file|command-message|context-window-usage|task-notification)[^>]*>[\s\S]*?<\/(?:system-reminder|ide_opened_file|command-message|context-window-usage|task-notification)>/gi

const BLOCKER_RE =
  /\b(fail(?:ed|s|ure|ing)?|broken|cannot|can't|won't work|does not work|doesn't work|still (?:broken|failing|wrong)|blocked|blocker|not (?:fixed|resolved|working)|crash(?:es|ed|ing)?)\b/i

const TASK_RE =
  /\b(fix|implement|add|create|build|refactor|debug|investigate|update|remove|delete|migrate|deploy|test|write|set up)\b/i

const SCOPE_CHANGE_RE =
  /\b(instead|actually|change of plan|forget that|new task|switch to|now I want|pivot|let'?s do|stop .* and)\b/i

const PREFERENCE_RE =
  /\b(prefer|please use|always|never|do not|don't|avoid|要求|必须|不要|偏好|优先)\b/i

const PATH_KEYS = ['path', 'file_path', 'filePath', 'file', 'filename', 'target'] as const
const READ_TOOLS = new Set(['read', 'read_file', 'Read', 'View', 'cat', 'glob', 'grep'])
const WRITE_TOOLS = new Set(['edit', 'write', 'Edit', 'Write', 'MultiEdit', 'edit_file', 'write_file'])

const asText = (value: unknown): string => typeof value === 'string' ? value : ''

const flattenText = (blocks: readonly BlackholeBlock[] | undefined): string =>
  (blocks ?? []).map((block) => {
    if (block.type === 'text' || block.type === 'reasoning') return asText(block.text)
    if (block.type === 'tool-result') return flattenText(block.content)
    return ''
  }).filter(Boolean).join('\n')

const sanitize = (text: string): string => text
  .replaceAll('\r', '')
  .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '')
  .trim()

const parseArguments = (args: string | Record<string, unknown> | undefined): Record<string, unknown> | undefined => {
  if (args !== undefined && typeof args === 'object') return args
  if (typeof args !== 'string') return undefined
  try {
    const parsed: unknown = JSON.parse(args)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

const firstString = (value: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined => {
  if (value === undefined) return undefined
  for (const key of keys) {
    if (typeof value[key] === 'string' && value[key].trim()) return value[key] as string
  }
  return undefined
}

const clip = (text: string, max: number): string => {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length <= max ? clean : `${clean.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

const linesOf = (text: string): string[] => text.split('\n').map((line) => line.trim()).filter(Boolean)

const seqLabel = (seq: number): string => seq >= 0 ? ` (seq ${seq})` : ''

/** Convert DSH messages into the normalized block vocabulary used by VCC. */
export function normalizeBlackholeMessages(
  messages: readonly BlackholeMessage[],
  seqs: readonly number[] = [],
): NormalizedBlackholeBlock[] {
  const toolNames = new Map<string, string>()
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const block of message.content ?? []) {
      if (block.type === 'tool-call' && typeof block.id === 'string' && typeof block.name === 'string') {
        toolNames.set(block.id, block.name)
      }
    }
  }

  const normalized: NormalizedBlackholeBlock[] = []
  messages.forEach((message, messageIndex) => {
    // A prior DSH compaction checkpoint is the durable previous-summary input,
    // not fresh transcript content. It is merged explicitly by
    // `previousCheckpointSummary()` below. rc.2 registers the
    // `compact-checkpoint` source kind; the legacy free-form marker stays.
    const source = message.source
    if (source?.kind === 'compact-checkpoint') return
    if (source?.kind === 'plugin' && source?.plugin === 'compact') return
    const seq = seqs[messageIndex] ?? -1
    // rc.2 promotes tool results to first-class tool-role messages; the
    // legacy shape carries them as a leading `tool-result` user block below.
    if (message.role === 'tool') {
      const toolMessage = message as BlackholeMessage & { toolCallId?: unknown; isError?: unknown }
      const toolCallId = typeof toolMessage.toolCallId === 'string' ? toolMessage.toolCallId : undefined
      normalized.push({
        kind: 'tool-result',
        text: flattenText(message.content),
        seq,
        messageIndex,
        name: toolCallId === undefined ? undefined : toolNames.get(toolCallId),
        toolCallId,
        ...(toolMessage.isError === true ? { isError: true } : {}),
      })
      return
    }
    const role = message.role === 'assistant' ? 'assistant' : 'user'
    for (const block of message.content ?? []) {
      switch (block.type) {
        case 'text': {
          const text = sanitize(asText(block.text))
          if (text) normalized.push({ kind: role, text, seq, messageIndex })
          break
        }
        case 'reasoning': {
          const text = sanitize(asText(block.text))
          if (text) normalized.push({ kind: 'thinking', text, seq, messageIndex })
          break
        }
        case 'tool-call':
          normalized.push({
            kind: 'tool-call',
            text: '',
            seq,
            messageIndex,
            name: typeof block.name === 'string' ? block.name : 'unknown',
            args: block.arguments,
            callId: typeof block.id === 'string' ? block.id : undefined,
          })
          break
        case 'tool-result': {
          const toolCallId = typeof block.toolCallId === 'string' ? block.toolCallId : undefined
          normalized.push({
            kind: 'tool-result',
            text: sanitize(flattenText(block.content)),
            seq,
            messageIndex,
            name: toolCallId === undefined ? undefined : toolNames.get(toolCallId),
            toolCallId,
            isError: block.isError,
          })
          break
        }
        case 'image':
        case 'document':
        case 'file':
          normalized.push({ kind: role, text: `[${block.type}]`, seq, messageIndex })
          break
        default:
          if (role === 'user' && typeof block.text === 'string') {
            const text = sanitize(block.text)
            if (text) normalized.push({ kind: 'user', text, seq, messageIndex })
          }
          break
      }
    }
  })
  return normalized
}

/** Apply pi-blackhole's noise suppression rules to normalized DSH blocks. */
export function filterBlackholeNoise(
  blocks: readonly NormalizedBlackholeBlock[],
  noisePatterns: readonly RegExp[] = [],
): NormalizedBlackholeBlock[] {
  const patterns = noisePatterns.length > 0 ? noisePatterns : [DEFAULT_NOISE_XML]
  return blocks.flatMap((block) => {
    if (block.kind === 'thinking') return []
    if ((block.kind === 'tool-call' || block.kind === 'tool-result') && block.name !== undefined && DEFAULT_NOISE_TOOLS.has(block.name)) return []
    if (block.kind !== 'user') return [block]
    if (DEFAULT_NOISE_STRINGS.some((noise) => block.text.includes(noise))) return []
    let text = block.text
    for (const pattern of patterns) text = text.replace(pattern, '')
    text = text.replace(/<\/?(?:command-name|command-args)>/gi, '').trim()
    return text ? [{ ...block, text }] : []
  })
}

const extractGoals = (blocks: readonly NormalizedBlackholeBlock[]): string[] => {
  const goals: string[] = []
  let latestScope: string[] | undefined
  let latestScopeSeq = -1
  for (const block of blocks) {
    if (block.kind !== 'user') continue
    const candidates = linesOf(block.text)
      .filter((line) => line.length > 5 && line.length <= 220)
      .filter((line) => !/^```|^(?:https?:|file:|\/)/i.test(line))
      .map((line) => line.replace(/^\s*[-*+\d.]+\s+/, '').trim())
    if (candidates.length === 0) continue
    if (goals.length === 0) goals.push(...candidates.slice(0, 6).map((line) => clip(line, 120)))
    if (SCOPE_CHANGE_RE.test(block.text) || TASK_RE.test(block.text.slice(0, 220))) {
      latestScope = candidates.slice(0, 3).map((line) => clip(line, 180))
      latestScopeSeq = block.seq
    }
  }
  if (latestScope !== undefined && latestScope.length > 0 && goals.length > latestScope.length) {
    goals.push('[Scope change]', ...latestScope.map((line) => `${line}${seqLabel(latestScopeSeq)}`))
  }
  return [...new Set(goals)].slice(0, 8)
}

const extractFiles = (blocks: readonly NormalizedBlackholeBlock[]): string[] => {
  const read = new Set<string>()
  const modified = new Set<string>()
  const addPath = (target: Set<string>, path: string | undefined) => {
    const normalized = path?.replaceAll('\\', '/').trim()
    if (normalized) target.add(normalized)
  }
  for (const block of blocks) {
    if (block.kind !== 'tool-call' || block.name === undefined) continue
    const args = parseArguments(block.args)
    const path = firstString(args, PATH_KEYS)
    if (READ_TOOLS.has(block.name)) addPath(read, path)
    if (WRITE_TOOLS.has(block.name)) addPath(modified, path)
    if ((block.name === 'bash' || block.name === 'shell') && typeof block.args === 'string') {
      const command = block.args
      const matches = command.match(/(?:^|\s)(?:cat|sed|rg|grep|git\s+diff)\s+(?:[^\s]+\s+)*([\w./\\-]+\.[\w-]+)/g) ?? []
      for (const match of matches) addPath(read, match.split(/\s+/).at(-1))
    }
  }
  for (const path of modified) read.delete(path)
  const format = (name: string, values: Set<string>) => values.size > 0 ? `- ${name}: ${[...values].slice(0, 12).join(', ')}${values.size > 12 ? ` (+${values.size - 12} more)` : ''}` : ''
  return [format('Modified', modified), format('Read', read)].filter(Boolean)
}

const extractCommits = (blocks: readonly NormalizedBlackholeBlock[]): string[] => {
  const commits: string[] = []
  for (const block of blocks) {
    const raw = block.kind === 'tool-call' ? block.args : block.text
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '')
    if (!/git\s+commit\b/i.test(text)) continue
    const message = text.match(/(?:-m|--message)\s+["']([^"']+)["']/i)?.[1]
    commits.push(message ? clip(message, 160) : clip(text, 160))
  }
  return [...new Set(commits)].slice(-8)
}

const extractOutstanding = (blocks: readonly NormalizedBlackholeBlock[]): string[] => {
  const items: string[] = []
  for (const block of blocks.slice(-20)) {
    if (block.kind === 'tool-result' && block.isError && block.text) {
      items.push(`[${block.name ?? 'tool'}] ${clip(block.text, 150)}`)
      continue
    }
    if (block.kind !== 'assistant' && block.kind !== 'user') continue
    for (const line of linesOf(block.text)) {
      if (!BLOCKER_RE.test(line) || line.length < 15) continue
      const item = `${block.kind === 'user' ? '[user] ' : ''}${clip(line, 150)}${seqLabel(block.seq)}`
      if (!items.includes(item)) items.push(item)
      break
    }
  }
  return items.slice(0, 5)
}

const extractPreferences = (blocks: readonly NormalizedBlackholeBlock[]): string[] => {
  const preferences: string[] = []
  for (const block of blocks) {
    if (block.kind !== 'user') continue
    for (const line of linesOf(block.text)) {
      if (!PREFERENCE_RE.test(line) || line.length < 12) continue
      preferences.push(clip(line.replace(/^[-*]\s+/, ''), 180))
    }
  }
  return [...new Set(preferences)].slice(-15)
}

const renderBrief = (blocks: readonly NormalizedBlackholeBlock[]): string => {
  const lines: string[] = []
  const resultSeqByCallId = new Map<string, number>()
  for (const block of blocks) {
    if (block.kind === 'tool-result' && block.toolCallId !== undefined) {
      resultSeqByCallId.set(block.toolCallId, block.seq)
    }
  }
  let role: string | undefined
  const openRole = (next: string): string => {
    if (role === next) return ''
    role = next
    return `[${next}]\n`
  }
  for (const block of blocks) {
    if (block.kind === 'tool-result') continue
    if (block.kind === 'tool-call') {
      const args = parseArguments(block.args)
      const key = firstString(args, ['path', 'file_path', 'filePath', 'file', 'command', 'pattern', 'query'])
      const suffix = key ? ` "${clip(key, 100)}"` : ''
      const resultSeq = block.callId === undefined ? undefined : resultSeqByCallId.get(block.callId)
      lines.push(`${openRole('assistant')}* ${block.name ?? 'unknown'}${suffix} (seq ${block.seq}${resultSeq !== undefined ? ` -> result ${resultSeq}` : ''})`)
      continue
    }
    lines.push(`${openRole(block.kind === 'thinking' ? 'assistant' : block.kind)}${clip(block.text, 600)}${seqLabel(block.seq)}`)
  }
  return lines.join('\n')
}

const section = (title: string, items: readonly string[]): string =>
  items.length === 0 ? '' : `[${title}]\n${items.join('\n')}`

const sectionOf = (text: string, title: string): string => {
  const marker = `[${title}]`
  const start = text.indexOf(marker)
  if (start < 0) return ''
  const after = text.slice(start)
  const next = SECTION_NAMES
    .filter((candidate) => candidate !== title)
    .map((candidate) => after.indexOf(`\n[${candidate}]`))
    .filter((index) => index >= 0)
  const separator = after.indexOf('\n\n---\n\n')
  const end = [...next, separator >= 0 ? separator : Number.MAX_SAFE_INTEGER].sort((a, b) => a - b)[0]
  return after.slice(0, end).trim()
}

const briefOf = (text: string): string => {
  const separator = text.indexOf(SUMMARY_SEPARATOR)
  return separator >= 0
    ? text.slice(separator + SUMMARY_SEPARATOR.length).split(/\n\nThe conversation before this point has been compacted/)[0].trim()
    // A transcript-only fresh pass has no structured section separator. Do
    // not silently discard it when merging with an older checkpoint. A
    // section-only summary, on the other hand, is structural data already
    // handled by `sectionOf()`.
    : SECTION_NAMES.some((title) => text.includes(`[${title}]`)) ? '' : text.trim()
}

const stripPreviousNoise = (text: string): string => text
  .split(/\n\n+/)
  .filter((paragraph) => !paragraph.includes('The conversation before this point has been compacted'))
  .filter((paragraph) => !/^## (?:Reflections|Observations)/m.test(paragraph))
  .join('\n\n')
  .trim()

const mergePrevious = (previous: string, fresh: string): string => {
  if (!previous) return fresh
  if (!fresh) return previous
  const headers = SECTION_NAMES.map((title) => {
    const oldSection = sectionOf(previous, title)
    const newSection = sectionOf(fresh, title)
    if (title === 'Outstanding Context') return newSection
    const oldLines = oldSection.split('\n').slice(1).filter(Boolean)
    const newLines = newSection.split('\n').slice(1).filter(Boolean)
    const merged = [...new Set([...oldLines, ...newLines])]
    const cap = title === 'Session Goal' || title === 'Commits' ? 8 : 15
    return merged.length > 0 ? `[${title}]\n${merged.slice(title === 'Session Goal' ? 0 : -cap).join('\n')}` : ''
  }).filter(Boolean)
  const previousBrief = briefOf(previous)
  const freshBrief = briefOf(fresh)
  const briefLines = [...previousBrief.split('\n'), ...freshBrief.split('\n')].filter(Boolean).slice(-120)
  if (briefLines.length > 0) headers.push(briefLines.join('\n'))
  return headers.join('\n\n---\n\n')
}

/** Compile a blackhole-style structured summary with a durable recall footer. */
export function compileBlackholeSummary(input: BlackholeSummaryInput): string {
  const normalized = filterBlackholeNoise(normalizeBlackholeMessages(input.messages, input.seqs), input.noisePatterns)
  const freshBrief = input.briefTranscript?.trim() || renderBrief(normalized)
  const fresh = [
    section('Session Goal', extractGoals(normalized)),
    section('Files And Changes', extractFiles(normalized)),
    section('Commits', extractCommits(normalized)),
    section('Outstanding Context', extractOutstanding(normalized)),
    section('User Preferences', extractPreferences(normalized)),
    freshBrief,
  ].filter(Boolean).join('\n\n---\n\n')
  const previous = input.previousSummary ? stripPreviousNoise(input.previousSummary) : ''
  let merged = mergePrevious(previous, fresh)
  if (!merged) return ''

  const maxTokens = Math.max(64, input.maxTokens ?? 8192)
  const footer = `\n\n${BLACKHOLE_RECALL_NOTE}`
  if (estimateEntryTokens(merged + footer) > maxTokens) {
    const structured = merged.includes('\n\n---\n\n')
      ? merged.slice(0, merged.indexOf('\n\n---\n\n'))
      : ''
    const budget = Math.max(16, maxTokens - estimateEntryTokens(structured + footer))
    const brief = briefOf(merged) || merged
    const clipped = truncateTokens(brief, budget, 'summary').text
    merged = structured ? `${structured}\n\n---\n\n${clipped}` : clipped
  }
  return `${merged}${footer}`
}

/** Pull the latest previous compact checkpoint text from a DSH message list. */
export function previousCheckpointSummary(messages: readonly BlackholeMessage[]): string | undefined {
  for (const message of [...messages].reverse()) {
    // rc.2 registers the `compact-checkpoint` source kind; the legacy
    // free-form `kind: 'plugin'` + `plugin: 'compact'` marker stays as a
    // fallback for sessions written by older harness revisions.
    const source = message.source
    if (source?.kind === 'compact-checkpoint') {
      const text = flattenText(message.content)
      if (text.trim()) return text
      continue
    }
    if (source?.kind !== 'plugin' || source?.plugin !== 'compact') continue
    const text = flattenText(message.content)
    if (text.trim()) return text
  }
  return undefined
}
