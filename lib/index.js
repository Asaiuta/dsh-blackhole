// src/hybrid.ts
import { BasicCompactionEngine } from "@deepseek-ai/dsh-compaction-basic";

// src/config.ts
import z from "@deepseek-ai/schemastery";
var endpointSchema = z.object({
  provider: z.string().required(),
  model: z.string().default("*"),
  baseUrl: z.string().required(),
  apiKeyEnv: z.string().default("OPENAI_API_KEY"),
  apiKey: z.string(),
  label: z.string(),
  headers: z.dict(z.string())
});
var CompactionResponsesConfigSchema = z.object({
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
    maxOverflowRetries: z.number().step(1).min(0)
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
  timeoutMs: z.number().step(1).min(0).default(12e4),
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
  retainedMessageTokenBudget: z.number().step(1).min(0).default(2e4)
});
function responsesEndpointUrl(baseUrl) {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (trimmed.endsWith("/responses")) return trimmed;
  if (trimmed.endsWith("/v1")) return `${trimmed}/responses`;
  if (trimmed.endsWith("/codex")) return `${trimmed}/responses`;
  return `${trimmed}/v1/responses`;
}
var HybridCompactionConfigSchema = z.object({
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
    maxOverflowRetries: z.number().step(1).min(0)
  })),
  /** Mount automatic between-step pressure + overflow recovery. Default true. */
  auto: z.boolean().default(true),
  // Responses-assisted knobs (same as the legacy engine).
  /** Endpoints eligible for remote Responses compaction v2. */
  endpoints: z.array(endpointSchema).default([]),
  /** Abort the remote attempt after this many ms (0 = no timeout). Default 120000. */
  timeoutMs: z.number().step(1).min(0).default(12e4),
  /** Legacy: when remote fails, fall back to the native LLM summarizer. Default true. */
  fallbackToLlm: z.boolean().default(true),
  /** Directory for persisted remote compaction state. */
  stateDir: z.string(),
  /** Persist the opaque replacement history returned by the server. Default true. */
  persistRemoteHistory: z.boolean().default(true),
  /** Token budget for the newest user messages retained verbatim. Default 20000. */
  retainedMessageTokenBudget: z.number().step(1).min(0).default(2e4),
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
  toolsPerTurn: z.number().step(1).min(0)
});
function resolveEndpoints(endpoints) {
  return (endpoints ?? []).map((endpoint) => {
    const baseUrl = endpoint.baseUrl.trim().replace(/\/+$/, "");
    const host = (() => {
      try {
        return new URL(baseUrl).host;
      } catch {
        return baseUrl.replace(/^[a-z]+:\/\//i, "");
      }
    })();
    return {
      provider: endpoint.provider,
      model: endpoint.model?.trim() || "*",
      baseUrl,
      apiKeyEnv: endpoint.apiKeyEnv?.trim() || "OPENAI_API_KEY",
      apiKey: endpoint.apiKey,
      label: endpoint.label?.trim() || host,
      headers: endpoint.headers ?? {},
      sendIdentityHeaders: endpoint.sendIdentityHeaders !== false
    };
  });
}

// src/remote-state.ts
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

// src/responses-v2.ts
function buildRemoteCompactionSummaryText(params) {
  return `Remote Responses compaction applied for ${params.provider}/${params.model} via ${params.endpoint}. Provider-native replacement history is retained for compatible future requests; use recall for omitted details.`;
}
function remoteCompactionModelKey(provider, model) {
  return `${provider}:openai-responses:${model}`;
}
function buildRemoteCompactionDetails(params) {
  return {
    version: 2,
    provider: "openai-responses-compaction",
    implementation: "responses_compaction_v2",
    modelKey: remoteCompactionModelKey(params.provider, params.model),
    replacementHistory: params.replacementHistory.map((item) => ({ ...item })),
    ...params.usage === void 0 ? {} : { usage: { ...params.usage } }
  };
}
function isTokenUsage(value) {
  if (!isRecord(value)) return false;
  return typeof value.inputTokens === "number" && Number.isFinite(value.inputTokens) && typeof value.outputTokens === "number" && Number.isFinite(value.outputTokens);
}
function parseRemoteCompactionDetails(value) {
  if (!isRecord(value) || value.version !== 2 || value.provider !== "openai-responses-compaction" || value.implementation !== "responses_compaction_v2" || typeof value.modelKey !== "string" || value.modelKey.length === 0 || !Array.isArray(value.replacementHistory) || value.replacementHistory.length === 0) {
    return void 0;
  }
  if (!value.replacementHistory.every(isReplayableResponseItem)) return void 0;
  if (value.usage !== void 0 && !isTokenUsage(value.usage)) return void 0;
  return {
    version: 2,
    provider: "openai-responses-compaction",
    implementation: "responses_compaction_v2",
    modelKey: value.modelKey,
    replacementHistory: value.replacementHistory.map((item) => ({ ...item })),
    ...value.usage === void 0 ? {} : { usage: value.usage }
  };
}
var IMAGE_CONTENT_OMITTED_PLACEHOLDER = "image content omitted because the durable image bytes are not available to the remote compaction request";
function approximateMessageTokens(item) {
  if (item.type !== "message" || !Array.isArray(item.content)) return 0;
  const text = item.content.filter((c) => c.type === "input_text" || c.type === "output_text").map((c) => c.text).join("");
  return Math.max(1, Math.ceil(text.length / 4));
}
function truncateMessageToTokenBudget(item, maxTokens) {
  if (item.type !== "message" || !Array.isArray(item.content)) return { ...item };
  let remainingCharacters = Math.max(0, maxTokens * 4);
  const content = item.content.flatMap((part) => {
    if (part.type === "input_image") return [part];
    if (remainingCharacters === 0) return [];
    const text = (part.text ?? "").slice(0, remainingCharacters);
    remainingCharacters -= text.length;
    return text ? [{ ...part, text }] : [];
  });
  return content.length > 0 ? { ...item, content } : void 0;
}
function buildReplacementHistory(input, compactionItem, retainedMessageTokenBudget) {
  if (compactionItem.type !== "compaction") {
    throw new Error("OpenAI remote compaction v2 did not return a compaction item.");
  }
  const retainedUserMessages = input.filter(
    (item) => item.type === "message" && item.role === "user" && isRealUserMessage(item)
  );
  let remainingTokens = retainedMessageTokenBudget;
  const retainedReversed = [];
  for (const item of [...retainedUserMessages].reverse()) {
    if (remainingTokens <= 0) break;
    const tokenCount = approximateMessageTokens(item);
    if (tokenCount <= remainingTokens) {
      retainedReversed.push(item);
      remainingTokens -= tokenCount;
      continue;
    }
    const truncated = truncateMessageToTokenBudget(item, remainingTokens);
    if (truncated) retainedReversed.push(truncated);
    remainingTokens = 0;
  }
  return [...retainedReversed.reverse(), { ...compactionItem }];
}
function dshMessageToResponseItems(message) {
  const items = [];
  if (message.role === "user" || message.role === "system") {
    const contentItems = [];
    const toolOutputs = [];
    for (const block of message.content) {
      switch (block.type) {
        case "text":
          contentItems.push({ type: "input_text", text: block.text });
          break;
        case "image":
          contentItems.push({ type: "input_text", text: IMAGE_CONTENT_OMITTED_PLACEHOLDER });
          break;
        case "tool-result":
          toolOutputs.push({
            type: "function_call_output",
            call_id: String(block.toolCallId).split("|", 1)[0],
            output: toolResultBlockToOutput(block.content)
          });
          break;
        default:
          break;
      }
    }
    if (contentItems.length > 0) {
      items.push({ type: "message", role: "user", content: contentItems });
    }
    items.push(...toolOutputs);
    return items;
  }
  if (message.role === "assistant") {
    const textBlocks = [];
    const flushText = () => {
      if (textBlocks.length === 0) return;
      items.push({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: textBlocks.join("") }]
      });
      textBlocks.length = 0;
    };
    for (const block of message.content) {
      switch (block.type) {
        case "text":
          textBlocks.push(block.text);
          break;
        case "reasoning":
          flushText();
          items.push({
            type: "reasoning",
            summary: [{ type: "summary_text", text: block.text }],
            encrypted_content: null
          });
          break;
        case "tool-call":
          flushText();
          items.push({
            type: "function_call",
            name: block.name,
            call_id: String(block.id).split("|", 1)[0],
            arguments: typeof block.arguments === "string" ? block.arguments : JSON.stringify(block.arguments ?? {})
          });
          break;
        default:
          break;
      }
    }
    flushText();
    return items;
  }
  return items;
}
function toolResultBlockToOutput(content) {
  return content.map((block) => {
    if (block.type === "text") return block.text;
    if (block.type === "image") return "[image]";
    return `[${String(block.type)}]`;
  }).filter(Boolean).join("\n").trim();
}
function isRealUserMessage(item) {
  if (item.type !== "message" || item.role !== "user") return false;
  if (typeof item.content === "string") return item.content.trim().length > 0;
  return Array.isArray(item.content) && item.content.length > 0;
}
function dshMessagesToResponseItems(messages) {
  return messages.flatMap((message) => dshMessageToResponseItems(message));
}
function reconstructRemoteCompactionHistory(params) {
  if (params.details.modelKey !== remoteCompactionModelKey(params.provider, params.model)) return void 0;
  const trailing = [];
  let pending = [];
  for (const message of params.trailingMessages) {
    if (message.source.kind === "plugin" && message.source.plugin === "compact") continue;
    const items = dshMessageToResponseItems(message);
    if (items.length === 0) continue;
    if (message.role === "assistant") {
      const source = message.source.kind === "model" ? message.source : void 0;
      if (source?.provider === params.provider && source.model === params.model) {
        trailing.push(...pending, ...items);
      }
      pending = [];
      continue;
    }
    pending.push(...items);
  }
  if (params.includePending === true) trailing.push(...pending);
  return [...params.details.replacementHistory.map((item) => ({ ...item })), ...trailing];
}
function toolSchemasToResponseTools(tools) {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters
  }));
}
function buildCompactionRequestBody(params) {
  return {
    model: params.model,
    input: [...params.input, { type: "compaction_trigger" }],
    ...params.instructions ? { instructions: params.instructions } : {},
    tools: params.tools,
    parallel_tool_calls: true,
    tool_choice: "auto",
    stream: true,
    store: false,
    include: ["reasoning.encrypted_content"],
    ...params.sessionId ? { prompt_cache_key: params.sessionId } : {}
  };
}
function parseSseData(text) {
  return text.replace(/\r\n/g, "\n").split("\n\n").flatMap((block) => {
    const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n").trim();
    if (!data || data === "[DONE]") return [];
    try {
      return [JSON.parse(data)];
    } catch {
      return [];
    }
  });
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isResponseItem(value) {
  return isRecord(value) && typeof value.type === "string";
}
function isReplayableResponseItem(value) {
  if (!isRecord(value)) return false;
  if (value.type === "compaction") return typeof value.encrypted_content === "string";
  if (value.type !== "message" || typeof value.role !== "string" || !Array.isArray(value.content)) return false;
  return value.content.every((content) => {
    if (!isRecord(content) || typeof content.type !== "string") return false;
    if (content.type === "input_image") return typeof content.image_url === "string";
    return (content.type === "input_text" || content.type === "output_text") && typeof content.text === "string";
  });
}
function parseCompactionV2Events(events) {
  let completed = false;
  let usage;
  const compactionItems = [];
  const itemSummaryChunks = [];
  const outputTextDoneChunks = [];
  const outputTextDeltaChunks = [];
  for (const event of events) {
    if (!isRecord(event)) continue;
    if (event.type === "error") {
      const message = typeof event.message === "string" ? event.message : "Unknown Responses API error";
      throw new Error(`OpenAI remote compaction v2 failed: ${message}`);
    }
    if (event.type === "response.failed") {
      const response = isRecord(event.response) ? event.response : void 0;
      const error = response && isRecord(response.error) ? response.error : void 0;
      const message = typeof error?.message === "string" ? error.message : "Response failed";
      throw new Error(`OpenAI remote compaction v2 failed: ${message}`);
    }
    if (event.type === "response.output_item.done" && isResponseItem(event.item)) {
      if (event.item.type === "compaction") {
        compactionItems.push(event.item);
        continue;
      }
      if (event.item.type === "message" && event.item.role === "assistant" && Array.isArray(event.item.content)) {
        for (const content of event.item.content) {
          if (content.type === "output_text") itemSummaryChunks.push(content.text);
        }
      }
      continue;
    }
    if (event.type === "response.output_text.done" && typeof event.text === "string") {
      outputTextDoneChunks.push(event.text);
      continue;
    }
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      outputTextDeltaChunks.push(event.delta);
      continue;
    }
    if (event.type === "response.completed") {
      completed = true;
      const response = isRecord(event.response) ? event.response : void 0;
      usage = response?.usage;
    }
  }
  if (!completed) {
    throw new Error("OpenAI remote compaction v2 stream ended before response.completed.");
  }
  if (compactionItems.length !== 1) {
    throw new Error(
      `OpenAI remote compaction v2 expected exactly one compaction item, got ${compactionItems.length}.`
    );
  }
  return {
    compactionItem: compactionItems[0],
    // Responses streams may expose the same text through both the completed
    // output item and `response.output_text.done`. Prefer the item payload and
    // use the latter only for providers that omit the item content; otherwise
    // a valid summary becomes `HelloHello`.
    summaryText: (itemSummaryChunks.length > 0 ? itemSummaryChunks : outputTextDoneChunks.length > 0 ? outputTextDoneChunks : outputTextDeltaChunks).join("").trim(),
    usage
  };
}
function mapCompactionUsage(value) {
  if (!isRecord(value)) return void 0;
  const inputTokens = typeof value.input_tokens === "number" && Number.isFinite(value.input_tokens) ? value.input_tokens : 0;
  const outputTokens = typeof value.output_tokens === "number" && Number.isFinite(value.output_tokens) ? value.output_tokens : 0;
  if (inputTokens === 0 && outputTokens === 0) return void 0;
  const details = isRecord(value.input_tokens_details) ? value.input_tokens_details : void 0;
  const cachedTokens = typeof details?.cached_tokens === "number" && Number.isFinite(details.cached_tokens) ? details.cached_tokens : 0;
  const cacheWriteTokens = typeof details?.cache_creation_tokens === "number" && Number.isFinite(details.cache_creation_tokens) ? details.cache_creation_tokens : typeof details?.cache_write_tokens === "number" && Number.isFinite(details.cache_write_tokens) ? details.cache_write_tokens : 0;
  return {
    inputTokens: Math.max(0, inputTokens - cachedTokens - cacheWriteTokens),
    outputTokens,
    ...cachedTokens > 0 ? { cacheReadTokens: cachedTokens } : {},
    ...cacheWriteTokens > 0 ? { cacheWriteTokens } : {}
  };
}
async function callResponsesCompactionV2(params) {
  const { endpoint, apiKey, provider, model, input, instructions, tools, sessionId, signal, timeoutMs, retainedMessageTokenBudget, installationId } = params;
  const baseUrl = endpoint.baseUrl.replace(/\/+$/, "");
  const url = baseUrl.endsWith("/responses") ? baseUrl : `${baseUrl}/responses`;
  const timeoutSignal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : void 0;
  const requestSignal = signal !== void 0 && timeoutSignal !== void 0 ? AbortSignal.any([signal, timeoutSignal]) : signal ?? timeoutSignal;
  const userHeaders = { ...endpoint.headers };
  const betaKey = Object.keys(userHeaders).find((key) => key.toLowerCase() === "x-codex-beta-features");
  const userBeta = betaKey !== void 0 ? String(userHeaders[betaKey]).split(",").map((f) => f.trim()).filter(Boolean) : [];
  if (betaKey !== void 0) delete userHeaders[betaKey];
  const betaFeatures = [.../* @__PURE__ */ new Set([...userBeta, "remote_compaction_v2"])].join(",");
  const identityHeaders = endpoint.sendIdentityHeaders && installationId ? {
    "x-codex-installation-id": installationId,
    ...sessionId !== void 0 ? { "x-codex-window-id": `${sessionId}:0`, session_id: sessionId } : {}
  } : {};
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      accept: "text/event-stream",
      ...identityHeaders,
      ...userHeaders,
      "x-codex-beta-features": betaFeatures
    },
    body: JSON.stringify(buildCompactionRequestBody({ model, input, instructions, tools, sessionId })),
    signal: requestSignal
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Responses compaction v2 failed (${response.status}): ${text || response.statusText}`);
  }
  const responseText = await response.text();
  const parsed = parseCompactionV2Events(parseSseData(responseText));
  if (parsed.compactionItem === void 0) {
    throw new Error("Responses compaction v2 returned no compaction item.");
  }
  const replacementHistory = buildReplacementHistory(input, parsed.compactionItem, retainedMessageTokenBudget);
  return {
    summaryText: parsed.summaryText,
    replacementHistory,
    usage: mapCompactionUsage(parsed.usage),
    details: buildRemoteCompactionDetails({
      provider: provider ?? endpoint.provider,
      model,
      replacementHistory,
      usage: mapCompactionUsage(parsed.usage)
    })
  };
}

// src/remote-state.ts
var RemoteCompactionStateStore = class {
  constructor(dir) {
    this.dir = dir;
  }
  pathFor(sessionId) {
    return join(this.dir, `${encodeURIComponent(sessionId)}.json`);
  }
  /** Persist one entry atomically (temp file + rename). */
  async save(entry) {
    await mkdir(this.dir, { recursive: true });
    const target = this.pathFor(entry.sessionId);
    const tmp = `${target}.tmp`;
    await writeFile(tmp, JSON.stringify(entry, null, 2), "utf8");
    await rename(tmp, target);
  }
  async load(sessionId) {
    try {
      const raw = await readFile(this.pathFor(sessionId), "utf8");
      const parsed = JSON.parse(raw);
      if (parsed.sessionId !== sessionId || !Array.isArray(parsed.replacementHistory)) {
        return void 0;
      }
      if (parsed.details !== void 0) {
        const details = parseRemoteCompactionDetails(parsed.details);
        if (details === void 0) return void 0;
        if (details.replacementHistory.length !== parsed.replacementHistory.length) return void 0;
        return { ...parsed, details };
      }
      return parsed;
    } catch {
      return void 0;
    }
  }
  /**
   * Load only a current-target v2 artifact.  Legacy entries remain readable
   * through `load()` for migration/diagnostics, but they are deliberately not
   * replayable because they lack the ownership contract and could contain a
   * provider-private history for a different route.
   */
  async loadForTarget(params) {
    const entry = await this.load(params.sessionId);
    if (entry?.details === void 0) return void 0;
    if (entry.provider !== params.provider || entry.model !== params.model) return void 0;
    if (params.endpoint !== void 0 && entry.endpoint !== params.endpoint) return void 0;
    return entry;
  }
  /**
   * Resolve the provider-native Responses history for one next request.
   * Returns `undefined` on missing/legacy/foreign state (fail closed).
   */
  async replayHistory(params) {
    const entry = await this.loadForTarget(params);
    if (entry?.details === void 0) return void 0;
    return reconstructRemoteCompactionHistory({
      details: entry.details,
      provider: params.provider,
      model: params.model,
      trailingMessages: params.trailingMessages
    });
  }
  /**
   * Build the complete input for one ordinary Responses request.
   *
   * The adapter owns the final HTTP envelope; this method owns only the
   * provider-native input list. A missing state is not an error — it means the
   * request starts from the supplied DSH messages. The fallback conversion is
   * deliberately local and deterministic, so a foreign provider/model or an
   * endpoint mismatch can never leak opaque state into another route.
   */
  async prepareInput(params) {
    const entry = await this.loadForTarget(params);
    if (entry?.details === void 0) return dshMessagesToResponseItems(params.trailingMessages);
    return reconstructRemoteCompactionHistory({
      details: entry.details,
      provider: params.provider,
      model: params.model,
      trailingMessages: params.trailingMessages,
      includePending: true
    }) ?? dshMessagesToResponseItems(params.trailingMessages);
  }
  async remove(sessionId) {
    try {
      const file = this.pathFor(sessionId);
      const trash = `${file}.removed`;
      await unlink(trash).catch(() => {
      });
      await rename(file, trash);
    } catch {
    }
  }
};

// src/engine-shared.ts
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join as join2 } from "node:path";
import { BlockAssembler, LlmError, contentHasImage, createUserMessage } from "@deepseek-ai/dsh-llm";
function conversationTarget(agent) {
  const config = agent.session.requestHeader()?.config;
  if (config !== void 0 && config.provider.length > 0 && config.model.length > 0) {
    return { provider: config.provider, model: config.model };
  }
  if (agent.options.provider !== void 0 && agent.options.provider.length > 0 && agent.options.model !== void 0 && agent.options.model.length > 0) {
    return { provider: agent.options.provider, model: agent.options.model };
  }
  return void 0;
}
function globMatch(pattern, value) {
  if (pattern === "*" || pattern === value) return true;
  const regex = new RegExp(
    `^${pattern.split("*").map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&")).join(".*")}$`.replace(/\?/g, ".")
  );
  return regex.test(value);
}
function defaultStateDir() {
  const home = process.env.DSH_HOME?.trim() || join2(homedir(), ".dsh");
  return join2(home, "plugins", "dsh-blackhole", "state");
}
function resolveInstallationId(stateDir) {
  const file = join2(stateDir, "..", "installation_id");
  try {
    if (existsSync(file)) {
      const existing = readFileSync(file, "utf8").trim();
      if (/^[0-9a-fA-F-]{36}$/.test(existing)) return existing.toLowerCase();
    }
    const installationId = randomUUID();
    try {
      writeFileSync(file, installationId);
    } catch {
    }
    return installationId;
  } catch {
    return void 0;
  }
}
var COMPACTION_INSTRUCTION = [
  "Compress the conversation above into a durable checkpoint for a later request.",
  "Keep every fact, path, command, decision, and unresolved issue that the next",
  "request may need. Preserve exact identifiers (paths, package names, keys,",
  "error codes) verbatim \u2014 never paraphrase or guess them. Use concise prose",
  "with short bullet lists. Do not invent anything that is not in the",
  'conversation. End with a "Pending" section listing unfinished work.'
].join(" ");
function finishError(finish) {
  switch (finish.kind) {
    case "error":
    case "aborted": {
      const error = new Error(finish.failure?.message ?? "stream failed");
      if (finish.failure?.code !== void 0) error.code = finish.failure.code;
      return error;
    }
    case "max-tokens": {
      const error = new Error("summarization truncated at the token cap (incomplete checkpoint)");
      error.code = "MAX_TOKENS";
      return error;
    }
    default:
      return void 0;
  }
}
function summaryText(blocks) {
  if (contentHasImage(blocks)) {
    throw new LlmError("compaction summary cannot contain image output", "UNSUPPORTED_CONTENT");
  }
  return blocks.filter((block) => block.type === "text");
}
async function summarizeWithLlm(ctx, config, input, agent, signal) {
  const latest = agent.session.requestHeader()?.config;
  const configured = config.summarizationProvider !== void 0 && config.summarizationProvider.length > 0 ? { provider: config.summarizationProvider, model: config.summarizationModel ?? "" } : void 0;
  const agentTarget = agent.options.provider !== void 0 && agent.options.provider.length > 0 && agent.options.model !== void 0 && agent.options.model.length > 0 ? { provider: agent.options.provider, model: agent.options.model } : void 0;
  const target = configured ?? latest ?? agentTarget;
  if (target === void 0 || target.model.length === 0) {
    throw new Error(
      "no provider/model available for LLM summarization: set the summarization fields, route one request, or set both AgentOptions fields"
    );
  }
  const assembler = new BlockAssembler();
  const messages = [...input.messages, createUserMessage({
    content: [{ type: "text", text: COMPACTION_INSTRUCTION }],
    source: { kind: "plugin", plugin: "dsh-blackhole" }
  })];
  const options = {
    provider: target.provider,
    model: target.model,
    messages,
    ...input.system === void 0 ? {} : { system: input.system },
    ...input.tools === void 0 ? {} : { tools: [...input.tools] },
    maxTokens: config.maxTokens ?? 8192,
    sessionId: agent.session.id,
    purpose: "compaction",
    ...signal === void 0 ? {} : { signal }
  };
  for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk);
  const error = finishError(assembler.finish);
  if (error !== void 0) throw error;
  const rawOutput = assembler.blocks();
  const summary = summaryText(rawOutput);
  if (!summary.some((block) => block.type === "text" && block.text.trim().length > 0)) {
    throw new Error("summarization produced no text summary content");
  }
  return {
    summary,
    rawOutput,
    llmStreamCall: true,
    provider: options.provider,
    model: options.model,
    maxTokens: options.maxTokens,
    ...assembler.usage === void 0 ? {} : { usage: assembler.usage }
  };
}

