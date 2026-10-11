/**
 * The hybrid routing compaction engine: dual-pipeline on one seam.
 *
 * DSH mounts exactly one compaction engine per context, so the dual pipeline
 * lives INSIDE this engine's `summarize()` hook:
 *
 *   1. Resolve the routed provider/model (durable request header first,
 *      agent options second).
 *   2. If a configured Responses endpoint serves that target — the official
 *      remote path: Responses compaction v2, exactly like the legacy engine,
 *      with the persisted opaque replacement history.
 *   3. On ANY remote failure (no endpoint, missing key, timeout, protocol
 *      error, non-shrinking result) the fallback chain resumes:
 *        - `instant` (default): a local deterministic VCC-style compiler
 *          (zero LLM calls, near-lossless `(seq N)` pointers back into the
 *          durable session log);
 *        - `instant-then-llm`: the compiler, and only if even it fails, the
 *          native one-shot LLM summarizer;
 *        - `llm`: legacy behavior — straight to the native LLM summarizer.
 *   4. Targets with NO matching endpoint never touch the network: they go
 *      straight to the local compiler (or, in `llm` mode, the native LLM).
 *
 * The compiler resolves REAL durable seqs by matching each flattened message
 * `id` (a UUID assigned by `dsh-llm::createMessage`) against the session
 * event log, so every `(seq N)` / `-> result M` pointer stays valid for a
 * recall tool mounted next to this engine.
 *
 * @module dsh-blackhole/hybrid
 */

import { Context } from '@deepseek-ai/cordis'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import type { LlmCallConfig, Message } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { resolveEndpoints, HybridCompactionConfigSchema } from './config.ts'
import type { HybridCompactionConfig, ResolvedResponsesEndpoint } from './config.ts'
import { RemoteCompactionStateStore } from './remote-state.ts'
import { buildRemoteCompactionSummaryText, callResponsesCompactionV2, dshMessagesToResponseItems, toolSchemasToResponseTools } from './responses-v2.ts'
import {
  conversationTarget, globMatch, defaultStateDir, resolveInstallationId,
  summarizeWithLlm,
} from './engine-shared.ts'
import type { SummarizationInput, SummaryResult } from './engine-shared.ts'
import {
  compileInstantRegion, compileNoisePatterns, DEFAULT_INSTANT_OPTIONS,
  DEFAULT_NOISE_PATTERNS, DEFAULT_TOOL_KEY_FIELDS, DEFAULT_ARG_TOOLS,
  estimateMessagesTokens, joinInstantEntries,
} from './instant.ts'
import type { InstantCompileOptions, InstantStats, RawMessage } from './instant.ts'
import { compileBlackholeSummary, previousCheckpointSummary } from './blackhole-summary.ts'
import type { BlackholeMessage } from './blackhole-summary.ts'
import { registerRecallTool, adaptRecallSession } from './recall.ts'
import type { RecallEvent, RecallSession, RecallToolRegistry } from './recall.ts'
import { deriveSessionMessage, readSessionEvents } from './session-access.ts'
import type { SessionEventSource } from './session-access.ts'
import {
  clearRuntimeModeOverride,
  loadRuntimeModeOverride,
  saveRuntimeModeOverride,
} from './mode-command.ts'
import type { BlackholeModeController } from './mode-command.ts'

const FALLBACK_MODES = new Set(['instant', 'instant-then-llm', 'llm'])

/** Compiled-region stats without the framing overhead of the type. */
export interface HybridCompiledSummary {
  summary: Message['content']
  provider: string
  model: string
  stats: InstantStats
  capped: boolean
  shadowedTokens: number
}

/**
 * Build the id → durable seq map of a session by scanning its event log the
 * same way the official surface does (`deriveEventMessage`). Every stored
 * message answers by id, so the flattened shadowed region's messages resolve
 * to their real log positions. Accepts both the runtime `Session`
 * (`snapshotEvents()`) and test fakes (a plain `events` array).
 */
export function resolveRegionSeqs(
  session: SessionEventSource,
  messages: readonly Message[],
): number[] {
  const idToSeq = new Map<string, number>()
  for (const event of readSessionEvents(session)) {
    if (typeof event.seq !== 'number') continue
    const message = deriveSessionMessage(session, event) as Message | null
    if (message !== null && message !== undefined && typeof message.id === 'string') {
      idToSeq.set(message.id, event.seq)
    }
  }
  return messages.map((message) => idToSeq.get(message.id) ?? -1)
}

