// src/index.ts
import { homedir } from "node:os";
import { join as join2 } from "node:path";
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
  retainedMessageTokenBudget: z.number().step(1).min(0).default(2e4)
});
function responsesEndpointUrl(baseUrl) {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (trimmed.endsWith("/responses")) return trimmed;
  if (trimmed.endsWith("/v1")) return `${trimmed}/responses`;
  if (trimmed.endsWith("/codex")) return `${trimmed}/responses`;
  return `${trimmed}/v1/responses`;
}
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
      headers: endpoint.headers ?? {}
    };
  });
}

// src/remote-state.ts
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
var RemoteCompactionStateStore = class {
  constructor(dir) {
    this.dir = dir;
  }
  pathFor(sessionId) {
    return join(this.dir, `${sessionId}.json`);
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
      if (typeof parsed.sessionId !== "string" || !Array.isArray(parsed.replacementHistory)) {
        return void 0;
      }
      return parsed;
    } catch {
      return void 0;
    }
  }
  async remove(sessionId) {
    try {
      const file = this.pathFor(sessionId);
      const parent = dirname(file);
      await rename(file, join(parent, `${sessionId}.json.removed`));
    } catch {
    }
  }
};

// src/responses-v2.ts
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
    (item) => item.type === "message" && item.role === "user"
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
    const textParts = [];
    const toolOutputs = [];
    for (const block of message.content) {
      switch (block.type) {
        case "text":
          textParts.push(block.text);
          break;
        case "image":
          textParts.push(IMAGE_CONTENT_OMITTED_PLACEHOLDER);
          break;
        case "tool-result":
          toolOutputs.push({
            type: "function_call_output",
            call_id: block.toolCallId,
            output: toolResultBlockToOutput(block.content)
          });
          break;
        default:
          break;
      }
    }
    const text = textParts.join("").trim();
    if (text.length > 0) {
      items.push({ type: "message", role: "user", content: [{ type: "input_text", text }] });
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
            call_id: block.id,
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
  return content.map((block) => block.type === "text" ? block.text : "").join("\n").trim();
}
function dshMessagesToResponseItems(messages) {
  return messages.flatMap((message) => dshMessageToResponseItems(message));
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
function parseCompactionV2Events(events) {
  let completed = false;
  let usage;
  let compactionItem;
  const summaryChunks = [];
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
        compactionItem = event.item;
        continue;
      }
      if (event.item.type === "message" && event.item.role === "assistant" && Array.isArray(event.item.content)) {
        for (const content of event.item.content) {
          if (content.type === "output_text") summaryChunks.push(content.text);
        }
      }
      continue;
    }
    if (event.type === "response.output_text.done" && typeof event.text === "string") {
      summaryChunks.push(event.text);
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
  return {
    compactionItem,
    summaryText: summaryChunks.join("").trim(),
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
  return {
    inputTokens: Math.max(0, inputTokens - cachedTokens),
    outputTokens,
    ...cachedTokens > 0 ? { cacheReadTokens: cachedTokens } : {}
  };
}
async function callResponsesCompactionV2(params) {
  const { endpoint, apiKey, model, input, instructions, tools, sessionId, signal, timeoutMs, retainedMessageTokenBudget } = params;
  const url = `${endpoint.baseUrl.replace(/\/+$/, "")}/responses`;
  const timeoutSignal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : void 0;
  const requestSignal = signal !== void 0 && timeoutSignal !== void 0 ? AbortSignal.any([signal, timeoutSignal]) : signal ?? timeoutSignal;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      accept: "text/event-stream",
      ...endpoint.headers
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
  return {
    summaryText: parsed.summaryText,
    replacementHistory: buildReplacementHistory(input, parsed.compactionItem, retainedMessageTokenBudget),
    usage: mapCompactionUsage(parsed.usage)
  };
}

// src/index.ts
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
  return join2(home, "plugins", "dsh-compaction-responses", "state");
}
var ResponsesCompactionEngine = class extends BasicCompactionEngine {
  static inject = ["llm", "tokenMeter", "sessions"];
  static Config = CompactionResponsesConfigSchema;
  /** Validated endpoint registry. */
  endpoints;
  /** Optional per-session artifact store. */
  state;
  /** The plugin's own validated config (base fields live in `this.config`). */
  options;
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
    this.state = persistRemoteHistory !== false ? new RemoteCompactionStateStore(stateDir?.trim() || defaultStateDir()) : void 0;
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
      return super.summarize(input, agent, signal);
    }
    const endpoint = this.matchEndpoint(target);
    if (endpoint === void 0) {
      return super.summarize(input, agent, signal);
    }
    const apiKey = endpoint.apiKey ?? (process.env[endpoint.apiKeyEnv] ?? "");
    if (apiKey.length === 0) {
      this.ctx.logger.warn(
        `responses compaction: endpoint ${endpoint.label} matched provider ${target.provider}/${target.model} but no API key found (${endpoint.apiKeyEnv}); falling back to the native summarizer`
      );
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
      const items = dshMessagesToResponseItems(input.messages);
      const result = await callResponsesCompactionV2({
        endpoint,
        apiKey,
        model: target.model,
        input: items,
        instructions: input.system,
        tools: toolSchemasToResponseTools(input.tools ?? []),
        sessionId: agent.id,
        signal,
        timeoutMs: this.options.timeoutMs ?? 12e4,
        retainedMessageTokenBudget: this.options.retainedMessageTokenBudget ?? 2e4
      });
      if (result.summaryText.length === 0) {
        throw new Error("Responses compaction v2 returned no readable summary text");
      }
      await this.state?.save({
        sessionId: agent.id,
        replacedAt: (/* @__PURE__ */ new Date()).toISOString(),
        provider: target.provider,
        model: target.model,
        endpoint: responsesEndpointUrl(endpoint.baseUrl),
        summaryText: result.summaryText,
        replacementHistory: result.replacementHistory
      });
      this.ctx.logger.info(
        `responses compaction: remote summary for ${target.provider}/${target.model} via ${endpoint.label} (${result.summaryText.length} chars, ${result.replacementHistory.length} replacement items)`
      );
      return {
        summary: [{ type: "text", text: result.summaryText }],
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
var index_default = ResponsesCompactionEngine;
export {
  CompactionResponsesConfigSchema,
  RemoteCompactionStateStore,
  ResponsesCompactionEngine,
  buildCompactionRequestBody,
  buildReplacementHistory,
  callResponsesCompactionV2,
  index_default as default,
  dshMessageToResponseItems,
  dshMessagesToResponseItems,
  mapCompactionUsage,
  parseCompactionV2Events,
  parseSseData,
  responsesEndpointUrl,
  toolSchemasToResponseTools
};
//# sourceMappingURL=index.js.map
