/**
 * Optional DSH human-command adapter for the recall tool.
 *
 * The command registry is structural on purpose: dsh-commands is not a hard
 * dependency of this backend, but full DSH profiles can provide it at runtime.
 * OM memory-id handling is deliberately exposed as a TODO response here.
 */
import type { RecallQuery, RecallSession } from './recall.ts';
export interface RecallCommandInvocation {
    readonly rawInput: string;
    readonly agent?: {
        readonly session?: RecallSession;
    };
    readonly signal?: AbortSignal;
}
export type RecallCommandResult = {
    readonly kind: 'success';
    readonly text?: string;
} | {
    readonly kind: 'error';
    readonly text: string;
};
export interface RecallCommandDefinition {
    readonly name: string;
    readonly description: string;
    readonly input?: {
        readonly hint: string;
    };
    readonly handler: (invocation: RecallCommandInvocation) => RecallCommandResult | Promise<RecallCommandResult>;
}
export interface RecallCommandRegistry {
    register: (definition: RecallCommandDefinition) => (() => void) | void;
}
/** Parse `/blackhole-recall`'s free-form argument without losing query text. */
export declare function parseRecallCommandInput(rawInput: string): RecallQuery;
export declare const RECALL_COMMAND_NAME = "blackhole-recall";
/** Build the optional user-facing command definition. */
export declare function createRecallCommand(): RecallCommandDefinition;
/** Register the command if a DSH command service is present. */
export declare function registerRecallCommand(registry: RecallCommandRegistry): (() => void) | void;
