/**
 * Codex-style remote compaction through the OpenAI Responses API.
 *
 * Puts the DSH summarization hook on the server side: the replayed
 * conversation is converted into Responses input items, a `compaction_trigger`
 * is appended, and the compaction response streams back from the normal
 * `{base}/responses` endpoint. The assistant-authored summary text from that
 * response becomes the readable checkpoint DSH lands in the session, and the
 * opaque replacement history is returned for durable persistence (the bridge
 * to provider-native replay).
 *
 * Protocol and retention logic derived from algal/pi-openai-server-compaction
 * (MIT) — see LICENSE.
 *
 * @module dsh-blackhole/responses-v2
 */

import type { ContentBlock, Message, TokenUsage, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { ResolvedResponsesEndpoint } from './config.ts'

/** Content items inside Responses message items. */
export type ResponseContentItem =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string }
  | { type: 'output_text'; text: string }

/** One Responses input/output item (the subset compaction needs). */
export type ResponseItem =
  | {
      type: 'message'
      role: string
      content: ResponseContentItem[]
      end_turn?: boolean
      phase?: string
    }
  | {
      type: 'reasoning'
      summary: Array<{ type: 'summary_text'; text: string }>
      encrypted_content: string | null
    }
  | { type: 'function_call'; name: string; arguments: string; call_id: string }
  | { type: 'function_call_output'; call_id: string; output: string | unknown[] }
  | { type: 'compaction'; encrypted_content: string }
  | { type: 'compaction_trigger' }
  | { type: string; [key: string]: unknown }

/** The portion of the compaction response that matters to DSH. */
export interface RemoteCompactionV2Result {
  /** Readable summary text written by the model during compaction. */
  summaryText: string
  /** The opaque replacement history: retained tail user messages + compaction item. */
  replacementHistory: ResponseItem[]
  /** Provider-reported usage, mapped onto DSH's TokenUsage shape. */
  usage?: TokenUsage
  /** Versioned provider-private details for the next same-model request. */
  details: RemoteCompactionDetails
}

/** Portable checkpoint text for the official compaction-only response shape. */
export function buildRemoteCompactionSummaryText(params: {
  provider: string
  model: string
  endpoint: string
}): string {
  return `Remote Responses compaction applied for ${params.provider}/${params.model} via ${params.endpoint}. ` +
    'Provider-native replacement history is retained for compatible future requests; use recall for omitted details.'
}

/**
 * Durable, adapter-owned replay facts.  The readable summary remains in the
 * DSH checkpoint; this record is only for a compatible Responses adapter.
 */
export interface RemoteCompactionDetails {
  readonly version: 2
  readonly provider: 'openai-responses-compaction'
  readonly implementation: 'responses_compaction_v2'
  readonly modelKey: string
  readonly replacementHistory: ResponseItem[]
  readonly usage?: TokenUsage
}

export function remoteCompactionModelKey(provider: string, model: string): string {
  return `${provider}:openai-responses:${model}`
}

/** Build a detached, versioned detail record after protocol validation. */
export function buildRemoteCompactionDetails(params: {
  provider: string
  model: string
  replacementHistory: ResponseItem[]
  usage?: TokenUsage
}): RemoteCompactionDetails {
  return {
    version: 2,
    provider: 'openai-responses-compaction',
    implementation: 'responses_compaction_v2',
    modelKey: remoteCompactionModelKey(params.provider, params.model),
    replacementHistory: params.replacementHistory.map((item) => ({ ...item })),
    ...(params.usage === undefined ? {} : { usage: { ...params.usage } }),
  }
}

function isTokenUsage(value: unknown): value is TokenUsage {
  if (!isRecord(value)) return false
  return typeof value.inputTokens === 'number' && Number.isFinite(value.inputTokens) &&
    typeof value.outputTokens === 'number' && Number.isFinite(value.outputTokens)
}

