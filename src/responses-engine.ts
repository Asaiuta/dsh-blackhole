/**
 * The legacy Responses-assisted compaction engine (unchanged behavior).
 *
 * Subclasses the official `BasicCompactionEngine` and overrides the single
 * customization hook (`summarize`). When the routed provider has a configured
 * Responses endpoint, the summary is produced by the model server via
 * Responses compaction v2 (the same protocol Codex's remote compaction uses)
 * and the opaque replacement history is persisted per session. Any failure —
 * no endpoint, missing key, timeout, protocol error — falls back to the
 * inherited native one-shot LLM summarizer.
 *
 * The hybrid routing engine (`RoutingCompactionEngine` in `hybrid.ts`) is the
 * default export of this package; this engine remains exported for setups
 * that want the Responses-only behavior without the local compiler.
 *
 * @module dsh-blackhole/responses-engine
 */

import { Context } from '@deepseek-ai/cordis'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CompactionResponsesConfigSchema, resolveEndpoints, responsesEndpointUrl } from './config.ts'
import type { CompactionResponsesConfig, ResolvedResponsesEndpoint } from './config.ts'
import { RemoteCompactionStateStore } from './remote-state.ts'
import { buildRemoteCompactionSummaryText, callResponsesCompactionV2, dshMessagesToResponseItems, toolSchemasToResponseTools } from './responses-v2.ts'
import { conversationTarget, globMatch, defaultStateDir, resolveInstallationId } from './engine-shared.ts'
import type { SummarizationInput, SummaryResult } from './engine-shared.ts'

export { CompactionResponsesConfigSchema }
export type { CompactionResponsesConfig, ResolvedResponsesEndpoint }
export { RemoteCompactionStateStore }
export type { RemoteCompactionStateEntry } from './remote-state.ts'
export { responsesEndpointUrl }

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
  protected readonly options: CompactionResponsesConfig
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
    if (this.state !== undefined) ctx.provide('responsesCompactionReplay', this.state)
    this.installationId = config.installationId !== undefined
      ? (config.installationId.trim() || undefined)
      : (resolvedStateDir !== undefined ? resolveInstallationId(resolvedStateDir) : undefined)
  }

  /** Pick the endpoint serving this provider/model, exact provider first. */
  protected matchEndpoint(target: Pick<LlmCallConfig, 'provider' | 'model'>): ResolvedResponsesEndpoint | undefined {
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
      await this.state?.remove(agent.id)
      return super.summarize(input, agent, signal)
    }
    const endpoint = this.matchEndpoint(target)
    if (endpoint === undefined) {
      await this.state?.remove(agent.id)
      return super.summarize(input, agent, signal)
    }

    const apiKey = endpoint.apiKey ?? (process.env[endpoint.apiKeyEnv] ?? '')
    if (apiKey.length === 0) {
      this.ctx.logger.warn(
        `responses compaction: endpoint ${endpoint.label} matched provider ${target.provider}/${target.model} ` +
        `but no API key found (${endpoint.apiKeyEnv}); falling back to the native summarizer`,
      )
      await this.state?.remove(agent.id)
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

    await this.state?.remove(agent.id)

    if (this.options.fallbackToLlm === false) {
      throw new Error(
        `responses compaction failed for ${endpoint.label} and fallbackToLlm is false; ` +
        'the compaction was aborted instead of switching engines',
      )
    }
    return super.summarize(input, agent, signal)
  }

  /** One remote compaction attempt; `undefined` means "fall back". */
  protected async remoteSummarize(params: {
    endpoint: ResolvedResponsesEndpoint
    apiKey: string
    target: Pick<LlmCallConfig, 'provider' | 'model'>
    input: SummarizationInput
    agent: Agent
    signal?: AbortSignal
  }): Promise<SummaryResult | undefined> {
    const { endpoint, apiKey, target, input, agent, signal } = params
    try {
      const items = await this.state?.prepareInput({
        sessionId: agent.id,
        provider: target.provider,
        model: target.model,
        trailingMessages: input.messages,
        endpoint: responsesEndpointUrl(endpoint.baseUrl),
      }) ?? dshMessagesToResponseItems(input.messages)
      const result = await callResponsesCompactionV2({
        endpoint,
        apiKey,
        provider: target.provider,
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

      const summaryText = result.summaryText.length > 0
        ? result.summaryText
        : buildRemoteCompactionSummaryText({
          provider: target.provider,
          model: target.model,
          endpoint: endpoint.label,
        })

      await this.state?.save({
        sessionId: agent.id,
        replacedAt: new Date().toISOString(),
        provider: target.provider,
        model: target.model,
        endpoint: responsesEndpointUrl(endpoint.baseUrl),
        summaryText,
        replacementHistory: result.replacementHistory,
        details: result.details,
      })

      this.ctx.logger.info(
        `responses compaction: remote summary for ${target.provider}/${target.model} via ${endpoint.label} ` +
        `(${summaryText.length} chars, ${result.replacementHistory.length} replacement items)`,
      )
      return {
        summary: [{ type: 'text', text: summaryText }],
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
