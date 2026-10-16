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
import { Context } from '@deepseek-ai/cordis';
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { CompactionResponsesConfigSchema, responsesEndpointUrl } from './config.ts';
import type { CompactionResponsesConfig, ResolvedResponsesEndpoint } from './config.ts';
import { RemoteCompactionStateStore } from './remote-state.ts';
import type { SummarizationInput, SummaryResult } from './engine-shared.ts';
export { CompactionResponsesConfigSchema };
export type { CompactionResponsesConfig, ResolvedResponsesEndpoint };
export { RemoteCompactionStateStore };
export type { RemoteCompactionStateEntry } from './remote-state.ts';
export { responsesEndpointUrl };
/**
 * The Responses-assisted compaction engine.
 *
 * Same service identity as the official backend (`compaction`); the bundle
 * patch re-points the `compaction-basic` row at this package, so the loader
 * mounts exactly one engine.
 */
export declare class ResponsesCompactionEngine extends BasicCompactionEngine {
    static inject: string[];
    static Config: import("@deepseek-ai/schemastery").default<any, any, "plain">;
    /** Validated endpoint registry. */
    readonly endpoints: ResolvedResponsesEndpoint[];
    /** Optional per-session artifact store. */
    readonly state: RemoteCompactionStateStore | undefined;
    /** The plugin's own validated config (base fields live in `this.config`). */
    protected readonly options: CompactionResponsesConfig;
    /** Persisted Codex-style installation id, resolved lazily. */
    private installationId;
    constructor(ctx: Context, config?: CompactionResponsesConfig);
    /** Pick the endpoint serving this provider/model, exact provider first. */
    protected matchEndpoint(target: Pick<LlmCallConfig, 'provider' | 'model'>): ResolvedResponsesEndpoint | undefined;
    /**
     * Summarize via Responses compaction v2 when an endpoint serves the routed
     * provider; otherwise (or on any failure) inherit the native LLM path.
     */
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
}