/** Fail-closed runtime validation for details loaded from durable storage. */
export function parseRemoteCompactionDetails(value: unknown): RemoteCompactionDetails | undefined {
  if (!isRecord(value) || value.version !== 2 || value.provider !== 'openai-responses-compaction' ||
    value.implementation !== 'responses_compaction_v2' || typeof value.modelKey !== 'string' ||
    value.modelKey.length === 0 || !Array.isArray(value.replacementHistory) || value.replacementHistory.length === 0) {
    return undefined
  }
  if (!value.replacementHistory.every(isReplayableResponseItem)) return undefined
  if (value.usage !== undefined && !isTokenUsage(value.usage)) return undefined
  return {
    version: 2,
    provider: 'openai-responses-compaction',
    implementation: 'responses_compaction_v2',
    modelKey: value.modelKey,
    replacementHistory: value.replacementHistory.map((item) => ({ ...item })),
    ...(value.usage === undefined ? {} : { usage: value.usage }),
  }
}

const IMAGE_CONTENT_OMITTED_PLACEHOLDER =
  'image content omitted because the durable image bytes are not available to the remote compaction request'

/** Approximate token cost of a message item (chars / 4), like Codex's heuristic. */
function approximateMessageTokens(item: ResponseItem): number {
  if (item.type !== 'message' || !Array.isArray(item.content)) return 0
  const text = item.content
    .filter((c): c is { type: 'input_text' | 'output_text'; text: string } =>
      c.type === 'input_text' || c.type === 'output_text')
    .map((c) => c.text)
    .join('')
  return Math.max(1, Math.ceil(text.length / 4))
}

function truncateMessageToTokenBudget(item: ResponseItem, maxTokens: number): ResponseItem | undefined {
  if (item.type !== 'message' || !Array.isArray(item.content)) return { ...item }
  let remainingCharacters = Math.max(0, maxTokens * 4)
  const content = item.content.flatMap((part) => {
    // Images are exempt from the character budget, like the upstream port.
    if (part.type === 'input_image') return [part]
    if (remainingCharacters === 0) return []
    const text = (part.text ?? '').slice(0, remainingCharacters)
    remainingCharacters -= text.length
    return text ? [{ ...part, text }] : []
  })
  return content.length > 0 ? { ...item, content } : undefined
}

/**
 * Keep the newest realization of the conversation verbatim up to a token
 * budget and append the opaque compaction item — the Codex-style replacement
 * history used for later provider-native replay.
 */
export function buildReplacementHistory(
  input: ResponseItem[],
  compactionItem: ResponseItem,
  retainedMessageTokenBudget: number,
): ResponseItem[] {
  if (compactionItem.type !== 'compaction') {
    throw new Error('OpenAI remote compaction v2 did not return a compaction item.')
  }
  // Non-empty user messages only, newest realization wins — same retention
  // rule as the upstream port.
  const retainedUserMessages = input.filter(
    (item) => item.type === 'message' && item.role === 'user' && isRealUserMessage(item),
  )
  let remainingTokens = retainedMessageTokenBudget
  const retainedReversed: ResponseItem[] = []
  for (const item of [...retainedUserMessages].reverse()) {
    if (remainingTokens <= 0) break
    const tokenCount = approximateMessageTokens(item)
    if (tokenCount <= remainingTokens) {
      retainedReversed.push(item)
      remainingTokens -= tokenCount
      continue
    }
    const truncated = truncateMessageToTokenBudget(item, remainingTokens)
    if (truncated) retainedReversed.push(truncated)
    remainingTokens = 0
  }
  return [...retainedReversed.reverse(), { ...compactionItem }]
}

