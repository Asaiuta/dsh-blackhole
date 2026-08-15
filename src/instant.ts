/**
 * Deterministic VCC-style region compiler, self-contained in this package.
 *
 * Ports the "conversation compiler" principle of
 * https://github.com/lllyasviel/VCC (`skills/conversation-compiler/scripts/VCC.py`)
 * into the DSH vocabulary:
 *
 *   - the durable session event log is the lossless layer (VCC's `.txt`);
 *   - a shadowed surface region compiles into a compact, reference-linked
 *     view (VCC's `.min.txt`) using ONLY original tokens — no model call, no
 *     paraphrase — which is what makes instant compaction deterministic and
 *     near-lossless;
 *   - every truncation and elision keeps a `(seq N)` pointer back to the
 *     exact durable event, so nothing is unrecoverable;
 *   - noise handling mirrors VCC's brief-mode rules: sanitize control bytes,
 *     strip known noise XML wrappers, hide reasoning by default, collapse
 *     every tool call into ONE line (key argument for whitelisted tools,
 *     name-only for the rest, a `-> result M` pointer instead of the result
 *     entry), and render images/documents as labels.
 *
 * The concrete rules are adapted from the MIT-licensed `dsh-compaction-instant`
 * (KitDoesIt) compiler, with the same observable formats (`[user]` /
 * `[assistant]` role headers on switch, `* name "arg" (seq N -> result M)`,
 * `...(truncated from seq N)`), reimplemented here so this package stays
 * dependency-free and the engine can route to the remote Responses pipeline.
 *
 * This module imports nothing from cordis or dsh packages, so it can be
 * unit-tested and reused outside a running harness. Messages are read as
 * plain `{ id, role, content, source }` values — exactly what
 * `Session.deriveEventMessage` projects; the engine resolves real durable
 * `seq`s before compiling (a synthesized message matches its stored event by
 * `id`).
 *
 * @module dsh-blackhole/instant
 */

// ── tokenizer (VCC `_tokenize` / `_TOK_RE`) ────────────────────────────────

const TOKEN_RE = /[a-zA-Z]+|[0-9]+|[^\sa-zA-Z0-9]|\s+/g

/** Whether a UTF-16 code unit can be an unpaired high surrogate. */
function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

/** Whether a UTF-16 code unit can be an unpaired low surrogate. */
function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

/** Move a slice end to a code-point boundary: never leave a lone high surrogate. */
function completeCodePointAtEnd(text: string): string {
  return isHighSurrogate(text.charCodeAt(text.length - 1)) ? text.slice(0, -1) : text
}

/** Move a slice start to a code-point boundary: never begin inside a surrogate pair. */
function completeCodePointAtStart(text: string): string {
  return isLowSurrogate(text.charCodeAt(0)) ? text.slice(1) : text
}

const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g
const CTRL_RE = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g

/**
 * Split text into fixed-density tokens under the same character-class
 * heuristic VCC uses: letter runs, digit runs, single punctuation chars,
 * whitespace runs. Deterministic, offline, consistent for every budget.
 */
export function tokenize(text: string): string[] {
  return text.match(TOKEN_RE) ?? []
}

/** Count the non-whitespace tokens of a text under {@link tokenize}. */
export function countTokens(text: string): number {
  let count = 0
  for (const token of tokenize(text)) if (token.trim().length > 0) count += 1
  return count
}

/**
 * Size one emitted entry the way every budget is enforced: the non-whitespace
 * token count, floored at the real-density `chars / 4` equivalent so a
 * pathological unbroken token run (minified file, base64 blob) cannot pass a
 * budget.
 */
export function estimateEntryTokens(text: string): number {
  return Math.max(countTokens(text), Math.ceil(text.length / 4))
}

/**
 * Strip carriage returns, ANSI escapes, and control bytes the way VCC's
 * `_sanitize` does — deterministic cleanup, never token-changing rewrites.
 */
export function sanitize(text: string): string {
  if (typeof text !== 'string') return ''
  let out = text
  if (out.includes('\r')) out = out.replaceAll('\r', '')
  if (out.includes('\x1b')) out = out.replace(ANSI_RE, '')
  return out.replace(CTRL_RE, '')
}

// ── noise stripping (VCC `_BRIEF_STRIP_RE` family) ─────────────────────────

const NOISE_UNWRAP_RE = /<\/?(?:command-name|command-args)>/g

/**
 * The VCC brief-mode noise XML patterns, adapted to harness markup. Applied
 * with the `s` flag; configurable via `noisePatterns`.
 */
export const DEFAULT_NOISE_PATTERNS: readonly string[] = [
  '<ide_opened_file>.*?</ide_opened_file>',
  '<ide_selection>.*?</ide_selection>',
  '<system-reminder>.*?</system-reminder>',
  '<command-message>.*?</command-message>',
  '<task-notification>.*?</task-notification>',
]