/**
 * The hybrid routing engine.
 *
 * Same service identity as the official backend (`compaction`); the bundle
 * patch re-points the `compaction-basic` row at this package, so the loader
 * mounts exactly one engine.
 */
export class RoutingCompactionEngine extends BasicCompactionEngine {
  static inject = ['llm', 'tokenMeter', 'sessions']

  static Config = HybridCompactionConfigSchema

  /** Validated endpoint registry. */
  readonly endpoints: ResolvedResponsesEndpoint[]
  /** Optional per-session artifact store. */
  readonly state: RemoteCompactionStateStore | undefined
  /** The plugin's own validated config (base fields live in `this.config`). */
  protected readonly options: HybridCompactionConfig
  /** Effective fallback chain: config default with any persisted runtime override applied. */
  private fallbackMode: 'instant' | 'instant-then-llm' | 'llm'
  /** Config-resolved fallback chain (what `/blackhole-mode reset` restores). */
  private readonly configFallbackMode: 'instant' | 'instant-then-llm' | 'llm'
  /** Remote Responses gate; `/blackhole-mode remote off` closes it, persistently. */
  private remoteEnabled = true
  /** Directory the sticky `/blackhole-mode` override file lives in, if resolvable. */
  private readonly modeStateDir: string | undefined
  /** Public controller seam the `blackhole-commands` plugin reads via `ctx.compaction`. */
  readonly modeController: BlackholeModeController
  /** Compiled local-compiler options. */
  private readonly compiler: InstantCompileOptions & { noisePatterns: RegExp[] }
  /** Persisted Codex-style installation id, resolved lazily. */
  private installationId: string | undefined

