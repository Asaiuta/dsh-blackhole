/**
 * Structured, deterministic summary compiler adapted from pi-blackhole's
 * pi-vcc layer.  The compiler deliberately works on a small structural view
 * of DSH messages so it remains independent from the optional dsh-tools
 * package and can be used by both compaction and recall tests.
 */
export interface BlackholeBlock {
    readonly type?: string;
    readonly text?: string;
    readonly id?: string;
    readonly name?: string;
    readonly arguments?: string | Record<string, unknown>;
    readonly toolCallId?: string;
    readonly content?: readonly BlackholeBlock[];
    readonly isError?: boolean;
    readonly [key: string]: unknown;
}
export interface BlackholeMessage {
    readonly id?: string;
    readonly role?: string;
    readonly content?: readonly BlackholeBlock[];
    readonly source?: {
        readonly kind?: string;
        readonly plugin?: string;
        readonly [key: string]: unknown;
    };
}
export type BlackholeBlockKind = 'user' | 'assistant' | 'thinking' | 'tool-call' | 'tool-result';
export interface NormalizedBlackholeBlock {
    readonly kind: BlackholeBlockKind;
    readonly text: string;
    readonly seq: number;
    readonly messageIndex: number;
    readonly name?: string;
    readonly args?: string | Record<string, unknown>;
    readonly callId?: string;
    readonly toolCallId?: string;
    readonly isError?: boolean;
}
export interface BlackholeSummaryInput {
    readonly messages: readonly BlackholeMessage[];
    readonly seqs?: readonly number[];
    readonly previousSummary?: string;
    readonly briefTranscript?: string;
    readonly maxTokens?: number;
    readonly noisePatterns?: readonly RegExp[];
}
export declare const BLACKHOLE_RECALL_NOTE: string;
/** Convert DSH messages into the normalized block vocabulary used by VCC. */
export declare function normalizeBlackholeMessages(messages: readonly BlackholeMessage[], seqs?: readonly number[]): NormalizedBlackholeBlock[];
/** Apply pi-blackhole's noise suppression rules to normalized DSH blocks. */
export declare function filterBlackholeNoise(blocks: readonly NormalizedBlackholeBlock[], noisePatterns?: readonly RegExp[]): NormalizedBlackholeBlock[];
/** Compile a blackhole-style structured summary with a durable recall footer. */
export declare function compileBlackholeSummary(input: BlackholeSummaryInput): string;
/** Pull the latest previous compact checkpoint text from a DSH message list. */
export declare function previousCheckpointSummary(messages: readonly BlackholeMessage[]): string | undefined;
