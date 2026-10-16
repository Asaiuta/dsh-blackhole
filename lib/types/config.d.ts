/**
 * Configuration for the Responses-assisted compaction backend.
 *
 * @module dsh-blackhole/config
 */
import z from '@deepseek-ai/schemastery';
/**
 * One Responses-capable endpoint, matched against the DSH provider route the
 * latest request ran on. A remote compaction v2 attempt is made only for
 * providers with a matching endpoint; everything else falls back to the
 * inherited native LLM summarizer.
 */
export interface ResponsesEndpointConfig {
    /**
     * DSH provider route key this endpoint serves (e.g. `openai`, `opencode`).
     * `*` matches any provider, which lets a single endpoint serve every routed
     * model of a gateway deployment.
     */
    provider: string;
    /**
     * Model filter: exact model id, a glob (`gpt-4*`, `*-responses`), or `*`
     * for every model of the provider (default).
     */
    model: string;
    /**
     * Responses endpoint base URL. The request is sent to `{baseUrl}/responses`
     * (a trailing `/v1` is honored). Examples:
     * `https://api.openai.com/v1` (direct), `https://gateway.example.com/v1`
     * (a gateway that forwards the Responses API), or `https://chatgpt.com/backend-api`
     * (official Codex backend, needs the matching headers).
     */
    baseUrl: string;
    /** Env var holding the API key. Defaults to `OPENAI_API_KEY`. */
    apiKeyEnv: string;
    /**
     * Inline API key. Prefer `apiKeyEnv` — an inline key ends up in the
     * profile's config file; never commit a real key.
     */
    apiKey?: string;
    /**
     * Provider label recorded on the DSH `compaction/summary` event. Defaults to
     * the baseUrl host.
     */
    label?: string;
    /**
     * Extra request headers (e.g. `OpenAI-Beta: responses=experimental`,
     * `x-codex-beta-features`). The authorization header is added automatically.
     */
    headers?: Record<string, string>;
    /**
     * Send the Codex identity headers (`x-codex-installation-id` and, when a
     * session id is known, `x-codex-window-id` + `session_id`) like the upstream
     * port does. The installation id is a persisted random UUID kept out of the
     * real Codex home. Default true.
     */
    sendIdentityHeaders?: boolean;
}
/** Resolved endpoint: config validated + label/defaults applied. */
export interface ResolvedResponsesEndpoint extends Required<Omit<ResponsesEndpointConfig, 'apiKey' | 'headers'>> {
    apiKey?: string;
    headers: Record<string, string>;
}
export declare const CompactionResponsesConfigSchema: z<any, any, "plain">;
/** The plugin's validated config shape (schemastery keeps object fields optional by default). */
export interface CompactionResponsesConfig {
    thresholdRatio?: number;
    retainRatio?: number;
    retainTokens?: number;
    summarizationProvider?: string;
    summarizationModel?: string;
    maxTokens?: number;
    compactionRetries?: number;
    maxOverflowRetries?: number;
    modelPolicies?: Array<{
        provider: string;
        model: string;
        thresholdRatio?: number;
        retainRatio?: number;
        retainTokens?: number;
        summarizationProvider?: string;
        summarizationModel?: string;
        maxTokens?: number;
        compactionRetries?: number;
        maxOverflowRetries?: number;
    }>;
    auto?: boolean;
    endpoints?: ResponsesEndpointConfig[];
    timeoutMs?: number;
    fallbackToLlm?: boolean;
    stateDir?: string;
    persistRemoteHistory?: boolean;
    retainedMessageTokenBudget?: number;
    /**
     * The persisted random installation id sent as `x-codex-installation-id`;
     * resolved lazily and written next to the state dir. Set to empty string to
     * disable (equivalent to `sendIdentityHeaders: false` on every endpoint).
     */
    installationId?: string;
}
/** Normalize the baseUrl into the exact URL the request goes to. */
export declare function responsesEndpointUrl(baseUrl: string): string;
/**
 * Fallback chain after a remote Responses compaction v2 attempt fails.
 *
 * - `instant` (default): hand the shadowed region to the local deterministic
 *   VCC-style compiler (zero model calls, near-lossless `(seq N)` pointers);
 * - `instant-then-llm`: try the local compiler first, then the native one-shot
 *   LLM summarizer if even the compiler fails (it should not);
 * - `llm`: legacy behavior — go straight to the native one-shot LLM summarizer.
 */
export type CompactionFallbackMode = 'instant' | 'instant-then-llm' | 'llm';
/** Compiler knobs for the deterministic VCC-style branch. */
export interface CompilerCompactionConfig {
    /** Token floor for the compiled checkpoint (scaled up by checkpointScale). Default 8192. */
    compileMaxTokens?: number;
    /** Checkpoint cap = max(compileMaxTokens, shadowed tokens x scale), ceilinged at checkpointCap. Default 0.1. */
    checkpointScale?: number;
    /** Hard ceiling for the compiled checkpoint size in tokens. Default 65536. */
    checkpointCap?: number;
    /** Per-text-block token budget for assistant text/reasoning. Default 512. */
    textTokens?: number;
    /** Per-text-block token budget for user text. Default 1024. */
    userTextTokens?: number;
    /** Per-tool-line token budget. Default 128. */
    toolCallTokens?: number;
    /** Keep `reasoning` blocks in the compiled view. Default false. */
    includeReasoning?: boolean;
    /** Strip known noise XML wrappers from user text. Default true. */
    stripNoiseXml?: boolean;
    /** Regex sources for noise XML blocks; empty list = defaults. */
    noisePatterns?: string[];
    /** Tool name → key-argument field for one-liners; empty = defaults. */
    toolKeyFields?: Record<string, string>;
    /** Tools whose key argument is kept; empty list = defaults. */
    toolArgTools?: string[];
    /** Tools rendered as nothing at all (no line, no pointer). */
    hideTools?: string[];
    /** Keep the first line of failed tool results as `[tool_error]`. 0 disables. Default 150. */
    toolErrorChars?: number;
    /** Compress bash commands (cd-strip, pipe-tail strip, cap). 0 disables. Default 120. */
    bashCap?: number;
    /** Collapse `<skill name="X">…</skill>` blocks to `[skill: X]`. Default true. */
    collapseSkills?: boolean;
    /** Strip leading self-talk fillers from assistant text. Default true. */
    stripSelfTalk?: boolean;
    /** Merge adjacent identical tool one-liners. Default true. */
    mergeToolLines?: boolean;
    /** Max tool one-liners per assistant turn; 0 = unlimited. Default 8. */
    toolsPerTurn?: number;
}
/**
 * Hybrid routing knobs over {@link CompactionResponsesConfig}.
 *
 * A matched Responses endpoint always takes the remote path first; the
 * fallback chain then depends on {@link CompactionFallbackMode}. Targets with
 * no matching endpoint always take the local deterministic compiler path.
 */
export interface HybridCompactionConfig extends CompactionResponsesConfig, CompilerCompactionConfig {
    /**
     * Fallback chain after a remote attempt fails (see {@link CompactionFallbackMode}).
     * Default `instant`. The legacy `fallbackToLlm` boolean maps on top:
     * an explicit `fallbackToLlm: false` forces `instant` even when this is unset.
     */
    fallbackMode?: CompactionFallbackMode;
}
/** Endpoints + base policy + hybrid routing + local compiler knobs. */
export declare const HybridCompactionConfigSchema: z<any, any, "plain">;
/** Resolve and validate the endpoint list once at construction. */
export declare function resolveEndpoints(endpoints: ResponsesEndpointConfig[] | undefined): ResolvedResponsesEndpoint[];
