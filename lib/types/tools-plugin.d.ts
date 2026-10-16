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
import type { Context } from '@deepseek-ai/cordis';
export declare const name = "blackhole-tools";
export declare const inject: readonly ["tools"];
/**
 * Register the `recall` tool on the host tool registry. The definition comes
 * from `createRecallTool()` in the dependency-free compiler module; the
 * official `defineTool()` wrapper compiles the author-DSL parameters into
 * enforced JSON Schema and wires argument validation plus the UI rendering.
 */
export declare function apply(ctx: Context): void;
