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
import { Context } from '@deepseek-ai/cordis';
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';
import type { LlmCallConfig, Message } from '@deepseek-ai/dsh-llm';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { HybridCompactionConfig, ResolvedResponsesEndpoint } from './config.ts';
import { RemoteCompactionStateStore } from './remote-state.ts';
import type { SummarizationInput, SummaryResult } from './engine-shared.ts';
import type { InstantStats } from './instant.ts';
import type { SessionEventSource } from './session-access.ts';
import type { BlackholeModeController } from './mode-command.ts';
/** Compiled-region stats without the framing overhead of the type. */
export interface HybridCompiledSummary {
    summary: Message['content'];
    provider: string;
    model: string;
    stats: InstantStats;
    capped: boolean;
    shadowedTokens: number;
}
/**
 * Build the id → durable seq map of a session by scanning its event log the
 * same way the official surface does (`deriveEventMessage`). Every stored
 * message answers by id, so the flattened shadowed region's messages resolve
 * to their real log positions. Accepts both the runtime `Session`
 * (`snapshotEvents()`) and test fakes (a plain `events` array).
 */
export declare function resolveRegionSeqs(session: SessionEventSource, messages: readonly Message[]): number[];
/**
 * The hybrid routing engine.
 *
 * Same service identity as the official backend (`compaction`); the bundle
 * patch re-points the `compaction-basic` row at this package, so the loader
 * mounts exactly one engine.
 */
export declare class RoutingCompactionEngine extends BasicCompactionEngine {
    static inject: string[];
    static Config: import("@deepseek-ai/schemastery").default<any, any, "plain">;
    /** Validated endpoint registry. */
    readonly endpoints: ResolvedResponsesEndpoint[];
    /** Optional per-session artifact store. */
    readonly state: RemoteCompactionStateStore | undefined;
    /** The plugin's own validated config (base fields live in `this.config`). */
    protected readonly options: HybridCompactionConfig;
    /** Effective fallback chain: config default with any persisted runtime override applied. */
    private fallbackMode;
    /** Config-resolved fallback chain (what `/blackhole-mode reset` restores). */
    private readonly configFallbackMode;
    /** Remote Responses gate; `/blackhole-mode remote off` closes it, persistently. */
    private remoteEnabled;
    /** Directory the sticky `/blackhole-mode` override file lives in, if resolvable. */
    private readonly modeStateDir;
    /** Public controller seam the `blackhole-commands` plugin reads via `ctx.compaction`. */
    readonly modeController: BlackholeModeController;
    /** Compiled local-compiler options. */
    private readonly compiler;
    /** Persisted Codex-style installation id, resolved lazily. */
    private installationId;
    constructor(ctx: Context, config?: HybridCompactionConfig);
    /** Token floor for the compiled checkpoint (scaled by the shadowed size). */
    private readonly compileMaxTokens;
    /** Checkpoint cap = max(compileMaxTokens, shadowed x scale), ceilinged at checkpointCap. */
    private readonly checkpointScale;
    /** Hard ceiling for the compiled checkpoint. */
    private readonly checkpointCap;
    /** Pick the endpoint serving this provider/model, exact provider first. */
    protected matchEndpoint(target: Pick<LlmCallConfig, 'provider' | 'model'>): ResolvedResponsesEndpoint | undefined;
    /** One-line description of the configured remote endpoints (for /blackhole-mode). */
    private describeEndpoints;
    /** Best-effort persist of the sticky /blackhole-mode override. */
    private persistModeOverride;
    protected summarize(input: SummarizationInput, agent: Agent, signal?: AbortSignal): Promise<SummaryResult>;
    /** One remote compaction attempt; `undefined` means "fall back". */
    protected remoteSummarize(params: {
        endpoint: ResolvedResponsesEndpoint;
        apiKey: string;
        target: Pick<LlmCallConfig, 'provider' | 'model'>;
        input: SummarizationInput;
        agent: Agent;
        signal?: AbortSignal;
    }): Promise<SummaryResult | undefined>;
    private responsesUrl;
    /**
     * The local deterministic branch: compile the shadowed region with the
     * VCC-style compiler at zero LLM cost.
     */
    protected instantSummarize(input: SummarizationInput, agent: Agent): SummaryResult;
    /** The native one-shot LLM branch (basic's summarizeWithLlm contract). */
    protected llmSummarize(input: SummarizationInput, agent: Agent, signal?: AbortSignal): Promise<SummaryResult>;
}
