/**
 * Durable per-session state for remote compaction: the opaque replacement
 * history returned by the Responses server, keyed by session id.
 *
 * The file store is intentionally dumb (JSON + atomic rename) so a deployment
 * can point `stateDir` at any durable path — including a mounted volume shared
 * across hosts, which is how a remote session hub keeps the artifact reachable
 * after the web host restarts.
 *
 * @module dsh-blackhole/remote-state
 */
import type { ResponseItem } from './responses-v2.ts';
import type { RemoteCompactionDetails } from './responses-v2.ts';
import type { Message } from '@deepseek-ai/dsh-llm';
/** One persisted remote compaction artifact for one session. */
export interface RemoteCompactionStateEntry {
    /** The DSH session the compaction ran on. */
    sessionId: string;
    /** ISO timestamp of the replacement, for staleness decisions. */
    replacedAt: string;
    /** Provider route and model that produced the artifact. */
    provider: string;
    model: string;
    /** Endpoint host that performed the compaction. */
    endpoint: string;
    /** Readable checkpoint text (mirrors what the session log landed). */
    summaryText: string;
    /** Opaque replacement history for provider-native replay. */
    replacementHistory: ResponseItem[];
    /** Versioned replay contract; optional for artifacts written before v0.3. */
    details?: RemoteCompactionDetails;
}
/**
 * Adapter-facing replay contract published by the plugin.
 *
 * `replayHistory()` is intentionally nullable so an adapter can distinguish a
 * missing/foreign/legacy artifact from a provider-native replacement window.
 * `prepareInput()` is the safer normal-turn entry point: it always returns a
 * portable Responses input, falling back to the ordinary DSH message
 * conversion when no owned artifact is available. This keeps adapters from
 * accidentally sending a stale opaque item after a route or endpoint switch.
 */
export interface ResponsesCompactionReplay {
    replayHistory(params: {
        sessionId: string;
        provider: string;
        model: string;
        trailingMessages: readonly Message[];
        endpoint?: string;
    }): Promise<ResponseItem[] | undefined>;
    prepareInput(params: {
        sessionId: string;
        provider: string;
        model: string;
        trailingMessages: readonly Message[];
        endpoint?: string;
    }): Promise<ResponseItem[]>;
}
/** JSON file store under a configurable directory. */
export declare class RemoteCompactionStateStore implements ResponsesCompactionReplay {
    readonly dir: string;
    constructor(dir: string);
    private pathFor;
    /** Persist one entry atomically (temp file + rename). */
    save(entry: RemoteCompactionStateEntry): Promise<void>;
    load(sessionId: string): Promise<RemoteCompactionStateEntry | undefined>;
    /**
     * Load only a current-target v2 artifact.  Legacy entries remain readable
     * through `load()` for migration/diagnostics, but they are deliberately not
     * replayable because they lack the ownership contract and could contain a
     * provider-private history for a different route.
     */
    loadForTarget(params: {
        sessionId: string;
        provider: string;
        model: string;
        endpoint?: string;
    }): Promise<RemoteCompactionStateEntry | undefined>;
    /**
     * Resolve the provider-native Responses history for one next request.
     * Returns `undefined` on missing/legacy/foreign state (fail closed).
     */
    replayHistory(params: {
        sessionId: string;
        provider: string;
        model: string;
        trailingMessages: readonly Message[];
        endpoint?: string;
    }): Promise<ResponseItem[] | undefined>;
    /**
     * Build the complete input for one ordinary Responses request.
     *
     * The adapter owns the final HTTP envelope; this method owns only the
     * provider-native input list. A missing state is not an error — it means the
     * request starts from the supplied DSH messages. The fallback conversion is
     * deliberately local and deterministic, so a foreign provider/model or an
     * endpoint mismatch can never leak opaque state into another route.
     */
    prepareInput(params: {
        sessionId: string;
        provider: string;
        model: string;
        trailingMessages: readonly Message[];
        endpoint?: string;
    }): Promise<ResponseItem[]>;
    remove(sessionId: string): Promise<void>;
}
