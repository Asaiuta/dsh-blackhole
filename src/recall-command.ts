/**
 * Optional DSH human-command adapter for the recall tool.
 *
 * The command registry is structural on purpose: dsh-commands is not a hard
 * dependency of this backend, but full DSH profiles can provide it at runtime.
 * OM memory-id handling is deliberately exposed as a TODO response here.
 */

import {
  isOmMemoryId,
  OM_RECALL_TODO,
  recallSession,
} from './recall.ts'
import type { RecallQuery, RecallSession } from './recall.ts'

export interface RecallCommandInvocation {
  readonly rawInput: string
  readonly agent?: {
    readonly session?: RecallSession
  }
  readonly signal?: AbortSignal
}

export type RecallCommandResult =
  | { readonly kind: 'success'; readonly text?: string }
  | { readonly kind: 'error'; readonly text: string }

export interface RecallCommandDefinition {
  readonly name: string
  readonly description: string
  readonly input?: { readonly hint: string }
  readonly handler: (invocation: RecallCommandInvocation) => RecallCommandResult | Promise<RecallCommandResult>
}

export interface RecallCommandRegistry {
  register: (definition: RecallCommandDefinition) => (() => void) | void
}

const COMMAND_FLAGS = /(?:^|\s)(page:\d+|scope:(?:all|lineage)|mode:(?:hybrid|file|touched)|offset:\d+|limit:\d+)(?=\s|$)/giu

/** Parse `/blackhole-recall`'s free-form argument without losing query text. */
export function parseRecallCommandInput(rawInput: string): RecallQuery {
  const raw = rawInput.trim()
  const flags = [...raw.matchAll(COMMAND_FLAGS)].map((match) => match[1].toLocaleLowerCase())
  const query = raw.replace(COMMAND_FLAGS, ' ').replace(/\s{2,}/gu, ' ').trim()
  const find = (prefix: string): string | undefined => flags.find((flag) => flag.startsWith(`${prefix}:`))?.slice(prefix.length + 1)
  const pageRaw = find('page')
  const offsetRaw = find('offset')
  const limitRaw = find('limit')
  const positiveInteger = (value: string | undefined): number | undefined => {
    if (value === undefined) return undefined
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
  }
  const nonNegativeInteger = (value: string | undefined): number | undefined => {
    if (value === undefined) return undefined
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined
  }
  const page = positiveInteger(pageRaw)
  const offset = nonNegativeInteger(offsetRaw)
  const limit = positiveInteger(limitRaw)
  const scopeRaw = find('scope')
  const modeRaw = find('mode')
  return {
    ...(query.length > 0 ? { query } : {}),
    ...(page === undefined ? {} : { page }),
    ...(offset === undefined ? {} : { offset }),
    ...(limit === undefined ? {} : { limit }),
    ...(scopeRaw === 'all' || scopeRaw === 'lineage' ? { scope: scopeRaw } : {}),
    ...(modeRaw === 'hybrid' || modeRaw === 'file' || modeRaw === 'touched' ? { mode: modeRaw } : {}),
  }
}

const hasRecallSession = (value: unknown): value is RecallSession => {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { events?: unknown; deriveEventMessage?: unknown }
  return Array.isArray(candidate.events) && typeof candidate.deriveEventMessage === 'function'
}

export const RECALL_COMMAND_NAME = 'blackhole-recall'

/** Build the optional user-facing command definition. */
export function createRecallCommand(): RecallCommandDefinition {
  return {
    name: RECALL_COMMAND_NAME,
    description: '检索会话历史，回读被压缩的上下文与更早的文件操作。',
    input: { hint: '<query> [page:N] [offset:N] [limit:N] [scope:all] [mode:file|touched]' },
    handler: async (invocation) => {
      const session = invocation.agent?.session
      if (!hasRecallSession(session)) {
        return { kind: 'error', text: '当前没有可用于回读的会话。' }
      }
      const params = parseRecallCommandInput(invocation.rawInput)
      if (isOmMemoryId(params.query)) return { kind: 'success', text: OM_RECALL_TODO }
      return { kind: 'success', text: recallSession(session, params).text }
    },
  }
}

/** Register the command if a DSH command service is present. */
export function registerRecallCommand(
  registry: RecallCommandRegistry,
): (() => void) | void {
  return registry.register(createRecallCommand())
}
