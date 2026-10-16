/**
 * Compatible access to a session's durable event log and message projection.
 *
 * DSH 0.2.0-rc deprecated synchronous event reads (`session.events`): the
 * runtime `Session` now exposes `snapshotEvents()` and the module-level
 * `deriveEventMessage()`, while every test fake and older harness revision
 * still answers with an `events` array and an instance `deriveEventMessage`
 * method. The compaction seam hands the engine a session it does not own, so
 * this module sniffs both shapes and normalizes the access behind one seam —
 * a wrong guess here crashed `resolveRegionSeqs()` inside the real harness.
 *
 * @module dsh-blackhole/session-access
 */
/** Loosest structural view of one durable session event. */
export interface SessionEventLike {
    readonly seq?: number;
    readonly [key: string]: unknown;
}
/**
 * Anything that can answer with the ordered durable event log: the runtime
 * `Session` (snapshotEvents) or a test fake / older harness (events array).
 */
export interface SessionEventSource {
    snapshotEvents?(fromSeq?: number, toSeqExclusive?: number): readonly SessionEventLike[];
    readonly events?: readonly SessionEventLike[];
    deriveEventMessage?(event: unknown): unknown | null;
}
/**
 * Read the full ordered event log from either shape. Prefer the runtime
 * snapshot; fall back to a plain array. Returns an empty array when the
 * session exposes neither (nothing to resolve, never a crash).
 */
export declare function readSessionEvents(session: SessionEventSource): readonly SessionEventLike[];
/**
 * Project one durable event onto its conversation message: the runtime seam
 * is the module-level `deriveEventMessage()`; fakes and older harnesses
 * answer on the session instance. Returns null when neither projection
 * applies.
 */
export declare function deriveSessionMessage(session: SessionEventSource, event: unknown): unknown | null;
