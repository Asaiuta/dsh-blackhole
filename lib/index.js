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
  if (message.role === "tool") {
    return [{
      type: "function_call_output",
      call_id: String(message.toolCallId).split("|", 1)[0],
      output: contentBlocksToOutput(message.content)
    }];
  }
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
        case "file":
          contentItems.push({ type: "input_text", text: fileBlockLabel(block) });
          break;
        default: {
          const legacy = block;
          if (legacy.type !== "tool-result") break;
          toolOutputs.push({
            type: "function_call_output",
            call_id: String(legacy.toolCallId ?? "").split("|", 1)[0],
            output: contentBlocksToOutput(legacy.content ?? [])
          });
        }
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
function fileBlockLabel(block) {
  const attachment = block.attachment;
  if (attachment !== void 0 && typeof attachment === "object") {
    for (const key of ["name", "filename", "path", "mediaType"]) {
      const value = attachment[key];
      if (typeof value === "string" && value.length > 0) return `[file: ${value}]`;
    }
  }
  return "[file]";
}
function contentBlocksToOutput(content) {
  return content.map((block) => {
    if (block.type === "text") return block.text;
    if (block.type === "image") return "[image]";
    if (block.type === "file") return fileBlockLabel(block);
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
    if (message.source.kind === "compact-checkpoint") continue;
    const legacySource = message.source;
    if (legacySource.kind === "plugin" && legacySource.plugin === "compact") continue;
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
    // Source kinds are merge-extensible — each producer registers its own via
    // module augmentation. This label is request-only (never appended to the
    // durable log), so keep the official backend's free-form `plugin` shape,
    // narrowed through unknown for the stricter rc.2 type union.
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
var TEXT_TAIL_SHARE = 3;
function truncateTextTokens(text, limit, ref) {
  const maxChars = Math.max(32, limit * 4);
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
  if (cut >= tokens.length && text.length <= maxChars) {
    return { text: text.replace(/\s+/g, " ").trim(), truncated: false };
  }
  const tailBudget = Math.max(1, Math.floor(limit / TEXT_TAIL_SHARE));
  const headBudget = Math.max(1, limit - tailBudget);
  let headCut = tokens.length;
  let headCount = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.trim().length === 0) continue;
    headCount += 1;
    if (headCount > headBudget) {
      headCut = index;
      break;
    }
  }
  let tailStart = tokens.length;
  let tailCount = 0;
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index];
    if (token.trim().length === 0) continue;
    tailCount += 1;
    if (tailCount >= tailBudget) {
      tailStart = index;
      break;
    }
  }
  if (tailStart <= headCut) {
    return truncateTokens(text, limit, ref);
  }
  const flatten = (value) => value.replace(/\s+/g, " ").trim();
  let headText = completeCodePointAtEnd(tokens.slice(0, headCut).join("").slice(0, headBudget * 4));
  let tailText = tokens.slice(tailStart).join("");
  if (tailText.length > tailBudget * 4) {
    let sliceFrom = tailText.length - tailBudget * 4;
    const code = tailText.charCodeAt(sliceFrom);
    if (code >= 56320 && code <= 57343) sliceFrom += 1;
    tailText = tailText.slice(sliceFrom);
  }
  headText = flatten(headText);
  tailText = flatten(tailText);
  const marker = ref === void 0 ? "...(elided)..." : `...(elided from ${ref})...`;
  return { text: `${headText}${marker}${tailText}`, truncated: true };
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
function fileLabel(block) {
  const attachment = block.attachment;
  if (attachment !== void 0 && typeof attachment === "object") {
    for (const key of ["name", "filename", "path", "mediaType"]) {
      const value = attachment[key];
      if (typeof value === "string" && value.length > 0) return `[file: ${value}]`;
    }
  }
  return "[file]";
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
  if (source === void 0) return false;
  if (source.kind === "compact-checkpoint") return true;
  return source.kind === "plugin" && source.plugin === "compact";
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
function mergeRepeatedToolRows(entries, stats, errorResultSeqs) {
  const TOOL_ROW_RE = /^(\[user\]\n|\[assistant\]\n|\[system\]\n)?(\* .*?) \((seq [^)]*)\)$/;
  const HEADER_RE = /^(\[user\]\n|\[assistant\]\n|\[system\]\n)/;
  const groups = /* @__PURE__ */ new Map();
  entries.forEach((entry, index) => {
    if (entry.kind !== "tool") return;
    const m = entry.text.match(TOOL_ROW_RE);
    if (m === null) return;
    const members = groups.get(m[2]);
    if (members === void 0) groups.set(m[2], [index]);
    else members.push(index);
  });
  const dropped = /* @__PURE__ */ new Set();
  const replacements = /* @__PURE__ */ new Map();
  for (const [base, indexes] of groups) {
    if (indexes.length < 2) continue;
    const members = indexes.map((index) => ({ index, entry: entries[index] }));
    const last = members[members.length - 1];
    const refs = members.map(({ entry }) => {
      const ref = entry.text.match(TOOL_ROW_RE)?.[3] ?? "";
      const resultSeq = Number(ref.match(/-> result (\d+)/)?.[1] ?? Number.NaN);
      if (entry === last.entry || Number.isInteger(resultSeq) && errorResultSeqs.has(resultSeq)) return ref;
      return ref.split(" -> ")[0];
    });
    replacements.set(last.index, {
      seq: last.entry.seq,
      text: `${base} (${refs.join(", ")}) x${members.length}`,
      kind: "tool"
    });
    for (const { index } of members) {
      if (index !== last.index) dropped.add(index);
    }
  }
  if (dropped.size === 0) return false;
  const out = [];
  let pendingHeader = "";
  entries.forEach((entry, index) => {
    if (dropped.has(index)) {
      const m = entry.text.match(HEADER_RE);
      if (m !== null) pendingHeader = m[1];
      return;
    }
    let final = replacements.get(index) ?? entry;
    if (pendingHeader !== "") {
      if (final.text.match(HEADER_RE) === null) final = { ...final, text: pendingHeader + final.text };
      pendingHeader = "";
    }
    out.push(final);
  });
  entries.length = 0;
  entries.push(...out);
  stats.elidedToolRows += dropped.size;
  stats.elidedRows += dropped.size;
  return true;
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
  const errorResultSeqs = /* @__PURE__ */ new Set();
  for (const node of nodes) {
    const message = node.message;
    if (message === null || message === void 0 || message.content === void 0) continue;
    if (message.role === "tool") {
      const toolMessage = message;
      const toolCallId = typeof toolMessage.toolCallId === "string" ? toolMessage.toolCallId : void 0;
      if (toolCallId !== void 0) resultSeqByCallId.set(toolCallId, node.seq);
      if (toolMessage.isError === true) errorResultSeqs.add(node.seq);
      continue;
    }
    for (const block of message.content) {
      if (block.type === "tool-call" && typeof block.id === "string") {
        if (typeof block.name === "string" && block.name.length > 0) {
          callNameByCallId.set(block.id, block.name);
        }
      } else if (block.type === "tool-result" && typeof block.toolCallId === "string") {
        resultSeqByCallId.set(block.toolCallId, node.seq);
        if (block.isError === true) errorResultSeqs.add(node.seq);
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
          const kept = truncateTextTokens(cleaned, effective.textTokens, seqRef(node.seq));
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
          const kept = truncateTextTokens(text, effective.textTokens, seqRef(node.seq));
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
        if (block.type === "file") {
          stats.documents += 1;
          header = roleHeader("assistant");
          pushEntry(node.seq, header + `${fileLabel(block)} (${seqRef(node.seq)})`, "media");
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
        } else if (block.type === "file") {
          stats.documents += 1;
          surviving += 1;
          header = roleHeader("user");
          pushEntry(node.seq, header + `${fileLabel(block)} (${seqRef(node.seq)})`, "media");
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
    if (message.role === "tool") {
      const toolMessage = message;
      stats.toolResults += 1;
      const errorChars = options.toolErrorChars ?? 150;
      if (errorChars > 0 && toolMessage.isError === true) {
        const body = firstLineOf(projectToolResultText(message.content ?? []), errorChars);
        if (body.length > 0 && body !== "(no output)") {
          const toolName = typeof toolMessage.toolCallId === "string" ? callNameByCallId.get(toolMessage.toolCallId) ?? "tool" : "tool";
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
    }
  }
  if (entries.length > 0) {
    const toolsPerTurn = options.toolsPerTurn ?? 8;
    const merge = options.mergeToolLines !== false;
    const merged = merge ? mergeRepeatedToolRows(entries, stats, errorResultSeqs) : false;
    if (merged || toolsPerTurn > 0) {
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
      for (const segment of segments) {
        if (segment.role === "assistant" && toolsPerTurn > 0) {
          const next = [];
          let runStart = 0;
          while (runStart < segment.items.length) {
            const turnSeq = segment.items[runStart].seq;
            let runEnd = runStart;
            while (runEnd < segment.items.length && segment.items[runEnd].seq === turnSeq) runEnd += 1;
            const turn = segment.items.slice(runStart, runEnd);
            const toolIdxs = [];
            turn.forEach((entry, itemIndex) => {
              if (entry.kind === "tool" && /(^|\n)\* /.test(entry.text)) toolIdxs.push(itemIndex);
            });
            if (toolIdxs.length > toolsPerTurn) {
              const dropCount = toolIdxs.length - toolsPerTurn;
              const dropSet = new Set(toolIdxs.slice(0, dropCount));
              const firstKept = toolIdxs[dropCount];
              const firstDropped = toolIdxs[0];
              const droppedHeader = turn[firstDropped]?.text.match(/^(\[user\]\n|\[assistant\]\n|\[system\]\n)/)?.[1] ?? "";
              let inserted = false;
              for (let itemIndex = 0; itemIndex < turn.length; itemIndex++) {
                if (dropSet.has(itemIndex)) continue;
                if (!inserted && itemIndex === firstKept) {
                  next.push({
                    seq: turnSeq,
                    text: `${droppedHeader}* (${dropCount} earlier tool-call entries omitted: seq ${turnSeq})`,
                    kind: "note"
                  });
                  inserted = true;
                }
                next.push(turn[itemIndex]);
              }
              stats.elidedToolRows += dropCount;
              stats.elidedRows += dropCount;
            } else {
              next.push(...turn);
            }
            runStart = runEnd;
          }
          segment.items = next;
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
    const source = message.source;
    if (source?.kind === "compact-checkpoint") return;
    if (source?.kind === "plugin" && source?.plugin === "compact") return;
    const seq = seqs[messageIndex] ?? -1;
    if (message.role === "tool") {
      const toolMessage = message;
      const toolCallId = typeof toolMessage.toolCallId === "string" ? toolMessage.toolCallId : void 0;
      normalized.push({
        kind: "tool-result",
        text: flattenText(message.content),
        seq,
        messageIndex,
        name: toolCallId === void 0 ? void 0 : toolNames.get(toolCallId),
        toolCallId,
        ...toolMessage.isError === true ? { isError: true } : {}
      });
      return;
    }
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
        case "file":
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
    const source = message.source;
    if (source?.kind === "compact-checkpoint") {
      const text2 = flattenText(message.content);
      if (text2.trim()) return text2;
      continue;
    }
    if (source?.kind !== "plugin" || source?.plugin !== "compact") continue;
    const text = flattenText(message.content);
    if (text.trim()) return text;
  }
  return void 0;
}

// src/session-access.ts
import { deriveEventMessage } from "@deepseek-ai/dsh-session";
function readSessionEvents(session) {
  if (typeof session.snapshotEvents === "function") {
    try {
      const events = session.snapshotEvents();
      if (Array.isArray(events)) return events;
    } catch {
    }
  }
  return Array.isArray(session.events) ? session.events : [];
}
function deriveSessionMessage(session, event) {
  if (typeof session.deriveEventMessage === "function") {
    return session.deriveEventMessage(event);
  }
  try {
    return deriveEventMessage(event);
  } catch {
    return null;
  }
}

// src/recall-output.ts
var utf8Encoder = typeof TextEncoder === "function" ? new TextEncoder() : void 0;
var MAX_RECALL_OUTPUT_BYTES = 50 * 1024;
var recallUtf8ByteLength = (text) => utf8Encoder?.encode(text).byteLength ?? text.length;
var clipRecallUtf8 = (text, maxBytes) => {
  if (!Number.isFinite(maxBytes)) return text;
  if (text.length <= maxBytes && recallUtf8ByteLength(text) <= maxBytes) return text;
  let bytes = 0;
  let end = 0;
  for (const character of text) {
    const size = recallUtf8ByteLength(character);
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += character.length;
  }
  return text.slice(0, end);
};
function capRecallOutput(text, note = "recall response truncated at 50KB; narrow the query or drill into a specific file.") {
  if (recallUtf8ByteLength(text) <= MAX_RECALL_OUTPUT_BYTES) return text;
  const suffix = `

... (${note})`;
  const clipped = clipRecallUtf8(text, Math.max(0, MAX_RECALL_OUTPUT_BYTES - recallUtf8ByteLength(suffix)));
  return `${clipped}${suffix}`;
}

// src/recall-regex.ts
var MAX_PATTERN_CHARS = 256;
var MAX_QUANTIFIERS = 2;
var MAX_QUANTIFIER_WIDTH = 32;
var isQuantifierStart = (character) => character === "*" || character === "+" || character === "?" || character === "{";
var hasUnsafeStructure = (pattern) => {
  if (/\\(?:[1-9][0-9]*|k<[^>]+>)/u.test(pattern)) return true;
  if (pattern.includes("(?")) return true;
  const groups = [];
  let inClass = false;
  let previousWasAtom = false;
  let previousWasQuantifier = false;
  let lastAtomGroup;
  let hasAlternation = false;
  let quantifierCount = 0;
  let unboundedQuantifierCount = 0;
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "\\") {
      index += 1;
      previousWasAtom = true;
      previousWasQuantifier = false;
      lastAtomGroup = void 0;
      continue;
    }
    if (inClass) {
      if (character === "]") inClass = false;
      continue;
    }
    if (character === "[") {
      inClass = true;
      previousWasAtom = true;
      previousWasQuantifier = false;
      lastAtomGroup = void 0;
      continue;
    }
    if (character === "(") {
      if (pattern[index + 1] === "?") return true;
      groups.push({ hasQuantifier: false, hasAlternation: false });
      previousWasAtom = false;
      previousWasQuantifier = false;
      lastAtomGroup = void 0;
      continue;
    }
    if (character === ")") {
      const frame = groups.pop();
      if (frame === void 0) return true;
      const parent = groups.at(-1);
      if (parent !== void 0) {
        parent.hasQuantifier ||= frame.hasQuantifier;
        parent.hasAlternation ||= frame.hasAlternation;
      }
      previousWasAtom = true;
      previousWasQuantifier = false;
      lastAtomGroup = frame;
      continue;
    }
    if (character === "|") {
      hasAlternation = true;
      const frame = groups.at(-1);
      if (frame !== void 0) frame.hasAlternation = true;
      previousWasAtom = false;
      previousWasQuantifier = false;
      lastAtomGroup = void 0;
      continue;
    }
    if (character === "^" || character === "$") {
      previousWasAtom = false;
      previousWasQuantifier = false;
      lastAtomGroup = void 0;
      continue;
    }
    if (isQuantifierStart(character)) {
      if (character === "?" && previousWasQuantifier) continue;
      let consumed = 1;
      let unbounded = character === "*" || character === "+";
      if (character === "{") {
        const range = pattern.slice(index).match(/^\{(\d+)(?:,(\d*))?\}/u);
        if (range === null) {
          previousWasAtom = true;
          previousWasQuantifier = false;
          lastAtomGroup = void 0;
          continue;
        }
        const minimum = Number(range[1]);
        const upper = range[2];
        const hasComma = range[0].includes(",");
        const maximum = !hasComma ? minimum : upper === "" ? void 0 : Number(upper);
        if (minimum > MAX_QUANTIFIER_WIDTH || maximum === void 0 || maximum > MAX_QUANTIFIER_WIDTH || maximum - minimum > MAX_QUANTIFIER_WIDTH) return true;
        consumed = range[0].length;
        unbounded = false;
      }
      if (!previousWasAtom || previousWasQuantifier) return true;
      if (lastAtomGroup !== void 0 && (lastAtomGroup.hasQuantifier || lastAtomGroup.hasAlternation)) return true;
      quantifierCount += 1;
      if (unbounded) unboundedQuantifierCount += 1;
      const frame = groups.at(-1);
      if (frame !== void 0) frame.hasQuantifier = true;
      previousWasQuantifier = true;
      previousWasAtom = true;
      index += consumed - 1;
      continue;
    }
    previousWasAtom = true;
    previousWasQuantifier = false;
    lastAtomGroup = void 0;
  }
  if (inClass || groups.length > 0) return true;
  if (hasAlternation && unboundedQuantifierCount > 0) return true;
  if (unboundedQuantifierCount > 1 && quantifierCount > 1) return true;
  if (quantifierCount > MAX_QUANTIFIERS) return true;
  return false;
};
var termsFromQuery = (query) => query.replace(/^\/(.*)\/[a-z]*$/i, "$1").match(/[\p{L}\p{N}_-]+/gu) ?? [];
function recallQueryTerms(query) {
  return termsFromQuery(query);
}
function recallRegexFromQuery(query) {
  const wrapped = query.match(/^\/(.+)\/([a-z]*)$/i);
  const pattern = wrapped?.[1] ?? query;
  if (wrapped === null && !/[|*+?{}()[\]\\^$.]/u.test(query)) return void 0;
  if (pattern.length > MAX_PATTERN_CHARS || hasUnsafeStructure(pattern)) return void 0;
  const rawFlags = wrapped?.[2].toLocaleLowerCase() ?? "";
  const flags = rawFlags.length === 0 ? "i" : rawFlags.includes("i") ? rawFlags : `${rawFlags}i`;
  try {
    return new RegExp(pattern, flags);
  } catch {
    return void 0;
  }
}

// src/recall-files.ts
var PATH_KEYS3 = ["path", "file_path", "filePath", "file", "filename", "target"];
var MUTATION_TOOL_NAMES = /* @__PURE__ */ new Set([
  "write",
  "edit",
  "multiedit",
  "write_file",
  "edit_file",
  "apply_patch",
  "patch",
  "writefile",
  "editfile",
  "applypatch",
  "create_file",
  "createfile",
  "replace_file",
  "replacefile",
  "str_replace",
  "strreplace",
  "insert_file",
  "overwrite_file",
  "update_file",
  "updatefile",
  "diff",
  "applydiff"
]);
var isRecallFileMutationTool = (name) => {
  if (typeof name !== "string") return false;
  const normalized = name.trim().toLocaleLowerCase();
  if (MUTATION_TOOL_NAMES.has(normalized)) return true;
  return /(?:^|[/.:_-])(?:write|edit|patch|replace|create|update)(?:$|[/.:_-])/u.test(normalized) || /(?:write|edit|patch|replace|create|update)(?:_?file)?$/u.test(normalized);
};
var asRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
var parseArguments2 = (value) => {
  const record = asRecord(value);
  if (record !== void 0) return record;
  if (typeof value !== "string") return void 0;
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return void 0;
  }
};
var normalizePath = (value) => value.trim().replaceAll("\\", "/");
var pathFromArguments = (args) => {
  for (const key of PATH_KEYS3) {
    if (typeof args[key] === "string" && args[key].trim().length > 0) {
      return normalizePath(args[key]);
    }
  }
  return void 0;
};
var isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
var isContentBearing = (args) => {
  if (typeof args.content === "string") return true;
  if (Array.isArray(args.edits) && args.edits.length > 0 && args.edits.every(isObject)) return true;
  if (typeof args.oldText === "string" && args.edits === void 0) return true;
  if (typeof args.newText === "string" && args.edits === void 0) return true;
  return false;
};
var formatContent = (args) => {
  const sections = [];
  if (typeof args.content === "string") sections.push(args.content);
  if (Array.isArray(args.edits)) {
    if (args.edits.length > 0) {
      sections.push(args.edits.map((edit, index) => {
        const record = isObject(edit) ? edit : {};
        const oldText = typeof record.oldText === "string" ? record.oldText : "";
        const newText = typeof record.newText === "string" ? record.newText : "";
        return `--- edit ${index + 1} ---
${oldText}
--- becomes ---
${newText}`;
      }).join("\n\n"));
    }
  } else {
    const oldText = typeof args.oldText === "string" ? args.oldText : "";
    const newText = typeof args.newText === "string" ? args.newText : "";
    if (oldText || newText) sections.push(`--- old ---
${oldText}
--- new ---
${newText}`);
  }
  return sections.join("\n\n") || "(empty file content)";
};
function extractRecallFileOperations(message) {
  const operations = [];
  for (const block of message.content ?? []) {
    if (block.type !== "tool-call") continue;
    if (!isRecallFileMutationTool(block.name)) continue;
    const args = parseArguments2(block.arguments);
    if (args === void 0 || !isContentBearing(args)) continue;
    const path = pathFromArguments(args);
    if (path === void 0) continue;
    operations.push({
      path,
      tool: typeof block.name === "string" && block.name.length > 0 ? block.name : "unknown",
      content: formatContent(args)
    });
  }
  return operations;
}
var utf8Encoder2 = typeof TextEncoder === "function" ? new TextEncoder() : void 0;
var byteLength = (text) => utf8Encoder2?.encode(text).byteLength ?? text.length;
var clipUtf8 = (text, maxBytes) => {
  if (!Number.isFinite(maxBytes)) return text;
  if (text.length <= maxBytes && byteLength(text) <= maxBytes) return text;
  let bytes = 0;
  let end = 0;
  for (const character of text) {
    const size = byteLength(character);
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += character.length;
  }
  return text.slice(0, end);
};
var clipForSearch = (text, maxBytes = 10240) => {
  if (byteLength(text) <= maxBytes) return text;
  return clipUtf8(text, maxBytes);
};
var PREVIEW_LINES = 30;
var MAX_FILE_PAGE_LINES = 1e3;
var FILE_RESPONSE_RESERVE_BYTES = 2 * 1024;
var linesByteLength = (lines) => lines.reduce(
  (total, line, index) => total + byteLength(line) + (index === 0 ? 0 : 1),
  0
);
var capLines = (lines, maxBytes) => {
  const totalBytes = linesByteLength(lines);
  const parts = [];
  let usedBytes = 0;
  let completeLines = 0;
  let truncatedInsideLine = false;
  for (const line of lines) {
    const separatorBytes = parts.length === 0 ? 0 : 1;
    const requiredBytes = separatorBytes + byteLength(line);
    if (usedBytes + requiredBytes <= maxBytes) {
      parts.push(line);
      usedBytes += requiredBytes;
      completeLines += 1;
      continue;
    }
    if (parts.length === 0) {
      const clipped = clipUtf8(line, Math.max(0, maxBytes));
      parts.push(clipped);
      usedBytes = byteLength(clipped);
      truncatedInsideLine = byteLength(clipped) < byteLength(line);
    }
    break;
  }
  const text = parts.join("\n");
  return {
    text,
    omittedBytes: Math.max(0, totalBytes - byteLength(text)),
    completeLines,
    truncatedInsideLine
  };
};
function recallFileSearchText(operations) {
  return operations.map((operation) => clipForSearch(operation.content)).join("\n");
}
var snippetFor = (text, query, regex) => {
  if (regex !== void 0) {
    regex.lastIndex = 0;
    const match = regex.exec(text);
    regex.lastIndex = 0;
    if (match !== null) {
      const start2 = Math.max(0, match.index - 60);
      const end2 = Math.min(text.length, match.index + Math.max(1, match[0].length) + 60);
      return `${start2 > 0 ? "..." : ""}${text.slice(start2, end2)}${end2 < text.length ? "..." : ""}`;
    }
  }
  const terms = recallQueryTerms(query);
  const lowered = text.toLocaleLowerCase();
  const term = terms.find((candidate) => lowered.includes(candidate.toLocaleLowerCase()));
  if (term === void 0) return void 0;
  const index = lowered.indexOf(term.toLocaleLowerCase());
  const start = Math.max(0, index - 60);
  const end = Math.min(text.length, index + term.length + 60);
  return `${start > 0 ? "..." : ""}${text.slice(start, end)}${end < text.length ? "..." : ""}`;
};
function findRecallFileMatches(operations, query) {
  const regex = recallRegexFromQuery(query);
  const terms = recallQueryTerms(query).map((term) => term.toLocaleLowerCase());
  return operations.flatMap((operation) => {
    const searchable = clipForSearch(operation.content);
    const matched = regex !== void 0 ? (regex.lastIndex = 0, regex.test(searchable)) : terms.some((term) => searchable.toLocaleLowerCase().includes(term));
    if (!matched) return [];
    const matchingLines = searchable.split("\n").filter((line) => {
      if (regex !== void 0) {
        regex.lastIndex = 0;
        return regex.test(line);
      }
      const lowered = line.toLocaleLowerCase();
      return terms.some((term) => lowered.includes(term));
    });
    return [{
      path: operation.path,
      tool: operation.tool,
      lineCount: matchingLines.length,
      snippet: snippetFor(searchable, query, regex)
    }];
  });
}
var pathMatches = (path, pattern) => path.toLocaleLowerCase().includes(pattern.toLocaleLowerCase());
var MAX_OPERATION_LIST_ENTRIES = 100;
var listOperations = (seq, operations) => {
  const visible = operations.slice(0, MAX_OPERATION_LIST_ENTRIES);
  const lines = visible.map((operation) => `  [#${seq}:${operation.path}] ${operation.tool}(${operation.path})`);
  const omitted = operations.length - visible.length;
  if (omitted > 0) lines.push(`  ... ${omitted} more operations omitted; use a more specific path.`);
  return lines.join("\n");
};
var formatOperation = (operation, seq, options) => {
  const body = operation.content;
  const allLines = body.split("\n");
  const totalLines = allLines.length;
  const previewLimit = PREVIEW_LINES;
  const header = `File: ${operation.path}
Tool: ${operation.tool}`;
  const bodyBudget = Math.max(
    0,
    MAX_RECALL_OUTPUT_BYTES - byteLength(header) - FILE_RESPONSE_RESERVE_BYTES
  );
  if (options.full) {
    const capped2 = capLines(allLines, bodyBudget);
    if (capped2.omittedBytes > 0) {
      const continuation = capped2.truncatedInsideLine ? " The 50KB cap falls inside a line; line-based paging cannot continue within that line." : ` Use #${seq}:${operation.path}:${capped2.completeLines}:${previewLimit} to continue with paged lines.`;
      return `${header}

${capped2.text}

... (${capped2.omittedBytes} more bytes \u2014 file exceeds 50KB display limit.${continuation})`;
    }
    return `${header}

${body}`;
  }
  if (options.offset !== void 0) {
    const start = Math.max(0, options.offset);
    const maxLines = Math.min(
      MAX_FILE_PAGE_LINES,
      Math.max(1, options.limit ?? previewLimit)
    );
    const end = Math.min(start + maxLines, totalLines);
    const visible = allLines.slice(start, end);
    if (visible.length === 0) return `Offset ${start} is beyond file length ${totalLines}. Use #${seq}:${operation.path} for the first ${previewLimit} lines.`;
    const capped2 = capLines(visible, bodyBudget);
    const displayedLines = capped2.truncatedInsideLine ? 1 : capped2.completeLines;
    const displayedEnd = start + Math.max(1, displayedLines);
    let output = `${header}
Lines ${start + 1}-${displayedEnd} (of ${totalLines}):

${capped2.text}`;
    if (capped2.omittedBytes > 0) {
      output += capped2.truncatedInsideLine ? `

... (${capped2.omittedBytes} more bytes in this line range \u2014 the 50KB cap falls inside a line, so line-based paging cannot continue within that line.)` : `

... (${capped2.omittedBytes} more bytes in this line range.)`;
    }
    const nextOffset = capped2.omittedBytes > 0 ? start + capped2.completeLines : end;
    if (!capped2.truncatedInsideLine && nextOffset < totalLines) {
      output += `

--- Use #${seq}:${operation.path}:${nextOffset} or #${seq}:${operation.path}:${nextOffset}:${maxLines} for next ${maxLines} lines, #${seq}:${operation.path}:full for complete ---`;
    } else if (capped2.omittedBytes === 0 && start > 0) {
      output += "\n\n(End of file)";
    }
    return output;
  }
  const previewEnd = Math.min(previewLimit, totalLines);
  const capped = capLines(allLines.slice(0, previewEnd), bodyBudget);
  let note = "";
  if (capped.omittedBytes > 0) {
    note = capped.truncatedInsideLine ? `

... (${capped.omittedBytes} more bytes in the preview \u2014 the 50KB cap falls inside a line, so line-based paging cannot continue within that line.)` : `

... (${capped.omittedBytes} more bytes in the preview \u2014 use #${seq}:${operation.path}:${capped.completeLines}:${previewLimit} to continue.)`;
  } else if (totalLines > previewEnd) {
    note = `

...(${totalLines - previewEnd} more lines \u2014 use #${seq}:${operation.path}:full for complete content, or #${seq}:${operation.path}:${previewEnd} for next ${previewLimit} lines)`;
  }
  return `${header}

${capped.text}${note}`;
};
function parseRecallDrillDown(query) {
  const match = query.match(/^#(\d+):(.+?)(?::(full|\d+(?::\d+)?))?$/iu);
  if (!match) return void 0;
  const seq = Number(match[1]);
  if (!Number.isSafeInteger(seq) || seq < 0) return void 0;
  const pathPattern = match[2];
  const suffix = match[3];
  if (suffix?.toLocaleLowerCase() === "full") return { seq, pathPattern, full: true };
  if (suffix !== void 0) {
    const parts = suffix.split(":").map(Number);
    const offset = parts[0];
    const limit = parts[1];
    if (!Number.isSafeInteger(offset) || offset < 0) return void 0;
    if (limit !== void 0 && (!Number.isSafeInteger(limit) || limit < 1)) return void 0;
    return { seq, pathPattern, full: false, offset, ...limit === void 0 ? {} : { limit } };
  }
  return { seq, pathPattern, full: false };
}
function renderRecallFileDrillDown(seq, operations, drillDown) {
  let rendered;
  if (drillDown.pathPattern.toLocaleLowerCase() === "file") {
    if (operations.length === 0) rendered = `No file content found in entry #${seq}.`;
    else if (operations.length > 1) rendered = `Entry #${seq} has ${operations.length} file operations:
${listOperations(seq, operations)}

Use #${seq}:path to drill into a specific file.`;
    else rendered = formatOperation(operations[0], seq, drillDown);
  } else {
    const matched = operations.filter((operation) => pathMatches(operation.path, drillDown.pathPattern));
    if (matched.length === 0) rendered = `No file content found in entry #${seq} for "${drillDown.pathPattern}".`;
    else if (matched.length > 1) {
      const uniquePaths = new Set(matched.map((operation) => operation.path.toLocaleLowerCase()));
      if (uniquePaths.size === 1) {
        const combined = {
          path: matched[0].path,
          tool: `${matched.map((operation) => operation.tool).join(", ")} (${matched.length} operations)`,
          content: matched.map((operation, index) => `--- operation ${index + 1} ---
${operation.content}`).join("\n\n")
        };
        rendered = formatOperation(combined, seq, drillDown);
      } else {
        rendered = `Entry #${seq} has ${matched.length} file operations matching "${drillDown.pathPattern}":
${listOperations(seq, matched)}

Use #${seq}:<more-specific-path> to drill into a specific file.`;
      }
    } else rendered = formatOperation(matched[0], seq, drillDown);
  }
  const note = rendered.includes("cannot continue within that line") ? "file drill-down response truncated at 50KB; the cap falls inside a line, so line-based paging cannot continue within that line." : "file drill-down response truncated at 50KB; narrow the path or line range.";
  return capRecallOutput(rendered, note);
}

// src/recall.ts
var isOmMemoryId = (query) => /^[a-f0-9]{12}$/u.test((query ?? "").trim());
var OM_RECALL_TODO = "OM \u56DE\u8BFB\u5728 dsh-blackhole \u4E2D\u6682\u672A\u5B9E\u73B0\uFF1A12 \u4F4D observation/reflection ID \u5C1A\u672A\u5EFA\u7ACB\u7D22\u5F15\u3002\u8BF7\u4F7F\u7528 #N\u3001#N:path\uFF0C\u6216\u4EE5\u6587\u672C/\u6B63\u5219\u67E5\u8BE2\u8F6C\u5F55\u5185\u5BB9\u3002";
var PAGE_SIZE = 5;
var DEFAULT_RECENT = 25;
var USER_TEXT_PREVIEW_CHARS = 300;
var TOOL_RESULT_PREVIEW_CHARS = 200;
var TOOL_ARGS_PREVIEW_CHARS = 300;
var SEARCH_BLOCK_CHARS = 10240;
var MAX_RESULT_ENTRIES = 100;
var MAX_EXPANSION_ENTRIES = 50;
var MAX_FILE_MATCH_NOTES = 100;
var PATH_KEYS4 = ["path", "file_path", "filePath", "file", "filename", "target"];
var FILE_CONTENT_KEYS = [
  "content",
  "contents",
  "edits",
  "oldText",
  "old_text",
  "newText",
  "new_text",
  "patch",
  "diff",
  "body",
  "source"
];
var asRecord2 = (value) => typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
var asText2 = (value) => typeof value === "string" ? value : "";
var sliceChars = (text, maxChars) => {
  if (text.length <= maxChars) return text;
  let end = Math.max(0, maxChars);
  const trailingCodeUnit = text.charCodeAt(end - 1);
  if (trailingCodeUnit >= 55296 && trailingCodeUnit <= 56319) end -= 1;
  return text.slice(0, end);
};
var clipChars = (text, maxChars) => text.length <= maxChars ? text : `${sliceChars(text, maxChars)}\u2026`;
var flattenBlocks = (blocks, maxChars = Number.POSITIVE_INFINITY) => {
  const parts = [];
  let remaining = maxChars;
  for (const block of blocks ?? []) {
    if (remaining <= 0) break;
    const separatorChars = parts.length === 0 ? 0 : 1;
    const available = Math.max(0, remaining - separatorChars);
    let text = "";
    if (block.type === "text" || block.type === "reasoning") text = asText2(block.text);
    else if (block.type === "tool-result") text = flattenBlocks(block.content, available);
    else if (block.type === "image") text = "[image]";
    else if (block.type === "document") text = "[document]";
    if (!text) continue;
    const visible = sliceChars(text, available);
    if (!visible) break;
    parts.push(visible);
    remaining -= separatorChars + visible.length;
    if (visible.length < text.length) break;
  }
  return parts.join("\n");
};
var parseArgs = (value) => {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value;
  if (typeof value !== "string") return void 0;
  try {
    return asRecord2(JSON.parse(value));
  } catch {
    return void 0;
  }
};
var filePathFromBlock = (block) => {
  if (block.type !== "tool-call") return void 0;
  const args = parseArgs(block.arguments);
  if (args === void 0) return void 0;
  for (const key of PATH_KEYS4) {
    if (typeof args[key] === "string" && args[key].trim()) return args[key].replaceAll("\\", "/");
  }
  return void 0;
};
var searchArguments = (args, rendered, toolName) => {
  const mutationTool = isRecallFileMutationTool(toolName);
  if (args === void 0) {
    return mutationTool ? "[file arguments omitted; invalid tool-call JSON]" : rendered;
  }
  const projected = { ...args };
  let redacted = false;
  if (mutationTool) {
    for (const key of FILE_CONTENT_KEYS) {
      if (projected[key] === void 0) continue;
      projected[key] = "[file content indexed separately]";
      redacted = true;
    }
  }
  if (!redacted && mutationTool) {
    const visibleKeys = new Set(PATH_KEYS4);
    const conservative = { ...projected };
    for (const [key, value] of Object.entries(conservative)) {
      if (visibleKeys.has(key)) continue;
      if (typeof value === "string" || Array.isArray(value) || typeof value === "object") {
        conservative[key] = "[file content indexed separately]";
        redacted = true;
      }
    }
    if (redacted) return JSON.stringify(conservative);
  }
  return redacted ? JSON.stringify(projected) : rendered;
};
var displayArguments = (args, rendered, path, seq, toolName) => {
  const indexed = searchArguments(args, rendered, toolName);
  const redaction = "[file content indexed separately]";
  const visible = path === void 0 ? indexed.replaceAll(redaction, "[file content omitted; no file path]") : indexed.replaceAll(redaction, `[file content omitted; use #${seq}:${path}]`);
  return clipChars(visible, TOOL_ARGS_PREVIEW_CHARS);
};
var renderExpandedMessage = (message, seq) => {
  const role = message.role === "assistant" ? "assistant" : "user";
  const lines = [];
  let remainingBytes = MAX_RECALL_OUTPUT_BYTES;
  const pushLine = (line) => {
    const separatorBytes = lines.length === 0 ? 0 : recallUtf8ByteLength("\n");
    const available = Math.max(0, remainingBytes - separatorBytes);
    const visible = clipRecallUtf8(line, available);
    if (!visible) return false;
    lines.push(visible);
    remainingBytes -= separatorBytes + recallUtf8ByteLength(visible);
    return visible.length === line.length;
  };
  pushLine(`[${role}]`);
  for (const block of message.content ?? []) {
    if (remainingBytes <= 0) break;
    if (block.type === "text" || block.type === "reasoning") {
      const text = asText2(block.text).trim();
      if (text && !pushLine(text)) break;
      continue;
    }
    if (block.type === "tool-call") {
      const name = typeof block.name === "string" ? block.name : "unknown";
      const args = parseArgs(block.arguments);
      const path = filePathFromBlock(block);
      const argumentText = args === void 0 ? asText2(block.arguments) : JSON.stringify(args);
      const visibleArguments = displayArguments(args, argumentText, path, seq, name);
      if (!pushLine(`* ${name}${visibleArguments ? ` ${visibleArguments}` : ""}`)) break;
      continue;
    }
    if (block.type === "tool-result") {
      const resultText = flattenBlocks(block.content, remainingBytes) || "(empty)";
      if (!pushLine(`[tool-result${block.isError ? " error" : ""}] ${resultText}`)) break;
      continue;
    }
    if ((block.type === "image" || block.type === "document") && !pushLine(`[${block.type}]`)) break;
  }
  pushLine(`(seq ${seq})`);
  return lines.join("\n");
};
var renderMessage = (message, seq) => {
  const role = message.role === "assistant" ? "assistant" : "user";
  const lines = [`[${role}]`];
  const searchLines = [`[${role}]`];
  const files = [];
  const toolCallIds = [];
  for (const block of message.content ?? []) {
    if (block.type === "text" || block.type === "reasoning") {
      const text2 = asText2(block.text).trim();
      if (text2) {
        lines.push(clipChars(text2, USER_TEXT_PREVIEW_CHARS));
        searchLines.push(clipChars(text2, SEARCH_BLOCK_CHARS));
      }
      continue;
    }
    if (block.type === "tool-call") {
      const name = typeof block.name === "string" ? block.name : "unknown";
      const args = parseArgs(block.arguments);
      const path = filePathFromBlock(block);
      if (path !== void 0) files.push(path);
      if (typeof block.id === "string") toolCallIds.push(block.id);
      const argumentText = args === void 0 ? asText2(block.arguments) : JSON.stringify(args);
      const indexedArguments = searchArguments(args, argumentText, name);
      const visibleArguments = displayArguments(args, argumentText, path, seq, name);
      lines.push(`* ${name}${visibleArguments ? ` ${visibleArguments}` : ""}`);
      searchLines.push(`* ${name}${indexedArguments ? ` ${clipChars(indexedArguments, SEARCH_BLOCK_CHARS)}` : ""}`);
      continue;
    }
    if (block.type === "tool-result") {
      const toolCallId = typeof block.toolCallId === "string" ? block.toolCallId : "";
      if (toolCallId) toolCallIds.push(toolCallId);
      const resultText = flattenBlocks(block.content, SEARCH_BLOCK_CHARS) || "(empty)";
      const resultPrefix = `[tool-result${block.isError ? " error" : ""}] `;
      lines.push(`${resultPrefix}${clipChars(resultText, TOOL_RESULT_PREVIEW_CHARS)}`);
      searchLines.push(`${resultPrefix}${clipChars(resultText, SEARCH_BLOCK_CHARS)}`);
      continue;
    }
    if (block.type === "image" || block.type === "document") {
      lines.push(`[${block.type}]`);
      searchLines.push(`[${block.type}]`);
    }
  }
  lines.push(`(seq ${seq})`);
  searchLines.push(`(seq ${seq})`);
  const text = lines.join("\n");
  const fileOperations = extractRecallFileOperations(message);
  return {
    text,
    getExpandedText: () => renderExpandedMessage(message, seq),
    files: [.../* @__PURE__ */ new Set([...files, ...fileOperations.map((operation) => operation.path)])],
    fileOperations,
    searchText: `${searchLines.join("\n")}
${recallFileSearchText(fileOperations)}`.trim(),
    toolCallIds: [...new Set(toolCallIds)]
  };
};
function indexRecallSession(session) {
  return session.events.flatMap((event) => {
    if (!Number.isSafeInteger(event.seq)) return [];
    const message = session.deriveEventMessage(event);
    if (message === null) return [];
    const rendered = renderMessage(message, event.seq);
    let expandedText;
    const entry = {
      seq: event.seq,
      id: typeof message.id === "string" ? message.id : `seq-${event.seq}`,
      message,
      text: rendered.text,
      get expandedText() {
        expandedText ??= rendered.getExpandedText();
        return expandedText;
      },
      files: rendered.files,
      fileOperations: rendered.fileOperations,
      searchText: rendered.searchText,
      toolCallIds: rendered.toolCallIds
    };
    Object.defineProperty(entry, "expandedText", { enumerable: false });
    return [entry];
  });
}
var normalizeQuery = (query) => (query ?? "").trim();
var parseEntryReference = (query) => {
  const match = query.match(/^#(\d+)$/u);
  if (match === null) return void 0;
  const seq = Number(match[1]);
  return Number.isSafeInteger(seq) && seq >= 0 ? seq : void 0;
};
var termsOf = (query) => recallQueryTerms(query).map((term) => term.toLocaleLowerCase());
function rankRecallEntries(entries, query, mode = "hybrid") {
  const normalized = normalizeQuery(query);
  if (!normalized) return [...entries];
  const regex = recallRegexFromQuery(normalized);
  const corpusOf = (entry) => mode === "file" ? recallFileSearchText(entry.fileOperations) : entry.searchText;
  if (regex !== void 0) return entries.filter((entry) => {
    regex.lastIndex = 0;
    return regex.test(corpusOf(entry));
  });
  const terms = [...new Set(termsOf(normalized))];
  if (terms.length === 0) return [];
  const documentFrequency = /* @__PURE__ */ new Map();
  const tokenSets = entries.map((entry) => new Set(termsOf(corpusOf(entry))));
  for (const tokenSet of tokenSets) for (const term of terms) if (tokenSet.has(term)) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  const averageLength = entries.length === 0 ? 1 : entries.reduce((sum, entry) => sum + termsOf(corpusOf(entry)).length, 0) / entries.length;
  const scored = entries.map((entry, index) => {
    const corpus = corpusOf(entry);
    const tokens = termsOf(corpus);
    const counts = /* @__PURE__ */ new Map();
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
    const score = terms.reduce((total, term) => {
      const frequency = counts.get(term) ?? 0;
      if (frequency === 0) return total;
      const idf = Math.log(1 + (entries.length - (documentFrequency.get(term) ?? 0) + 0.5) / ((documentFrequency.get(term) ?? 0) + 0.5));
      const lengthNorm = 1 + 0.75 * (tokens.length / Math.max(1, averageLength) - 1);
      return total + idf * (frequency * 2.2 / (frequency + 1.2 * lengthNorm));
    }, 0) + (corpus.toLocaleLowerCase().includes(normalized.toLocaleLowerCase()) ? 1 : 0);
    return { entry, score, index };
  });
  return scored.filter((item) => item.score > 0).sort((a, b) => b.score - a.score || a.index - b.index).map((item) => item.entry);
}
var touchedFilesOf = (entries) => {
  const files = /* @__PURE__ */ new Map();
  for (const entry of entries) for (const operation of entry.fileOperations) {
    const refs = files.get(operation.path) ?? [];
    const existing = refs.find((ref) => ref.seq === entry.seq);
    if (existing === void 0) refs.push({ seq: entry.seq, tools: /* @__PURE__ */ new Set([operation.tool]) });
    else existing.tools.add(operation.tool);
    files.set(operation.path, refs);
  }
  return [...files.entries()].map(([path, refs]) => ({
    path,
    refs: refs.map((ref) => ({ seq: ref.seq, tools: [...ref.tools] }))
  }));
};
var formatTouched = (entries, params) => {
  const files = touchedFilesOf(entries);
  if (files.length === 0) return { text: "No touched files found.", total: 0, page: 1, totalPages: 1, entrySeqs: [] };
  const requestedLimit = params.limit;
  const pageSize = typeof requestedLimit === "number" && Number.isSafeInteger(requestedLimit) && requestedLimit > 0 ? Math.min(MAX_RESULT_ENTRIES, requestedLimit) : PAGE_SIZE;
  const explicitOffset = typeof params.offset === "number" && Number.isSafeInteger(params.offset) && params.offset >= 0 ? params.offset : void 0;
  const requestedPage = params.page;
  const page = explicitOffset === void 0 ? typeof requestedPage === "number" && Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1 : Math.floor(explicitOffset / pageSize) + 1;
  const offset = explicitOffset ?? (page - 1) * pageSize;
  const totalPages = Math.max(1, Math.ceil(files.length / pageSize));
  const visible = files.slice(offset, offset + pageSize);
  const lines = visible.map((file) => {
    const refs = file.refs.map((ref) => `#${ref.seq} (${ref.tools.join(", ")})`).join(", ");
    return `- ${file.path} \u2014 ${refs}`;
  });
  const nextPage = offset + pageSize < files.length ? `
--- Use page:${page + 1} limit:${pageSize} or offset:${offset + pageSize} limit:${pageSize} for more files ---` : "";
  const entrySeqs = [...new Set(visible.flatMap((file) => file.refs.map((ref) => ref.seq)))];
  return {
    text: `Page ${page}/${totalPages} (${files.length} total files)

${lines.join("\n") || "No touched files on this page."}${nextPage}`,
    total: files.length,
    page,
    totalPages,
    entrySeqs
  };
};
function recallSession(session, params = {}) {
  const mode = params.mode ?? "hybrid";
  const query = normalizeQuery(params.query);
  if (isOmMemoryId(query)) {
    return { text: OM_RECALL_TODO, entries: [], total: 0, page: 1, totalPages: 1 };
  }
  const allEntries = indexRecallSession(session);
  const allowedSeqs = params.scope === "all" || session.lineageSeqs === void 0 ? void 0 : new Set(session.lineageSeqs);
  const scoped = allowedSeqs === void 0 ? allEntries : allEntries.filter((entry) => allowedSeqs.has(entry.seq));
  if (mode === "touched") {
    const touched = formatTouched(scoped, params);
    const entrySeqs = new Set(touched.entrySeqs);
    const entries = scoped.filter((entry) => entrySeqs.has(entry.seq)).slice(0, MAX_RESULT_ENTRIES);
    return {
      text: capRecallOutput(touched.text),
      entries,
      total: touched.total,
      page: touched.page,
      totalPages: touched.totalPages
    };
  }
  const entryReference = parseEntryReference(query);
  if (entryReference !== void 0) {
    const entry = scoped.find((candidate) => candidate.seq === entryReference);
    if (entry === void 0) {
      return { text: `Cannot expand indices outside the selected scope: ${entryReference}. Use scope:'all' to reach other branches.`, entries: [], total: 0, page: 1, totalPages: 1 };
    }
    return {
      text: capRecallOutput(`#${entry.seq}
${entry.expandedText}`),
      entries: [entry],
      total: 1,
      page: 1,
      totalPages: 1
    };
  }
  const drillDown = parseRecallDrillDown(query);
  if (drillDown === void 0 && /^#\d+:/u.test(query)) {
    return {
      text: "Invalid recall drill-down syntax. Use #N:path, #N:path:full, #N:path:offset, or #N:path:offset:limit.",
      entries: [],
      total: 0,
      page: 1,
      totalPages: 1
    };
  }
  if (drillDown !== void 0) {
    const entry = scoped.find((candidate) => candidate.seq === drillDown.seq);
    if (entry === void 0) {
      return { text: `Cannot expand indices outside the selected scope: ${drillDown.seq}. Use scope:'all' to reach other branches.`, entries: [], total: 0, page: 1, totalPages: 1 };
    }
    return {
      text: renderRecallFileDrillDown(entry.seq, entry.fileOperations, drillDown),
      entries: [entry],
      total: 1,
      page: 1,
      totalPages: 1
    };
  }
  const candidates = mode === "file" ? scoped.filter((entry) => entry.fileOperations.length > 0) : scoped;
  const ranked = query ? rankRecallEntries(candidates, query, mode) : candidates.slice(-DEFAULT_RECENT);
  const uniqueExpansionTargets = [...new Set(params.expand ?? [])];
  const expansionTargets = uniqueExpansionTargets.slice(0, MAX_EXPANSION_ENTRIES);
  const entriesBySeq = new Map(scoped.map((entry) => [entry.seq, entry]));
  const expanded = expansionTargets.flatMap((seq) => {
    const entry = entriesBySeq.get(seq);
    return entry === void 0 ? [] : [entry];
  });
  const merged = [...new Map([...ranked, ...expanded].map((entry) => [entry.seq, entry])).values()];
  const explicitOffset = Number.isFinite(params.offset) ? Math.max(0, Math.floor(params.offset)) : void 0;
  const explicitLimit = Number.isFinite(params.limit) ? Math.min(MAX_RESULT_ENTRIES, Math.max(1, Math.floor(params.limit))) : void 0;
  const pageSize = explicitLimit ?? PAGE_SIZE;
  const requestedPage = params.page;
  const page = explicitOffset === void 0 ? typeof requestedPage === "number" && Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1 : Math.floor(explicitOffset / pageSize) + 1;
  const offset = explicitOffset ?? (page - 1) * pageSize;
  const totalPages = Math.max(1, Math.ceil(merged.length / pageSize));
  const pagedEntries = merged.slice(offset, offset + pageSize);
  const allPageEntries = [...new Map([...expanded, ...pagedEntries].map((entry) => [entry.seq, entry])).values()];
  const pageEntries = allPageEntries.slice(0, MAX_RESULT_ENTRIES);
  const expandedSeqs = new Set(expanded.map((entry) => entry.seq));
  const expansionNotice = uniqueExpansionTargets.length > MAX_EXPANSION_ENTRIES ? `
--- Only the first ${MAX_EXPANSION_ENTRIES} explicit expansions are shown; narrow expand for the rest. ---` : "";
  const resultNotice = allPageEntries.length > MAX_RESULT_ENTRIES ? `
--- ${allPageEntries.length - MAX_RESULT_ENTRIES} page entries omitted by the ${MAX_RESULT_ENTRIES}-entry response bound; use paging or narrower expand. ---` : "";
  const header = query ? `${merged.length} matches${params.scope === "all" ? " (scope: all)" : ""}` : `Recent session entries${params.scope === "all" ? " (scope: all)" : ""}`;
  const nextPage = offset + pageSize < merged.length ? `
--- Use offset:${offset + pageSize} limit:${pageSize} for more results ---` : "";
  const decorated = pageEntries.map((entry) => {
    if (query && entry.fileOperations.length > 0) {
      Object.defineProperty(entry, "fileMatches", {
        configurable: true,
        enumerable: true,
        value: findRecallFileMatches(entry.fileOperations, query),
        writable: false
      });
    }
    return entry;
  });
  const fileNotes = (entry) => {
    if (entry.fileMatches === void 0 || entry.fileMatches.length === 0) return "";
    const visibleMatches = entry.fileMatches.slice(0, MAX_FILE_MATCH_NOTES);
    const omitted = entry.fileMatches.length - visibleMatches.length;
    return `
[file matches]
${visibleMatches.map((match) => `- ${match.path} (${match.tool}, ${match.lineCount} matching lines)${match.snippet === void 0 ? "" : `
  ${match.snippet}`}`).join("\n")}${omitted > 0 ? `
- ... ${omitted} more file matches omitted; narrow the query.` : ""}`;
  };
  const text = capRecallOutput(`${header}

${decorated.map((entry) => `#${entry.seq}
${expandedSeqs.has(entry.seq) ? entry.expandedText : entry.text}${fileNotes(entry)}`).join("\n\n") || "No matching session entries."}${nextPage}${expansionNotice}${resultNotice}`);
  return { text, entries: decorated, total: merged.length, page, totalPages };
}
var recallParameters = {
  query: { type: "string", description: "Text/regex search; #N expands an entry; #N:path drills file content with :full or :offset:limit. 12-char OM ids are TODO." },
  expand: { type: "array", items: { type: "integer" }, description: "Durable seq numbers to expand." },
  page: { type: "integer", description: "1-based result page." },
  offset: { type: "integer", description: "Zero-based result offset." },
  limit: { type: "integer", description: "Maximum results after offset." },
  scope: { type: "string", enum: ["lineage", "all"], description: "Search active lineage or all available session events." },
  mode: { type: "string", enum: ["hybrid", "file", "touched"], description: "Search transcript + file content, file content only, or aggregate touched files." }
};
var recallOutputSpec = {
  type: "object",
  additionalProperties: false,
  properties: {
    text: { type: "string", required: true, description: "Rendered recall response (UTF-8, size-capped)." }
  }
};
var recallQueryFromUnknown = (value) => {
  const record = asRecord2(value);
  if (record === void 0) return {};
  const positiveInteger = (candidate) => typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate > 0 ? candidate : void 0;
  const nonNegativeInteger = (candidate) => typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : void 0;
  const expand = Array.isArray(record.expand) ? record.expand.slice(0, MAX_EXPANSION_ENTRIES + 1).filter((candidate) => typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0) : void 0;
  const page = positiveInteger(record.page);
  const offset = nonNegativeInteger(record.offset);
  const limit = positiveInteger(record.limit);
  const scope = record.scope === "lineage" || record.scope === "all" ? record.scope : void 0;
  const mode = record.mode === "hybrid" || record.mode === "file" || record.mode === "touched" ? record.mode : void 0;
  return {
    ...typeof record.query === "string" ? { query: record.query } : {},
    ...expand === void 0 ? {} : { expand },
    ...page === void 0 ? {} : { page },
    ...offset === void 0 ? {} : { offset },
    ...limit === void 0 ? {} : { limit },
    ...scope === void 0 ? {} : { scope },
    ...mode === void 0 ? {} : { mode }
  };
};
function createRecallTool(getSession) {
  return {
    name: "recall",
    description: "Search durable session history and recover compacted context, file operations, and earlier tool results.",
    parameters: recallParameters,
    output: {
      schema: recallOutputSpec,
      render: (_args, value) => {
        const rendered = asRecord2(value)?.text;
        return [{ type: "text", text: typeof rendered === "string" ? rendered : String(value) }];
      }
    },
    async execute(args, exec) {
      const session = getSession(exec);
      if (session === void 0) return { text: "No session is available for recall." };
      const result = recallSession(session, recallQueryFromUnknown(args));
      return { text: result.text };
    }
  };
}
function adaptRecallSession(session) {
  if (typeof session !== "object" || session === null) return void 0;
  const candidate = session;
  if (candidate.snapshotEvents === void 0 && !Array.isArray(candidate.events)) return void 0;
  return {
    events: readSessionEvents(candidate),
    deriveEventMessage: (event) => deriveSessionMessage(candidate, event)
  };
}
function registerRecallTool(registry, getSession) {
  return registry.register(createRecallTool(getSession));
}

// src/mode-command.ts
import { mkdirSync, readFileSync as readFileSync2, rmSync, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join3 } from "node:path";
var MODE_COMMAND_NAME = "blackhole-mode";
var FALLBACK_MODES = ["instant", "instant-then-llm", "llm"];
var MODE_DESCRIPTIONS = {
  instant: "\u672C\u5730\u786E\u5B9A\u6027 VCC \u7F16\u8BD1\u5668\uFF08\u96F6\u6A21\u578B\u8C03\u7528\uFF0C(seq N) \u56DE\u8BFB\u6307\u9488\uFF09",
  "instant-then-llm": "\u5148\u672C\u5730\u7F16\u8BD1\uFF0C\u4EC5\u5F53\u7F16\u8BD1\u5668\u4E5F\u5931\u8D25\u65F6\u6539\u7528\u539F\u751F LLM \u6458\u8981",
  llm: "\u539F\u751F\u5355\u6B21 LLM \u6458\u8981\uFF08\u5B98\u65B9 dsh-compaction-basic \u884C\u4E3A\uFF09"
};
var USAGE = "\u7528\u6CD5\uFF1A[instant | instant-then-llm | llm | remote [on | off] | reset]";
function parseModeCommandInput(rawInput) {
  const input = rawInput.trim().toLowerCase();
  if (input.length === 0) return { action: "status" };
  if (FALLBACK_MODES.includes(input)) {
    return { action: "mode", mode: input };
  }
  if (input === "reset") return { action: "reset" };
  if (input === "remote" || input.startsWith("remote ")) {
    const argument = input.slice("remote".length).trim();
    if (argument.length === 0) return { action: "remote" };
    if (argument === "on") return { action: "remote", enabled: true };
    if (argument === "off") return { action: "remote", enabled: false };
    return {
      action: "invalid",
      message: `"remote ${argument}" \u4E0D\u662F\u5408\u6CD5\u53D6\u503C\uFF1B\u8BF7\u7528 "remote on" \u6216 "remote off"`
    };
  }
  return {
    action: "invalid",
    message: `\u672A\u77E5\u6A21\u5F0F ${JSON.stringify(rawInput.trim())}\uFF1B${USAGE}`
  };
}
var RUNTIME_MODE_FILE = "runtime-mode.json";
function runtimeModeFilePath(dir) {
  return join3(dir, RUNTIME_MODE_FILE);
}
function loadRuntimeModeOverride(dir) {
  if (dir === void 0 || dir.length === 0) return void 0;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync2(runtimeModeFilePath(dir), "utf8"));
  } catch {
    return void 0;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
  const record = parsed;
  const override = {};
  const mode = record.fallbackMode;
  if (typeof mode === "string" && FALLBACK_MODES.includes(mode)) {
    override.fallbackMode = mode;
  }
  if (typeof record.remoteEnabled === "boolean") override.remoteEnabled = record.remoteEnabled;
  if (typeof record.savedAt === "string") override.savedAt = record.savedAt;
  return override.fallbackMode === void 0 && override.remoteEnabled === void 0 ? void 0 : override;
}
function saveRuntimeModeOverride(dir, override) {
  if (dir === void 0 || dir.length === 0) return false;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync2(
      runtimeModeFilePath(dir),
      `${JSON.stringify({ savedAt: (/* @__PURE__ */ new Date()).toISOString(), ...override }, null, 2)}
`
    );
    return true;
  } catch {
    return false;
  }
}
function clearRuntimeModeOverride(dir) {
  if (dir === void 0 || dir.length === 0) return false;
  try {
    rmSync(runtimeModeFilePath(dir), { force: true });
    return true;
  } catch {
    return false;
  }
}
function statusText(controller) {
  const mode = controller.getFallbackMode();
  const remote = controller.isRemoteEnabled() ? "\u5DF2\u542F\u7528" : "\u5DF2\u7981\u7528";
  const modeOverride = mode !== controller.getFallbackModeDefault() ? `\uFF08\u8FD0\u884C\u65F6\u8986\u76D6\uFF1B\u914D\u7F6E\u9ED8\u8BA4\uFF1A${controller.getFallbackModeDefault()}\uFF09` : "";
  const remoteOverride = controller.isRemoteEnabled() !== controller.isRemoteEnabledDefault() ? `\uFF08\u8FD0\u884C\u65F6\u8986\u76D6\uFF1B\u914D\u7F6E\u9ED8\u8BA4\uFF1A${controller.isRemoteEnabledDefault() ? "\u5DF2\u542F\u7528" : "\u5DF2\u7981\u7528"}\uFF09` : "";
  return [
    `\u56DE\u9000\u94FE\uFF1A${mode} \u2014 ${MODE_DESCRIPTIONS[mode]}${modeOverride}`,
    `\u8FDC\u7AEF Responses \u538B\u7F29\uFF1A${remote}${remoteOverride}\uFF08${controller.describeEndpoints()}\uFF09`,
    `\u5207\u6362\u5BF9\u672C DSH \u4E3B\u76EE\u5F55\u6301\u4E45\u751F\u6548\uFF1B/blackhole-mode reset \u6062\u590D\u914D\u7F6E\u9ED8\u8BA4\u3002${USAGE}`
  ].join("\n");
}
function createModeCommand(controller) {
  return {
    name: MODE_COMMAND_NAME,
    description: "\u67E5\u770B\u6216\u5207\u6362 dsh-blackhole \u7684\u538B\u7F29\u7BA1\u7EBF\uFF08\u8FD0\u884C\u65F6\u751F\u6548\uFF09\u3002",
    input: { hint: "[instant | instant-then-llm | llm | remote [on | off] | reset]" },
    handler: (invocation) => {
      const parsed = parseModeCommandInput(invocation.rawInput);
      switch (parsed.action) {
        case "status":
          return { kind: "success", text: statusText(controller) };
        case "mode": {
          controller.setFallbackMode(parsed.mode);
          return {
            kind: "success",
            text: `\u56DE\u9000\u94FE\u5DF2\u5207\u6362\u4E3A ${parsed.mode} \u2014 ${MODE_DESCRIPTIONS[parsed.mode]}\uFF1B\u8986\u76D6\u8DE8 DSH \u91CD\u542F\u4FDD\u7559\uFF08/blackhole-mode reset \u6E05\u9664\uFF09\u3002`
          };
        }
        case "remote": {
          if (parsed.enabled === void 0) {
            return {
              kind: "success",
              text: `\u8FDC\u7AEF Responses \u538B\u7F29\u5F53\u524D${controller.isRemoteEnabled() ? "\u5DF2\u542F\u7528" : "\u5DF2\u7981\u7528"}\uFF08${controller.describeEndpoints()}\uFF09\u3002`
            };
          }
          controller.setRemoteEnabled(parsed.enabled);
          return {
            kind: "success",
            text: parsed.enabled ? `\u8FDC\u7AEF Responses \u538B\u7F29\u5DF2\u91CD\u65B0\u542F\u7528\uFF08${controller.describeEndpoints()}\uFF09\uFF1B\u5339\u914D\u7684\u76EE\u6807\u5148\u8D70\u8FDC\u7AEF\uFF0C\u5931\u8D25\u540E\u843D\u5230${controller.getFallbackMode()}\u56DE\u9000\u3002` : `\u8FDC\u7AEF Responses \u538B\u7F29\u5DF2\u7981\u7528\uFF1B\u6240\u6709\u76EE\u6807\u6539\u7528${controller.getFallbackMode()}\u56DE\u9000\uFF0C\u76F4\u5230\u91CD\u65B0\u542F\u7528\u3002\u5207\u6362\u8DE8 DSH \u91CD\u542F\u4FDD\u7559\uFF1B\u672C\u5730\u68C0\u67E5\u70B9\u843D\u76D8\u65F6\u4F1A\u6E05\u9664\u5DF2\u6301\u4E45\u5316\u7684\u8FDC\u7AEF\u66FF\u6362\u5386\u53F2\u3002`
          };
        }
        case "reset": {
          controller.resetRuntimeMode();
          return {
            kind: "success",
            text: `\u8FD0\u884C\u65F6\u8986\u76D6\u5DF2\u6E05\u9664\uFF1B\u56DE\u5230\u914D\u7F6E\u9ED8\u8BA4\uFF08\u56DE\u9000\u94FE\uFF1A${controller.getFallbackMode()}\uFF0C\u8FDC\u7AEF Responses \u538B\u7F29${controller.isRemoteEnabled() ? "\u5DF2\u542F\u7528" : "\u5DF2\u7981\u7528"}\uFF09\u3002`
          };
        }
        default:
          return { kind: "error", text: parsed.message };
      }
    }
  };
}
function registerModeCommand(registry, controller) {
  return registry.register(createModeCommand(controller));
}

// src/hybrid.ts
var FALLBACK_MODES2 = /* @__PURE__ */ new Set(["instant", "instant-then-llm", "llm"]);
function resolveRegionSeqs(session, messages) {
  const idToSeq = /* @__PURE__ */ new Map();
  for (const event of readSessionEvents(session)) {
    if (typeof event.seq !== "number") continue;
    const message = deriveSessionMessage(session, event);
    if (message !== null && message !== void 0 && typeof message.id === "string") {
      idToSeq.set(message.id, event.seq);
    }
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
  /** Effective fallback chain: config default with any persisted runtime override applied. */
  fallbackMode;
  /** Config-resolved fallback chain (what `/blackhole-mode reset` restores). */
  configFallbackMode;
  /** Remote Responses gate; `/blackhole-mode remote off` closes it, persistently. */
  remoteEnabled = true;
  /** Directory the sticky `/blackhole-mode` override file lives in, if resolvable. */
  modeStateDir;
  /** Public controller seam the `blackhole-commands` plugin reads via `ctx.compaction`. */
  modeController;
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
    this.modeStateDir = stateDir?.trim() || defaultStateDir();
    if (this.state !== void 0) {
      ctx.provide("responsesCompactionReplay", this.state);
    }
    this.installationId = config.installationId !== void 0 ? config.installationId.trim() || void 0 : resolvedStateDir !== void 0 ? resolveInstallationId(resolvedStateDir) : void 0;
    const explicit = fallbackMode?.trim();
    if (explicit !== void 0 && explicit.length > 0 && !FALLBACK_MODES2.has(explicit)) {
      throw new Error(
        `fallbackMode must be one of "instant", "instant-then-llm", "llm"; got ${JSON.stringify(explicit)}`
      );
    }
    this.fallbackMode = explicit !== void 0 && explicit.length > 0 ? explicit : fallbackToLlm === false ? "instant" : "instant";
    this.configFallbackMode = this.fallbackMode;
    const modeOverride = loadRuntimeModeOverride(this.modeStateDir);
    if (modeOverride?.fallbackMode !== void 0) this.fallbackMode = modeOverride.fallbackMode;
    if (modeOverride?.remoteEnabled !== void 0) this.remoteEnabled = modeOverride.remoteEnabled;
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
    const releaseRecallRegistration = (surface, disposer) => {
      if (disposer === void 0) return;
      try {
        disposer();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.logger.warn(`dsh-blackhole: failed to release ${surface} recall registration (${message})`);
      }
    };
    let recallToolRegistry;
    let recallToolDisposer;
    const attachRecallTool = (candidate) => {
      if (candidate === recallToolRegistry) return;
      releaseRecallRegistration("tool", recallToolDisposer);
      recallToolDisposer = void 0;
      recallToolRegistry = void 0;
      if (typeof candidate?.register !== "function") return;
      const tools = candidate;
      try {
        const disposer = registerRecallTool(tools, (exec) => {
          const candidate2 = exec;
          return adaptRecallSession(candidate2?.agent?.session);
        });
        recallToolRegistry = tools;
        recallToolDisposer = typeof disposer === "function" ? disposer : void 0;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.logger.warn(`dsh-blackhole: optional recall tool registration failed (${message})`);
      }
    };
    this.modeController = {
      getFallbackMode: () => this.fallbackMode,
      getFallbackModeDefault: () => this.configFallbackMode,
      setFallbackMode: (mode) => {
        if (!FALLBACK_MODES2.has(mode)) throw new Error(`invalid fallback mode: ${mode}`);
        this.fallbackMode = mode;
        this.persistModeOverride();
      },
      isRemoteEnabled: () => this.remoteEnabled,
      isRemoteEnabledDefault: () => true,
      setRemoteEnabled: (enabled) => {
        this.remoteEnabled = enabled;
        this.persistModeOverride();
      },
      resetRuntimeMode: () => {
        clearRuntimeModeOverride(this.modeStateDir);
        this.fallbackMode = this.configFallbackMode;
        this.remoteEnabled = true;
      },
      describeEndpoints: () => this.describeEndpoints()
    };
    const safeContext = ctx;
    attachRecallTool(safeContext.get?.("tools"));
    safeContext.on?.("internal/service", (name, value) => {
      if (name === "tools") attachRecallTool(value);
    });
    ctx.effect(() => () => {
      releaseRecallRegistration("tool", recallToolDisposer);
      recallToolDisposer = void 0;
      recallToolRegistry = void 0;
    }, "dsh-blackhole recall tool");
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
  /** One-line description of the configured remote endpoints (for /blackhole-mode). */
  describeEndpoints() {
    if (this.endpoints.length === 0) return "no endpoints configured";
    return this.endpoints.map((endpoint) => `${endpoint.provider}/${endpoint.model} \u2192 ${endpoint.label}`).join(", ");
  }
  /** Best-effort persist of the sticky /blackhole-mode override. */
  persistModeOverride() {
    const saved = saveRuntimeModeOverride(this.modeStateDir, {
      fallbackMode: this.fallbackMode,
      remoteEnabled: this.remoteEnabled
    });
    if (!saved) {
      this.ctx.logger.warn(
        "dsh-blackhole: runtime mode override could not be persisted; it resets on the next DSH start"
      );
    }
  }
  async summarize(input, agent, signal) {
    const target = conversationTarget(agent);
    if (target === void 0) {
      await this.state?.remove(agent.id);
      return this.instantSummarize(input, agent);
    }
    const endpoint = this.remoteEnabled ? this.matchEndpoint(target) : void 0;
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

// src/recall-command.ts
var COMMAND_FLAGS = /(?:^|\s)(page:\d+|scope:(?:all|lineage)|mode:(?:hybrid|file|touched)|offset:\d+|limit:\d+)(?=\s|$)/giu;
function parseRecallCommandInput(rawInput) {
  const raw = rawInput.trim();
  const flags = [...raw.matchAll(COMMAND_FLAGS)].map((match) => match[1].toLocaleLowerCase());
  const query = raw.replace(COMMAND_FLAGS, " ").replace(/\s{2,}/gu, " ").trim();
  const find = (prefix) => flags.find((flag) => flag.startsWith(`${prefix}:`))?.slice(prefix.length + 1);
  const pageRaw = find("page");
  const offsetRaw = find("offset");
  const limitRaw = find("limit");
  const positiveInteger = (value) => {
    if (value === void 0) return void 0;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : void 0;
  };
  const nonNegativeInteger = (value) => {
    if (value === void 0) return void 0;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : void 0;
  };
  const page = positiveInteger(pageRaw);
  const offset = nonNegativeInteger(offsetRaw);
  const limit = positiveInteger(limitRaw);
  const scopeRaw = find("scope");
  const modeRaw = find("mode");
  return {
    ...query.length > 0 ? { query } : {},
    ...page === void 0 ? {} : { page },
    ...offset === void 0 ? {} : { offset },
    ...limit === void 0 ? {} : { limit },
    ...scopeRaw === "all" || scopeRaw === "lineage" ? { scope: scopeRaw } : {},
    ...modeRaw === "hybrid" || modeRaw === "file" || modeRaw === "touched" ? { mode: modeRaw } : {}
  };
}
var hasRecallSession = (value) => {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value;
  return Array.isArray(candidate.events) && typeof candidate.deriveEventMessage === "function";
};
var RECALL_COMMAND_NAME = "blackhole-recall";
function createRecallCommand() {
  return {
    name: RECALL_COMMAND_NAME,
    description: "\u68C0\u7D22\u4F1A\u8BDD\u5386\u53F2\uFF0C\u56DE\u8BFB\u88AB\u538B\u7F29\u7684\u4E0A\u4E0B\u6587\u4E0E\u66F4\u65E9\u7684\u6587\u4EF6\u64CD\u4F5C\u3002",
    input: { hint: "<query> [page:N] [offset:N] [limit:N] [scope:all] [mode:file|touched]" },
    handler: async (invocation) => {
      const session = invocation.agent?.session;
      if (!hasRecallSession(session)) {
        return { kind: "error", text: "\u5F53\u524D\u6CA1\u6709\u53EF\u7528\u4E8E\u56DE\u8BFB\u7684\u4F1A\u8BDD\u3002" };
      }
      const params = parseRecallCommandInput(invocation.rawInput);
      if (isOmMemoryId(params.query)) return { kind: "success", text: OM_RECALL_TODO };
      return { kind: "success", text: recallSession(session, params).text };
    }
  };
}
function registerRecallCommand(registry) {
  return registry.register(createRecallCommand());
}
export {
  BLACKHOLE_RECALL_NOTE,
  CompactionResponsesConfigSchema,
  DEFAULT_ARG_TOOLS,
  DEFAULT_INSTANT_OPTIONS,
  DEFAULT_NOISE_PATTERNS,
  DEFAULT_TOOL_KEY_FIELDS,
  HybridCompactionConfigSchema,
  MODE_COMMAND_NAME,
  OM_RECALL_TODO,
  PATH_KEYS,
  RECALL_COMMAND_NAME,
  RUNTIME_MODE_FILE,
  RemoteCompactionStateStore,
  ResponsesCompactionEngine,
  RoutingCompactionEngine,
  adaptRecallSession,
  buildCompactionRequestBody,
  buildRemoteCompactionDetails,
  buildReplacementHistory,
  callResponsesCompactionV2,
  clearRuntimeModeOverride,
  collapseSkillText,
  compileBlackholeSummary,
  compileInstantRegion,
  compileNoisePatterns,
  compressBash,
  countTokens,
  createModeCommand,
  createRecallCommand,
  createRecallTool,
  RoutingCompactionEngine as default,
  deriveSessionMessage,
  dshMessageToResponseItems,
  dshMessagesToResponseItems,
  estimateEntryTokens,
  estimateMessagesTokens,
  extractRecallFileOperations,
  filterBlackholeNoise,
  findRecallFileMatches,
  firstLineOf,
  indexRecallSession,
  isOmMemoryId,
  joinInstantEntries,
  loadRuntimeModeOverride,
  mapCompactionUsage,
  normalizeBlackholeMessages,
  parseCompactionV2Events,
  parseModeCommandInput,
  parseRecallCommandInput,
  parseRecallDrillDown,
  parseRemoteCompactionDetails,
  parseSseData,
  parseToolArguments,
  pickToolKeyArg,
  previousCheckpointSummary,
  projectToolResultText,
  rankRecallEntries,
  readSessionEvents,
  recallFileSearchText,
  recallSession,
  reconstructRemoteCompactionHistory,
  registerModeCommand,
  registerRecallCommand,
  registerRecallTool,
  remoteCompactionModelKey,
  renderRecallFileDrillDown,
  resolveEndpoints,
  resolveRegionSeqs,
  responsesEndpointUrl,
  runtimeModeFilePath,
  sanitize,
  saveRuntimeModeOverride,
  stripNoiseXml,
  stripSelfTalkPrefix,
  tokenize,
  toolSchemasToResponseTools,
  truncateTextTokens,
  truncateTokens
};
//# sourceMappingURL=index.js.map
