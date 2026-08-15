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

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ResponseItem } from './responses-v2.ts'
import {
  dshMessagesToResponseItems,
  parseRemoteCompactionDetails,
  reconstructRemoteCompactionHistory,
} from './responses-v2.ts'
import type { RemoteCompactionDetails } from './responses-v2.ts'
import type { Message } from '@deepseek-ai/dsh-llm'

/** One persisted remote compaction artifact for one session. */
export interface RemoteCompactionStateEntry {
  /** The DSH session the compaction ran on. */
  sessionId: string
  /** ISO timestamp of the replacement, for staleness decisions. */
  replacedAt: string
  /** Provider route and model that produced the artifact. */
  provider: string
  model: string
  /** Endpoint host that performed the compaction. */
  endpoint: string
  /** Readable checkpoint text (mirrors what the session log landed). */
  summaryText: string
  /** Opaque replacement history for provider-native replay. */
  replacementHistory: ResponseItem[]
  /** Versioned replay contract; optional for artifacts written before v0.3. */
  details?: RemoteCompactionDetails
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
    sessionId: string
    provider: string
    model: string
    trailingMessages: readonly Message[]
    endpoint?: string
  }): Promise<ResponseItem[] | undefined>
  prepareInput(params: {
    sessionId: string
    provider: string
    model: string
    trailingMessages: readonly Message[]
    endpoint?: string
  }): Promise<ResponseItem[]>
}

/** JSON file store under a configurable directory. */
export class RemoteCompactionStateStore implements ResponsesCompactionReplay {
  constructor(readonly dir: string) {}

  private pathFor(sessionId: string): string {
    // Session ids are normally UUIDs, but adapters are an extension seam.
    // Encode the filename component so a malformed id cannot escape stateDir
    // through `../` or a Windows drive/UNC separator.
    return join(this.dir, `${encodeURIComponent(sessionId)}.json`)
  }

  /** Persist one entry atomically (temp file + rename). */
  async save(entry: RemoteCompactionStateEntry): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const target = this.pathFor(entry.sessionId)
    const tmp = `${target}.tmp`
    await writeFile(tmp, JSON.stringify(entry, null, 2), 'utf8')
    await rename(tmp, target)
  }

  async load(sessionId: string): Promise<RemoteCompactionStateEntry | undefined> {
    try {
      const raw = await readFile(this.pathFor(sessionId), 'utf8')
      const parsed = JSON.parse(raw) as RemoteCompactionStateEntry
      if (parsed.sessionId !== sessionId || !Array.isArray(parsed.replacementHistory)) {
        return undefined
      }
      if (parsed.details !== undefined) {
        const details = parseRemoteCompactionDetails(parsed.details)
        if (details === undefined) return undefined
        if (details.replacementHistory.length !== parsed.replacementHistory.length) return undefined
        return { ...parsed, details }
      }
      return parsed
    } catch {
      return undefined
    }
  }

  /**
   * Load only a current-target v2 artifact.  Legacy entries remain readable
   * through `load()` for migration/diagnostics, but they are deliberately not
   * replayable because they lack the ownership contract and could contain a
   * provider-private history for a different route.
   */
  async loadForTarget(params: {
    sessionId: string
    provider: string
    model: string
    endpoint?: string
  }): Promise<RemoteCompactionStateEntry | undefined> {
    const entry = await this.load(params.sessionId)
    if (entry?.details === undefined) return undefined
    if (entry.provider !== params.provider || entry.model !== params.model) return undefined
    if (params.endpoint !== undefined && entry.endpoint !== params.endpoint) return undefined
    return entry
  }

  /**
   * Resolve the provider-native Responses history for one next request.
   * Returns `undefined` on missing/legacy/foreign state (fail closed).
   */
  async replayHistory(params: {
    sessionId: string
    provider: string
    model: string
    trailingMessages: readonly Message[]
    endpoint?: string
  }): Promise<ResponseItem[] | undefined> {
    const entry = await this.loadForTarget(params)
    if (entry?.details === undefined) return undefined
    return reconstructRemoteCompactionHistory({
      details: entry.details,
      provider: params.provider,
      model: params.model,
      trailingMessages: params.trailingMessages,
    })
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
  async prepareInput(params: {
    sessionId: string
    provider: string
    model: string
    trailingMessages: readonly Message[]
    endpoint?: string
  }): Promise<ResponseItem[]> {
    const entry = await this.loadForTarget(params)
    if (entry?.details === undefined) return dshMessagesToResponseItems(params.trailingMessages)
    return reconstructRemoteCompactionHistory({
      details: entry.details,
      provider: params.provider,
      model: params.model,
      trailingMessages: params.trailingMessages,
      includePending: true,
    }) ?? dshMessagesToResponseItems(params.trailingMessages)
  }

  async remove(sessionId: string): Promise<void> {
    try {
      const file = this.pathFor(sessionId)
      const trash = `${file}.removed`
      // A prior cleanup may have left the recoverable marker behind. Replace
      // that marker before the atomic move so a successful remove really
      // invalidates the artifact on every retry.
      await unlink(trash).catch(() => {})
      await rename(file, trash)
    } catch {
      // Absent or unremovable state is not a compaction failure.
    }
  }
}
