/**
 * Configuration for the Responses-assisted compaction backend.
 *
 * @module dsh-blackhole/config
 */

import z from '@deepseek-ai/schemastery'

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
  provider: string
  /**
   * Model filter: exact model id, a glob (`gpt-4*`, `*-responses`), or `*`
   * for every model of the provider (default).
   */
  model: string
  /**
   * Responses endpoint base URL. The request is sent to `{baseUrl}/responses`
   * (a trailing `/v1` is honored). Examples:
   * `https://api.openai.com/v1` (direct), `https://gateway.example.com/v1`
   * (a gateway that forwards the Responses API), or `https://chatgpt.com/backend-api`
   * (official Codex backend, needs the matching headers).
   */
  baseUrl: string
  /** Env var holding the API key. Defaults to `OPENAI_API_KEY`. */
  apiKeyEnv: string
  /**
   * Inline API key. Prefer `apiKeyEnv` — an inline key ends up in the
   * profile's config file; never commit a real key.
   */
  apiKey?: string
  /**
   * Provider label recorded on the DSH `compaction/summary` event. Defaults to
   * the baseUrl host.
   */
  label?: string
  /**
   * Extra request headers (e.g. `OpenAI-Beta: responses=experimental`,
   * `x-codex-beta-features`). The authorization header is added automatically.
   */
  headers?: Record<string, string>
  /**
   * Send the Codex identity headers (`x-codex-installation-id` and, when a
   * session id is known, `x-codex-window-id` + `session_id`) like the upstream
   * port does. The installation id is a persisted random UUID kept out of the
   * real Codex home. Default true.
   */
  sendIdentityHeaders?: boolean
}

/** Resolved endpoint: config validated + label/defaults applied. */
export interface ResolvedResponsesEndpoint extends Required<Omit<ResponsesEndpointConfig, 'apiKey' | 'headers'>> {
  apiKey?: string
  headers: Record<string, string>
}

const endpointSchema = z.object({
  provider: z.string().required(),
  model: z.string().default('*'),
  baseUrl: z.string().required(),
  apiKeyEnv: z.string().default('OPENAI_API_KEY'),
  apiKey: z.string(),
  label: z.string(),
  headers: z.dict(z.string()),
})

export const CompactionResponsesConfigSchema = z.object({
  // Inherited BasicCompactionEngine knobs (same fields, same defaults as
  // @deepseek-ai/dsh-compaction-basic).
  thresholdRatio: z.number(),
  retainRatio: z.number(),
  retainTokens: z.number().step(1).min(0),
  summarizationProvider: z.string(),
  summarizationModel: z.string(),
  maxTokens: z.number().step(1).min(1),
  compactionRetries: z.number().step(1).min(0),
  maxOverflowRetries: z.number().step(1).min(0),
  modelPolicies: z.array(z.object({
    provider: z.string().required(),
    model: z.string().required(),
    thresholdRatio: z.number(),
    retainRatio: z.number(),
    retainTokens: z.number().step(1).min(0),
    summarizationProvider: z.string(),
    summarizationModel: z.string(),
    maxTokens: z.number().step(1).min(1),
    compactionRetries: z.number().step(1).min(0),
    maxOverflowRetries: z.number().step(1).min(0),
  })),
  /** Mount automatic between-step pressure + overflow recovery. Default true. */
  auto: z.boolean().default(true),

  // Responses-assisted knobs.
  /** Endpoints eligible for remote Responses compaction v2. */
  endpoints: z.array(endpointSchema).default([]),
  /**
   * Abort the remote attempt after this many ms and fall back (0 = no
   * timeout, the request signal alone governs). Default 120000.
   */
  timeoutMs: z.number().step(1).min(0).default(120000),
  /**
   * When the remote attempt fails, fall back to the inherited native
   * summarizer. Default true. Set false to fail the compaction instead — the
   * failure then surfaces through the normal compaction error path and the
   * checkpoint does not silently switch engines.
   */
  fallbackToLlm: z.boolean().default(true),
  /**
   * Directory for persisted remote compaction state (per-session replacement
   * history). Defaults to `$DSH_HOME/plugins/dsh-blackhole/state`.
   */
  stateDir: z.string(),
  /**
   * Persist the opaque replacement history returned by the server. Default
   * true. The persisted artifact is the Codex-style bridge for later
   * Responses replay; point `stateDir` somewhere durable on multi-host setups.
   */
  persistRemoteHistory: z.boolean().default(true),
  /**
   * Token budget for the most recent user messages retained verbatim in the
   * replacement history (Codex reserves 20K). Default 20000.
   */
  retainedMessageTokenBudget: z.number().step(1).min(0).default(20000),
})