// src/instant.ts
var TOKEN_RE = /[a-zA-Z]+|[0-9]+|[^\sa-zA-Z0-9]|\s+/g;
function isHighSurrogate(code) {
  return code >= 55296 && code <= 56319;
}
function completeCodePointAtEnd(text) {
  return isHighSurrogate(text.charCodeAt(text.length - 1)) ? text.slice(0, -1) : text;
}
var ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
var CTRL_RE = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
function tokenize(text) {
  return text.match(TOKEN_RE) ?? [];
}
function countTokens(text) {
  let count = 0;
  for (const token of tokenize(text)) if (token.trim().length > 0) count += 1;
  return count;
}
function estimateEntryTokens(text) {
  return Math.max(countTokens(text), Math.ceil(text.length / 4));
}
function sanitize(text) {
  if (typeof text !== "string") return "";
  let out = text;
  if (out.includes("\r")) out = out.replaceAll("\r", "");
  if (out.includes("\x1B")) out = out.replace(ANSI_RE, "");
  return out.replace(CTRL_RE, "");
}
var NOISE_UNWRAP_RE = /<\/?(?:command-name|command-args)>/g;
var DEFAULT_NOISE_PATTERNS = [
  "<ide_opened_file>.*?</ide_opened_file>",
  "<ide_selection>.*?</ide_selection>",
  "<system-reminder>.*?</system-reminder>",
  "<command-message>.*?</command-message>",
  "<task-notification>.*?</task-notification>"
];
function compileNoisePatterns(sources) {
  return sources.map((source, index) => {
    try {
      return new RegExp(source, "s");
    } catch (error) {
      throw new Error(
        `noisePatterns[${index}] (${JSON.stringify(source)}) is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });
}
function stripNoiseXml(text, patterns) {
  let out = text;
  for (const pattern of patterns) out = out.replace(pattern, "");
  out = out.replace(NOISE_UNWRAP_RE, "");
  return out.trim();
}
function truncateTokens(text, limit, ref) {
  const tokens = tokenize(text);
  let count = 0;
  let cut = tokens.length;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.trim().length === 0) continue;
    count += 1;
    if (count > limit) {
      cut = index;
      break;
    }
  }
  let out = cut >= tokens.length ? text : tokens.slice(0, cut).join("");
  let truncated = cut < tokens.length;
  const maxChars = Math.max(32, limit * 4);
  if (out.length > maxChars) {
    out = completeCodePointAtEnd(out.slice(0, maxChars));
    truncated = true;
  } else if (truncated) {
    out = completeCodePointAtEnd(out);
  }
  if (!truncated) {
    return { text: text.replace(/\s+/g, " ").trim(), truncated: false };
  }
  out = out.replace(/\s+$/u, "").replace(/\s+/g, " ").trim();
  const note = ref === void 0 ? "...(truncated)" : `...(truncated from ${ref})`;
  return { text: out + note, truncated: true };
}
var DEFAULT_TOOL_KEY_FIELDS = Object.freeze({
  read: "file_path",
  edit: "file_path",
  write: "file_path",
  glob: "pattern",
  grep: "pattern",
  bash: "command",
  Read: "file_path",
  Edit: "file_path",
  Write: "file_path",
  Glob: "pattern",
  Grep: "pattern",
  web_search: "query",
  skill: "name",
  ralph: "objective",
  subagent: "description",
  subagent_fork: "description",
  create_goal: "objective",
  update_goal: "objective",
  workflow: "name",
  interrupt_agent: "agent_id",
  job_kill: "job_id",
  job_output: "job_id",
  send_message: "message"
});
var DEFAULT_ARG_TOOLS = [
  "read",
  "write",
  "edit",
  "glob",
  "grep",
  "bash",
  "shell",
  "web_search",
  "skill",
  "subagent",
  "subagent_fork",
  "ralph",
  "workflow",
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep"
];
var PATH_KEYS = ["path", "file_path", "filePath", "file"];
function parseToolArguments(arguments_) {
  if (typeof arguments_ !== "string") return null;
  try {
    return JSON.parse(arguments_);
  } catch {
    return null;
  }
}
function pickToolKeyArg(name, parsed, keyFields) {
  const key = keyFields[name];
  if (key !== void 0 && parsed !== null && typeof parsed[key] === "string") {
    return parsed[key];
  }
  if (parsed !== null) {
    for (const pathKey of PATH_KEYS) {
      if (typeof parsed[pathKey] === "string") return parsed[pathKey];
    }
    for (const value of Object.values(parsed)) {
      if (typeof value === "string") return value;
    }
  }
  return void 0;
}
function clipArg(arg) {
  const clean = arg.replace(/[\r\n\t]+/g, " ").trim();
  if (clean.length <= 100) return clean;
  return `${clean.slice(0, 60)}...${clean.slice(-30)}`;
}
var SELF_TALK_PREFIX_RE = /^\s*(?:hmm|wait|actually|oh|okay|ok|well|so)[,.!\s-]+/i;
function stripSelfTalkPrefix(text, max = 2) {
  let out = text;
  for (let i = 0; i < max; i++) {
    const stripped = out.replace(SELF_TALK_PREFIX_RE, "");
    if (stripped === out) break;
    out = stripped;
  }
  return out;
}
var SKILL_BLOCK_RE = /<skill\s+name="([^"]+)"[^>]*>[\s\S]*?(?:<\/skill>|$)/g;
function collapseSkillText(text) {
  return text.replace(SKILL_BLOCK_RE, (_, name) => `[skill: ${name}]`);
}
var PIPE_TAIL_RE = /\s*\|\s*(?:head|tail|sort|wc|column|tr|cut|uniq)(?:\s[^|]*)?$/;
function compressBash(raw, cap = 120) {
  let cmd = raw.split("\n").map((line) => line.trim()).filter(Boolean).join("; ");
  cmd = cmd.replace(/^cd\s+\S+\s*&&\s*/, "");
  for (let i = 0; i < 10; i++) {
    const stripped = cmd.replace(PIPE_TAIL_RE, "");
    if (stripped === cmd) break;
    cmd = stripped;
  }
  if (cmd.length > cap) {
    const cut = cmd.lastIndexOf(" ", cap - 2);
    const end = cut > cap * 0.6 ? cut : cap - 3;
    return cmd.slice(0, end).trimEnd() + "...";
  }
  return cmd;
}
function firstLineOf(text, max) {
  const line = (text.split("\n")[0] ?? "").trim();
  if (line.length <= max) return line;
  const cut = line.lastIndexOf(" ", max);
  return line.slice(0, cut > max * 0.6 ? cut : max);
}
function imageLabel(block) {
  const mime = block.mediaType ?? block.attachment?.mediaType;
  return mime === void 0 || mime.length === 0 ? "[image]" : `[image: ${mime}]`;
}
function projectToolResultText(blocks) {
  const parts = [];
  const visit = (block) => {
    if (block.type === "text") {
      const text = sanitize(block.text ?? "");
      if (text.length > 0) parts.push(text);
    } else if (block.type === "image") parts.push("[image]");
    else if (block.type === "document") parts.push("[document]");
    else if (Array.isArray(block.content) && block.content.length > 0) {
      for (const nested of block.content) visit(nested);
    } else if (block.type === "tool-result") {
      parts.push("[tool-result]");
    } else {
      parts.push(`[${String(block.type)}]`);
    }
  };
  for (const block of blocks) visit(block);
  return parts.join("\n");
}
function isCheckpointSource(source) {
  return source !== void 0 && source.kind === "plugin" && source.plugin === "compact";
}
function seqRef(seq) {
  return `seq ${seq}`;
}
var DEFAULT_INSTANT_OPTIONS = {
  textTokens: 512,
  userTextTokens: 1024,
  toolCallTokens: 128,
  includeReasoning: false,
  stripNoiseXml: true,
  noisePatterns: compileNoisePatterns(DEFAULT_NOISE_PATTERNS),
  toolKeyFields: DEFAULT_TOOL_KEY_FIELDS,
  // Empty = extract the key argument for EVERY tool (pi-blackhole behavior:
  // field map → path-key fallback → first string arg → name-only), not just
  // a whitelist.  A non-empty list opts back into whitelist-only extraction.
  toolArgTools: [],
  hideTools: /* @__PURE__ */ new Set(),
  toolErrorChars: 150,
  bashCap: 120,
  collapseSkills: true,
  stripSelfTalk: true,
  mergeToolLines: true,
  toolsPerTurn: 8
};
function estimateMessagesTokensImpl(messages) {
  let total = 0;
  for (const message of messages) {
    for (const block of message.content ?? []) {
      const serialized = JSON.stringify(block);
      if (serialized !== void 0 && serialized.length > 0) {
        total += Math.ceil(serialized.length / 4);
      }
    }
    total += 2;
  }
  return total;
}
function compileInstantRegion(nodes, options, maxTokens) {
  const stats = {
    nodes: nodes.length,
    entries: 0,
    toolCalls: 0,
    toolResults: 0,
    toolErrors: 0,
    images: 0,
    documents: 0,
    reasoningElided: 0,
    noiseElided: 0,
    checkpoints: 0,
    tokens: 0,
    elidedToolRows: 0,
    elidedRows: 0
  };
  const entries = [];
  const estimated = /* @__PURE__ */ new Map();
  const pushEntry = (seq, text, kind) => {
    const entry = { seq, text, kind };
    const tokens = estimateEntryTokens(text);
    estimated.set(entry, tokens);
    entries.push(entry);
    stats.entries += 1;
    stats.tokens += tokens;
  };
  const resultSeqByCallId = /* @__PURE__ */ new Map();
  const callNameByCallId = /* @__PURE__ */ new Map();
  for (const node of nodes) {
    const message = node.message;
    if (message === null || message === void 0 || message.content === void 0) continue;
    for (const block of message.content) {
      if (block.type === "tool-call" && typeof block.id === "string") {
        if (typeof block.name === "string" && block.name.length > 0) {
          callNameByCallId.set(block.id, block.name);
        }
      } else if (block.type === "tool-result" && typeof block.toolCallId === "string") {
        resultSeqByCallId.set(block.toolCallId, node.seq);
      }
    }
  }
  const effective = {
    textTokens: Math.max(1, options.textTokens),
    userTextTokens: Math.max(1, options.userTextTokens),
    toolCallTokens: Math.max(1, options.toolCallTokens)
  };
  const hiddenTools = options.hideTools;
  const argTools = new Set(options.toolArgTools);
  let lastRole;
  let open = false;
  const roleHeader = (role) => {
    if (!open || lastRole !== role) {
      open = true;
      lastRole = role;
      return `[${role}]
`;
    }
    return "";
  };
  for (const node of nodes) {
    const message = node.message;
    if (message === null || message === void 0 || message.content === void 0) continue;
    if (message.role === "assistant") {
      let header = "";
      for (const block of message.content) {
        if (block.type === "text") {
          const text = sanitize(block.text ?? "");
          if (text.trim().length === 0) continue;
          header = roleHeader("assistant");
          const cleaned = options.stripSelfTalk === false ? text : stripSelfTalkPrefix(text);
          const kept = truncateTokens(cleaned, effective.textTokens, seqRef(node.seq));
          pushEntry(node.seq, header + kept.text, "text");
          continue;
        }
        if (block.type === "reasoning") {
          if (options.includeReasoning !== true) {
            stats.reasoningElided += 1;
            continue;
          }
          const text = sanitize(block.text ?? "");
          if (text.trim().length === 0) continue;
          header = roleHeader("assistant");
          const kept = truncateTokens(text, effective.textTokens, seqRef(node.seq));
          pushEntry(node.seq, header + kept.text, "reasoning");
          continue;
        }
        if (block.type === "tool-call") {
          const name = block.name ?? "unknown";
          stats.toolCalls += 1;
          if (hiddenTools.has(name)) continue;
          const resultSeq = resultSeqByCallId.get(block.id ?? "");
          const ref = resultSeq === void 0 ? seqRef(node.seq) : `${seqRef(node.seq)} -> result ${resultSeq}`;
          const bashCap = options.bashCap ?? 120;
          if ((name === "bash" || name === "Bash") && bashCap > 0) {
            const parsed = parseToolArguments(block.arguments);
            const raw = parsed !== null && typeof parsed.command === "string" ? parsed.command : parsed !== null && typeof parsed.description === "string" ? parsed.description : "";
            const cmd = compressBash(raw, bashCap);
            if (cmd.length === 0) continue;
            header = roleHeader("assistant");
            pushEntry(node.seq, header + `* bash "${cmd}" (${ref})`, "tool");
            continue;
          }
          header = roleHeader("assistant");
          let oneLine;
          if (argTools.size > 0 && !argTools.has(name)) {
            oneLine = `* ${name}`;
          } else {
            const parsed = parseToolArguments(block.arguments);
            const arg = pickToolKeyArg(name, parsed, options.toolKeyFields);
            oneLine = arg === void 0 || arg.length === 0 ? `* ${name}` : `* ${name} "${clipArg(arg)}"`;
          }
          const kept = truncateTokens(oneLine, effective.toolCallTokens, seqRef(node.seq));
          pushEntry(node.seq, header + `${kept.text} (${ref})`, "tool");
          continue;
        }
        if (block.type === "image") {
          stats.images += 1;
          header = roleHeader("assistant");
          pushEntry(node.seq, header + `${imageLabel(block)} (${seqRef(node.seq)})`, "media");
          continue;
        }
        if (block.type === "document") {
          stats.documents += 1;
          header = roleHeader("assistant");
          pushEntry(node.seq, header + `[document] (${seqRef(node.seq)})`, "media");
          continue;
        }
        header = roleHeader("assistant");
        pushEntry(node.seq, header + `[${String(block.type)}] (${seqRef(node.seq)})`, "media");
      }
      continue;
    }
    if (message.role === "user") {
      const firstBlock = message.content[0];
      if (firstBlock !== void 0 && firstBlock.type === "tool-result") {
        if (typeof firstBlock.toolCallId === "string") {
          resultSeqByCallId.set(firstBlock.toolCallId, node.seq);
        }
        stats.toolResults += 1;
        const errorChars = options.toolErrorChars ?? 150;
        if (errorChars > 0 && firstBlock.isError === true) {
          const body = firstLineOf(projectToolResultText(message.content), errorChars);
          if (body.length > 0 && body !== "(no output)") {
            const toolName = typeof firstBlock.toolCallId === "string" ? callNameByCallId.get(firstBlock.toolCallId) ?? "tool" : "tool";
            stats.toolErrors += 1;
            pushEntry(
              node.seq,
              `[tool_error] ${toolName} (${seqRef(node.seq)})
${body}`,
              "tool-error"
            );
            open = false;
            lastRole = void 0;
          }
        }
        continue;
      }
      if (isCheckpointSource(message.source)) {
        stats.checkpoints += 1;
        const text = projectToolResultText(message.content);
        if (text.length > 0) {
          const header2 = roleHeader("system");
          pushEntry(node.seq, header2 + text, "checkpoint");
        }
        continue;
      }
      let surviving = 0;
      let header = "";
      for (const block of message.content) {
        if (block.type === "text") {
          let text = sanitize(block.text ?? "");
          if (options.stripNoiseXml !== false) text = stripNoiseXml(text, options.noisePatterns);
          if (options.collapseSkills !== false) text = collapseSkillText(text);
          if (text.length === 0) continue;
          surviving += 1;
          header = roleHeader("user");
          const kept = truncateTokens(text, effective.userTextTokens, seqRef(node.seq));
          pushEntry(node.seq, header + kept.text, "text");
        } else if (block.type === "image") {
          stats.images += 1;
          surviving += 1;
          header = roleHeader("user");
          pushEntry(node.seq, header + `${imageLabel(block)} (${seqRef(node.seq)})`, "media");
        } else if (block.type === "document") {
          stats.documents += 1;
          surviving += 1;
          header = roleHeader("user");
          pushEntry(node.seq, header + `[document] (${seqRef(node.seq)})`, "media");
        } else {
          const text = sanitize(block.text ?? "");
          if (text.length === 0) continue;
          surviving += 1;
          header = roleHeader("user");
          const kept = truncateTokens(text, effective.userTextTokens, seqRef(node.seq));
          pushEntry(node.seq, header + kept.text, "text");
        }
      }
      if (surviving === 0) {
        stats.noiseElided += 1;
        pushEntry(
          node.seq,
          `${roleHeader("user")}* [user message elided: noise-only] (${seqRef(node.seq)})`,
          "note"
        );
      }
    }
  }
  if (entries.length > 0) {
    const toolsPerTurn = options.toolsPerTurn ?? 8;
    const merge = options.mergeToolLines !== false;
    if (toolsPerTurn > 0 || merge) {
      const segments = [];
      let curRole = "";
      let items = [];
      for (const entry of entries) {
        const headerMatch = entry.text.match(/^\[(user|assistant|system)\]\n/);
        if (headerMatch !== null) {
          if (items.length > 0) segments.push({ role: curRole, items });
          curRole = headerMatch[1];
          items = [];
        }
        items.push(entry);
      }
      if (items.length > 0) segments.push({ role: curRole, items });
      const processed = [];
      const TOOL_ROW_RE = /^(\[user\]\n|\[assistant\]\n|\[system\]\n)?(\* .*?) \((seq [^)]*)\)$/;
      const MERGED_ROW_RE = /^(\[user\]\n|\[assistant\]\n|\[system\]\n)?(\* .*?) \((.+)\) x(\d+)$/;
      for (const segment of segments) {
        if (segment.role === "assistant" && toolsPerTurn > 0) {
          const toolIdxs = [];
          segment.items.forEach((entry, index) => {
            if (entry.kind === "tool" && /(^|\n)\* /.test(entry.text)) toolIdxs.push(index);
          });
          if (toolIdxs.length > toolsPerTurn) {
            const dropCount = toolIdxs.length - toolsPerTurn;
            const dropSet = new Set(toolIdxs.slice(0, dropCount));
            const firstKept = toolIdxs[dropCount];
            const firstDropped = toolIdxs[0];
            const droppedHeader = segment.items[firstDropped]?.text.match(/^(\[user\]\n|\[assistant\]\n|\[system\]\n)/)?.[1] ?? "";
            const next = [];
            let inserted = false;
            for (let index = 0; index < segment.items.length; index++) {
              if (dropSet.has(index)) continue;
              if (!inserted && index === firstKept) {
                next.push({
                  seq: segment.items[firstDropped]?.seq ?? -1,
                  text: `${droppedHeader}* (${dropCount} earlier tool-call entries omitted)`,
                  kind: "note"
                });
                inserted = true;
              }
              next.push(segment.items[index]);
            }
            segment.items = next;
            stats.elidedToolRows += dropCount;
            stats.elidedRows += dropCount;
          }
        }
        if (merge) {
          const merged = [];
          for (const entry of segment.items) {
            if (entry.kind !== "tool") {
              merged.push(entry);
              continue;
            }
            const m = entry.text.match(TOOL_ROW_RE);
            if (m === null) {
              merged.push(entry);
              continue;
            }
            const base = m[2];
            const ref = m[3];
            const last = merged[merged.length - 1];
            const acc = last !== void 0 && last.kind === "tool" ? last.text.match(MERGED_ROW_RE) : null;
            const lastRow = last !== void 0 && last.kind === "tool" ? last.text.match(TOOL_ROW_RE) : null;
            if (acc !== null && acc[2] === base) {
              const plainRef = ref.split(" -> ")[0];
              merged[merged.length - 1] = {
                seq: last.seq,
                text: `${acc[1] ?? ""}${base} (${acc[3]}, ${plainRef}) x${parseInt(acc[4], 10) + 1}`,
                kind: "tool"
              };
            } else if (lastRow !== null && lastRow[2] === base) {
              const plainRef = ref.split(" -> ")[0];
              const lastRef = lastRow[3].split(" -> ")[0];
              merged[merged.length - 1] = {
                seq: last.seq,
                text: `${lastRow[1] ?? ""}${base} (${lastRef}, ${plainRef}) x2`,
                kind: "tool"
              };
            } else {
              merged.push(entry);
            }
          }
          segment.items = merged;
        }
        processed.push(...segment.items);
      }
      entries.length = 0;
      entries.push(...processed);
      estimated.clear();
      let total2 = 0;
      for (const entry of entries) {
        const tokens = estimateEntryTokens(entry.text);
        estimated.set(entry, tokens);
        total2 += tokens;
      }
      stats.entries = entries.length;
      stats.tokens = total2;
    }
  }
  let total = stats.tokens;
  let capped = false;
  if (total > maxTokens && entries.length > 0) {
    capped = true;
    const priority = (kind) => kind === "tool" || kind === "media" || kind === "note" ? 0 : 1;
    const order = entries.map((entry, index) => ({ entry, index })).sort((a, b) => priority(a.entry.kind) - priority(b.entry.kind) || a.index - b.index);
    const removed = [];
    while (total > maxTokens && order.length > 1) {
      const next = order.shift();
      if (next === void 0) break;
      const entry = next.entry;
      total -= estimated.get(entry) ?? 0;
      removed.push(entry);
      if (entry.kind === "tool") stats.elidedToolRows += 1;
      stats.elidedRows += 1;
    }
    if (removed.length > 0) {
      const removedSet = new Set(removed);
      const retained = entries.filter((entry) => !removedSet.has(entry));
      entries.length = 0;
      entries.push(...retained);
      stats.entries = entries.length;
    }
    if (removed.length > 0 && total + 24 <= maxTokens && entries.length > 0) {
      const seqs = removed.map((entry) => entry.seq).filter((seq) => seq >= 0).sort((a, b) => a - b);
      const span = seqs.length === 0 ? "" : seqs[0] === seqs[seqs.length - 1] ? `seq ${seqs[0]}` : `seqs ${seqs[0]}-${seqs[seqs.length - 1]}`;
      const kindLabel = stats.elidedToolRows > 0 ? "tool/result" : "earlier";
      const noteText = removed.length === 1 ? `[1 ${kindLabel} entry elided: ${span}]` : `[${removed.length} ${kindLabel} entries elided: ${span}]`;
      const tokens = estimateEntryTokens(noteText);
      entries.unshift({ seq: -1, text: noteText, kind: "note" });
      stats.entries = entries.length;
      stats.tokens = total + tokens;
    } else {
      stats.tokens = total;
    }
  }
  return { entries, stats, capped };
}
function joinInstantEntries(entries) {
  return entries.map((entry) => entry.text).join("\n");
}
function estimateMessagesTokens(messages) {
  return estimateMessagesTokensImpl(messages);
}

// src/blackhole-summary.ts
var BLACKHOLE_RECALL_NOTE = "The conversation before this point has been compacted into the summary above. Details not captured here \u2014 exact code, error messages, file paths \u2014 are only recoverable via `recall`. Use `recall` to search the session history. Do not redo work already completed.";
var SECTION_NAMES = [
  "Session Goal",
  "Files And Changes",
  "Commits",
  "Outstanding Context",
  "User Preferences"
];
var SUMMARY_SEPARATOR = "\n\n---\n\n";
var DEFAULT_NOISE_TOOLS = /* @__PURE__ */ new Set([
  "TodoWrite",
  "TodoRead",
  "ToolSearch",
  "WebSearch",
  "AskUser",
  "ExitSpecMode",
  "GenerateDroid",
  "todo/write",
  "todo/read"
]);
var DEFAULT_NOISE_STRINGS = [
  "Continue from where you left off.",
  "No response requested.",
  "IMPORTANT: TodoWrite was not called yet."
];
var DEFAULT_NOISE_XML = /<(?:system-reminder|ide_opened_file|command-message|context-window-usage|task-notification)[^>]*>[\s\S]*?<\/(?:system-reminder|ide_opened_file|command-message|context-window-usage|task-notification)>/gi;
var BLOCKER_RE = /\b(fail(?:ed|s|ure|ing)?|broken|cannot|can't|won't work|does not work|doesn't work|still (?:broken|failing|wrong)|blocked|blocker|not (?:fixed|resolved|working)|crash(?:es|ed|ing)?)\b/i;
var TASK_RE = /\b(fix|implement|add|create|build|refactor|debug|investigate|update|remove|delete|migrate|deploy|test|write|set up)\b/i;
var SCOPE_CHANGE_RE = /\b(instead|actually|change of plan|forget that|new task|switch to|now I want|pivot|let'?s do|stop .* and)\b/i;
var PREFERENCE_RE = /\b(prefer|please use|always|never|do not|don't|avoid|要求|必须|不要|偏好|优先)\b/i;
var PATH_KEYS2 = ["path", "file_path", "filePath", "file", "filename", "target"];
var READ_TOOLS = /* @__PURE__ */ new Set(["read", "read_file", "Read", "View", "cat", "glob", "grep"]);
var WRITE_TOOLS = /* @__PURE__ */ new Set(["edit", "write", "Edit", "Write", "MultiEdit", "edit_file", "write_file"]);
var asText = (value) => typeof value === "string" ? value : "";
var flattenText = (blocks) => (blocks ?? []).map((block) => {
  if (block.type === "text" || block.type === "reasoning") return asText(block.text);
  if (block.type === "tool-result") return flattenText(block.content);
  return "";
}).filter(Boolean).join("\n");
var sanitize2 = (text) => text.replaceAll("\r", "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "").trim();
var parseArguments = (args) => {
  if (args !== void 0 && typeof args === "object") return args;
  if (typeof args !== "string") return void 0;
  try {
    const parsed = JSON.parse(args);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : void 0;
  } catch {
    return void 0;
  }
};
var firstString = (value, keys) => {
  if (value === void 0) return void 0;
  for (const key of keys) {
    if (typeof value[key] === "string" && value[key].trim()) return value[key];
  }
  return void 0;
};
var clip = (text, max) => {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, Math.max(0, max - 1)).trimEnd()}\u2026`;
};
var linesOf = (text) => text.split("\n").map((line) => line.trim()).filter(Boolean);
var seqLabel = (seq) => seq >= 0 ? ` (seq ${seq})` : "";
function normalizeBlackholeMessages(messages, seqs = []) {
  const toolNames = /* @__PURE__ */ new Map();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.content ?? []) {
      if (block.type === "tool-call" && typeof block.id === "string" && typeof block.name === "string") {
        toolNames.set(block.id, block.name);
      }
    }
  }
  const normalized = [];
  messages.forEach((message, messageIndex) => {
    if (message.source?.kind === "plugin" && message.source.plugin === "compact") return;
    const seq = seqs[messageIndex] ?? -1;
    const role = message.role === "assistant" ? "assistant" : "user";
    for (const block of message.content ?? []) {
      switch (block.type) {
        case "text": {
          const text = sanitize2(asText(block.text));
          if (text) normalized.push({ kind: role, text, seq, messageIndex });
          break;
        }
        case "reasoning": {
          const text = sanitize2(asText(block.text));
          if (text) normalized.push({ kind: "thinking", text, seq, messageIndex });
          break;
        }
        case "tool-call":
          normalized.push({
            kind: "tool-call",
            text: "",
            seq,
            messageIndex,
            name: typeof block.name === "string" ? block.name : "unknown",
            args: block.arguments,
            callId: typeof block.id === "string" ? block.id : void 0
          });
          break;
        case "tool-result": {
          const toolCallId = typeof block.toolCallId === "string" ? block.toolCallId : void 0;
          normalized.push({
            kind: "tool-result",
            text: sanitize2(flattenText(block.content)),
            seq,
            messageIndex,
            name: toolCallId === void 0 ? void 0 : toolNames.get(toolCallId),
            toolCallId,
            isError: block.isError
          });
          break;
        }
        case "image":
        case "document":
          normalized.push({ kind: role, text: `[${block.type}]`, seq, messageIndex });
          break;
        default:
          if (role === "user" && typeof block.text === "string") {
            const text = sanitize2(block.text);
            if (text) normalized.push({ kind: "user", text, seq, messageIndex });
          }
          break;
      }
    }
  });
  return normalized;
}
function filterBlackholeNoise(blocks, noisePatterns = []) {
  const patterns = noisePatterns.length > 0 ? noisePatterns : [DEFAULT_NOISE_XML];
  return blocks.flatMap((block) => {
    if (block.kind === "thinking") return [];
    if ((block.kind === "tool-call" || block.kind === "tool-result") && block.name !== void 0 && DEFAULT_NOISE_TOOLS.has(block.name)) return [];
    if (block.kind !== "user") return [block];
    if (DEFAULT_NOISE_STRINGS.some((noise) => block.text.includes(noise))) return [];
    let text = block.text;
    for (const pattern of patterns) text = text.replace(pattern, "");
    text = text.replace(/<\/?(?:command-name|command-args)>/gi, "").trim();
    return text ? [{ ...block, text }] : [];
  });
}
var extractGoals = (blocks) => {
  const goals = [];
  let latestScope;
  let latestScopeSeq = -1;
  for (const block of blocks) {
    if (block.kind !== "user") continue;
    const candidates = linesOf(block.text).filter((line) => line.length > 5 && line.length <= 220).filter((line) => !/^```|^(?:https?:|file:|\/)/i.test(line)).map((line) => line.replace(/^\s*[-*+\d.]+\s+/, "").trim());
    if (candidates.length === 0) continue;
    if (goals.length === 0) goals.push(...candidates.slice(0, 6).map((line) => clip(line, 120)));
    if (SCOPE_CHANGE_RE.test(block.text) || TASK_RE.test(block.text.slice(0, 220))) {
      latestScope = candidates.slice(0, 3).map((line) => clip(line, 180));
      latestScopeSeq = block.seq;
    }
  }
  if (latestScope !== void 0 && latestScope.length > 0 && goals.length > latestScope.length) {
    goals.push("[Scope change]", ...latestScope.map((line) => `${line}${seqLabel(latestScopeSeq)}`));
  }
  return [...new Set(goals)].slice(0, 8);
};
var extractFiles = (blocks) => {
  const read = /* @__PURE__ */ new Set();
  const modified = /* @__PURE__ */ new Set();
  const addPath = (target, path) => {
    const normalized = path?.replaceAll("\\", "/").trim();
    if (normalized) target.add(normalized);
  };
  for (const block of blocks) {
    if (block.kind !== "tool-call" || block.name === void 0) continue;
    const args = parseArguments(block.args);
    const path = firstString(args, PATH_KEYS2);
    if (READ_TOOLS.has(block.name)) addPath(read, path);
    if (WRITE_TOOLS.has(block.name)) addPath(modified, path);
    if ((block.name === "bash" || block.name === "shell") && typeof block.args === "string") {
      const command = block.args;
      const matches = command.match(/(?:^|\s)(?:cat|sed|rg|grep|git\s+diff)\s+(?:[^\s]+\s+)*([\w./\\-]+\.[\w-]+)/g) ?? [];
      for (const match of matches) addPath(read, match.split(/\s+/).at(-1));
    }
  }
  for (const path of modified) read.delete(path);
  const format = (name, values) => values.size > 0 ? `- ${name}: ${[...values].slice(0, 12).join(", ")}${values.size > 12 ? ` (+${values.size - 12} more)` : ""}` : "";
  return [format("Modified", modified), format("Read", read)].filter(Boolean);
};
var extractCommits = (blocks) => {
  const commits = [];
  for (const block of blocks) {
    const raw = block.kind === "tool-call" ? block.args : block.text;
    const text = typeof raw === "string" ? raw : JSON.stringify(raw ?? "");
    if (!/git\s+commit\b/i.test(text)) continue;
    const message = text.match(/(?:-m|--message)\s+["']([^"']+)["']/i)?.[1];
    commits.push(message ? clip(message, 160) : clip(text, 160));
  }
  return [...new Set(commits)].slice(-8);
};
var extractOutstanding = (blocks) => {
  const items = [];
  for (const block of blocks.slice(-20)) {
    if (block.kind === "tool-result" && block.isError && block.text) {
      items.push(`[${block.name ?? "tool"}] ${clip(block.text, 150)}`);
      continue;
    }
    if (block.kind !== "assistant" && block.kind !== "user") continue;
    for (const line of linesOf(block.text)) {
      if (!BLOCKER_RE.test(line) || line.length < 15) continue;
      const item = `${block.kind === "user" ? "[user] " : ""}${clip(line, 150)}${seqLabel(block.seq)}`;
      if (!items.includes(item)) items.push(item);
      break;
    }
  }
  return items.slice(0, 5);
};
var extractPreferences = (blocks) => {
  const preferences = [];
  for (const block of blocks) {
    if (block.kind !== "user") continue;
    for (const line of linesOf(block.text)) {
      if (!PREFERENCE_RE.test(line) || line.length < 12) continue;
      preferences.push(clip(line.replace(/^[-*]\s+/, ""), 180));
    }
  }
  return [...new Set(preferences)].slice(-15);
};
var renderBrief = (blocks) => {
  const lines = [];
  const resultSeqByCallId = /* @__PURE__ */ new Map();
  for (const block of blocks) {
    if (block.kind === "tool-result" && block.toolCallId !== void 0) {
      resultSeqByCallId.set(block.toolCallId, block.seq);
    }
  }
  let role;
  const openRole = (next) => {
    if (role === next) return "";
    role = next;
    return `[${next}]
`;
  };
  for (const block of blocks) {
    if (block.kind === "tool-result") continue;
    if (block.kind === "tool-call") {
      const args = parseArguments(block.args);
      const key = firstString(args, ["path", "file_path", "filePath", "file", "command", "pattern", "query"]);
      const suffix = key ? ` "${clip(key, 100)}"` : "";
      const resultSeq = block.callId === void 0 ? void 0 : resultSeqByCallId.get(block.callId);
      lines.push(`${openRole("assistant")}* ${block.name ?? "unknown"}${suffix} (seq ${block.seq}${resultSeq !== void 0 ? ` -> result ${resultSeq}` : ""})`);
      continue;
    }
    lines.push(`${openRole(block.kind === "thinking" ? "assistant" : block.kind)}${clip(block.text, 600)}${seqLabel(block.seq)}`);
  }
  return lines.join("\n");
};
var section = (title, items) => items.length === 0 ? "" : `[${title}]
${items.join("\n")}`;
var sectionOf = (text, title) => {
  const marker = `[${title}]`;
  const start = text.indexOf(marker);
  if (start < 0) return "";
  const after = text.slice(start);
  const next = SECTION_NAMES.filter((candidate) => candidate !== title).map((candidate) => after.indexOf(`
[${candidate}]`)).filter((index) => index >= 0);
  const separator = after.indexOf("\n\n---\n\n");
  const end = [...next, separator >= 0 ? separator : Number.MAX_SAFE_INTEGER].sort((a, b) => a - b)[0];
  return after.slice(0, end).trim();
};
var briefOf = (text) => {
  const separator = text.indexOf(SUMMARY_SEPARATOR);
  return separator >= 0 ? text.slice(separator + SUMMARY_SEPARATOR.length).split(/\n\nThe conversation before this point has been compacted/)[0].trim() : SECTION_NAMES.some((title) => text.includes(`[${title}]`)) ? "" : text.trim();
};
var stripPreviousNoise = (text) => text.split(/\n\n+/).filter((paragraph) => !paragraph.includes("The conversation before this point has been compacted")).filter((paragraph) => !/^## (?:Reflections|Observations)/m.test(paragraph)).join("\n\n").trim();
var mergePrevious = (previous, fresh) => {
  if (!previous) return fresh;
  if (!fresh) return previous;
  const headers = SECTION_NAMES.map((title) => {
    const oldSection = sectionOf(previous, title);
    const newSection = sectionOf(fresh, title);
    if (title === "Outstanding Context") return newSection;
    const oldLines = oldSection.split("\n").slice(1).filter(Boolean);
    const newLines = newSection.split("\n").slice(1).filter(Boolean);
    const merged = [.../* @__PURE__ */ new Set([...oldLines, ...newLines])];
    const cap = title === "Session Goal" || title === "Commits" ? 8 : 15;
    return merged.length > 0 ? `[${title}]
${merged.slice(title === "Session Goal" ? 0 : -cap).join("\n")}` : "";
  }).filter(Boolean);
  const previousBrief = briefOf(previous);
  const freshBrief = briefOf(fresh);
  const briefLines = [...previousBrief.split("\n"), ...freshBrief.split("\n")].filter(Boolean).slice(-120);
  if (briefLines.length > 0) headers.push(briefLines.join("\n"));
  return headers.join("\n\n---\n\n");
};
function compileBlackholeSummary(input) {
  const normalized = filterBlackholeNoise(normalizeBlackholeMessages(input.messages, input.seqs), input.noisePatterns);
  const freshBrief = input.briefTranscript?.trim() || renderBrief(normalized);
  const fresh = [
    section("Session Goal", extractGoals(normalized)),
    section("Files And Changes", extractFiles(normalized)),
    section("Commits", extractCommits(normalized)),
    section("Outstanding Context", extractOutstanding(normalized)),
    section("User Preferences", extractPreferences(normalized)),
    freshBrief
  ].filter(Boolean).join("\n\n---\n\n");
  const previous = input.previousSummary ? stripPreviousNoise(input.previousSummary) : "";
  let merged = mergePrevious(previous, fresh);
  if (!merged) return "";
  const maxTokens = Math.max(64, input.maxTokens ?? 8192);
  const footer = `

${BLACKHOLE_RECALL_NOTE}`;
  if (estimateEntryTokens(merged + footer) > maxTokens) {
    const structured = merged.includes("\n\n---\n\n") ? merged.slice(0, merged.indexOf("\n\n---\n\n")) : "";
    const budget = Math.max(16, maxTokens - estimateEntryTokens(structured + footer));
    const brief = briefOf(merged) || merged;
    const clipped = truncateTokens(brief, budget, "summary").text;
    merged = structured ? `${structured}

---

${clipped}` : clipped;
  }
  return `${merged}${footer}`;
}
function previousCheckpointSummary(messages) {
  for (const message of [...messages].reverse()) {
    if (message.source?.kind !== "plugin" || message.source.plugin !== "compact") continue;
    const text = flattenText(message.content);
    if (text.trim()) return text;
  }
  return void 0;
}

// src/recall.ts
var PAGE_SIZE = 5;
var DEFAULT_RECENT = 25;
var PATH_KEYS3 = ["path", "file_path", "filePath", "file", "filename", "target"];
var asRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
var asText2 = (value) => typeof value === "string" ? value : "";
var flattenBlocks = (blocks) => (blocks ?? []).map((block) => {
  if (block.type === "text" || block.type === "reasoning") return asText2(block.text);
  if (block.type === "tool-result") return flattenBlocks(block.content);
  if (block.type === "image") return "[image]";
  if (block.type === "document") return "[document]";
  return "";
}).filter(Boolean).join("\n");
var parseArgs = (value) => {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value;
  if (typeof value !== "string") return void 0;
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return void 0;
  }
};
var filePathFromBlock = (block) => {
  if (block.type !== "tool-call") return void 0;
  const args = parseArgs(block.arguments);
  if (args === void 0) return void 0;
  for (const key of PATH_KEYS3) {
    if (typeof args[key] === "string" && args[key].trim()) return args[key].replaceAll("\\", "/");
  }
  return void 0;
};
var renderMessage = (message, seq) => {
  const role = message.role === "assistant" ? "assistant" : "user";
  const lines = [`[${role}]`];
  const files = [];
  const toolCallIds = [];
  for (const block of message.content ?? []) {
    if (block.type === "text" || block.type === "reasoning") {
      const text = asText2(block.text).trim();
      if (text) lines.push(text);
      continue;
    }
    if (block.type === "tool-call") {
      const name = typeof block.name === "string" ? block.name : "unknown";
      const args = parseArgs(block.arguments);
      const path = filePathFromBlock(block);
      if (path !== void 0) files.push(path);
      if (typeof block.id === "string") toolCallIds.push(block.id);
      const argumentText = args === void 0 ? asText2(block.arguments) : JSON.stringify(args);
      lines.push(`* ${name}${argumentText ? ` ${argumentText}` : ""}`);
      continue;
    }
    if (block.type === "tool-result") {
      const toolCallId = typeof block.toolCallId === "string" ? block.toolCallId : "";
      if (toolCallId) toolCallIds.push(toolCallId);
      lines.push(`[tool-result${block.isError ? " error" : ""}] ${flattenBlocks(block.content) || "(empty)"}`);
      continue;
    }
    if (block.type === "image" || block.type === "document") lines.push(`[${block.type}]`);
  }
  lines.push(`(seq ${seq})`);
  return { text: lines.join("\n"), files: [...new Set(files)], toolCallIds: [...new Set(toolCallIds)] };
};
function indexRecallSession(session) {
  return session.events.flatMap((event) => {
    if (!Number.isSafeInteger(event.seq)) return [];
    const message = session.deriveEventMessage(event);
    if (message === null) return [];
    const rendered = renderMessage(message, event.seq);
    return [{
      seq: event.seq,
      id: typeof message.id === "string" ? message.id : `seq-${event.seq}`,
      message,
      ...rendered
    }];
  });
}
var normalizeQuery = (query) => (query ?? "").trim();
var isRegexQuery = (query) => /^\/.+\/[a-z]*$/i.test(query);
var regexFromQuery = (query) => {
  if (!isRegexQuery(query)) return void 0;
  const match = query.match(/^\/(.+)\/([a-z]*)$/i);
  if (!match) return void 0;
  try {
    return new RegExp(match[1], match[2].includes("i") ? match[2] : `${match[2]}i`);
  } catch {
    return void 0;
  }
};
var termsOf = (query) => query.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
function rankRecallEntries(entries, query) {
  const normalized = normalizeQuery(query);
  if (!normalized) return [...entries];
  const regex = regexFromQuery(normalized);
  if (regex !== void 0) return entries.filter((entry) => {
    regex.lastIndex = 0;
    return regex.test(entry.text);
  });
  const terms = termsOf(normalized);
  if (terms.length === 0) return [];
  const documentFrequency = /* @__PURE__ */ new Map();
  const tokenSets = entries.map((entry) => new Set(termsOf(entry.text)));
  for (const tokenSet of tokenSets) for (const term of terms) if (tokenSet.has(term)) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  const averageLength = entries.length === 0 ? 1 : entries.reduce((sum, entry) => sum + termsOf(entry.text).length, 0) / entries.length;
  const scored = entries.map((entry, index) => {
    const tokens = termsOf(entry.text);
    const counts = /* @__PURE__ */ new Map();
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
    const score = terms.reduce((total, term) => {
      const frequency = counts.get(term) ?? 0;
      if (frequency === 0) return total;
      const idf = Math.log(1 + (entries.length - (documentFrequency.get(term) ?? 0) + 0.5) / ((documentFrequency.get(term) ?? 0) + 0.5));
      const lengthNorm = 1 + 0.75 * (tokens.length / Math.max(1, averageLength) - 1);
      return total + idf * (frequency * 2.2 / (frequency + 1.2 * lengthNorm));
    }, 0) + (entry.text.toLocaleLowerCase().includes(normalized.toLocaleLowerCase()) ? 1 : 0);
    return { entry, score, index };
  });
  return scored.filter((item) => item.score > 0).sort((a, b) => b.score - a.score || a.index - b.index).map((item) => item.entry);
}
var parseDrillDown = (query) => {
  const match = query.match(/^#(\d+)(?::(.+))?$/);
  if (!match) return void 0;
  let path = match[2];
  let offset;
  let limit;
  if (path?.endsWith(":full")) path = path.slice(0, -5);
  else {
    const page = path?.match(/^(.*):(\d+):(\d+)$/);
    if (page) {
      path = page[1];
      offset = Number(page[2]);
      limit = Number(page[3]);
    }
  }
  return { seq: Number(match[1]), path: path?.trim() || void 0, offset, limit };
};
var formatTouched = (entries) => {
  const files = /* @__PURE__ */ new Map();
  for (const entry of entries) for (const file of entry.files) files.set(file, [...files.get(file) ?? [], entry.seq]);
  if (files.size === 0) return "No touched files found.";
  return [...files.entries()].map(([file, seqs]) => `- ${file} (seqs ${seqs.join(", ")})`).join("\n");
};
function recallSession(session, params = {}) {
  const allEntries = indexRecallSession(session);
  const allowedSeqs = params.scope === "all" || session.lineageSeqs === void 0 ? void 0 : new Set(session.lineageSeqs);
  const scoped = allowedSeqs === void 0 ? allEntries : allEntries.filter((entry) => allowedSeqs.has(entry.seq));
  const mode = params.mode ?? "hybrid";
  if (mode === "touched") {
    return { text: formatTouched(scoped), entries: scoped, total: scoped.length, page: 1, totalPages: 1 };
  }
  const query = normalizeQuery(params.query);
  const drillDown = parseDrillDown(query);
  if (drillDown !== void 0) {
    const entry = scoped.find((candidate) => candidate.seq === drillDown.seq);
    if (entry === void 0) {
      return { text: `No session entry ${drillDown.seq} is available in the selected scope.`, entries: [], total: 0, page: 1, totalPages: 1 };
    }
    if (drillDown.path !== void 0 && !entry.files.some((file) => file.toLocaleLowerCase().includes(drillDown.path.toLocaleLowerCase()))) {
      return { text: `Entry ${drillDown.seq} has no file matching ${drillDown.path}.`, entries: [], total: 0, page: 1, totalPages: 1 };
    }
    const lines = entry.text.split("\n");
    const start = Math.max(0, drillDown.offset ?? 0);
    const end = drillDown.limit === void 0 ? lines.length : start + Math.max(0, drillDown.limit);
    return { text: lines.slice(start, end).join("\n"), entries: [entry], total: 1, page: 1, totalPages: 1 };
  }
  const candidates = mode === "file" ? scoped.filter((entry) => entry.files.length > 0) : scoped;
  const ranked = query ? rankRecallEntries(candidates, query) : candidates.slice(-DEFAULT_RECENT);
  const expanded = (params.expand ?? []).flatMap((seq) => candidates.filter((entry) => entry.seq === seq));
  const merged = [...new Map([...ranked, ...expanded].map((entry) => [entry.seq, entry])).values()];
  const explicitOffset = Number.isFinite(params.offset) ? Math.max(0, Math.floor(params.offset)) : void 0;
  const explicitLimit = Number.isFinite(params.limit) ? Math.max(1, Math.floor(params.limit)) : void 0;
  const page = Math.max(1, params.page ?? 1);
  const pageSize = explicitLimit ?? PAGE_SIZE;
  const offset = explicitOffset ?? (page - 1) * pageSize;
  const totalPages = Math.max(1, Math.ceil(merged.length / pageSize));
  const pageEntries = merged.slice(offset, offset + pageSize);
  const header = query ? `${merged.length} matches${params.scope === "all" ? " (scope: all)" : ""}` : `Recent session entries${params.scope === "all" ? " (scope: all)" : ""}`;
  const nextPage = offset + pageSize < merged.length ? `
--- Use offset:${offset + pageSize} limit:${pageSize} for more results ---` : "";
  const text = `${header}

${pageEntries.map((entry) => `#${entry.seq}
${entry.text}`).join("\n\n") || "No matching session entries."}${nextPage}`;
  return { text, entries: pageEntries, total: merged.length, page, totalPages };
}
var recallParameters = {
  type: "object",
  additionalProperties: false,
  properties: {
    query: { type: "string", description: "Text/regex search; #N expands an entry; #N:path drills down with optional :offset:limit." },
    expand: { type: "array", items: { type: "integer" }, description: "Durable seq numbers to expand." },
    page: { type: "integer", minimum: 1, description: "1-based result page." },
    offset: { type: "integer", minimum: 0, description: "Zero-based result offset." },
    limit: { type: "integer", minimum: 1, description: "Maximum results after offset." },
    scope: { type: "string", enum: ["lineage", "all"], description: "Search active lineage or all available session events." },
    mode: { type: "string", enum: ["hybrid", "file", "touched"], description: "Search all content, file-bearing entries, or aggregate touched files." }
  }
};
function createRecallTool(getSession) {
  return {
    name: "recall",
    description: "Search durable session history and recover compacted context, file operations, and earlier tool results.",
    parameters: recallParameters,
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { text: { type: "string" } },
        required: ["text"]
      },
      render: (value) => {
        const rendered = asRecord(value)?.text;
        return [{ type: "text", text: typeof rendered === "string" ? rendered : String(value) }];
      }
    },
    async execute(args, exec) {
      const session = getSession(exec);
      if (session === void 0) return { text: "No session is available for recall." };
      const result = recallSession(session, asRecord(args) ?? {});
      return { text: result.text };
    }
  };
}
function registerRecallTool(registry, getSession) {
  return registry.register(createRecallTool(getSession));
}

// src/hybrid.ts
var FALLBACK_MODES = /* @__PURE__ */ new Set(["instant", "instant-then-llm", "llm"]);
function resolveRegionSeqs(session, messages) {
  const idToSeq = /* @__PURE__ */ new Map();
  for (const event of session.events) {
    if (typeof event.seq !== "number") continue;
    const message = session.deriveEventMessage(event);
    if (message !== null && typeof message.id === "string") idToSeq.set(message.id, event.seq);
  }
  return messages.map((message) => idToSeq.get(message.id) ?? -1);
}
var RoutingCompactionEngine = class extends BasicCompactionEngine {
  static inject = ["llm", "tokenMeter", "sessions"];
  static Config = HybridCompactionConfigSchema;
  /** Validated endpoint registry. */
  endpoints;
  /** Optional per-session artifact store. */
  state;
  /** The plugin's own validated config (base fields live in `this.config`). */
  options;
  /** Normalized fallback chain («instant» | «instant-then-llm» | «llm»). */
  fallbackMode;
  /** Compiled local-compiler options. */
  compiler;
  /** Persisted Codex-style installation id, resolved lazily. */
  installationId;
  constructor(ctx, config = {}) {
    const {
      endpoints,
      timeoutMs,
      fallbackToLlm,
      stateDir,
      persistRemoteHistory,
      retainedMessageTokenBudget,
      fallbackMode,
      compileMaxTokens,
      checkpointScale,
      checkpointCap,
      textTokens,
      userTextTokens,
      toolCallTokens,
      includeReasoning,
      stripNoiseXml: stripNoiseXml2,
      noisePatterns,
      toolKeyFields,
      toolArgTools,
      hideTools,
      toolErrorChars,
      bashCap,
      collapseSkills,
      stripSelfTalk,
      mergeToolLines,
      toolsPerTurn,
      ...baseConfig
    } = config;
    super(ctx, baseConfig);
    this.options = config;
    this.endpoints = resolveEndpoints(endpoints);
    const resolvedStateDir = persistRemoteHistory !== false ? stateDir?.trim() || defaultStateDir() : void 0;
    this.state = resolvedStateDir !== void 0 ? new RemoteCompactionStateStore(resolvedStateDir) : void 0;
    if (this.state !== void 0) {
      ctx.provide("responsesCompactionReplay", this.state);
    }
    this.installationId = config.installationId !== void 0 ? config.installationId.trim() || void 0 : resolvedStateDir !== void 0 ? resolveInstallationId(resolvedStateDir) : void 0;
    const explicit = fallbackMode?.trim();
    if (explicit !== void 0 && explicit.length > 0 && !FALLBACK_MODES.has(explicit)) {
      throw new Error(
        `fallbackMode must be one of "instant", "instant-then-llm", "llm"; got ${JSON.stringify(explicit)}`
      );
    }
    this.fallbackMode = explicit !== void 0 && explicit.length > 0 ? explicit : fallbackToLlm === false ? "instant" : "instant";
    const noiseList = noisePatterns !== void 0 && noisePatterns.length > 0 ? noisePatterns : DEFAULT_NOISE_PATTERNS;
    this.compiler = {
      textTokens: textTokens ?? DEFAULT_INSTANT_OPTIONS.textTokens,
      userTextTokens: userTextTokens ?? DEFAULT_INSTANT_OPTIONS.userTextTokens,
      toolCallTokens: toolCallTokens ?? DEFAULT_INSTANT_OPTIONS.toolCallTokens,
      includeReasoning: includeReasoning ?? false,
      stripNoiseXml: stripNoiseXml2 ?? true,
      noisePatterns: compileNoisePatterns(noiseList),
      toolKeyFields: toolKeyFields !== void 0 && Object.keys(toolKeyFields).length > 0 ? toolKeyFields : DEFAULT_TOOL_KEY_FIELDS,
      // Explicit non-empty list = whitelist-only extraction; unset = extract
      // for every tool (pi-blackhole behavior, the default).
      toolArgTools: toolArgTools !== void 0 && toolArgTools.length > 0 ? toolArgTools : DEFAULT_INSTANT_OPTIONS.toolArgTools,
      hideTools: new Set(hideTools ?? []),
      toolErrorChars: toolErrorChars ?? DEFAULT_INSTANT_OPTIONS.toolErrorChars,
      bashCap: bashCap ?? DEFAULT_INSTANT_OPTIONS.bashCap,
      collapseSkills: collapseSkills ?? DEFAULT_INSTANT_OPTIONS.collapseSkills,
      stripSelfTalk: stripSelfTalk ?? DEFAULT_INSTANT_OPTIONS.stripSelfTalk,
      mergeToolLines: mergeToolLines ?? DEFAULT_INSTANT_OPTIONS.mergeToolLines,
      toolsPerTurn: toolsPerTurn ?? DEFAULT_INSTANT_OPTIONS.toolsPerTurn
    };
    this.compileMaxTokens = compileMaxTokens ?? 8192;
    this.checkpointScale = checkpointScale ?? 0.1;
    this.checkpointCap = checkpointCap ?? 65536;
    let recallDisposer;
    const attachRecall = (candidate) => {
      const tools = candidate;
      if (tools?.register === void 0) {
        recallDisposer?.();
        recallDisposer = void 0;
        return;
      }
      if (recallDisposer !== void 0) return;
      const disposer = registerRecallTool(tools, (exec) => {
        const candidate2 = exec;
        const session = candidate2?.agent?.session;
        return session?.events !== void 0 && typeof session.deriveEventMessage === "function" ? session : void 0;
      });
      if (disposer !== void 0) recallDisposer = disposer;
    };
    const safeContext = ctx;
    attachRecall(safeContext.get?.("tools"));
    safeContext.on?.("internal/service", (name, value) => {
      if (name === "tools") attachRecall(value);
    }, { global: true });
    ctx.effect(() => () => {
      recallDisposer?.();
      recallDisposer = void 0;
    }, "dsh-blackhole recall");
  }
  /** Token floor for the compiled checkpoint (scaled by the shadowed size). */
  compileMaxTokens;
  /** Checkpoint cap = max(compileMaxTokens, shadowed x scale), ceilinged at checkpointCap. */
  checkpointScale;
  /** Hard ceiling for the compiled checkpoint. */
  checkpointCap;
  /** Pick the endpoint serving this provider/model, exact provider first. */
  matchEndpoint(target) {
    const exact = this.endpoints.filter((endpoint) => endpoint.provider === target.provider);
    const wildcard = this.endpoints.filter((endpoint) => endpoint.provider === "*");
    for (const endpoint of [...exact, ...wildcard]) {
      if (globMatch(endpoint.model, target.model)) return endpoint;
    }
    return void 0;
  }
  async summarize(input, agent, signal) {
    const target = conversationTarget(agent);
    if (target === void 0) {
      await this.state?.remove(agent.id);
      return this.instantSummarize(input, agent);
    }
    const endpoint = this.matchEndpoint(target);
    if (endpoint !== void 0) {
      const apiKey = endpoint.apiKey ?? (process.env[endpoint.apiKeyEnv] ?? "");
      if (apiKey.length === 0) {
        this.ctx.logger.warn(
          `hybrid compaction: endpoint ${endpoint.label} matched provider ${target.provider}/${target.model} but no API key found (${endpoint.apiKeyEnv}); using the local compiler`
        );
      } else {
        const attempt = await this.remoteSummarize({ endpoint, apiKey, target, input, agent, signal });
        if (attempt !== void 0) return attempt;
      }
    }
    await this.state?.remove(agent.id);
    switch (this.fallbackMode) {
      case "llm":
        return this.llmSummarize(input, agent, signal);
      case "instant-then-llm": {
        try {
          return await this.instantSummarize(input, agent);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.ctx.logger.warn(`hybrid compaction: local compiler failed (${message}); using the native LLM summarizer`);
          return this.llmSummarize(input, agent, signal);
        }
      }
      default:
        return this.instantSummarize(input, agent);
    }
  }
  /** One remote compaction attempt; `undefined` means "fall back". */
  async remoteSummarize(params) {
    const { endpoint, apiKey, target, input, agent, signal } = params;
    try {
      const items = await this.state?.prepareInput({
        sessionId: agent.id,
        provider: target.provider,
        model: target.model,
        trailingMessages: input.messages,
        endpoint: this.responsesUrl(endpoint.baseUrl)
      }) ?? dshMessagesToResponseItems(input.messages);
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
        timeoutMs: this.options.timeoutMs ?? 12e4,
        retainedMessageTokenBudget: this.options.retainedMessageTokenBudget ?? 2e4,
        installationId: this.options.installationId ?? this.installationId
      });
      const summaryText2 = result.summaryText.length > 0 ? result.summaryText : buildRemoteCompactionSummaryText({
        provider: target.provider,
        model: target.model,
        endpoint: endpoint.label
      });
      await this.state?.save({
        sessionId: agent.id,
        replacedAt: (/* @__PURE__ */ new Date()).toISOString(),
        provider: target.provider,
        model: target.model,
        endpoint: this.responsesUrl(endpoint.baseUrl),
        summaryText: summaryText2,
        replacementHistory: result.replacementHistory,
        details: result.details
      });
      this.ctx.logger.info(
        `hybrid compaction: remote summary for ${target.provider}/${target.model} via ${endpoint.label} (${summaryText2.length} chars, ${result.replacementHistory.length} replacement items)`
      );
      return {
        summary: [{ type: "text", text: summaryText2 }],
        provider: endpoint.label,
        model: target.model,
        usage: result.usage
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.ctx.logger.warn(
        `hybrid compaction: remote attempt failed for ${endpoint.label} (${message}); falling back`
      );
      return void 0;
    }
  }
  responsesUrl(baseUrl) {
    const trimmed = baseUrl.trim().replace(/\/+$/, "");
    if (trimmed.endsWith("/responses")) return trimmed;
    if (trimmed.endsWith("/v1")) return `${trimmed}/responses`;
    if (trimmed.endsWith("/codex")) return `${trimmed}/responses`;
    return `${trimmed}/v1/responses`;
  }
  /**
   * The local deterministic branch: compile the shadowed region with the
   * VCC-style compiler at zero LLM cost.
   */
  instantSummarize(input, agent) {
    const session = agent.session;
    const seqs = resolveRegionSeqs(session, [...input.messages]);
    const nodes = [...input.messages].map((message, index) => ({
      seq: seqs[index] ?? -1,
      message
    }));
    const shadowedTokens = estimateMessagesTokens(nodes.map((node) => node.message));
    const cap = Math.min(
      this.checkpointCap,
      Math.max(this.compileMaxTokens, Math.floor(shadowedTokens * this.checkpointScale))
    );
    const compiled = compileInstantRegion(nodes, this.compiler, cap);
    const briefText = joinInstantEntries(compiled.entries);
    const text = compileBlackholeSummary({
      messages: [...input.messages],
      seqs,
      previousSummary: previousCheckpointSummary(
        [...input.messages]
      ),
      briefTranscript: briefText,
      maxTokens: cap
    });
    if (text.trim().length === 0) {
      throw new Error("instant compiler produced no content for the shadowed region");
    }
    const estimated = estimateMessagesTokens([{ content: [{ type: "text", text }] }]) + 64;
    if (estimated >= shadowedTokens && compiled.stats.tokens > 0) {
      throw new Error(
        `instant checkpoint does not shrink the shadowed region (${estimated} >= ${shadowedTokens} tokens)`
      );
    }
    if (compiled.capped) {
      this.ctx.logger.info(
        `hybrid compaction: local compiler capped the checkpoint at ${cap} tokens (shadowed ${shadowedTokens}, ${compiled.stats.elidedRows} rows elided)`
      );
    }
    return {
      summary: [{ type: "text", text }],
      provider: "instant",
      model: "vcc-compiler",
      rawOutput: [{ type: "text", text }]
    };
  }
  /** The native one-shot LLM branch (basic's summarizeWithLlm contract). */
  llmSummarize(input, agent, signal) {
    return summarizeWithLlm(this.ctx, this.config, input, agent, signal);
  }
};

// src/responses-engine.ts
import { BasicCompactionEngine as BasicCompactionEngine2 } from "@deepseek-ai/dsh-compaction-basic";
var ResponsesCompactionEngine = class extends BasicCompactionEngine2 {
  static inject = ["llm", "tokenMeter", "sessions"];
  static Config = CompactionResponsesConfigSchema;
  /** Validated endpoint registry. */
  endpoints;
  /** Optional per-session artifact store. */
  state;
  /** The plugin's own validated config (base fields live in `this.config`). */
  options;
  /** Persisted Codex-style installation id, resolved lazily. */
  installationId;
  constructor(ctx, config = {}) {
    const {
      endpoints,
      timeoutMs,
      fallbackToLlm,
      stateDir,
      persistRemoteHistory,
      retainedMessageTokenBudget,
      ...baseConfig
    } = config;
    super(ctx, baseConfig);
    this.options = config;
    this.endpoints = resolveEndpoints(endpoints);
    const resolvedStateDir = persistRemoteHistory !== false ? stateDir?.trim() || defaultStateDir() : void 0;
    this.state = resolvedStateDir !== void 0 ? new RemoteCompactionStateStore(resolvedStateDir) : void 0;
    if (this.state !== void 0) ctx.provide("responsesCompactionReplay", this.state);
    this.installationId = config.installationId !== void 0 ? config.installationId.trim() || void 0 : resolvedStateDir !== void 0 ? resolveInstallationId(resolvedStateDir) : void 0;
  }
  /** Pick the endpoint serving this provider/model, exact provider first. */
  matchEndpoint(target) {
    const exact = this.endpoints.filter((endpoint) => endpoint.provider === target.provider);
    const wildcard = this.endpoints.filter((endpoint) => endpoint.provider === "*");
    for (const endpoint of [...exact, ...wildcard]) {
      if (globMatch(endpoint.model, target.model)) return endpoint;
    }
    return void 0;
  }
  /**
   * Summarize via Responses compaction v2 when an endpoint serves the routed
   * provider; otherwise (or on any failure) inherit the native LLM path.
   */
  async summarize(input, agent, signal) {
    const target = conversationTarget(agent);
    if (target === void 0) {
      await this.state?.remove(agent.id);
      return super.summarize(input, agent, signal);
    }
    const endpoint = this.matchEndpoint(target);
    if (endpoint === void 0) {
      await this.state?.remove(agent.id);
      return super.summarize(input, agent, signal);
    }
    const apiKey = endpoint.apiKey ?? (process.env[endpoint.apiKeyEnv] ?? "");
    if (apiKey.length === 0) {
      this.ctx.logger.warn(
        `responses compaction: endpoint ${endpoint.label} matched provider ${target.provider}/${target.model} but no API key found (${endpoint.apiKeyEnv}); falling back to the native summarizer`
      );
      await this.state?.remove(agent.id);
      return super.summarize(input, agent, signal);
    }
    const attempt = await this.remoteSummarize({
      endpoint,
      apiKey,
      target,
      input,
      agent,
      signal
    });
    if (attempt !== void 0) return attempt;
    await this.state?.remove(agent.id);
    if (this.options.fallbackToLlm === false) {
      throw new Error(
        `responses compaction failed for ${endpoint.label} and fallbackToLlm is false; the compaction was aborted instead of switching engines`
      );
    }
    return super.summarize(input, agent, signal);
  }
  /** One remote compaction attempt; `undefined` means "fall back". */
  async remoteSummarize(params) {
    const { endpoint, apiKey, target, input, agent, signal } = params;
    try {
      const items = await this.state?.prepareInput({
        sessionId: agent.id,
        provider: target.provider,
        model: target.model,
        trailingMessages: input.messages,
        endpoint: responsesEndpointUrl(endpoint.baseUrl)
      }) ?? dshMessagesToResponseItems(input.messages);
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
        timeoutMs: this.options.timeoutMs ?? 12e4,
        retainedMessageTokenBudget: this.options.retainedMessageTokenBudget ?? 2e4,
        installationId: this.options.installationId ?? this.installationId
      });
      const summaryText2 = result.summaryText.length > 0 ? result.summaryText : buildRemoteCompactionSummaryText({
        provider: target.provider,
        model: target.model,
        endpoint: endpoint.label
      });
      await this.state?.save({
        sessionId: agent.id,
        replacedAt: (/* @__PURE__ */ new Date()).toISOString(),
        provider: target.provider,
        model: target.model,
        endpoint: responsesEndpointUrl(endpoint.baseUrl),
        summaryText: summaryText2,
        replacementHistory: result.replacementHistory,
        details: result.details
      });
      this.ctx.logger.info(
        `responses compaction: remote summary for ${target.provider}/${target.model} via ${endpoint.label} (${summaryText2.length} chars, ${result.replacementHistory.length} replacement items)`
      );
      return {
        summary: [{ type: "text", text: summaryText2 }],
        provider: endpoint.label,
        model: target.model,
        usage: result.usage
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.ctx.logger.warn(
        `responses compaction failed for ${endpoint.label} (${message}); falling back to the native summarizer`
      );
      return void 0;
    }
  }
};
export {
  BLACKHOLE_RECALL_NOTE,
  CompactionResponsesConfigSchema,
  DEFAULT_ARG_TOOLS,
  DEFAULT_INSTANT_OPTIONS,
  DEFAULT_NOISE_PATTERNS,
  DEFAULT_TOOL_KEY_FIELDS,
  HybridCompactionConfigSchema,
  PATH_KEYS,
  RemoteCompactionStateStore,
  ResponsesCompactionEngine,
  RoutingCompactionEngine,
  buildCompactionRequestBody,
  buildRemoteCompactionDetails,
  buildReplacementHistory,
  callResponsesCompactionV2,
  collapseSkillText,
  compileBlackholeSummary,
  compileInstantRegion,
  compileNoisePatterns,
  compressBash,
  countTokens,
  createRecallTool,
  RoutingCompactionEngine as default,
  dshMessageToResponseItems,
  dshMessagesToResponseItems,
  estimateEntryTokens,
  estimateMessagesTokens,
  filterBlackholeNoise,
  firstLineOf,
  indexRecallSession,
  joinInstantEntries,
  mapCompactionUsage,
  normalizeBlackholeMessages,
  parseCompactionV2Events,
  parseRemoteCompactionDetails,
  parseSseData,
  parseToolArguments,
  pickToolKeyArg,
  previousCheckpointSummary,
  projectToolResultText,
  rankRecallEntries,
  recallSession,
  reconstructRemoteCompactionHistory,
  registerRecallTool,
  remoteCompactionModelKey,
  resolveEndpoints,
  resolveRegionSeqs,
  responsesEndpointUrl,
  sanitize,
  stripNoiseXml,
  stripSelfTalkPrefix,
  tokenize,
  toolSchemasToResponseTools,
  truncateTokens
};
//# sourceMappingURL=index.js.map
