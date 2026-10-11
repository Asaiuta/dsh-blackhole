/**
 * File-content extraction used by the DSH recall surface.
 *
 * The Pi implementation reads the raw JSONL session file for this operation.
 * DSH already keeps the lossless event log in memory, so the equivalent seam
 * is a projection over the original tool-call arguments.  This module stays
 * independent from the optional dsh-tools package and deliberately does not
 * implement observational-memory (OM) IDs; that is a separate TODO.
 */

import type { BlackholeMessage } from './blackhole-summary.ts'
import { capRecallOutput, MAX_RECALL_OUTPUT_BYTES } from './recall-output.ts'
import { recallQueryTerms, recallRegexFromQuery } from './recall-regex.ts'

export interface RecallFileOperation {
  readonly path: string
  readonly tool: string
  readonly content: string
}

export interface RecallFileMatch {
  readonly path: string
  readonly tool: string
  readonly lineCount: number
  readonly snippet?: string
}

export interface RecallDrillDown {
  readonly seq: number
  readonly pathPattern: string
  readonly full: boolean
  readonly offset?: number
  readonly limit?: number
}

const PATH_KEYS = ['path', 'file_path', 'filePath', 'file', 'filename', 'target'] as const
const MUTATION_TOOL_NAMES = new Set([
  'write', 'edit', 'multiedit', 'write_file', 'edit_file', 'apply_patch', 'patch',
  'writefile', 'editfile', 'applypatch', 'create_file', 'createfile', 'replace_file',
  'replacefile', 'str_replace', 'strreplace', 'insert_file', 'overwrite_file',
  'update_file', 'updatefile', 'diff', 'applydiff',
])

