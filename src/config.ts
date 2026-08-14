/**
 * Configuration for the Responses-assisted compaction backend.
 *
 * @module dsh-compaction-responses/config
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
   * history). Defaults to `$DSH_HOME/plugins/dsh-compaction-responses/state`.
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
}

/** Normalize the baseUrl into the exact URL the request goes to. */
export function responsesEndpointUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  if (trimmed.endsWith('/responses')) return trimmed
  if (trimmed.endsWith('/v1')) return `${trimmed}/responses`
  if (trimmed.endsWith('/codex')) return `${trimmed}/responses`
  return `${trimmed}/v1/responses`
}

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
    }
  })
}