/** Convert one DSH message into Responses input items. */
export function dshMessageToResponseItems(message: Message): ResponseItem[] {
  const items: ResponseItem[] = []

  if (message.role === 'user' || message.role === 'system') {
    const contentItems: ResponseContentItem[] = []
    const toolOutputs: ResponseItem[] = []
    for (const block of message.content) {
      switch (block.type) {
        case 'text':
          contentItems.push({ type: 'input_text', text: block.text })
          break
        case 'image':
          // DSH stores image bytes in the attachment store; a compaction call
          // cannot resolve them here, so the visit is recorded as text.
          contentItems.push({ type: 'input_text', text: IMAGE_CONTENT_OMITTED_PLACEHOLDER })
          break
        case 'tool-result':
          toolOutputs.push({
            type: 'function_call_output',
            call_id: String(block.toolCallId).split('|', 1)[0],
            output: toolResultBlockToOutput(block.content),
          })
          break
        default:
          break
      }
    }
    if (contentItems.length > 0) {
      items.push({ type: 'message', role: 'user', content: contentItems })
    }
    items.push(...toolOutputs)
    return items
  }

  if (message.role === 'assistant') {
    const textBlocks: string[] = []
    const flushText = () => {
      if (textBlocks.length === 0) return
      items.push({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: textBlocks.join('') }],
      })
      textBlocks.length = 0
    }
    for (const block of message.content) {
      switch (block.type) {
        case 'text':
          textBlocks.push(block.text)
          break
        case 'reasoning':
          flushText()
          items.push({
            type: 'reasoning',
            summary: [{ type: 'summary_text', text: block.text }],
            encrypted_content: null,
          })
          break
        case 'tool-call':
          flushText()
          items.push({
            type: 'function_call',
            name: block.name,
            call_id: String(block.id).split('|', 1)[0],
            arguments: typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {}),
          })
          break
        default:
          break
      }
    }
    flushText()
    return items
  }

  return items
}

function toolResultBlockToOutput(content: readonly ContentBlock[]): string {
  return content
    .map((block) => {
      if (block.type === 'text') return block.text
      if (block.type === 'image') return '[image]'
      return `[${String(block.type)}]`
    })
    .filter(Boolean)
    .join('\n')
    .trim()
}

function isRealUserMessage(item: ResponseItem): boolean {
  if (item.type !== 'message' || item.role !== 'user') return false
  if (typeof item.content === 'string') return item.content.trim().length > 0
  return Array.isArray(item.content) && item.content.length > 0
}
export function dshMessagesToResponseItems(messages: readonly Message[]): ResponseItem[] {
  return messages.flatMap((message) => dshMessageToResponseItems(message))
}

/**
 * Rebuild the explicit Responses history for one compatible target.  The
 * trailing surface is grouped by completed assistant turns exactly like the
 * upstream port: pending user/tool items are retained only when the matching
 * assistant response is present, and foreign-model assistant turns are
 * discarded so provider-private signatures cannot cross model ownership.
 */
export function reconstructRemoteCompactionHistory(params: {
  details: RemoteCompactionDetails
  provider: string
  model: string
  trailingMessages: readonly Message[]
  /** Include a final incomplete user/tool turn for an ordinary request. */
  includePending?: boolean
}): ResponseItem[] | undefined {
  if (params.details.modelKey !== remoteCompactionModelKey(params.provider, params.model)) return undefined
  const trailing: ResponseItem[] = []
  let pending: ResponseItem[] = []
  for (const message of params.trailingMessages) {
    if (message.source.kind === 'plugin' && message.source.plugin === 'compact') continue
    const items = dshMessageToResponseItems(message)
    if (items.length === 0) continue
    if (message.role === 'assistant') {
      const source = message.source.kind === 'model' ? message.source : undefined
      if (source?.provider === params.provider && source.model === params.model) {
        trailing.push(...pending, ...items)
      }
      pending = []
      continue
    }
    pending.push(...items)
  }
  if (params.includePending === true) trailing.push(...pending)
  return [...params.details.replacementHistory.map((item) => ({ ...item })), ...trailing]
}

/** Port DSH tool schemas into Responses function tools. */
export function toolSchemasToResponseTools(tools: readonly ToolSchema[]): Record<string, unknown>[] {
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }))
}

/** The compaction v2 request body: input + `compaction_trigger`, streaming. */
export function buildCompactionRequestBody(params: {
  model: string
  input: ResponseItem[]
  instructions?: string
  tools: Record<string, unknown>[]
  sessionId?: string
}): Record<string, unknown> {
  return {
    model: params.model,
    input: [...params.input, { type: 'compaction_trigger' }],
    ...(params.instructions ? { instructions: params.instructions } : {}),
    tools: params.tools,
    parallel_tool_calls: true,
    tool_choice: 'auto',
    stream: true,
    store: false,
    include: ['reasoning.encrypted_content'],
    ...(params.sessionId ? { prompt_cache_key: params.sessionId } : {}),
  }
}

