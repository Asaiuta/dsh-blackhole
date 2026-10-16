/**
 * DSH recall/search seam adapted from pi-blackhole's unified recall tool.
 *
 * The core is runtime-independent: it indexes the durable DSH session event
 * log through `deriveEventMessage()`.  `registerRecallTool()` deliberately
 * accepts a structural registry instead of importing dsh-tools, allowing the
 * same package to run against DSH profiles where that optional package is
 * supplied by the host.
 */
import type { BlackholeMessage } from './blackhole-summary.ts';
import type { RecallFileMatch, RecallFileOperation } from './recall-files.ts';
export type { RecallDrillDown, RecallFileMatch, RecallFileOperation } from './recall-files.ts';
export type RecallScope = 'lineage' | 'all';
export type RecallMode = 'hybrid' | 'file' | 'touched';
export interface RecallEvent {
    readonly seq: number;
    readonly type?: string;
    readonly data?: unknown;
}
export interface RecallSession {
    readonly events: readonly RecallEvent[];
    readonly deriveEventMessage: (event: unknown) => BlackholeMessage | null;
    /** Optional host-provided active-lineage projection. */
    readonly lineageSeqs?: readonly number[];
}
export interface RecallQuery {
    readonly query?: string;
    readonly expand?: readonly number[];
    readonly page?: number;
    /** Zero-based result offset, useful when a host wants cursor paging. */
    readonly offset?: number;
    /** Maximum result count after `offset`; defaults to the standard page size. */
    readonly limit?: number;
    readonly scope?: RecallScope;
    readonly mode?: RecallMode;
}
export interface RecallEntry {
    readonly seq: number;
    readonly id: string;
    readonly message: BlackholeMessage;
    /** Compact transcript rendering used in ordinary ranked result pages. */
    readonly text: string;
    /** Explicit #N rendering: full prose/results, with file bodies still redacted. */
    readonly expandedText: string;
    readonly files: readonly string[];
    /** Original content-bearing Write/Edit arguments for file search/drill-down. */
    readonly fileOperations: readonly RecallFileOperation[];
    /** Search corpus: rendered transcript plus bounded file-operation content. */
    readonly searchText: string;
    readonly toolCallIds: readonly string[];
    readonly fileMatches?: readonly RecallFileMatch[];
}
export interface RecallResult {
    readonly text: string;
    readonly entries: readonly RecallEntry[];
    readonly total: number;
    readonly page: number;
    readonly totalPages: number;
}
/**
 * OM memory ids are intentionally reserved for a future ledger integration.
 * Keeping the predicate here lets the tool/command fail clearly instead of
 * silently treating an OM id as an ordinary transcript search.
 */
export declare const isOmMemoryId: (query: string | undefined) => boolean;
export declare const OM_RECALL_TODO: string;
export interface RecallToolDefinition {
    readonly name: 'recall';
    readonly description: string;
    /** dsh-tools author-DSL property map (inline `required` flags, whitelisted keys only). */
    readonly parameters: Record<string, unknown>;
    readonly output: {
        /** dsh-tools author-DSL value schema. */
        readonly schema: Record<string, unknown>;
        readonly render: (args: unknown, value: unknown) => readonly {
            type: 'text';
            text: string;
        }[];
    };
    readonly execute: (args: unknown, exec: unknown) => Promise<{
        text: string;
    }>;
}
export interface RecallToolRegistry {
    register: (definition: RecallToolDefinition) => (() => void) | void;
}
export interface RecallToolContext {
    readonly session?: RecallSession;
}
/** Build the durable searchable index from a DSH session. */
export declare function indexRecallSession(session: RecallSession): RecallEntry[];
/** Small BM25-like ranker with deterministic tie-breaking by durable seq. */
export declare function rankRecallEntries(entries: readonly RecallEntry[], query: string, mode?: RecallMode): RecallEntry[];
/** Execute one recall query against a DSH session. */
export declare function recallSession(session: RecallSession, params?: RecallQuery): RecallResult;
/** Build a dsh-tools-compatible definition without hard-coding its package. */
export declare function createRecallTool(getSession: (exec: unknown) => RecallSession | undefined): RecallToolDefinition;
/**
 * Adapt a runtime Session (or a test fake) onto the recall tool's structural
 * `RecallSession` seam. The runtime exposes `snapshotEvents()` plus the
 * module-level projection; fakes answer with an `events` array and an
 * instance method — the adapter normalizes both behind one guard.
 */
export declare function adaptRecallSession(session: unknown): RecallSession | undefined;
/** Register recall into a host dsh-tools registry. */
export declare function registerRecallTool(registry: RecallToolRegistry, getSession: (exec: unknown) => RecallSession | undefined): (() => void) | void;
