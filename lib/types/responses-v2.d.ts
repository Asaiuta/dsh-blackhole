/**
 * Codex-style remote compaction through the OpenAI Responses API.
 *
 * Puts the DSH summarization hook on the server side: the replayed
 * conversation is converted into Responses input items, a `compaction_trigger`
 * is appended, and the compaction response streams back from the normal
 * `{base}/responses` endpoint. The assistant-authored summary text from that
 * response becomes the readable checkpoint DSH lands in the session, and the
 * opaque replacement history is returned for durable persistence (the bridge
 * to provider-native replay).
 *
 * Protocol and retention logic derived from algal/pi-openai-server-compaction
 * (MIT) — see LICENSE.
 *
 * @module dsh-blackhole/responses-v2
 */
import type { Message, TokenUsage, ToolSchema } from '@deepseek-ai/dsh-llm';
import type { ResolvedResponsesEndpoint } from './config.ts';
/** Content items inside Responses message items. */
export type ResponseContentItem = {
    type: 'input_text';
    text: string;
} | {
    type: 'input_image';
    image_url: string;
} | {
    type: 'output_text';
    text: string;
};
/** One Responses input/output item (the subset compaction needs). */
export type ResponseItem = {
    type: 'message';
    role: string;
    content: ResponseContentItem[];
    end_turn?: boolean;
    phase?: string;
} | {
    type: 'reasoning';
    summary: Array<{
        type: 'summary_text';
        text: string;
    }>;
    encrypted_content: string | null;
} | {
    type: 'function_call';
    name: string;
    arguments: string;
    call_id: string;
} | {
    type: 'function_call_output';
    call_id: string;
    output: string | unknown[];
} | {
    type: 'compaction';
    encrypted_content: string;
} | {
    type: 'compaction_trigger';
} | {
    type: string;
    [key: string]: unknown;
};
/** The portion of the compaction response that matters to DSH. */
export interface RemoteCompactionV2Result {
    /** Readable summary text written by the model during compaction. */
    summaryText: string;
    /** The opaque replacement history: retained tail user messages + compaction item. */
    replacementHistory: ResponseItem[];
    /** Provider-reported usage, mapped onto DSH's TokenUsage shape. */
    usage?: TokenUsage;
    /** Versioned provider-private details for the next same-model request. */
    details: RemoteCompactionDetails;
}
/** Portable checkpoint text for the official compaction-only response shape. */
export declare function buildRemoteCompactionSummaryText(params: {
    provider: string;
    model: string;
    endpoint: string;
}): string;
/**
 * Durable, adapter-owned replay facts.  The readable summary remains in the
 * DSH checkpoint; this record is only for a compatible Responses adapter.
 */
export interface RemoteCompactionDetails {
    readonly version: 2;
    readonly provider: 'openai-responses-compaction';
    readonly implementation: 'responses_compaction_v2';
    readonly modelKey: string;
    readonly replacementHistory: ResponseItem[];
    readonly usage?: TokenUsage;
}
export declare function remoteCompactionModelKey(provider: string, model: string): string;
/** Build a detached, versioned detail record after protocol validation. */
export declare function buildRemoteCompactionDetails(params: {
    provider: string;
    model: string;
    replacementHistory: ResponseItem[];
    usage?: TokenUsage;
}): RemoteCompactionDetails;
/** Fail-closed runtime validation for details loaded from durable storage. */
export declare function parseRemoteCompactionDetails(value: unknown): RemoteCompactionDetails | undefined;
/**
 * Keep the newest realization of the conversation verbatim up to a token
 * budget and append the opaque compaction item — the Codex-style replacement
 * history used for later provider-native replay.
 */
export declare function buildReplacementHistory(input: ResponseItem[], compactionItem: ResponseItem, retainedMessageTokenBudget: number): ResponseItem[];
/** Convert one DSH message into Responses input items. */
export declare function dshMessageToResponseItems(message: Message): ResponseItem[];
export declare function dshMessagesToResponseItems(messages: readonly Message[]): ResponseItem[];
/**
 * Rebuild the explicit Responses history for one compatible target.  The
 * trailing surface is grouped by completed assistant turns exactly like the
 * upstream port: pending user/tool items are retained only when the matching
 * assistant response is present, and foreign-model assistant turns are
 * discarded so provider-private signatures cannot cross model ownership.
 */
export declare function reconstructRemoteCompactionHistory(params: {
    details: RemoteCompactionDetails;
    provider: string;
    model: string;
    trailingMessages: readonly Message[];
    /** Include a final incomplete user/tool turn for an ordinary request. */
    includePending?: boolean;
}): ResponseItem[] | undefined;
/** Port DSH tool schemas into Responses function tools. */
export declare function toolSchemasToResponseTools(tools: readonly ToolSchema[]): Record<string, unknown>[];
/** The compaction v2 request body: input + `compaction_trigger`, streaming. */
export declare function buildCompactionRequestBody(params: {
    model: string;
    input: ResponseItem[];
    instructions?: string;
    tools: Record<string, unknown>[];
    sessionId?: string;
}): Record<string, unknown>;
export declare function parseSseData(text: string): unknown[];
interface ParsedCompactionStream {
    compactionItem?: ResponseItem;
    /** Assistant output text accumulated across the whole compaction response. */
    summaryText: string;
    usage?: unknown;
}
/** Parse the SSE stream; extract the compaction item, usage, and summary text. */
export declare function parseCompactionV2Events(events: unknown[]): ParsedCompactionStream;
/** Map an OpenAI usage snapshot onto DSH's TokenUsage. */
export declare function mapCompactionUsage(value: unknown): TokenUsage | undefined;
/**
 * Run Responses compaction v2 against one endpoint.
 *
 * @throws on transport or protocol failure — callers fall back to the native
 * summarizer.
 */
export declare function callResponsesCompactionV2(params: {
    endpoint: ResolvedResponsesEndpoint;
    apiKey: string;
    /** DSH provider route that owns the target model. */
    provider?: string;
    model: string;
    input: ResponseItem[];
    instructions?: string;
    tools: Record<string, unknown>[];
    sessionId?: string;
    signal?: AbortSignal;
    timeoutMs: number;
    retainedMessageTokenBudget: number;
    /** Codex installation id; sent as `x-codex-installation-id` (+ window/session headers) when provided. */
    installationId?: string;
}): Promise<RemoteCompactionV2Result>;
export {};