/** Compile untrusted noise-pattern sources, throwing on invalid regex. */
export function compileNoisePatterns(sources: readonly string[]): RegExp[] {
  return sources.map((source, index) => {
    try {
      return new RegExp(source, 's')
    } catch (error) {
      throw new Error(
        `noisePatterns[${index}] (${JSON.stringify(source)}) is not a valid regular expression: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      )
    }
  })
}

/** Strip configured noise XML blocks and unwrap command-name/args tags. */
export function stripNoiseXml(text: string, patterns: readonly RegExp[]): string {
  let out = text
  for (const pattern of patterns) out = out.replace(pattern, '')
  out = out.replace(NOISE_UNWRAP_RE, '')
  return out.trim()
}

// ── truncation (VCC `_trunc`) ──────────────────────────────────────────────

/**
 * Truncate text to a non-whitespace-token budget, preserving exact original
 * tokens and appending a VCC-style provenance note when something was cut.
 * Every budget is enforced twice — by token count AND by a `limit * 4`
 * character ceiling.
 * @returns `{ text, truncated }` — `truncated` is true when anything was cut.
 */
export function truncateTokens(
  text: string,
  limit: number,
  ref?: string,
): { text: string; truncated: boolean } {
  const tokens = tokenize(text)
  let count = 0
  let cut = tokens.length
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.trim().length === 0) continue
    count += 1
    if (count > limit) {
      cut = index
      break
    }
  }
  let out = cut >= tokens.length ? text : tokens.slice(0, cut).join('')
  let truncated = cut < tokens.length
  const maxChars = Math.max(32, limit * 4)
  if (out.length > maxChars) {
    out = completeCodePointAtEnd(out.slice(0, maxChars))
    truncated = true
  } else if (truncated) {
    out = completeCodePointAtEnd(out)
  }
  if (!truncated) {
    // pi-blackhole flattens whitespace even on the untruncated path (VCC
    // brief mode treats the checkpoint as one dense token stream).
    return { text: text.replace(/\s+/g, ' ').trim(), truncated: false }
  }
  // The truncated path is flattened too, so the checkpoint stays one dense
  // line per block exactly like blackhole's word-truncated flat text.
  out = out.replace(/\s+$/u, '').replace(/\s+/g, ' ').trim()
  const note = ref === undefined ? '...(truncated)' : `...(truncated from ${ref})`
  return { text: out + note, truncated: true }
}

// ── tool-call one-liner (VCC `_tool_summary`) ──────────────────────────────

/** VCC's `_TOOL_SUMMARY_FIELDS`, extended for the DSH tool catalog. */
export const DEFAULT_TOOL_KEY_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  read: 'file_path',
  edit: 'file_path',
  write: 'file_path',
  glob: 'pattern',
  grep: 'pattern',
  bash: 'command',
  Read: 'file_path',
  Edit: 'file_path',
  Write: 'file_path',
  Glob: 'pattern',
  Grep: 'pattern',
  web_search: 'query',
  skill: 'name',
  ralph: 'objective',
  subagent: 'description',
  subagent_fork: 'description',
  create_goal: 'objective',
  update_goal: 'objective',
  workflow: 'name',
  interrupt_agent: 'agent_id',
  job_kill: 'job_id',
  job_output: 'job_id',
  send_message: 'message',
})

/**
 * Tools whose key argument is kept in the one-liner. Everything else renders
 * name-only (`* tool (seq N)`) — bookkeeping tools carry no semantic payload
 * worth the tokens (VCC's brief mode keeps `Read`/`Edit`/… args and drops
 * the rest).
 */
export const DEFAULT_ARG_TOOLS: readonly string[] = [
  'read', 'write', 'edit', 'glob', 'grep', 'bash', 'shell', 'web_search',
  'skill', 'subagent', 'subagent_fork', 'ralph', 'workflow',
  'Read', 'Write', 'Edit', 'Glob', 'Grep',
]

/** Canonical path-like argument keys (pi-blackhole's PATH_KEYS). */
export const PATH_KEYS: readonly string[] = ['path', 'file_path', 'filePath', 'file']

/** Parse a tool-call arguments JSON string; `null` when it does not parse. */
export function parseToolArguments(arguments_: string | undefined): Record<string, unknown> | null {
  if (typeof arguments_ !== 'string') return null
  try {
    return JSON.parse(arguments_) as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * Pick the key argument of a tool call: the tool-specific field first
 * (`bash` → `command`), then any canonical path-like key, then the first
 * string-valued argument, else nothing. The path fallback mirrors
 * pi-blackhole's `extractPath` so capitalized `Read`/`Edit`/`Write` calls
 * keep their target path even when no explicit mapping exists.
 */
export function pickToolKeyArg(
  name: string,
  parsed: Record<string, unknown> | null,
  keyFields: Readonly<Record<string, string>>,
): string | undefined {
  const key = keyFields[name]
  if (key !== undefined && parsed !== null && typeof parsed[key] === 'string') {
    return parsed[key] as string
  }
  if (parsed !== null) {
    for (const pathKey of PATH_KEYS) {
      if (typeof parsed[pathKey] === 'string') return parsed[pathKey] as string
    }
    for (const value of Object.values(parsed)) {
      if (typeof value === 'string') return value
    }
  }
  return undefined
}

/** Clip a tool argument for display (keeps head and tail, one ellipsis). */
function clipArg(arg: string): string {
  const clean = arg.replace(/[\r\n\t]+/g, ' ').trim()
  if (clean.length <= 100) return clean
  return `${clean.slice(0, 60)}...${clean.slice(-30)}`
}

// ── pi-blackhole brief rules ported in (pinned 49ab560) ──────────────────

/** Leading self-talk fillers stripped from assistant text (up to 2 passes). */
export const SELF_TALK_PREFIX_RE = /^\s*(?:hmm|wait|actually|oh|okay|ok|well|so)[,.!\s-]+/i

/** Strip leading self-talk filler, up to `max` consecutive passes. */
export function stripSelfTalkPrefix(text: string, max = 2): string {
  let out = text
  for (let i = 0; i < max; i++) {
    const stripped = out.replace(SELF_TALK_PREFIX_RE, '')
    if (stripped === out) break
    out = stripped
  }
  return out
}

/** Collapse `<skill name="X" …>…</skill>` blocks to `[skill: X]`. */
const SKILL_BLOCK_RE = /<skill\s+name="([^"]+)"[^>]*>[\s\S]*?(?:<\/skill>|$)/g
export function collapseSkillText(text: string): string {
  return text.replace(SKILL_BLOCK_RE, (_, name) => `[skill: ${name}]`)
}

/** Only strip pure-formatting pipe tails (head/tail/sort/wc/column/…). */
const PIPE_TAIL_RE = /\s*\|\s*(?:head|tail|sort|wc|column|tr|cut|uniq)(?:\s[^|]*)?$/

/**
 * Semantic bash compression: flatten lines with `; `, strip a `cd x &&`
 * prefix and formatting pipe tails, cap the length. Ported from
 * pi-blackhole's `compressBash`.
 */
export function compressBash(raw: string, cap = 120): string {
  let cmd = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('; ')
  cmd = cmd.replace(/^cd\s+\S+\s*&&\s*/, '')
  for (let i = 0; i < 10; i++) {
    const stripped = cmd.replace(PIPE_TAIL_RE, '')
    if (stripped === cmd) break
    cmd = stripped
  }
  if (cmd.length > cap) {
    const cut = cmd.lastIndexOf(' ', cap - 2)
    const end = cut > cap * 0.6 ? cut : cap - 3
    return cmd.slice(0, end).trimEnd() + '...'
  }
  return cmd
}

/** First line of a text, clipped to `max` chars at a word boundary. */
export function firstLineOf(text: string, max: number): string {
  const line = (text.split('\n')[0] ?? '').trim()
  if (line.length <= max) return line
  const cut = line.lastIndexOf(' ', max)
  return line.slice(0, cut > max * 0.6 ? cut : max)
}

/** Mime label for an image block (pi-blackhole keeps `[image: mimeType]`). */
function imageLabel(block: RawBlock): string {
  const mime = block.mediaType ?? block.attachment?.mediaType
  return mime === undefined || mime.length === 0 ? '[image]' : `[image: ${mime}]`
}

/** Project nested tool-result blocks into one plain-text string. */
export function projectToolResultText(blocks: readonly RawBlock[]): string {
  const parts: string[] = []
  const visit = (block: RawBlock): void => {
    if (block.type === 'text') {
      const text = sanitize(block.text ?? '')
      if (text.length > 0) parts.push(text)
    } else if (block.type === 'image') parts.push('[image]')
    else if (block.type === 'document') parts.push('[document]')
    else if (Array.isArray(block.content) && block.content.length > 0) {
      for (const nested of block.content) visit(nested)
    } else if (block.type === 'tool-result') {
      // A tool-result block with no projected text renders as its label.
      parts.push('[tool-result]')
    } else {
      parts.push(`[${String(block.type)}]`)
    }
  }
  for (const block of blocks) visit(block)
  return parts.join('\n')
}

/** Whether a message source identifies a landed compaction checkpoint node. */
export function isCheckpointSource(source: RawSource | undefined): boolean {
  return source !== undefined && source.kind === 'plugin' && source.plugin === 'compact'
}

function seqRef(seq: number): string {
  return `seq ${seq}`
}

// ── region compilation ─────────────────────────────────────────────────────

/** Minimal structural view of a DSH content block (typed loosely on purpose). */
export interface RawBlock {
  type: string
  text?: string
  toolCallId?: string
  id?: string
  name?: string
  arguments?: string
  isError?: boolean
  mediaType?: string
  attachment?: { mediaType?: string; [key: string]: unknown }
  content?: readonly RawBlock[]
}

/** Minimal structural view of a message source. */
export interface RawSource {
  kind?: string
  plugin?: string
  callId?: string
}

/** Minimal structural view of a message (what `deriveEventMessage` projects). */
export interface RawMessage {
  id?: string
  role?: string
  content?: readonly RawBlock[]
  source?: RawSource
}

/** One compiled region node: a message anchored to its durable session seq. */
export interface CompilerNode {
  /** Durable session-log seq this message came from; -1 when unknown. */
  seq: number
  message: RawMessage
}

export type InstantEntryKind = 'text' | 'reasoning' | 'tool' | 'tool-error' | 'media' | 'note' | 'checkpoint'

/** One compiled entry of the checkpoint view. */
export interface InstantEntry {
  /** Durable seq the entry derives from. */
  seq: number
  /** Rendered entry text (original tokens only, plus role/pointer markers). */
  text: string
  /** Deletion-priority kind: `tool`/`media`/`note` rows drop before `text` rows. */
  kind: InstantEntryKind
}

/** Compiler configuration knobs (mirror of the instant engine's knobs). */
export interface InstantCompileOptions {
  /** Per-text-block token budget for assistant text/reasoning. Default 512. */
  textTokens: number
  /** Per-text-block token budget for user text. Default 1024. */
  userTextTokens: number
  /** Per-tool-line token budget. Default 128. */
  toolCallTokens: number
  /** Keep `reasoning` blocks as `[assistant]` entries. Default false. */
  includeReasoning: boolean
  /** Strip configured noise XML wrappers from user text. Default true. */
  stripNoiseXml: boolean
  /** Compiled noise regexes (see {@link compileNoisePatterns}). */
  noisePatterns: readonly RegExp[]
  /** Tool name → key-argument field. */
  toolKeyFields: Readonly<Record<string, string>>
  /** Tools whose key argument is kept in the one-liner. */
  toolArgTools: readonly string[]
  /** Tools rendered as nothing at all (no `* name` line). */
  hideTools: ReadonlySet<string>
  /** Keep the first line of failed tool results as `[tool_error]` entries. Default 150 (0 disables). */
  toolErrorChars?: number
  /** Compress bash commands (cd-strip, pipe-tail strip, cap). Default 120 (0 disables). */
  bashCap?: number
  /** Collapse `<skill name="X">…</skill>` blocks to `[skill: X]`. Default true. */
  collapseSkills?: boolean
  /** Strip leading self-talk fillers from assistant text (hmm/wait/actually/…). Default true. */
  stripSelfTalk?: boolean
  /** Merge adjacent identical tool one-liners (`… xN`). Default true. */
  mergeToolLines?: boolean
  /** Max tool one-liners per assistant turn; 0 = unlimited. Default 8. */
  toolsPerTurn?: number
}

/** Compilation counters (mirror of the instant engine's stats, minus checkpoints framing). */
export interface InstantStats {
  nodes: number
  entries: number
  toolCalls: number
  toolResults: number
  toolErrors: number
  images: number
  documents: number
  reasoningElided: number
  noiseElided: number
  checkpoints: number
  tokens: number
  elidedToolRows: number
  elidedRows: number
}

/** Result of one region compile. */
export interface InstantCompiledRegion {
  entries: InstantEntry[]
  stats: InstantStats
  /** True when the token cap forced entry dropping. */
  capped: boolean
}

export const DEFAULT_INSTANT_OPTIONS: InstantCompileOptions = {
  textTokens: 512,
  userTextTokens: 1024,
  toolCallTokens: 128,
  includeReasoning: false,
  stripNoiseXml: true,
  noisePatterns: compileNoisePatterns(DEFAULT_NOISE_PATTERNS),
  toolKeyFields: DEFAULT_TOOL_KEY_FIELDS,
  // Empty = extract the key argument for EVERY tool (pi-blackhole behavior:
  // field map → path-key fallback → first string arg → name-only), not just
  // a whitelist.  A non-empty list opts back into whitelist-only extraction.
  toolArgTools: [],
  hideTools: new Set(),
  toolErrorChars: 150,
  bashCap: 120,
  collapseSkills: true,
  stripSelfTalk: true,
  mergeToolLines: true,
  toolsPerTurn: 8,
}

function estimateMessagesTokensImpl(messages: readonly RawMessage[]): number {
  let total = 0
  for (const message of messages) {
    for (const block of message.content ?? []) {
      // A DSH block is structured JSON.  Counting only `block.text` undercounts
      // tool-call arguments and nested tool-result content by orders of
      // magnitude, which makes the cap and the pre-shrink check unsound.  The
      // durable session boundary already guarantees JSON values, so use the
      // serialized block as a conservative deterministic estimate.
      const serialized = JSON.stringify(block)
      if (serialized !== undefined && serialized.length > 0) {
        total += Math.ceil(serialized.length / 4)
      }
    }
    total += 2 // per-message envelope overhead
  }
  return total
}

/**
 * Compile one shadowed region into the reference-linked checkpoint view.
 *
 * Entry rendering rules (VCC brief mode):
 *   - role headers `[user]` / `[assistant]` / `[system]` print only when the
 *     role changes;
 *   - every tool call becomes ONE line `* name "arg" (seq N -> result M)`
 *     (key argument only for whitelisted tools; `-> result M` resolves a
 *     later tool-result user message by call id);
 *   - tool results NEVER occupy an entry — the content is one recall away via
 *     the call line's pointer, VCC drops results from brief mode too;
 *   - reasoning elided unless `includeReasoning`;
 *   - images/documents render as `[image] (seq N)` labels;
 *   - checkpoint nodes (source plugin `compact`) render as `[system]` text;
 *   - a noise-only user message leaves a `* [user message elided: noise-only]`
 *     note instead of silence;
 *   - long text truncates with `...(truncated from seq N)`.
 *
 * When the total exceeds `maxTokens`, the cap drops the oldest
 * `tool`/`media`/`note` rows first, then the oldest `text`/`reasoning`
 * rows, always keeping the newest content, and prepends an `[N entries
 * elided: seqs a-b]` note.
 */
export function compileInstantRegion(
  nodes: readonly CompilerNode[],
  options: InstantCompileOptions,
  maxTokens: number,
): InstantCompiledRegion {
  const stats: InstantStats = {
    nodes: nodes.length,
    entries: 0,
    toolCalls: 0,
    toolResults: 0,
    toolErrors: 0,
    images: 0,
    documents: 0,
    reasoningElided: 0,
    noiseElided: 0,
    checkpoints: 0,
    tokens: 0,
    elidedToolRows: 0,
    elidedRows: 0,
  }
  const entries: InstantEntry[] = []
  const estimated = new Map<InstantEntry, number>()
  const pushEntry = (seq: number, text: string, kind: InstantEntryKind): void => {
    const entry: InstantEntry = { seq, text, kind }
    const tokens = estimateEntryTokens(text)
    estimated.set(entry, tokens)
    entries.push(entry)
    stats.entries += 1
    stats.tokens += tokens
  }

  // Pre-pass over the ordered nodes: map each tool-call id to the seq of its
  // result node, so every call one-liner can carry `(seq N -> result M)`
  // even though results no longer occupy entries.  The same pass records
  // call id → tool name: real DSH `ToolResultBlock`s carry only
  // `toolCallId` + `isError` (no name), so `[tool_error]` lines must resolve
  // the tool name through their correlated call.
  const resultSeqByCallId = new Map<string, number>()
  const callNameByCallId = new Map<string, string>()
  for (const node of nodes) {
    const message = node.message
    if (message === null || message === undefined || message.content === undefined) continue
    for (const block of message.content) {
      if (block.type === 'tool-call' && typeof block.id === 'string') {
        if (typeof block.name === 'string' && block.name.length > 0) {
          callNameByCallId.set(block.id, block.name)
        }
      } else if (block.type === 'tool-result' && typeof block.toolCallId === 'string') {
        resultSeqByCallId.set(block.toolCallId, node.seq)
      }
    }
  }

  const effective = {
    textTokens: Math.max(1, options.textTokens),
    userTextTokens: Math.max(1, options.userTextTokens),
    toolCallTokens: Math.max(1, options.toolCallTokens),
  }
  const hiddenTools = options.hideTools
  const argTools = new Set(options.toolArgTools)

  let lastRole: string | undefined
  let open = false
  const roleHeader = (role: string): string => {
    if (!open || lastRole !== role) {
      open = true
      lastRole = role
      return `[${role}]\n`
    }
    return ''
  }

  for (const node of nodes) {
    const message = node.message
    if (message === null || message === undefined || message.content === undefined) continue
    if (message.role === 'assistant') {
      let header = ''
      for (const block of message.content) {
        if (block.type === 'text') {
          const text = sanitize(block.text ?? '')
          if (text.trim().length === 0) continue
          header = roleHeader('assistant')
          // pi-blackhole strips leading self-talk filler (hmm/wait/actually/…).
          const cleaned = options.stripSelfTalk === false ? text : stripSelfTalkPrefix(text)
          const kept = truncateTokens(cleaned, effective.textTokens, seqRef(node.seq))
          pushEntry(node.seq, header + kept.text, 'text')
          continue
        }
        if (block.type === 'reasoning') {
          if (options.includeReasoning !== true) {
            stats.reasoningElided += 1
            continue
          }
          const text = sanitize(block.text ?? '')
          if (text.trim().length === 0) continue
          header = roleHeader('assistant')
          const kept = truncateTokens(text, effective.textTokens, seqRef(node.seq))
          pushEntry(node.seq, header + kept.text, 'reasoning')
          continue
        }
        if (block.type === 'tool-call') {
          const name = block.name ?? 'unknown'
          stats.toolCalls += 1
          if (hiddenTools.has(name)) continue
          const resultSeq = resultSeqByCallId.get(block.id ?? '')
          const ref = resultSeq === undefined
            ? seqRef(node.seq)
            : `${seqRef(node.seq)} -> result ${resultSeq}`
          const bashCap = options.bashCap ?? 120
          if ((name === 'bash' || name === 'Bash') && bashCap > 0) {
            // pi-blackhole compresses bash tool calls semantically
            // (cd-strip, pipe-tail strip, length cap) but still renders them
            // as `* bash "cmd"` assistant one-liners — the `$ cmd` form only
            // applies to pi's standalone bashExecution role, which DSH has
            // no equivalent of.
            const parsed = parseToolArguments(block.arguments)
            const raw = parsed !== null && typeof parsed.command === 'string'
              ? parsed.command
              : (parsed !== null && typeof parsed.description === 'string' ? parsed.description : '')
            const cmd = compressBash(raw, bashCap)
            if (cmd.length === 0) continue
            header = roleHeader('assistant')
            pushEntry(node.seq, header + `* bash "${cmd}" (${ref})`, 'tool')
            continue
          }
          header = roleHeader('assistant')
          let oneLine: string
          if (argTools.size > 0 && !argTools.has(name)) {
            // Explicit extraction whitelist that does not list this tool:
            // name-only line (bookkeeping tools carry no semantic payload).
            oneLine = `* ${name}`
          } else {
            const parsed = parseToolArguments(block.arguments)
            const arg = pickToolKeyArg(name, parsed, options.toolKeyFields)
            oneLine = arg === undefined || arg.length === 0 ? `* ${name}` : `* ${name} "${clipArg(arg)}"`
          }
          const kept = truncateTokens(oneLine, effective.toolCallTokens, seqRef(node.seq))
          pushEntry(node.seq, header + `${kept.text} (${ref})`, 'tool')
          continue
        }
        if (block.type === 'image') {
          stats.images += 1
          header = roleHeader('assistant')
          pushEntry(node.seq, header + `${imageLabel(block)} (${seqRef(node.seq)})`, 'media')
          continue
        }
        if (block.type === 'document') {
          stats.documents += 1
          header = roleHeader('assistant')
          pushEntry(node.seq, header + `[document] (${seqRef(node.seq)})`, 'media')
          continue
        }
        // Unknown merge-extensible block types render as labels.
        header = roleHeader('assistant')
        pushEntry(node.seq, header + `[${String(block.type)}] (${seqRef(node.seq)})`, 'media')
      }
      /* reasoning-only and empty assistant messages produce no entry */
      continue
    }
    if (message.role === 'user') {
      const firstBlock = message.content[0]
      if (firstBlock !== undefined && firstBlock.type === 'tool-result') {
        // Tool results normally never occupy an entry: the content is either
        // absorbed into the following assistant text or one recall away via
        // the call line's `-> result N` pointer.  Failed results are the
        // exception — pi-blackhole keeps `[tool_error] name (#N)` with the
        // first line of the body so a failure reason survives the checkpoint.
        if (typeof firstBlock.toolCallId === 'string') {
          resultSeqByCallId.set(firstBlock.toolCallId, node.seq)
        }
        stats.toolResults += 1
        const errorChars = options.toolErrorChars ?? 150
        if (errorChars > 0 && firstBlock.isError === true) {
          const body = firstLineOf(projectToolResultText(message.content), errorChars)
          if (body.length > 0 && body !== '(no output)') {
            // Real DSH tool-result blocks carry no name; resolve it through
            // the correlated tool-call recorded in the pre-pass.
            const toolName = typeof firstBlock.toolCallId === 'string'
              ? (callNameByCallId.get(firstBlock.toolCallId) ?? 'tool')
              : 'tool'
            stats.toolErrors += 1
            pushEntry(
              node.seq,
              `[tool_error] ${toolName} (${seqRef(node.seq)})\n${body}`,
              'tool-error',
            )
            // A tool-error row interrupts the role stream: the next entry
            // re-opens its own segment header (pi-blackhole treats every
            // `[tool_error]` section as a fresh block).
            open = false
            lastRole = undefined
          }
        }
        continue
      }
      if (isCheckpointSource(message.source)) {
        stats.checkpoints += 1
        const text = projectToolResultText(message.content)
        if (text.length > 0) {
          // The checkpoint node is a user/message in the durable protocol
          // (surface replacement only allows message nodes), but it is
          // harness-generated framing — display it as [system].
          const header = roleHeader('system')
          pushEntry(node.seq, header + text, 'checkpoint')
        }
        continue
      }
      let surviving = 0
      let header = ''
      for (const block of message.content) {
        if (block.type === 'text') {
          let text = sanitize(block.text ?? '')
          if (options.stripNoiseXml !== false) text = stripNoiseXml(text, options.noisePatterns)
          // pi-blackhole collapses skill blocks to `[skill: name]`.
          if (options.collapseSkills !== false) text = collapseSkillText(text)
          if (text.length === 0) continue
          surviving += 1
          header = roleHeader('user')
          const kept = truncateTokens(text, effective.userTextTokens, seqRef(node.seq))
          pushEntry(node.seq, header + kept.text, 'text')
        } else if (block.type === 'image') {
          stats.images += 1
          surviving += 1
          header = roleHeader('user')
          pushEntry(node.seq, header + `${imageLabel(block)} (${seqRef(node.seq)})`, 'media')
        } else if (block.type === 'document') {
          stats.documents += 1
          surviving += 1
          header = roleHeader('user')
          pushEntry(node.seq, header + `[document] (${seqRef(node.seq)})`, 'media')
        } else {
          const text = sanitize(block.text ?? '')
          if (text.length === 0) continue
          surviving += 1
          header = roleHeader('user')
          const kept = truncateTokens(text, effective.userTextTokens, seqRef(node.seq))
          pushEntry(node.seq, header + kept.text, 'text')
        }
      }
      if (surviving === 0) {
        stats.noiseElided += 1
        pushEntry(
          node.seq,
          `${roleHeader('user')}* [user message elided: noise-only] (${seqRef(node.seq)})`,
          'note',
        )
      }
    }
  }

  // ── post-processing: per-turn tool cap + identical tool-line merge ──────
  // pi-blackhole keeps at most `toolsPerTurn` tool one-liners per assistant
  // turn (tail wins) and merges adjacent identical one-liners; both reduce
  // checkpoint rows before the global token cap runs.
  if (entries.length > 0) {
    const toolsPerTurn = options.toolsPerTurn ?? 8
    const merge = options.mergeToolLines !== false
    if (toolsPerTurn > 0 || merge) {
      // Split into role segments: an entry carrying a `[role]` header starts
      // a new segment.
      const segments: Array<{ role: string; items: InstantEntry[] }> = []
      let curRole = ''
      let items: InstantEntry[] = []
      for (const entry of entries) {
        const headerMatch = entry.text.match(/^\[(user|assistant|system)\]\n/)
        if (headerMatch !== null) {
          if (items.length > 0) segments.push({ role: curRole, items })
          curRole = headerMatch[1]
          items = []
        }
        items.push(entry)
      }
      if (items.length > 0) segments.push({ role: curRole, items })

      const processed: InstantEntry[] = []
      const TOOL_ROW_RE = /^(\[user\]\n|\[assistant\]\n|\[system\]\n)?(\* .*?) \((seq [^)]*)\)$/
      const MERGED_ROW_RE = /^(\[user\]\n|\[assistant\]\n|\[system\]\n)?(\* .*?) \((.+)\) x(\d+)$/
      for (const segment of segments) {
        // Per-turn tool cap (tool one-liners only; `$ cmd` bash lines and
        // tool-error rows do not count, mirroring pi-blackhole).
        if (segment.role === 'assistant' && toolsPerTurn > 0) {
          const toolIdxs: number[] = []
          segment.items.forEach((entry, index) => {
            if (entry.kind === 'tool' && /(^|\n)\* /.test(entry.text)) toolIdxs.push(index)
          })
          if (toolIdxs.length > toolsPerTurn) {
            const dropCount = toolIdxs.length - toolsPerTurn
            const dropSet = new Set(toolIdxs.slice(0, dropCount))
            const firstKept = toolIdxs[dropCount]
            const firstDropped = toolIdxs[0]
            // The dropped head may carry the segment's `[assistant]` header;
            // keep it on the omission note so the segment stays labeled.
            const droppedHeader = segment.items[firstDropped]?.text.match(/^(\[user\]\n|\[assistant\]\n|\[system\]\n)/)?.[1] ?? ''
            const next: InstantEntry[] = []
            let inserted = false
            for (let index = 0; index < segment.items.length; index++) {
              if (dropSet.has(index)) continue
              if (!inserted && index === firstKept) {
                next.push({
                  seq: segment.items[firstDropped]?.seq ?? -1,
                  text: `${droppedHeader}* (${dropCount} earlier tool-call entries omitted)`,
                  kind: 'note',
                })
                inserted = true
              }
              next.push(segment.items[index])
            }
            segment.items = next
            stats.elidedToolRows += dropCount
            stats.elidedRows += dropCount
          }
        }
        // Merge adjacent identical tool one-liners into `... (seq A, seq B) xN`.
        if (merge) {
          const merged: InstantEntry[] = []
          for (const entry of segment.items) {
            if (entry.kind !== 'tool') {
              merged.push(entry)
              continue
            }
            const m = entry.text.match(TOOL_ROW_RE)
            if (m === null) {
              merged.push(entry)
              continue
            }
            const base = m[2]
            const ref = m[3]
            const last = merged[merged.length - 1]
            const acc = last !== undefined && last.kind === 'tool'
              ? last.text.match(MERGED_ROW_RE)
              : null
            const lastRow = last !== undefined && last.kind === 'tool'
              ? last.text.match(TOOL_ROW_RE)
              : null
            if (acc !== null && acc[2] === base) {
              const plainRef = ref.split(' -> ')[0]
              merged[merged.length - 1] = {
                seq: last.seq,
                text: `${acc[1] ?? ''}${base} (${acc[3]}, ${plainRef}) x${parseInt(acc[4], 10) + 1}`,
                kind: 'tool',
              }
            } else if (lastRow !== null && lastRow[2] === base) {
              // First merge: two plain identical rows become `... (r1, r2) x2`.
              const plainRef = ref.split(' -> ')[0]
              const lastRef = lastRow[3].split(' -> ')[0]
              merged[merged.length - 1] = {
                seq: last.seq,
                text: `${lastRow[1] ?? ''}${base} (${lastRef}, ${plainRef}) x2`,
                kind: 'tool',
              }
            } else {
              merged.push(entry)
            }
          }
          segment.items = merged
        }
        processed.push(...segment.items)
      }
      entries.length = 0
      entries.push(...processed)
      // Recompute estimates so the cap below operates on the merged rows.
      estimated.clear()
      let total = 0
      for (const entry of entries) {
        const tokens = estimateEntryTokens(entry.text)
        estimated.set(entry, tokens)
        total += tokens
      }
      stats.entries = entries.length
      stats.tokens = total
    }
  }

  // ── cap enforcement ────────────────────────────────────────────────────
  // Drop the oldest tool/media/note rows first, then the oldest
  // text/reasoning rows; the newest content always survives. A note entry
  // records what was elided (with the seq range) so the loss stays explicit.
  let total = stats.tokens
  let capped = false
  if (total > maxTokens && entries.length > 0) {
    capped = true
    const priority = (kind: InstantEntryKind): number =>
      kind === 'tool' || kind === 'media' || kind === 'note' ? 0 : 1
    const order = entries
      .map((entry, index) => ({ entry, index }))
      .sort((a, b) => priority(a.entry.kind) - priority(b.entry.kind) || a.index - b.index)
    const removed: InstantEntry[] = []
    while (total > maxTokens && order.length > 1) {
      const next = order.shift()
      if (next === undefined) break
      const entry = next.entry
      total -= estimated.get(entry) ?? 0
      removed.push(entry)
      if (entry.kind === 'tool') stats.elidedToolRows += 1
      stats.elidedRows += 1
    }
    // `removed` is a real deletion, not just a reporting list.  Keep the
    // returned entries, stats.entries, and stats.tokens consistent with the
    // actual checkpoint text; otherwise callers receive capped=true while the
    // supposedly elided rows are still emitted.
    if (removed.length > 0) {
      const removedSet = new Set(removed)
      const retained = entries.filter((entry) => !removedSet.has(entry))
      entries.length = 0
      entries.push(...retained)
      stats.entries = entries.length
    }
    // The note itself costs tokens, so it is only added when the cap still
    // has room (and never itself elided).
    if (removed.length > 0 && (total + 24) <= maxTokens && entries.length > 0) {
      const seqs = removed
        .map((entry) => entry.seq)
        .filter((seq) => seq >= 0)
        .sort((a, b) => a - b)
      const span = seqs.length === 0 ? '' : seqs[0] === seqs[seqs.length - 1]
        ? `seq ${seqs[0]}`
        : `seqs ${seqs[0]}-${seqs[seqs.length - 1]}`
      const kindLabel = stats.elidedToolRows > 0 ? 'tool/result' : 'earlier'
      const noteText = removed.length === 1
        ? `[1 ${kindLabel} entry elided: ${span}]`
        : `[${removed.length} ${kindLabel} entries elided: ${span}]`
      const tokens = estimateEntryTokens(noteText)
      entries.unshift({ seq: -1, text: noteText, kind: 'note' })
      stats.entries = entries.length
      stats.tokens = total + tokens
    } else {
      stats.tokens = total
    }
  }

  return { entries, stats, capped }
}

/** Join compiled entries into the checkpoint text (blank-line separated). */
export function joinInstantEntries(entries: readonly InstantEntry[]): string {
  return entries.map((entry) => entry.text).join('\n')
}

/** Rough token estimate of a message list (chars/4 + envelope). */
export function estimateMessagesTokens(messages: readonly RawMessage[]): number {
  return estimateMessagesTokensImpl(messages)
}