export function parseSseData(text: string): unknown[] {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n\n')
    .flatMap((block) => {
      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
        .trim()
      if (!data || data === '[DONE]') return []
      try {
        return [JSON.parse(data) as unknown]
      } catch {
        return []
      }
    })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isResponseItem(value: unknown): value is ResponseItem {
  return isRecord(value) && typeof value.type === 'string'
}

/** The only item forms this package can safely send back during replay. */
function isReplayableResponseItem(value: unknown): value is ResponseItem {
  if (!isRecord(value)) return false
  if (value.type === 'compaction') return typeof value.encrypted_content === 'string'
  if (value.type !== 'message' || typeof value.role !== 'string' || !Array.isArray(value.content)) return false
  return value.content.every((content) => {
    if (!isRecord(content) || typeof content.type !== 'string') return false
    if (content.type === 'input_image') return typeof content.image_url === 'string'
    return (content.type === 'input_text' || content.type === 'output_text') && typeof content.text === 'string'
  })
}

interface ParsedCompactionStream {
  compactionItem?: ResponseItem
  /** Assistant output text accumulated across the whole compaction response. */
  summaryText: string
  usage?: unknown
}

/** Parse the SSE stream; extract the compaction item, usage, and summary text. */
export function parseCompactionV2Events(events: unknown[]): ParsedCompactionStream {
  let completed = false
  let usage: unknown
  const compactionItems: ResponseItem[] = []
  const itemSummaryChunks: string[] = []
  const outputTextDoneChunks: string[] = []
  const outputTextDeltaChunks: string[] = []

  for (const event of events) {
    if (!isRecord(event)) continue
    if (event.type === 'error') {
      const message = typeof event.message === 'string' ? event.message : 'Unknown Responses API error'
      throw new Error(`OpenAI remote compaction v2 failed: ${message}`)
    }
    if (event.type === 'response.failed') {
      const response = isRecord(event.response) ? event.response : undefined
      const error = response && isRecord(response.error) ? response.error : undefined
      const message = typeof error?.message === 'string' ? error.message : 'Response failed'
      throw new Error(`OpenAI remote compaction v2 failed: ${message}`)
    }
    if (event.type === 'response.output_item.done' && isResponseItem(event.item)) {
      if (event.item.type === 'compaction') {
        compactionItems.push(event.item)
        continue
      }
      if (event.item.type === 'message' && event.item.role === 'assistant' &&
        Array.isArray(event.item.content)) {
        for (const content of event.item.content) {
          if (content.type === 'output_text') itemSummaryChunks.push(content.text)
        }
      }
      continue
    }
    if (event.type === 'response.output_text.done' && typeof event.text === 'string') {
      outputTextDoneChunks.push(event.text)
      continue
    }
    if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
      outputTextDeltaChunks.push(event.delta)
      continue
    }
    if (event.type === 'response.completed') {
      completed = true
      const response = isRecord(event.response) ? event.response : undefined
      usage = response?.usage
    }
  }

  if (!completed) {
    throw new Error('OpenAI remote compaction v2 stream ended before response.completed.')
  }
  if (compactionItems.length !== 1) {
    throw new Error(
      `OpenAI remote compaction v2 expected exactly one compaction item, got ${compactionItems.length}.`,
    )
  }
  return {
    compactionItem: compactionItems[0],
    // Responses streams may expose the same text through both the completed
    // output item and `response.output_text.done`. Prefer the item payload and
    // use the latter only for providers that omit the item content; otherwise
    // a valid summary becomes `HelloHello`.
    summaryText: (itemSummaryChunks.length > 0
      ? itemSummaryChunks
      : outputTextDoneChunks.length > 0 ? outputTextDoneChunks : outputTextDeltaChunks).join('').trim(),
    usage,
  }
}