/** The plugin's validated config shape (schemastery keeps object fields optional by default). */
export interface CompactionResponsesConfig {
  thresholdRatio?: number
  retainRatio?: number
  retainTokens?: number
  summarizationProvider?: string
  summarizationModel?: string
  maxTokens?: number
  compactionRetries?: number
  maxOverflowRetries?: number
  modelPolicies?: Array<{
    provider: string
    model: string
    thresholdRatio?: number
    retainRatio?: number
    retainTokens?: number
    summarizationProvider?: string
    summarizationModel?: string
    maxTokens?: number
    compactionRetries?: number
    maxOverflowRetries?: number
  }>
  auto?: boolean
  endpoints?: ResponsesEndpointConfig[]
  timeoutMs?: number
  fallbackToLlm?: boolean
  stateDir?: string
  persistRemoteHistory?: boolean
  retainedMessageTokenBudget?: number
  /**
   * The persisted random installation id sent as `x-codex-installation-id`;
   * resolved lazily and written next to the state dir. Set to empty string to
   * disable (equivalent to `sendIdentityHeaders: false` on every endpoint).
   */
  installationId?: string
}

/** Normalize the baseUrl into the exact URL the request goes to. */
export function responsesEndpointUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  if (trimmed.endsWith('/responses')) return trimmed
  if (trimmed.endsWith('/v1')) return `${trimmed}/responses`
  if (trimmed.endsWith('/codex')) return `${trimmed}/responses`
  return `${trimmed}/v1/responses`
}

// ── hybrid routing knobs ────────────────────────────────────────────────────

/**
 * Fallback chain after a remote Responses compaction v2 attempt fails.
 *
 * - `instant` (default): hand the shadowed region to the local deterministic
 *   VCC-style compiler (zero model calls, near-lossless `(seq N)` pointers);
 * - `instant-then-llm`: try the local compiler first, then the native one-shot
 *   LLM summarizer if even the compiler fails (it should not);
 * - `llm`: legacy behavior — go straight to the native one-shot LLM summarizer.
 */
export type CompactionFallbackMode = 'instant' | 'instant-then-llm' | 'llm'

/** Compiler knobs for the deterministic VCC-style branch. */
export interface CompilerCompactionConfig {
  /** Token floor for the compiled checkpoint (scaled up by checkpointScale). Default 8192. */
  compileMaxTokens?: number
  /** Checkpoint cap = max(compileMaxTokens, shadowed tokens x scale), ceilinged at checkpointCap. Default 0.1. */
  checkpointScale?: number
  /** Hard ceiling for the compiled checkpoint size in tokens. Default 65536. */
  checkpointCap?: number
  /** Per-text-block token budget for assistant text/reasoning. Default 512. */
  textTokens?: number
  /** Per-text-block token budget for user text. Default 1024. */
  userTextTokens?: number
  /** Per-tool-line token budget. Default 128. */
  toolCallTokens?: number
  /** Keep `reasoning` blocks in the compiled view. Default false. */
  includeReasoning?: boolean
  /** Strip known noise XML wrappers from user text. Default true. */
  stripNoiseXml?: boolean
  /** Regex sources for noise XML blocks; empty list = defaults. */
  noisePatterns?: string[]
  /** Tool name → key-argument field for one-liners; empty = defaults. */
  toolKeyFields?: Record<string, string>
  /** Tools whose key argument is kept; empty list = defaults. */
  toolArgTools?: string[]
  /** Tools rendered as nothing at all (no line, no pointer). */
  hideTools?: string[]
  /** Keep the first line of failed tool results as `[tool_error]`. 0 disables. Default 150. */
  toolErrorChars?: number
  /** Compress bash commands (cd-strip, pipe-tail strip, cap). 0 disables. Default 120. */
  bashCap?: number
  /** Collapse `<skill name="X">…</skill>` blocks to `[skill: X]`. Default true. */
  collapseSkills?: boolean
  /** Strip leading self-talk fillers from assistant text. Default true. */
  stripSelfTalk?: boolean
  /** Merge adjacent identical tool one-liners. Default true. */
  mergeToolLines?: boolean
  /** Max tool one-liners per assistant turn; 0 = unlimited. Default 8. */
  toolsPerTurn?: number
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
  fallbackMode?: CompactionFallbackMode
}

