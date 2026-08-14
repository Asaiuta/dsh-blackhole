/**
 * Durable per-session state for remote compaction: the opaque replacement
 * history returned by the Responses server, keyed by session id.
 *
 * The file store is intentionally dumb (JSON + atomic rename) so a deployment
 * can point `stateDir` at any durable path — including a mounted volume shared
 * across hosts, which is how a remote session hub keeps the artifact reachable
 * after the web host restarts.
 *
 * @module dsh-compaction-responses/remote-state
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ResponseItem } from './responses-v2.ts'

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
}

/** JSON file store under a configurable directory. */
export class RemoteCompactionStateStore {
  constructor(readonly dir: string) {}

  private pathFor(sessionId: string): string {
    return join(this.dir, `${sessionId}.json`)
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
      if (typeof parsed.sessionId !== 'string' || !Array.isArray(parsed.replacementHistory)) {
        return undefined
      }
      return parsed
    } catch {
      return undefined
    }
  }

  async remove(sessionId: string): Promise<void> {
    try {
      const file = this.pathFor(sessionId)
      const parent = dirname(file)
      await rename(file, join(parent, `${sessionId}.json.removed`))
    } catch {
      // Absent or unremovable state is not a compaction failure.
    }
  }
}