export const isRecallFileMutationTool = (name: unknown): boolean => {
  if (typeof name !== 'string') return false
  const normalized = name.trim().toLocaleLowerCase()
  if (MUTATION_TOOL_NAMES.has(normalized)) return true
  // Namespaced host tools commonly use `fs.write`/`file.edit`; keep the
  // allow-list conservative so read/search tools with a content field cannot
  // become touched-file entries by accident.
  return /(?:^|[/.:_-])(?:write|edit|patch|replace|create|update)(?:$|[/.:_-])/u.test(normalized)
    || /(?:write|edit|patch|replace|create|update)(?:_?file)?$/u.test(normalized)
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined

const parseArguments = (value: unknown): Record<string, unknown> | undefined => {
  const record = asRecord(value)
  if (record !== undefined) return record
  if (typeof value !== 'string') return undefined
  try {
    return asRecord(JSON.parse(value))
  } catch {
    return undefined
  }
}

const normalizePath = (value: string): string => value.trim().replaceAll('\\', '/')

const pathFromArguments = (args: Record<string, unknown>): string | undefined => {
  for (const key of PATH_KEYS) {
    if (typeof args[key] === 'string' && args[key].trim().length > 0) {
      return normalizePath(args[key] as string)
    }
  }
  return undefined
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isContentBearing = (args: Record<string, unknown>): boolean => {
  if (typeof args.content === 'string') return true
  if (Array.isArray(args.edits) && args.edits.length > 0 && args.edits.every(isObject)) return true
  if (typeof args.oldText === 'string' && args.edits === undefined) return true
  if (typeof args.newText === 'string' && args.edits === undefined) return true
  return false
}

const formatContent = (args: Record<string, unknown>): string => {
  const sections: string[] = []
  if (typeof args.content === 'string') sections.push(args.content)

  if (Array.isArray(args.edits)) {
    if (args.edits.length > 0) {
      sections.push(args.edits.map((edit, index) => {
        const record = isObject(edit) ? edit : {}
        const oldText = typeof record.oldText === 'string' ? record.oldText : ''
        const newText = typeof record.newText === 'string' ? record.newText : ''
        return `--- edit ${index + 1} ---\n${oldText}\n--- becomes ---\n${newText}`
      }).join('\n\n'))
    }
  } else {
    const oldText = typeof args.oldText === 'string' ? args.oldText : ''
    const newText = typeof args.newText === 'string' ? args.newText : ''
    if (oldText || newText) sections.push(`--- old ---\n${oldText}\n--- new ---\n${newText}`)
  }

  return sections.join('\n\n') || '(empty file content)'
}

/** Extract Write/Edit-style content from one DSH message. */
export function extractRecallFileOperations(message: BlackholeMessage): RecallFileOperation[] {
  const operations: RecallFileOperation[] = []
  for (const block of message.content ?? []) {
    if (block.type !== 'tool-call') continue
    if (!isRecallFileMutationTool(block.name)) continue
    const args = parseArguments(block.arguments)
    if (args === undefined || !isContentBearing(args)) continue
    const path = pathFromArguments(args)
    if (path === undefined) continue
    operations.push({
      path,
      tool: typeof block.name === 'string' && block.name.length > 0 ? block.name : 'unknown',
      content: formatContent(args),
    })
  }
  return operations
}

const utf8Encoder = typeof TextEncoder === 'function' ? new TextEncoder() : undefined

const byteLength = (text: string): number => utf8Encoder?.encode(text).byteLength ?? text.length

const clipUtf8 = (text: string, maxBytes: number): string => {
  if (!Number.isFinite(maxBytes)) return text
  if (text.length <= maxBytes && byteLength(text) <= maxBytes) return text
  let bytes = 0
  let end = 0
  for (const character of text) {
    const size = byteLength(character)
    if (bytes + size > maxBytes) break
    bytes += size
    end += character.length
  }
  return text.slice(0, end)
}

const clipForSearch = (text: string, maxBytes = 10_240): string => {
  if (byteLength(text) <= maxBytes) return text
  // Keep this conservative: search recall is an aid, while drill-down can
  // still return the complete (bounded) operation body.
  return clipUtf8(text, maxBytes)
}

const PREVIEW_LINES = 30
const MAX_FILE_PAGE_LINES = 1_000
const FILE_RESPONSE_RESERVE_BYTES = 2 * 1024

interface CappedLines {
  readonly text: string
  readonly omittedBytes: number
  /** Number of complete lines represented by `text`. */
  readonly completeLines: number
  /** True when the first line alone exceeded the available byte budget. */
  readonly truncatedInsideLine: boolean
}

const linesByteLength = (lines: readonly string[]): number => lines.reduce(
  (total, line, index) => total + byteLength(line) + (index === 0 ? 0 : 1),
  0,
)

/**
 * Fit a line window into a response budget. Once one complete line fits we
 * stop before the next oversized line, preserving a valid next-line offset.
 * Only an individually oversized first line is clipped in-place.
 */
const capLines = (lines: readonly string[], maxBytes: number): CappedLines => {
  const totalBytes = linesByteLength(lines)
  const parts: string[] = []
  let usedBytes = 0
  let completeLines = 0
  let truncatedInsideLine = false

  for (const line of lines) {
    const separatorBytes = parts.length === 0 ? 0 : 1
    const requiredBytes = separatorBytes + byteLength(line)
    if (usedBytes + requiredBytes <= maxBytes) {
      parts.push(line)
      usedBytes += requiredBytes
      completeLines += 1
      continue
    }

    if (parts.length === 0) {
      const clipped = clipUtf8(line, Math.max(0, maxBytes))
      parts.push(clipped)
      usedBytes = byteLength(clipped)
      truncatedInsideLine = byteLength(clipped) < byteLength(line)
    }
    break
  }

  const text = parts.join('\n')
  return {
    text,
    omittedBytes: Math.max(0, totalBytes - byteLength(text)),
    completeLines,
    truncatedInsideLine,
  }
}

export function recallFileSearchText(operations: readonly RecallFileOperation[]): string {
  return operations.map((operation) => clipForSearch(operation.content)).join('\n')
}

const snippetFor = (text: string, query: string, regex: RegExp | undefined): string | undefined => {
  if (regex !== undefined) {
    regex.lastIndex = 0
    const match = regex.exec(text)
    regex.lastIndex = 0
    if (match !== null) {
      const start = Math.max(0, match.index - 60)
      const end = Math.min(text.length, match.index + Math.max(1, match[0].length) + 60)
      return `${start > 0 ? '...' : ''}${text.slice(start, end)}${end < text.length ? '...' : ''}`
    }
  }
  const terms = recallQueryTerms(query)
  const lowered = text.toLocaleLowerCase()
  const term = terms.find((candidate) => lowered.includes(candidate.toLocaleLowerCase()))
  if (term === undefined) return undefined
  const index = lowered.indexOf(term.toLocaleLowerCase())
  const start = Math.max(0, index - 60)
  const end = Math.min(text.length, index + term.length + 60)
  return `${start > 0 ? '...' : ''}${text.slice(start, end)}${end < text.length ? '...' : ''}`
}

/** Return file-level match indicators for a query. */
export function findRecallFileMatches(
  operations: readonly RecallFileOperation[],
  query: string,
): RecallFileMatch[] {
  const regex = recallRegexFromQuery(query)
  const terms = recallQueryTerms(query).map((term) => term.toLocaleLowerCase())
  return operations.flatMap((operation) => {
    // Keep metadata generation on the same bounded corpus used by ranking.
    // The original body remains available only through explicit drill-down.
    const searchable = clipForSearch(operation.content)
    const matched = regex !== undefined
      ? (regex.lastIndex = 0, regex.test(searchable))
      : terms.some((term) => searchable.toLocaleLowerCase().includes(term))
    if (!matched) return []
    const matchingLines = searchable.split('\n').filter((line) => {
      if (regex !== undefined) {
        regex.lastIndex = 0
        return regex.test(line)
      }
      const lowered = line.toLocaleLowerCase()
      return terms.some((term) => lowered.includes(term))
    })
    return [{
      path: operation.path,
      tool: operation.tool,
      lineCount: matchingLines.length,
      snippet: snippetFor(searchable, query, regex),
    }]
  })
}

const pathMatches = (path: string, pattern: string): boolean =>
  path.toLocaleLowerCase().includes(pattern.toLocaleLowerCase())

const MAX_OPERATION_LIST_ENTRIES = 100

const listOperations = (seq: number, operations: readonly RecallFileOperation[]): string => {
  const visible = operations.slice(0, MAX_OPERATION_LIST_ENTRIES)
  const lines = visible.map((operation) => `  [#${seq}:${operation.path}] ${operation.tool}(${operation.path})`)
  const omitted = operations.length - visible.length
  if (omitted > 0) lines.push(`  ... ${omitted} more operations omitted; use a more specific path.`)
  return lines.join('\n')
}

const formatOperation = (
  operation: RecallFileOperation,
  seq: number,
  options: Pick<RecallDrillDown, 'full' | 'offset' | 'limit'>,
): string => {
  const body = operation.content
  const allLines = body.split('\n')
  const totalLines = allLines.length
  const previewLimit = PREVIEW_LINES
  const header = `File: ${operation.path}\nTool: ${operation.tool}`
  // Leave deterministic space for paging guidance and the final global cap
  // marker. This keeps the useful continuation note visible at 50 KB.
  const bodyBudget = Math.max(
    0,
    MAX_RECALL_OUTPUT_BYTES - byteLength(header) - FILE_RESPONSE_RESERVE_BYTES,
  )

  if (options.full) {
    const capped = capLines(allLines, bodyBudget)
    if (capped.omittedBytes > 0) {
      const continuation = capped.truncatedInsideLine
        ? ' The 50KB cap falls inside a line; line-based paging cannot continue within that line.'
        : ` Use #${seq}:${operation.path}:${capped.completeLines}:${previewLimit} to continue with paged lines.`
      return `${header}\n\n${capped.text}\n\n... (${capped.omittedBytes} more bytes — file exceeds 50KB display limit.${continuation})`
    }
    return `${header}\n\n${body}`
  }

  if (options.offset !== undefined) {
    const start = Math.max(0, options.offset)
    const maxLines = Math.min(
      MAX_FILE_PAGE_LINES,
      Math.max(1, options.limit ?? previewLimit),
    )
    const end = Math.min(start + maxLines, totalLines)
    const visible = allLines.slice(start, end)
    if (visible.length === 0) return `Offset ${start} is beyond file length ${totalLines}. Use #${seq}:${operation.path} for the first ${previewLimit} lines.`
    const capped = capLines(visible, bodyBudget)
    const displayedLines = capped.truncatedInsideLine ? 1 : capped.completeLines
    const displayedEnd = start + Math.max(1, displayedLines)
    let output = `${header}\nLines ${start + 1}-${displayedEnd} (of ${totalLines}):\n\n${capped.text}`
    if (capped.omittedBytes > 0) {
      output += capped.truncatedInsideLine
        ? `\n\n... (${capped.omittedBytes} more bytes in this line range — the 50KB cap falls inside a line, so line-based paging cannot continue within that line.)`
        : `\n\n... (${capped.omittedBytes} more bytes in this line range.)`
    }
    const nextOffset = capped.omittedBytes > 0
      ? start + capped.completeLines
      : end
    if (!capped.truncatedInsideLine && nextOffset < totalLines) {
      output += `\n\n--- Use #${seq}:${operation.path}:${nextOffset} or #${seq}:${operation.path}:${nextOffset}:${maxLines} for next ${maxLines} lines, #${seq}:${operation.path}:full for complete ---`
    } else if (capped.omittedBytes === 0 && start > 0) {
      output += '\n\n(End of file)'
    }
    return output
  }

  const previewEnd = Math.min(previewLimit, totalLines)
  const capped = capLines(allLines.slice(0, previewEnd), bodyBudget)
  let note = ''
  if (capped.omittedBytes > 0) {
    note = capped.truncatedInsideLine
      ? `\n\n... (${capped.omittedBytes} more bytes in the preview — the 50KB cap falls inside a line, so line-based paging cannot continue within that line.)`
      : `\n\n... (${capped.omittedBytes} more bytes in the preview — use #${seq}:${operation.path}:${capped.completeLines}:${previewLimit} to continue.)`
  } else if (totalLines > previewEnd) {
    note = `\n\n...(${totalLines - previewEnd} more lines — use #${seq}:${operation.path}:full for complete content, or #${seq}:${operation.path}:${previewEnd} for next ${previewLimit} lines)`
  }
  return `${header}\n\n${capped.text}${note}`
}

/** Parse #N:path, #N:path:full, #N:path:offset, or #N:path:offset:limit. */
export function parseRecallDrillDown(query: string): RecallDrillDown | undefined {
  const match = query.match(/^#(\d+):(.+?)(?::(full|\d+(?::\d+)?))?$/iu)
  if (!match) return undefined
  const seq = Number(match[1])
  if (!Number.isSafeInteger(seq) || seq < 0) return undefined
  const pathPattern = match[2]
  const suffix = match[3]
  if (suffix?.toLocaleLowerCase() === 'full') return { seq, pathPattern, full: true }
  if (suffix !== undefined) {
    const parts = suffix.split(':').map(Number)
    const offset = parts[0]
    const limit = parts[1]
    if (!Number.isSafeInteger(offset) || offset < 0) return undefined
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) return undefined
    return { seq, pathPattern, full: false, offset, ...(limit === undefined ? {} : { limit }) }
  }
  return { seq, pathPattern, full: false }
}

/** Render a file drill-down in the same progressive style as pi-blackhole. */
export function renderRecallFileDrillDown(
  seq: number,
  operations: readonly RecallFileOperation[],
  drillDown: RecallDrillDown,
): string {
  let rendered: string
  if (drillDown.pathPattern.toLocaleLowerCase() === 'file') {
    if (operations.length === 0) rendered = `No file content found in entry #${seq}.`
    else if (operations.length > 1) rendered = `Entry #${seq} has ${operations.length} file operations:\n${listOperations(seq, operations)}\n\nUse #${seq}:path to drill into a specific file.`
    else rendered = formatOperation(operations[0], seq, drillDown)
  } else {
    const matched = operations.filter((operation) => pathMatches(operation.path, drillDown.pathPattern))
    if (matched.length === 0) rendered = `No file content found in entry #${seq} for "${drillDown.pathPattern}".`
    else if (matched.length > 1) {
      const uniquePaths = new Set(matched.map((operation) => operation.path.toLocaleLowerCase()))
      if (uniquePaths.size === 1) {
        const combined: RecallFileOperation = {
          path: matched[0].path,
          tool: `${matched.map((operation) => operation.tool).join(', ')} (${matched.length} operations)`,
          content: matched.map((operation, index) => `--- operation ${index + 1} ---\n${operation.content}`).join('\n\n'),
        }
        rendered = formatOperation(combined, seq, drillDown)
      } else {
        rendered = `Entry #${seq} has ${matched.length} file operations matching "${drillDown.pathPattern}":\n${listOperations(seq, matched)}\n\nUse #${seq}:<more-specific-path> to drill into a specific file.`
      }
    } else rendered = formatOperation(matched[0], seq, drillDown)
  }
  const note = rendered.includes('cannot continue within that line')
    ? 'file drill-down response truncated at 50KB; the cap falls inside a line, so line-based paging cannot continue within that line.'
    : 'file drill-down response truncated at 50KB; narrow the path or line range.'
  return capRecallOutput(rendered, note)
}
