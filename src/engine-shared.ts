/**
 * Shared plumbing between the two engines of this package: the legacy
 * Responses-only engine and the hybrid routing engine. Extracted so both
 * subclass `BasicCompactionEngine` with identical target resolution,
 * endpoint matching, state handling, and the native LLM fallback.
 *
 * @module dsh-blackhole/engine-shared
 */

import { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { BlockAssembler, LlmError, contentHasImage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, LlmCallConfig, Message, TokenUsage, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'

/**
 * Structural mirror of the summarizer hook's contracts. The official package
 * does not deep-export them; the shapes are stable within the seam.
 */
export interface SummarizationInput {
  /** The conversation's own system prompt; absent for a system-less request. */
  readonly system?: string
  /** The conversation's tool schemas; absent when the request carried none. */
  readonly tools?: readonly ToolSchema[]
  /** The shadowed region, in surface order, that precedes the compaction instruction. */
  readonly messages: readonly Message[]
}

/** Safe summary content plus the exact auxiliary call envelope recorded with it. */
export type SummaryResult = {
  summary: ContentBlock[]
  provider: string
  model: string
  maxTokens?: number
  usage?: TokenUsage
} & (
  | {
    /** Complete provider output before the backend's safe summary projection. */
    rawOutput: ContentBlock[]
    /** Identifies exactly one call through this context's `ctx.llm.stream()`. */
    llmStreamCall: true
  }
  | {
    /** Optional complete output from an unmarked template, remote, or other summarizer. */
    rawOutput?: ContentBlock[]
    /** An unmarked summary does not identify a call through this context's LLM seam. */
    llmStreamCall?: never
  }
)

/** Resolve the exact provider/model durably routed for the latest request. */
export function conversationTarget(
  agent: Agent,
): Pick<LlmCallConfig, 'provider' | 'model'> | undefined {
  const config = agent.session.requestHeader()?.config
  if (config !== undefined && config.provider.length > 0 && config.model.length > 0) {
    return { provider: config.provider, model: config.model }
  }
  if (agent.options.provider !== undefined && agent.options.provider.length > 0
    && agent.options.model !== undefined && agent.options.model.length > 0) {
    return { provider: agent.options.provider, model: agent.options.model }
  }
  return undefined
}

/** Minimal glob matcher supporting `*` and `?` (and plain equality). */
export function globMatch(pattern: string, value: string): boolean {
  if (pattern === '*' || pattern === value) return true
  const regex = new RegExp(
    `^${pattern.split('*').map((part) => part.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('.*')}$`
      .replace(/\?/g, '.'),
  )
  return regex.test(value)
}

export function defaultStateDir(): string {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(home, 'plugins', 'dsh-blackhole', 'state')
}

/**
 * The persisted random installation id sent as `x-codex-installation-id`,
 * mirroring the upstream port's identity behavior without ever touching the
 * real Codex home (~/.codex). Resolved lazily, so a read-only stateDir just
 * omits the header.
 */
export function resolveInstallationId(stateDir: string): string | undefined {
  const file = join(stateDir, '..', 'installation_id')
  try {
    if (existsSync(file)) {
      const existing = readFileSync(file, 'utf8').trim()
      if (/^[0-9a-fA-F-]{36}$/.test(existing)) return existing.toLowerCase()
    }
    const installationId = randomUUID()
    try {
      writeFileSync(file, installationId)
    } catch {
      // Header is a parity hint, not a reason to fail compaction.
    }
    return installationId
  } catch {
    return undefined
  }
}

/**
 * The compaction instruction appended to the LLM fallback call. A short,
 * self-authored prompt (the official backend replays its own instruction
 * array; this package keeps one compact version for the fallback branch).
 */
export const COMPACTION_INSTRUCTION = [
  'Compress the conversation above into a durable checkpoint for a later request.',
  'Keep every fact, path, command, decision, and unresolved issue that the next',
  'request may need. Preserve exact identifiers (paths, package names, keys,',
  'error codes) verbatim — never paraphrase or guess them. Use concise prose',
  'with short bullet lists. Do not invent anything that is not in the',
  'conversation. End with a "Pending" section listing unfinished work.',
].join(' ')

/** Map a terminal LLM finish to its fail-closed error (basic's finishError). */
function finishError(finish: { kind: string; failure?: { message: string; code?: string } }): Error | undefined {
  switch (finish.kind) {
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure?.message ?? 'stream failed')
      if (finish.failure?.code !== undefined) (error as Error & { code?: string }).code = finish.failure.code
      return error
    }
    case 'max-tokens': {
      const error = new Error('summarization truncated at the token cap (incomplete checkpoint)')
      ;(error as Error & { code?: string }).code = 'MAX_TOKENS'
      return error
    }
    default: return undefined
  }
}

/** Reject visual output and keep only text before synthesizing a user message. */
function summaryText(blocks: ContentBlock[]): ContentBlock[] {
  if (contentHasImage(blocks)) {
    throw new LlmError('compaction summary cannot contain image output', 'UNSUPPORTED_CONTENT')
  }
  return blocks.filter((block) => block.type === 'text')
}

/** Native one-shot LLM summarization, mirroring basic's summarizeWithLlm. */
export async function summarizeWithLlm(
  ctx: Context,
  config: {
    summarizationProvider?: string
    summarizationModel?: string
    maxTokens?: number
  },
  input: SummarizationInput,
  agent: Agent,
  signal?: AbortSignal,
): Promise<SummaryResult> {
  const latest = agent.session.requestHeader()?.config
  const configured = config.summarizationProvider !== undefined && config.summarizationProvider.length > 0
    ? { provider: config.summarizationProvider, model: config.summarizationModel ?? '' }
    : undefined
  const agentTarget = agent.options.provider !== undefined && agent.options.provider.length > 0
    && agent.options.model !== undefined && agent.options.model.length > 0
    ? { provider: agent.options.provider, model: agent.options.model }
    : undefined
  const target = configured ?? latest ?? agentTarget
  if (target === undefined || target.model.length === 0) {
    throw new Error(
      'no provider/model available for LLM summarization: set the summarization ' +
      'fields, route one request, or set both AgentOptions fields',
    )
  }

  const assembler = new BlockAssembler()
  const messages = [...input.messages, createUserMessage({
    content: [{ type: 'text', text: COMPACTION_INSTRUCTION }],
    // Source kinds are merge-extensible — each producer registers its own via
    // module augmentation. This label is request-only (never appended to the
    // durable log), so keep the official backend's free-form `plugin` shape,
    // narrowed through unknown for the stricter rc.2 type union.
    source: { kind: 'plugin', plugin: 'dsh-blackhole' } as unknown as Message['source'],
  })]
  const options = {
    provider: target.provider,
    model: target.model,
    messages,
    ...(input.system === undefined ? {} : { system: input.system }),
    ...(input.tools === undefined ? {} : { tools: [...input.tools] }),
    maxTokens: config.maxTokens ?? 8192,
    sessionId: agent.session.id,
    purpose: 'compaction' as const,
    ...(signal === undefined ? {} : { signal }),
  }
  for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
  const error = finishError(assembler.finish)
  if (error !== undefined) throw error
  const rawOutput = assembler.blocks()
  const summary = summaryText(rawOutput)
  if (!summary.some((block) => block.type === 'text' && block.text.trim().length > 0)) {
    throw new Error('summarization produced no text summary content')
  }
  return {
    summary,
    rawOutput,
    llmStreamCall: true,
    provider: options.provider,
    model: options.model,
    maxTokens: options.maxTokens,
    ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
  }
}