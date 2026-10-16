/**
 * Optional DSH human-command adapter for runtime compaction-mode switching.
 *
 * `/blackhole-mode` flips the routing engine's runtime state — the fallback
 * chain and the remote Responses gate — and persists the switch as a small
 * JSON file in the plugin's own state dir, so it survives DSH restarts.
 * `/blackhole-mode reset` clears the override and returns to the config
 * defaults. The durable default still lives in the profile config
 * (`fallbackMode` / `endpoints`); the override file only carries the deltas
 * the user applied at runtime, and plugins never write the host's profile
 * YAML.
 *
 * All human-facing strings are Simplified Chinese to match the desktop UI;
 * mode tokens (`instant` / `llm` / `remote` …) stay as literal command
 * syntax. Model-facing strings elsewhere (tool descriptions, checkpoint
 * content) remain English.
 *
 * @module dsh-blackhole/mode-command
 */
import type { CompactionFallbackMode } from './config.ts';
/** Runtime mutability seam over the routing engine's switchable state. */
export interface BlackholeModeController {
    /** Current fallback chain mode. */
    getFallbackMode(): CompactionFallbackMode;
    /** Fallback chain mode resolved from the plugin config (no override). */
    getFallbackModeDefault(): CompactionFallbackMode;
    setFallbackMode(mode: CompactionFallbackMode): void;
    /** Whether remote Responses compaction attempts are currently enabled. */
    isRemoteEnabled(): boolean;
    /** Remote gate resolved from the plugin config (no override). */
    isRemoteEnabledDefault(): boolean;
    setRemoteEnabled(enabled: boolean): void;
    /** Drop the persisted override and restore the config defaults. */
    resetRuntimeMode(): void;
    /** One-line summary of the configured remote endpoints. */
    describeEndpoints(): string;
}
export type ModeCommandResult = {
    readonly kind: 'success';
    readonly text?: string;
} | {
    readonly kind: 'error';
    readonly text: string;
};
export interface ModeCommandInvocation {
    readonly rawInput: string;
}
export interface ModeCommandDefinition {
    readonly name: string;
    readonly description: string;
    readonly input?: {
        readonly hint: string;
    };
    readonly handler: (invocation: ModeCommandInvocation) => ModeCommandResult | Promise<ModeCommandResult>;
}
/** Structural shape of the optional dsh-commands service for this command. */
export interface ModeCommandRegistry {
    register: (definition: ModeCommandDefinition) => (() => void) | void;
}
export declare const MODE_COMMAND_NAME = "blackhole-mode";
export type ModeCommandAction = {
    readonly action: 'status';
} | {
    readonly action: 'mode';
    readonly mode: CompactionFallbackMode;
} | {
    readonly action: 'remote';
    readonly enabled?: boolean;
} | {
    readonly action: 'reset';
} | {
    readonly action: 'invalid';
    readonly message: string;
};
/** Parse `/blackhole-mode`'s free-form argument. */
export declare function parseModeCommandInput(rawInput: string): ModeCommandAction;
/** The persisted runtime switch deltas. */
export interface RuntimeModeOverride {
    fallbackMode?: CompactionFallbackMode;
    remoteEnabled?: boolean;
    savedAt?: string;
}
/** File name of the persisted override inside the plugin state dir. */
export declare const RUNTIME_MODE_FILE = "runtime-mode.json";
/** Absolute path of the persisted override inside `dir`. */
export declare function runtimeModeFilePath(dir: string): string;
/**
 * Read the persisted override; a missing or unreadable file, or a file with
 * no valid fields (corrupt, wrong types), yields `undefined` so a broken
 * artifact can never wedge the engine.
 */
export declare function loadRuntimeModeOverride(dir: string | undefined): RuntimeModeOverride | undefined;
/** Persist the override best-effort; `false` means the caller should warn. */
export declare function saveRuntimeModeOverride(dir: string | undefined, override: RuntimeModeOverride): boolean;
/** Remove the persisted override; `false` means the caller should warn. */
export declare function clearRuntimeModeOverride(dir: string | undefined): boolean;
/** Build the optional user-facing command definition. */
export declare function createModeCommand(controller: BlackholeModeController): ModeCommandDefinition;
/** Register the command if a DSH command service is present. */
export declare function registerModeCommand(registry: ModeCommandRegistry, controller: BlackholeModeController): (() => void) | void;