  constructor(ctx: Context, config: HybridCompactionConfig = {}) {
    // The inherited resolveConfig() rejects unknown keys, so hand it only the
    // base policy fields and keep every plugin-specific knob aside.
    const {
      endpoints, timeoutMs, fallbackToLlm, stateDir, persistRemoteHistory,
      retainedMessageTokenBudget, fallbackMode, compileMaxTokens, checkpointScale,
      checkpointCap, textTokens, userTextTokens, toolCallTokens, includeReasoning,
      stripNoiseXml, noisePatterns, toolKeyFields, toolArgTools, hideTools,
      toolErrorChars, bashCap, collapseSkills, stripSelfTalk, mergeToolLines,
      toolsPerTurn,
      ...baseConfig
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
    // The sticky /blackhole-mode override file lives in the same plugin state
    // tree as the remote replacement history, but resolves independently of
    // persistRemoteHistory so runtime switching keeps working when that's off.
    this.modeStateDir = stateDir?.trim() || defaultStateDir()
    if (this.state !== undefined) {
      // Adapter-facing bridge.  The DSH request seam is immutable, so a
      // Responses adapter can opt in by resolving this service and calling
      // `prepareInput()` before it serializes an ordinary turn.
      ctx.provide('responsesCompactionReplay', this.state)
    }
    this.installationId = config.installationId !== undefined
      ? (config.installationId.trim() || undefined)
      : (resolvedStateDir !== undefined ? resolveInstallationId(resolvedStateDir) : undefined)

    // Legacy boolean maps on top of the explicit mode: fallbackToLlm:false
    // always means «instant»; a bare true behaves like the default.
    const explicit = fallbackMode?.trim()
    if (explicit !== undefined && explicit.length > 0 && !FALLBACK_MODES.has(explicit)) {
      throw new Error(
        `fallbackMode must be one of "instant", "instant-then-llm", "llm"; got ${JSON.stringify(explicit)}`,
      )
    }
    this.fallbackMode = explicit !== undefined && explicit.length > 0
      ? (explicit as 'instant' | 'instant-then-llm' | 'llm')
      : (fallbackToLlm === false ? 'instant' : 'instant')
    this.configFallbackMode = this.fallbackMode
    // Re-apply the sticky runtime override (if any) over the config defaults;
    // a corrupt or foreign file is ignored, config remains the durable truth.
    const modeOverride = loadRuntimeModeOverride(this.modeStateDir)
    if (modeOverride?.fallbackMode !== undefined) this.fallbackMode = modeOverride.fallbackMode
    if (modeOverride?.remoteEnabled !== undefined) this.remoteEnabled = modeOverride.remoteEnabled

    const noiseList = noisePatterns !== undefined && noisePatterns.length > 0
      ? noisePatterns : DEFAULT_NOISE_PATTERNS
    this.compiler = {
      textTokens: textTokens ?? DEFAULT_INSTANT_OPTIONS.textTokens,
      userTextTokens: userTextTokens ?? DEFAULT_INSTANT_OPTIONS.userTextTokens,
      toolCallTokens: toolCallTokens ?? DEFAULT_INSTANT_OPTIONS.toolCallTokens,
      includeReasoning: includeReasoning ?? false,
      stripNoiseXml: stripNoiseXml ?? true,
      noisePatterns: compileNoisePatterns(noiseList),
      toolKeyFields: toolKeyFields !== undefined && Object.keys(toolKeyFields).length > 0
        ? toolKeyFields : DEFAULT_TOOL_KEY_FIELDS,
      // Explicit non-empty list = whitelist-only extraction; unset = extract
      // for every tool (pi-blackhole behavior, the default).
      toolArgTools: toolArgTools !== undefined && toolArgTools.length > 0
        ? toolArgTools : DEFAULT_INSTANT_OPTIONS.toolArgTools,
      hideTools: new Set(hideTools ?? []),
      toolErrorChars: toolErrorChars ?? DEFAULT_INSTANT_OPTIONS.toolErrorChars,
      bashCap: bashCap ?? DEFAULT_INSTANT_OPTIONS.bashCap,
      collapseSkills: collapseSkills ?? DEFAULT_INSTANT_OPTIONS.collapseSkills,
      stripSelfTalk: stripSelfTalk ?? DEFAULT_INSTANT_OPTIONS.stripSelfTalk,
      mergeToolLines: mergeToolLines ?? DEFAULT_INSTANT_OPTIONS.mergeToolLines,
      toolsPerTurn: toolsPerTurn ?? DEFAULT_INSTANT_OPTIONS.toolsPerTurn,
    }
    this.compileMaxTokens = compileMaxTokens ?? 8192
    this.checkpointScale = checkpointScale ?? 0.1
    this.checkpointCap = checkpointCap ?? 65536

    // dsh-tools and dsh-commands are optional host services. Probe them via
    // `get()` (a direct undeclared property read makes Cordis throw), and also
    // observe `internal/service` so late-loaded profiles receive both recall
    // surfaces. Listeners and registry disposers belong to this plugin fiber.
    const releaseRecallRegistration = (surface: string, disposer: (() => void) | undefined): void => {
      if (disposer === undefined) return
      try {
        disposer()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger.warn(`dsh-blackhole: failed to release ${surface} recall registration (${message})`)
      }
    }
    let recallToolRegistry: RecallToolRegistry | undefined
    let recallToolDisposer: (() => void) | undefined
    const attachRecallTool = (candidate: unknown): void => {
      if (candidate === recallToolRegistry) return
      releaseRecallRegistration('tool', recallToolDisposer)
      recallToolDisposer = undefined
      recallToolRegistry = undefined
      if (typeof (candidate as { register?: unknown } | null)?.register !== 'function') return
      const tools = candidate as RecallToolRegistry
      try {
        const disposer = registerRecallTool(tools, (exec): RecallSession | undefined => {
          const candidate = exec as { agent?: { session?: unknown } } | undefined
          return adaptRecallSession(candidate?.agent?.session)
        })
        recallToolRegistry = tools
        recallToolDisposer = typeof disposer === 'function' ? disposer : undefined
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger.warn(`dsh-blackhole: optional recall tool registration failed (${message})`)
      }
    }
    // The /blackhole-mode controller: the only mutable seam over the engine's
    // runtime-switchable state (fallback chain + remote gate). Every switch
    // persists into the plugin state dir and is re-applied on the next DSH
    // start; config files remain the durable source of defaults. Public on
    // purpose: the `blackhole-commands` plugin reads it through
    // `ctx.compaction.modeController` to wire the user-facing command.
    this.modeController = {
      getFallbackMode: () => this.fallbackMode,
      getFallbackModeDefault: () => this.configFallbackMode,
      setFallbackMode: (mode) => {
        if (!FALLBACK_MODES.has(mode)) throw new Error(`invalid fallback mode: ${mode}`)
        this.fallbackMode = mode
        this.persistModeOverride()
      },
      isRemoteEnabled: () => this.remoteEnabled,
      isRemoteEnabledDefault: () => true,
      setRemoteEnabled: (enabled) => {
        this.remoteEnabled = enabled
        this.persistModeOverride()
      },
      resetRuntimeMode: () => {
        clearRuntimeModeOverride(this.modeStateDir)
        this.fallbackMode = this.configFallbackMode
        this.remoteEnabled = true
      },
      describeEndpoints: () => this.describeEndpoints(),
    }
    const safeContext = ctx as unknown as {
      get?: (name: string, strict?: boolean) => unknown
      on?: (name: string, listener: (...args: unknown[]) => void, options?: { global?: boolean }) => unknown
    }
    attachRecallTool(safeContext.get?.('tools'))
    // Cordis service notifications carry an isolation filter. A global
    // listener would also see sibling/agent-scoped registries and could bind
    // the wrong tools service into this plugin. Command registration is NOT
    // done here: the probe-and-observe approach cannot see the host plane
    // from inside the preset's isolated compaction group — the dedicated
    // `blackhole-commands` plugin (inject: commands + compaction) owns it.
    safeContext.on?.('internal/service', (name, value) => {
      if (name === 'tools') attachRecallTool(value)
    })
    ctx.effect(() => () => {
      releaseRecallRegistration('tool', recallToolDisposer)
      recallToolDisposer = undefined
      recallToolRegistry = undefined
    }, 'dsh-blackhole recall tool')
  }

  /** Token floor for the compiled checkpoint (scaled by the shadowed size). */
  private readonly compileMaxTokens: number
  /** Checkpoint cap = max(compileMaxTokens, shadowed x scale), ceilinged at checkpointCap. */
  private readonly checkpointScale: number
  /** Hard ceiling for the compiled checkpoint. */
  private readonly checkpointCap: number

  /** Pick the endpoint serving this provider/model, exact provider first. */
  protected matchEndpoint(target: Pick<LlmCallConfig, 'provider' | 'model'>): ResolvedResponsesEndpoint | undefined {
    const exact = this.endpoints.filter((endpoint) => endpoint.provider === target.provider)
    const wildcard = this.endpoints.filter((endpoint) => endpoint.provider === '*')
    for (const endpoint of [...exact, ...wildcard]) {
      if (globMatch(endpoint.model, target.model)) return endpoint
    }
    return undefined
  }

  /** One-line description of the configured remote endpoints (for /blackhole-mode). */
  private describeEndpoints(): string {
    if (this.endpoints.length === 0) return 'no endpoints configured'
    return this.endpoints
      .map((endpoint) => `${endpoint.provider}/${endpoint.model} → ${endpoint.label}`)
      .join(', ')
  }

  /** Best-effort persist of the sticky /blackhole-mode override. */
  private persistModeOverride(): void {
    const saved = saveRuntimeModeOverride(this.modeStateDir, {
      fallbackMode: this.fallbackMode,
      remoteEnabled: this.remoteEnabled,
    })
    if (!saved) {
      this.ctx.logger.warn(
        'dsh-blackhole: runtime mode override could not be persisted; it resets on the next DSH start',
      )
    }
  }

  protected async summarize(input: SummarizationInput, agent: Agent, signal?: AbortSignal): Promise<SummaryResult> {
    const target = conversationTarget(agent)

    // No route info → local compiler (it needs no provider).
    if (target === undefined) {
      await this.state?.remove(agent.id)
      return this.instantSummarize(input, agent)
    }
    // Remote path only when the runtime gate is open and a configured
    // endpoint serves this provider/model.
    const endpoint = this.remoteEnabled ? this.matchEndpoint(target) : undefined
    if (endpoint !== undefined) {
      const apiKey = endpoint.apiKey ?? (process.env[endpoint.apiKeyEnv] ?? '')
      if (apiKey.length === 0) {
        this.ctx.logger.warn(
          `hybrid compaction: endpoint ${endpoint.label} matched provider ${target.provider}/${target.model} ` +
          `but no API key found (${endpoint.apiKeyEnv}); using the local compiler`,
        )
      } else {
        const attempt = await this.remoteSummarize({ endpoint, apiKey, target, input, agent, signal })
        if (attempt !== undefined) return attempt
      }
    }

    // Any local/LLM checkpoint supersedes the last provider-native window.
    // Leaving it on disk would let a later same-provider turn replay history
    // from before this fallback compaction and silently skip the new checkpoint.
    await this.state?.remove(agent.id)

    // Fallback chain after a remote failure (or a never-attempted remote).
    switch (this.fallbackMode) {
      case 'llm':
        return this.llmSummarize(input, agent, signal)
      case 'instant-then-llm': {
        try {
          return await this.instantSummarize(input, agent)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          this.ctx.logger.warn(`hybrid compaction: local compiler failed (${message}); using the native LLM summarizer`)
          return this.llmSummarize(input, agent, signal)
        }
      }
      default:
        return this.instantSummarize(input, agent)
    }
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
      // If an earlier remote checkpoint belongs to this exact target, carry
      // its opaque replacement window forward and append only the current
      // trailing surface.  This is the compaction-side replay path; a normal
      // conversation turn still requires the provider adapter bridge exposed
      // by RemoteCompactionStateStore.prepareInput().
      const items = await this.state?.prepareInput({
        sessionId: agent.id,
        provider: target.provider,
        model: target.model,
        trailingMessages: input.messages,
        endpoint: this.responsesUrl(endpoint.baseUrl),
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
        endpoint: this.responsesUrl(endpoint.baseUrl),
        summaryText,
        replacementHistory: result.replacementHistory,
        details: result.details,
      })

      this.ctx.logger.info(
        `hybrid compaction: remote summary for ${target.provider}/${target.model} via ${endpoint.label} ` +
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
        `hybrid compaction: remote attempt failed for ${endpoint.label} (${message}); falling back`,
      )
      return undefined
    }
  }

