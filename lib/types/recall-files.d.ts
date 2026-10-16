/**
 * File-content extraction used by the DSH recall surface.
 *
 * The Pi implementation reads the raw JSONL session file for this operation.
 * DSH already keeps the lossless event log in memory, so the equivalent seam
 * is a projection over the original tool-call arguments.  This module stays
 * independent from the optional dsh-tools package and deliberately does not
 * implement observational-memory (OM) IDs; that is a separate TODO.
 */
import type { BlackholeMessage } from './blackhole-summary.ts';
export interface RecallFileOperation {
    readonly path: string;
    readonly tool: string;
    readonly content: string;
}
export interface RecallFileMatch {
    readonly path: string;
    readonly tool: string;
    readonly lineCount: number;
    readonly snippet?: string;
}
export interface RecallDrillDown {
    readonly seq: number;
    readonly pathPattern: string;
    readonly full: boolean;
    readonly offset?: number;
    readonly limit?: number;
}
export declare const isRecallFileMutationTool: (name: unknown) => boolean;
/** Extract Write/Edit-style content from one DSH message. */
export declare function extractRecallFileOperations(message: BlackholeMessage): RecallFileOperation[];
export declare function recallFileSearchText(operations: readonly RecallFileOperation[]): string;
/** Return file-level match indicators for a query. */
export declare function findRecallFileMatches(operations: readonly RecallFileOperation[], query: string): RecallFileMatch[];
/** Parse #N:path, #N:path:full, #N:path:offset, or #N:path:offset:limit. */
export declare function parseRecallDrillDown(query: string): RecallDrillDown | undefined;
/** Render a file drill-down in the same progressive style as pi-blackhole. */
export declare function renderRecallFileDrillDown(seq: number, operations: readonly RecallFileOperation[], drillDown: RecallDrillDown): string;
