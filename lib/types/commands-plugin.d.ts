/**
 * The dsh-commands adapter as a first-class cordis plugin, mirroring the
 * official `dsh-command-compact` shape exactly.
 *
 * History matters here: the engine used to probe `ctx.get?.('commands')` at
 * construction and observe `internal/service` for late mounts. Both guesses
 * fail on the desktop preset — the strict `get()` returns `undefined` while
 * the commands fiber is still starting, and the service event is emitted on
 * the scope where the change happened, so a listener inside the preset's
 * isolated compaction group never hears the host-plane mount. The official
 * pattern sidesteps all of it: a declared `inject` makes cordis defer `apply`
 * until the registries exist, and `ctx.commands` is then directly readable.
 *
 * Mounted ONLY from the bundle patch's preset compaction group ([2]); the
 * host plane ([1], headless) has no commands registry, and double-mounting
 * would collide with the already-registered command names.
 *
 * @module dsh-blackhole/commands-plugin
 */
import type { Context } from '@deepseek-ai/cordis';
export declare const name = "blackhole-commands";
export declare const inject: readonly ["commands", "compaction"];
/**
 * Register `/blackhole-mode` and `/blackhole-recall` on the host command
 * registry. Definitions follow the official contract (name / description /
 * input.hint / handler returning `{ kind, text }`), so the desktop UI and
 * headless command runners consume them exactly like `/compact`.
 */
export declare function apply(ctx: Context): void;