  private responsesUrl(baseUrl: string): string {
    const trimmed = baseUrl.trim().replace(/\/+$/, '')
    if (trimmed.endsWith('/responses')) return trimmed
    if (trimmed.endsWith('/v1')) return `${trimmed}/responses`
    if (trimmed.endsWith('/codex')) return `${trimmed}/responses`
    return `${trimmed}/v1/responses`
  }

  /**
   * The local deterministic branch: compile the shadowed region with the
   * VCC-style compiler at zero LLM cost.
   */
  protected instantSummarize(input: SummarizationInput, agent: Agent): SummaryResult {
    const session = agent.session
    const seqs = resolveRegionSeqs(session, [...input.messages])
    const nodes = [...input.messages].map((message, index) => ({
      seq: seqs[index] ?? -1,
      message: message as unknown as RawMessage,
    }))
    const shadowedTokens = estimateMessagesTokens(nodes.map((node) => node.message))
    const cap = Math.min(
      this.checkpointCap,
      Math.max(this.compileMaxTokens, Math.floor(shadowedTokens * this.checkpointScale)),
    )
    const compiled = compileInstantRegion(nodes, this.compiler, cap)
    const briefText = joinInstantEntries(compiled.entries)
    const text = compileBlackholeSummary({
      messages: [...input.messages] as unknown as BlackholeMessage[],
      seqs,
      previousSummary: previousCheckpointSummary(
        [...input.messages] as unknown as BlackholeMessage[],
      ),
      briefTranscript: briefText,
      maxTokens: cap,
    })
    if (text.trim().length === 0) {
      throw new Error('instant compiler produced no content for the shadowed region')
    }
    // Conservative pre-shrink check: the parent re-frames the summary with the
    // checkpoint preamble + tags, so reserve a margin. If the compiler cannot
    // shrink the region, fail fast instead of aborting the whole compaction.
    const estimated = estimateMessagesTokens([{ content: [{ type: 'text', text }] } as RawMessage]) + 64
    if (estimated >= shadowedTokens && compiled.stats.tokens > 0) {
      throw new Error(
        `instant checkpoint does not shrink the shadowed region ` +
        `(${estimated} >= ${shadowedTokens} tokens)`,
      )
    }
    if (compiled.capped) {
      this.ctx.logger.info(
        `hybrid compaction: local compiler capped the checkpoint at ${cap} tokens ` +
        `(shadowed ${shadowedTokens}, ${compiled.stats.elidedRows} rows elided)`,
      )
    }
    return {
      summary: [{ type: 'text', text }],
      provider: 'instant',
      model: 'vcc-compiler',
      rawOutput: [{ type: 'text', text }],
    }
  }

  /** The native one-shot LLM branch (basic's summarizeWithLlm contract). */
  protected llmSummarize(input: SummarizationInput, agent: Agent, signal?: AbortSignal): Promise<SummaryResult> {
    return summarizeWithLlm(this.ctx, this.config, input, agent, signal)
  }
}