/** Endpoints + base policy + hybrid routing + local compiler knobs. */
export const HybridCompactionConfigSchema = z.object({
  // Inherited BasicCompactionEngine knobs (same fields, same defaults).
  thresholdRatio: z.number(),
  retainRatio: z.number(),
  retainTokens: z.number().step(1).min(0),
  summarizationProvider: z.string(),
  summarizationModel: z.string(),
  maxTokens: z.number().step(1).min(1),
  compactionRetries: z.number().step(1).min(0),
  maxOverflowRetries: z.number().step(1).min(0),
  modelPolicies: z.array(z.object({
    provider: z.string().required(),
    model: z.string().required(),
    thresholdRatio: z.number(),
    retainRatio: z.number(),
    retainTokens: z.number().step(1).min(0),
    summarizationProvider: z.string(),
    summarizationModel: z.string(),
    maxTokens: z.number().step(1).min(1),
    compactionRetries: z.number().step(1).min(0),
    maxOverflowRetries: z.number().step(1).min(0),
  })),
  /** Mount automatic between-step pressure + overflow recovery. Default true. */
  auto: z.boolean().default(true),

  // Responses-assisted knobs (same as the legacy engine).
  /** Endpoints eligible for remote Responses compaction v2. */
  endpoints: z.array(endpointSchema).default([]),
  /** Abort the remote attempt after this many ms (0 = no timeout). Default 120000. */
  timeoutMs: z.number().step(1).min(0).default(120000),
  /** Legacy: when remote fails, fall back to the native LLM summarizer. Default true. */
  fallbackToLlm: z.boolean().default(true),
  /** Directory for persisted remote compaction state. */
  stateDir: z.string(),
  /** Persist the opaque replacement history returned by the server. Default true. */
  persistRemoteHistory: z.boolean().default(true),
  /** Token budget for the newest user messages retained verbatim. Default 20000. */
  retainedMessageTokenBudget: z.number().step(1).min(0).default(20000),

  // Hybrid routing + local compiler knobs.
  /** Fallback chain after a remote attempt fails. Default `instant`. */
  fallbackMode: z.string(),
  /** Token floor for the compiled checkpoint. Default 8192. */
  compileMaxTokens: z.number().step(1).min(1),
  /** Checkpoint scale factor on the shadowed token count. Default 0.1. */
  checkpointScale: z.number().min(0.01).max(1),
  /** Hard ceiling for the compiled checkpoint. Default 65536. */
  checkpointCap: z.number().step(1).min(1),
  /** Per-text-block token budget for assistant text. Default 512. */
  textTokens: z.number().step(1).min(1),
  /** Per-text-block token budget for user text. Default 1024. */
  userTextTokens: z.number().step(1).min(1),
  /** Per-tool-line token budget. Default 128. */
  toolCallTokens: z.number().step(1).min(1),
  /** Keep `reasoning` blocks. Default false. */
  includeReasoning: z.boolean(),
  /** Strip noise XML wrappers. Default true. */
  stripNoiseXml: z.boolean(),
  /** Noise XML regex sources; empty = defaults. */
  noisePatterns: z.array(z.string()),
  /** Tool → key-argument field map; empty = defaults. */
  toolKeyFields: z.dict(z.string()),
  /** Tools whose key argument is kept; empty = defaults. */
  toolArgTools: z.array(z.string()),
  /** Tools rendered as nothing at all. */
  hideTools: z.array(z.string()),
  /** Keep the first line of failed tool results as `[tool_error]`. 0 disables. Default 150. */
  toolErrorChars: z.number().step(1).min(0),
  /** Compress bash commands (cd-strip, pipe-tail strip, cap). 0 disables. Default 120. */
  bashCap: z.number().step(1).min(0),
  /** Collapse `<skill name="X">…</skill>` blocks to `[skill: X]`. Default true. */
  collapseSkills: z.boolean(),
  /** Strip leading self-talk fillers from assistant text. Default true. */
  stripSelfTalk: z.boolean(),
  /** Merge adjacent identical tool one-liners. Default true. */
  mergeToolLines: z.boolean(),
  /** Max tool one-liners per assistant turn; 0 = unlimited. Default 8. */
  toolsPerTurn: z.number().step(1).min(0),
})

/** Resolve and validate the endpoint list once at construction. */
export function resolveEndpoints(
  endpoints: ResponsesEndpointConfig[] | undefined,
): ResolvedResponsesEndpoint[] {
  return (endpoints ?? []).map((endpoint) => {
    const baseUrl = endpoint.baseUrl.trim().replace(/\/+$/, '')
    const host = (() => {
      try {
        return new URL(baseUrl).host
      } catch {
        return baseUrl.replace(/^[a-z]+:\/\//i, '')
      }
    })()
    return {
      provider: endpoint.provider,
      model: endpoint.model?.trim() || '*',
      baseUrl,
      apiKeyEnv: endpoint.apiKeyEnv?.trim() || 'OPENAI_API_KEY',
      apiKey: endpoint.apiKey,
      label: endpoint.label?.trim() || host,
      headers: endpoint.headers ?? {},
      sendIdentityHeaders: endpoint.sendIdentityHeaders !== false,
    }
  })
}