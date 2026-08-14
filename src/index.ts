/**
 * dsh-compaction-responses: a Codex-style remote compaction backend for
 * DeepSeek Harness.
 *
 * The engine subclasses the official `BasicCompactionEngine`, inheriting the
 * whole pressure/retention/replay machinery and the token-meter pricing, and
 * overrides the single customization hook (`summarize`). When the routed
 * provider has a configured Responses endpoint, the summary is produced by the
 * model server via Responses compaction v2 (the same protocol Codex's remote
 * compaction uses) and the opaque replacement history is persisted per
 * session. Any failure — no endpoint, missing key, timeout, protocol error —
 * falls back to the inherited native one-shot LLM summarizer, so a broken
 * gateway never breaks compaction.
 *
 * @module dsh-compaction-responses
 */

import { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import type { ContentBlock, LlmCallConfig, Message, TokenUsage, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CompactionResponsesConfigSchema, resolveEndpoints, responsesEndpointUrl } from './config.ts'
import type { CompactionResponsesConfig, ResolvedResponsesEndpoint } from './config.ts'
import { RemoteCompactionStateStore } from './remote-state.ts'
import type { RemoteCompactionStateEntry } from './remote-state.ts'
import { callResponsesCompactionV2, dshMessagesToResponseItems, toolSchemasToResponseTools } from './responses-v2.ts'
import type { ResponseItem } from './responses-v2.ts'

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

export { CompactionResponsesConfigSchema }
export type { CompactionResponsesConfig, ResolvedResponsesEndpoint }
export { RemoteCompactionStateStore }
export type { RemoteCompactionStateEntry }
export { responsesEndpointUrl }
export type { ResponseItem }
// Protocol layer, re-exported for downstream consumers (replay tooling, tests).
export {
  buildCompactionRequestBody,
  buildReplacementHistory,
  callResponsesCompactionV2,
  dshMessageToResponseItems,
  dshMessagesToResponseItems,
  mapCompactionUsage,
  parseCompactionV2Events,
  parseSseData,
  toolSchemasToResponseTools,
} from './responses-v2.ts'
export type {
  RemoteCompactionV2Result,
  ResponseContentItem,
} from './responses-v2.ts'

/** Resolve the exact provider/model durably routed for the latest request. */
function conversationTarget(
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
function globMatch(pattern: string, value: string): boolean {
  if (pattern === '*' || pattern === value) return true
  const regex = new RegExp(
    `^${pattern.split('*').map((part) => part.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('.*')}$`
      .replace(/\?/g, '.'),
  )
  return regex.test(value)
}

function defaultStateDir(): string {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(home, 'plugins', 'dsh-compaction-responses', 'state')
}

/**
 * The persisted random installation id sent as `x-codex-installation-id`,
 * mirroring the upstream port's identity behavior without ever touching the
 * real Codex home (~/.codex). Resolved lazily, so a read-only stateDir just
 * omits the header.
 */
function resolveInstallationId(stateDir: string): string | undefined {
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
 * The Responses-assisted compaction engine.
 *
 * Same service identity as the official backend (`compaction`); the bundle
 * patch re-points the `compaction-basic` row at this package, so the loader
 * mounts exactly one engine.
 */
export class ResponsesCompactionEngine extends BasicCompactionEngine {
  static inject = ['llm', 'tokenMeter', 'sessions']

  static Config = CompactionResponsesConfigSchema

  /** Validated endpoint registry. */
  readonly endpoints: ResolvedResponsesEndpoint[]
  /** Optional per-session artifact store. */
  readonly state: RemoteCompactionStateStore | undefined
  /** The plugin's own validated config (base fields live in `this.config`). */
  private readonly options: CompactionResponsesConfig
  /** Persisted Codex-style installation id, resolved lazily. */
  private installationId: string | undefined

  constructor(ctx: Context, config: CompactionResponsesConfig = {}) {
    // The inherited resolveConfig() rejects unknown keys, so hand it only the
    // base policy fields and keep the plugin's own knobs aside.
    const {
      endpoints, timeoutMs, fallbackToLlm, stateDir, persistRemoteHistory,
      retainedMessageTokenBudget, ...baseConfig
    } = config
    super(ctx, baseConfig)
    this.options = config
    this.endpoints = resolveEndpoints(endpoints)
    const resolvedStateDir = persistRemoteHistory !== false
      ? (stateDir?.trim() || defaultStateDir())
      : undefined
    this.state = resolvedStateDir !== undefined
      ? new RemoteCompactionStateStore(resolvedStateDir)
      : undefined
    this.installationId = config.installationId !== undefined
      ? (config.installationId.trim() || undefined)
      : (resolvedStateDir !== undefined ? resolveInstallationId(resolvedStateDir) : undefined)
  }

  /** Pick the endpoint serving this provider/model, exact provider first. */
  private matchEndpoint(target: Pick<LlmCallConfig, 'provider' | 'model'>): ResolvedResponsesEndpoint | undefined {
    const exact = this.endpoints.filter((endpoint) => endpoint.provider === target.provider)
    const wildcard = this.endpoints.filter((endpoint) => endpoint.provider === '*')
    for (const endpoint of [...exact, ...wildcard]) {
      if (globMatch(endpoint.model, target.model)) return endpoint
    }
    return undefined
  }

  /**
   * Summarize via Responses compaction v2 when an endpoint serves the routed
   * provider; otherwise (or on any failure) inherit the native LLM path.
   */
  protected async summarize(input: SummarizationInput, agent: Agent, signal?: AbortSignal): Promise<SummaryResult> {
    const target = conversationTarget(agent)
    if (target === undefined) {
      return super.summarize(input, agent, signal)
    }
    const endpoint = this.matchEndpoint(target)
    if (endpoint === undefined) {
      return super.summarize(input, agent, signal)
    }

    const apiKey = endpoint.apiKey ?? (process.env[endpoint.apiKeyEnv] ?? '')
    if (apiKey.length === 0) {
      this.ctx.logger.warn(
        `responses compaction: endpoint ${endpoint.label} matched provider ${target.provider}/${target.model} ` +
        `but no API key found (${endpoint.apiKeyEnv}); falling back to the native summarizer`,
      )
      return super.summarize(input, agent, signal)
    }

    const attempt = await this.remoteSummarize({
      endpoint,
      apiKey,
      target,
      input,
      agent,
      signal,
    })
    if (attempt !== undefined) return attempt

    if (this.options.fallbackToLlm === false) {
      throw new Error(
        `responses compaction failed for ${endpoint.label} and fallbackToLlm is false; ` +
        'the compaction was aborted instead of switching engines',
      )
    }
    return super.summarize(input, agent, signal)
  }

  /** One remote compaction attempt; `undefined` means "fall back". */
  private async remoteSummarize(params: {
    endpoint: ResolvedResponsesEndpoint
    apiKey: string
    target: Pick<LlmCallConfig, 'provider' | 'model'>
    input: SummarizationInput
    agent: Agent
    signal?: AbortSignal
  }): Promise<SummaryResult | undefined> {
    const { endpoint, apiKey, target, input, agent, signal } = params
    try {
      const items = dshMessagesToResponseItems(input.messages)
      const result = await callResponsesCompactionV2({
        endpoint,
        apiKey,
        model: target.model,
        input: items,
        instructions: input.system,
        tools: toolSchemasToResponseTools(input.tools ?? []),
        sessionId: agent.id,
        signal,
        timeoutMs: this.options.timeoutMs ?? 120000,
        retainedMessageTokenBudget: this.options.retainedMessageTokenBudget ?? 20000,
        installationId: this.options.installationId ?? this.installationId,
      })

      if (result.summaryText.length === 0) {
        throw new Error('Responses compaction v2 returned no readable summary text')
      }

      await this.state?.save({
        sessionId: agent.id,
        replacedAt: new Date().toISOString(),
        provider: target.provider,
        model: target.model,
        endpoint: responsesEndpointUrl(endpoint.baseUrl),
        summaryText: result.summaryText,
        replacementHistory: result.replacementHistory,
      })

      this.ctx.logger.info(
        `responses compaction: remote summary for ${target.provider}/${target.model} via ${endpoint.label} ` +
        `(${result.summaryText.length} chars, ${result.replacementHistory.length} replacement items)`,
      )
      return {
        summary: [{ type: 'text', text: result.summaryText }],
        provider: endpoint.label,
        model: target.model,
        usage: result.usage,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.ctx.logger.warn(
        `responses compaction failed for ${endpoint.label} (${message}); falling back to the native summarizer`,
      )
      return undefined
    }
  }
}

export default ResponsesCompactionEngine