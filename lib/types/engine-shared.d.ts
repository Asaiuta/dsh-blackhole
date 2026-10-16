/**
 * Shared plumbing between the two engines of this package: the legacy
 * Responses-only engine and the hybrid routing engine. Extracted so both
 * subclass `BasicCompactionEngine` with identical target resolution,
 * endpoint matching, state handling, and the native LLM fallback.
 *
 * @module dsh-blackhole/engine-shared
 */
import { Context } from '@deepseek-ai/cordis';
import type { ContentBlock, LlmCallConfig, Message, TokenUsage, ToolSchema } from '@deepseek-ai/dsh-llm';
import type { Agent } from '@deepseek-ai/dsh-agent';
/**
 * Structural mirror of the summarizer hook's contracts. The official package
 * does not deep-export them; the shapes are stable within the seam.
 */
export interface SummarizationInput {
    /** The conversation's own system prompt; absent for a system-less request. */
    readonly system?: string;
    /** The conversation's tool schemas; absent when the request carried none. */
    readonly tools?: readonly ToolSchema[];
    /** The shadowed region, in surface order, that precedes the compaction instruction. */
    readonly messages: readonly Message[];
}
/** Safe summary content plus the exact auxiliary call envelope recorded with it. */
export type SummaryResult = {
    summary: ContentBlock[];
    provider: string;
    model: string;
    maxTokens?: number;
    usage?: TokenUsage;
} & ({
    /** Complete provider output before the backend's safe summary projection. */
    rawOutput: ContentBlock[];
    /** Identifies exactly one call through this context's `ctx.llm.stream()`. */
    llmStreamCall: true;
} | {
    /** Optional complete output from an unmarked template, remote, or other summarizer. */
    rawOutput?: ContentBlock[];
    /** An unmarked summary does not identify a call through this context's LLM seam. */
    llmStreamCall?: never;
});
/** Resolve the exact provider/model durably routed for the latest request. */
export declare function conversationTarget(agent: Agent): Pick<LlmCallConfig, 'provider' | 'model'> | undefined;
/** Minimal glob matcher supporting `*` and `?` (and plain equality). */
export declare function globMatch(pattern: string, value: string): boolean;
export declare function defaultStateDir(): string;
/**
 * The persisted random installation id sent as `x-codex-installation-id`,
 * mirroring the upstream port's identity behavior without ever touching the
 * real Codex home (~/.codex). Resolved lazily, so a read-only stateDir just
 * omits the header.
 */
export declare function resolveInstallationId(stateDir: string): string | undefined;
/**
 * The compaction instruction appended to the LLM fallback call. A short,
 * self-authored prompt (the official backend replays its own instruction
 * array; this package keeps one compact version for the fallback branch).
 */
export declare const COMPACTION_INSTRUCTION: string;
/** Native one-shot LLM summarization, mirroring basic's summarizeWithLlm. */
export declare function summarizeWithLlm(ctx: Context, config: {
    summarizationProvider?: string;
    summarizationModel?: string;
    maxTokens?: number;
}, input: SummarizationInput, agent: Agent, signal?: AbortSignal): Promise<SummaryResult>;