/** Map an OpenAI usage snapshot onto DSH's TokenUsage. */
export function mapCompactionUsage(value: unknown): TokenUsage | undefined {
  if (!isRecord(value)) return undefined
  const inputTokens = typeof value.input_tokens === 'number' && Number.isFinite(value.input_tokens)
    ? value.input_tokens
    : 0
  const outputTokens = typeof value.output_tokens === 'number' && Number.isFinite(value.output_tokens)
    ? value.output_tokens
    : 0
  if (inputTokens === 0 && outputTokens === 0) return undefined
  const details = isRecord(value.input_tokens_details) ? value.input_tokens_details : undefined
  const cachedTokens = typeof details?.cached_tokens === 'number' && Number.isFinite(details.cached_tokens)
    ? details.cached_tokens
    : 0
  const cacheWriteTokens = typeof details?.cache_creation_tokens === 'number' && Number.isFinite(details.cache_creation_tokens)
    ? details.cache_creation_tokens
    : (typeof details?.cache_write_tokens === 'number' && Number.isFinite(details.cache_write_tokens)
      ? details.cache_write_tokens
      : 0)
  return {
    inputTokens: Math.max(0, inputTokens - cachedTokens - cacheWriteTokens),
    outputTokens,
    ...(cachedTokens > 0 ? { cacheReadTokens: cachedTokens } : {}),
    ...(cacheWriteTokens > 0 ? { cacheWriteTokens } : {}),
  }
}

/**
 * Run Responses compaction v2 against one endpoint.
 *
 * @throws on transport or protocol failure — callers fall back to the native
 * summarizer.
 */
export async function callResponsesCompactionV2(params: {
  endpoint: ResolvedResponsesEndpoint
  apiKey: string
  /** DSH provider route that owns the target model. */
  provider?: string
  model: string
  input: ResponseItem[]
  instructions?: string
  tools: Record<string, unknown>[]
  sessionId?: string
  signal?: AbortSignal
  timeoutMs: number
  retainedMessageTokenBudget: number
  /** Codex installation id; sent as `x-codex-installation-id` (+ window/session headers) when provided. */
  installationId?: string
}): Promise<RemoteCompactionV2Result> {
  const { endpoint, apiKey, provider, model, input, instructions, tools, sessionId, signal, timeoutMs, retainedMessageTokenBudget, installationId } = params
  const baseUrl = endpoint.baseUrl.replace(/\/+$/, '')
  const url = baseUrl.endsWith('/responses') ? baseUrl : `${baseUrl}/responses`

  const timeoutSignal = timeoutMs > 0
    ? AbortSignal.timeout(timeoutMs)
    : undefined
  const requestSignal = signal !== undefined && timeoutSignal !== undefined
    ? AbortSignal.any([signal, timeoutSignal])
    : (signal ?? timeoutSignal)

  // The upstream port sends x-codex-beta-features on EVERY remote compaction
  // request, merging any endpoint-provided feature list; identity headers are
  // separate and opt-out-able.
  const userHeaders = { ...endpoint.headers }
  const betaKey = Object.keys(userHeaders).find((key) => key.toLowerCase() === 'x-codex-beta-features')
  const userBeta = betaKey !== undefined
    ? String(userHeaders[betaKey]).split(',').map((f) => f.trim()).filter(Boolean)
    : []
  if (betaKey !== undefined) delete userHeaders[betaKey]
  const betaFeatures = [...new Set([...userBeta, 'remote_compaction_v2'])].join(',')

  const identityHeaders = endpoint.sendIdentityHeaders && installationId
    ? {
      'x-codex-installation-id': installationId,
      ...(sessionId !== undefined
        ? { 'x-codex-window-id': `${sessionId}:0`, session_id: sessionId }
        : {}),
    }
    : {}

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...identityHeaders,
      ...userHeaders,
      'x-codex-beta-features': betaFeatures,
    },
    body: JSON.stringify(buildCompactionRequestBody({ model, input, instructions, tools, sessionId })),
    signal: requestSignal,
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Responses compaction v2 failed (${response.status}): ${text || response.statusText}`)
  }

  const responseText = await response.text()
  const parsed = parseCompactionV2Events(parseSseData(responseText))
  if (parsed.compactionItem === undefined) {
    throw new Error('Responses compaction v2 returned no compaction item.')
  }

  const replacementHistory = buildReplacementHistory(input, parsed.compactionItem, retainedMessageTokenBudget)
  return {
    summaryText: parsed.summaryText,
    replacementHistory,
    usage: mapCompactionUsage(parsed.usage),
    details: buildRemoteCompactionDetails({
      provider: provider ?? endpoint.provider,
      model,
      replacementHistory,
      usage: mapCompactionUsage(parsed.usage),
    }),
  }
}
