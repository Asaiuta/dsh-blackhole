/**
 * The recall tool as a first-class cordis plugin unit, mirroring the official
 * tool plugins (`dsh-tool-todo` et al.): a declared `inject = ['tools']`
 * makes cordis defer `apply` until the tool registry exists, and the
 * definition goes through the official `defineTool()` wrapper — author-DSL
 * parameters, JSON-Schema argument validation, and the structured
 * `output.render` the desktop UI consumes.
 *
 * Mounted from the bundle patch's preset compaction group ([2]). The host
 * plane ([1], headless) keeps the engine's legacy probe-based attach, which
 * works there because the engine and the tools service share the host scope.
 *
 * @module dsh-blackhole/tools-plugin
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { adaptRecallSession, createRecallTool } from './recall.ts'
import type { RecallSession } from './recall.ts'

export const name = 'blackhole-tools'

export const inject = ['tools'] as const

/** The slice of the cordis context this plugin touches (services arrive via inject). */
interface ToolsHostContext {
  tools: {
    register(definition: unknown): (() => void) | void
  }
  effect(setup: () => Generator<unknown>, label?: string): unknown
}

/** Pull the recall-visible session off a tool execution context. */
function recallSessionFromExec(exec: unknown): RecallSession | undefined {
  const candidate = exec as { agent?: { session?: unknown } } | undefined
  return adaptRecallSession(candidate?.agent?.session)
}

/**
 * Register the `recall` tool on the host tool registry. The definition comes
 * from `createRecallTool()` in the dependency-free compiler module; the
 * official `defineTool()` wrapper compiles the author-DSL parameters into
 * enforced JSON Schema and wires argument validation plus the UI rendering.
 */
export function apply(ctx: Context): void {
  const host = ctx as unknown as ToolsHostContext
  host.effect(function* () {
    // The structural definition is author-DSL shaped but loosely typed (the
    // compiler module stays dsh-tools-free). `as never` keeps the compiler
    // from expanding DefineToolOptions' recursive Infer types against the
    // loose record — the runtime wrapper performs the real validation.
    const definition = createRecallTool(recallSessionFromExec)
    yield host.tools.register(defineTool(definition as never))
  }, 'dsh-blackhole recall tool')
}
