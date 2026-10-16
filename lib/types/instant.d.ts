/**
 * Deterministic VCC-style region compiler, self-contained in this package.
 *
 * Ports the "conversation compiler" principle of
 * https://github.com/lllyasviel/VCC (`skills/conversation-compiler/scripts/VCC.py`)
 * into the DSH vocabulary:
 *
 *   - the durable session event log is the lossless layer (VCC's `.txt`);
 *   - a shadowed surface region compiles into a compact, reference-linked
 *     view (VCC's `.min.txt`) using ONLY original tokens — no model call, no
 *     paraphrase — which is what makes instant compaction deterministic and
 *     near-lossless;
 *   - every truncation and elision keeps a `(seq N)` pointer back to the
 *     exact durable event, so nothing is unrecoverable;
 *   - noise handling mirrors VCC's brief-mode rules: sanitize control bytes,
 *     strip known noise XML wrappers, hide reasoning by default, collapse
 *     every tool call into ONE line (key argument for whitelisted tools,
 *     name-only for the rest, a `-> result M` pointer instead of the result
 *     entry), and render images/documents as labels.
 *
 * The concrete rules are adapted from the MIT-licensed `dsh-compaction-instant`
 * (KitDoesIt) compiler, with the same observable formats (`[user]` /
 * `[assistant]` role headers on switch, `* name "arg" (seq N -> result M)`,
 * `...(truncated from seq N)`), reimplemented here so this package stays
 * dependency-free and the engine can route to the remote Responses pipeline.
 *
 * This module imports nothing from cordis or dsh packages, so it can be
 * unit-tested and reused outside a running harness. Messages are read as
 * plain `{ id, role, content, source }` values — exactly what
 * `Session.deriveEventMessage` projects; the engine resolves real durable
 * `seq`s before compiling (a synthesized message matches its stored event by
 * `id`).
 *
 * @module dsh-blackhole/instant
 */
/**
 * Split text into fixed-density tokens under the same character-class
 * heuristic VCC uses: letter runs, digit runs, single punctuation chars,
 * whitespace runs. Deterministic, offline, consistent for every budget.
 */
export declare function tokenize(text: string): string[];
/** Count the non-whitespace tokens of a text under {@link tokenize}. */
export declare function countTokens(text: string): number;
/**
 * Size one emitted entry the way every budget is enforced: the non-whitespace
 * token count, floored at the real-density `chars / 4` equivalent so a
 * pathological unbroken token run (minified file, base64 blob) cannot pass a
 * budget.
 */
export declare function estimateEntryTokens(text: string): number;
/**
 * Strip carriage returns, ANSI escapes, and control bytes the way VCC's
 * `_sanitize` does — deterministic cleanup, never token-changing rewrites.
 */
export declare function sanitize(text: string): string;
/**
 * The VCC brief-mode noise XML patterns, adapted to harness markup. Applied
 * with the `s` flag; configurable via `noisePatterns`.
 */
export declare const DEFAULT_NOISE_PATTERNS: readonly string[];
/** Compile untrusted noise-pattern sources, throwing on invalid regex. */
export declare function compileNoisePatterns(sources: readonly string[]): RegExp[];
/** Strip configured noise XML blocks and unwrap command-name/args tags. */
export declare function stripNoiseXml(text: string, patterns: readonly RegExp[]): string;
/**
 * Truncate text to a non-whitespace-token budget, preserving exact original
 * tokens and appending a VCC-style provenance note when something was cut.
 * Every budget is enforced twice — by token count AND by a `limit * 4`
 * character ceiling.
 * @returns `{ text, truncated }` — `truncated` is true when anything was cut.
 */
export declare function truncateTokens(text: string, limit: number, ref?: string): {
    text: string;
    truncated: boolean;
};
/**
 * Dual-window truncation for assistant TEXT blocks: an over-budget block
 * keeps its head AND its tail, eliding the middle behind a seq-pointer
 * marker (`...(elided from seq N)...`).  Coding-agent conclusions sit at the
 * END of assistant messages, so head-only truncation systematically cut them
 * off — the real-session profile measured 6/55 blocks over budget with
 * ~6.5K tokenizer tokens of tails dropped.  Deterministic: the head window
 * is `ceil(limit·⅔)` tokens, the tail window `floor(limit/3)`, both
 * hard-capped at 4 chars/token like {@link truncateTokens}.  Tool one-liners
 * and user text stay head-only (`truncateTokens`): a one-liner's identity is
 * its head, and user text shows no measured tail loss.
 */
export declare function truncateTextTokens(text: string, limit: number, ref?: string): {
    text: string;
    truncated: boolean;
};
/** VCC's `_TOOL_SUMMARY_FIELDS`, extended for the DSH tool catalog. */
export declare const DEFAULT_TOOL_KEY_FIELDS: Readonly<Record<string, string>>;
/**
 * Tools whose key argument is kept in the one-liner. Everything else renders
 * name-only (`* tool (seq N)`) — bookkeeping tools carry no semantic payload
 * worth the tokens (VCC's brief mode keeps `Read`/`Edit`/… args and drops
 * the rest).
 */
export declare const DEFAULT_ARG_TOOLS: readonly string[];
/** Canonical path-like argument keys (pi-blackhole's PATH_KEYS). */
export declare const PATH_KEYS: readonly string[];
/** Parse a tool-call arguments JSON string; `null` when it does not parse. */
export declare function parseToolArguments(arguments_: string | undefined): Record<string, unknown> | null;
/**
 * Pick the key argument of a tool call: the tool-specific field first
 * (`bash` → `command`), then any canonical path-like key, then the first
 * string-valued argument, else nothing. The path fallback mirrors
 * pi-blackhole's `extractPath` so capitalized `Read`/`Edit`/`Write` calls
 * keep their target path even when no explicit mapping exists.
 */
export declare function pickToolKeyArg(name: string, parsed: Record<string, unknown> | null, keyFields: Readonly<Record<string, string>>): string | undefined;
/** Leading self-talk fillers stripped from assistant text (up to 2 passes). */
export declare const SELF_TALK_PREFIX_RE: RegExp;
/** Strip leading self-talk filler, up to `max` consecutive passes. */
export declare function stripSelfTalkPrefix(text: string, max?: number): string;
export declare function collapseSkillText(text: string): string;
/**
 * Semantic bash compression: flatten lines with `; `, strip a `cd x &&`
 * prefix and formatting pipe tails, cap the length. Ported from
 * pi-blackhole's `compressBash`.
 */
export declare function compressBash(raw: string, cap?: number): string;
/** First line of a text, clipped to `max` chars at a word boundary. */
export declare function firstLineOf(text: string, max: number): string;
/** Project nested tool-result blocks into one plain-text string. */
export declare function projectToolResultText(blocks: readonly RawBlock[]): string;
/**
 * Whether a message source identifies a landed compaction checkpoint node.
 * The official vocabulary registers the `compact-checkpoint` source kind via
 * module augmentation; the legacy free-form `kind: 'plugin'` +
 * `plugin: 'compact'` shape stays as a fallback for sessions written by
 * older harness revisions.
 */
export declare function isCheckpointSource(source: RawSource | undefined): boolean;
/** Minimal structural view of a DSH content block (typed loosely on purpose). */
export interface RawBlock {
    type: string;
    text?: string;
    toolCallId?: string;
    id?: string;
    name?: string;
    arguments?: string;
    isError?: boolean;
    mediaType?: string;
    attachment?: {
        mediaType?: string;
        [key: string]: unknown;
    };
    content?: readonly RawBlock[];
}
/** Minimal structural view of a message source. */
export interface RawSource {
    kind?: string;
    plugin?: string;
    callId?: string;
}
/** Minimal structural view of a message (what `deriveEventMessage` projects). */
export interface RawMessage {
    id?: string;
    role?: string;
    content?: readonly RawBlock[];
    source?: RawSource;
}
/** One compiled region node: a message anchored to its durable session seq. */
export interface CompilerNode {
    /** Durable session-log seq this message came from; -1 when unknown. */
    seq: number;
    message: RawMessage;
}
export type InstantEntryKind = 'text' | 'reasoning' | 'tool' | 'tool-error' | 'media' | 'note' | 'checkpoint';
/** One compiled entry of the checkpoint view. */
export interface InstantEntry {
    /** Durable seq the entry derives from. */
    seq: number;
    /** Rendered entry text (original tokens only, plus role/pointer markers). */
    text: string;
    /** Deletion-priority kind: `tool`/`media`/`note` rows drop before `text` rows. */
    kind: InstantEntryKind;
}
/** Compiler configuration knobs (mirror of the instant engine's knobs). */
export interface InstantCompileOptions {
    /** Per-text-block token budget for assistant text/reasoning. Default 512. */
    textTokens: number;
    /** Per-text-block token budget for user text. Default 1024. */
    userTextTokens: number;
    /** Per-tool-line token budget. Default 128. */
    toolCallTokens: number;
    /** Keep `reasoning` blocks as `[assistant]` entries. Default false. */
    includeReasoning: boolean;
    /** Strip configured noise XML wrappers from user text. Default true. */
    stripNoiseXml: boolean;
    /** Compiled noise regexes (see {@link compileNoisePatterns}). */
    noisePatterns: readonly RegExp[];
    /** Tool name → key-argument field. */
    toolKeyFields: Readonly<Record<string, string>>;
    /** Tools whose key argument is kept in the one-liner. */
    toolArgTools: readonly string[];
    /** Tools rendered as nothing at all (no `* name` line). */
    hideTools: ReadonlySet<string>;
    /** Keep the first line of failed tool results as `[tool_error]` entries. Default 150 (0 disables). */
    toolErrorChars?: number;
    /** Compress bash commands (cd-strip, pipe-tail strip, cap). Default 120 (0 disables). */
    bashCap?: number;
    /** Collapse `<skill name="X">…</skill>` blocks to `[skill: X]`. Default true. */
    collapseSkills?: boolean;
    /** Strip leading self-talk fillers from assistant text (hmm/wait/actually/…). Default true. */
    stripSelfTalk?: boolean;
    /** Merge repeated tool one-liners checkpoint-wide into their last occurrence (`… xN`, last-wins). Default true. */
    mergeToolLines?: boolean;
    /** Max tool one-liners per assistant turn; 0 = unlimited. Default 8. */
    toolsPerTurn?: number;
}
/** Compilation counters (mirror of the instant engine's stats, minus checkpoints framing). */
export interface InstantStats {
    nodes: number;
    entries: number;
    toolCalls: number;
    toolResults: number;
    toolErrors: number;
    images: number;
    documents: number;
    reasoningElided: number;
    noiseElided: number;
    checkpoints: number;
    tokens: number;
    elidedToolRows: number;
    elidedRows: number;
}
/** Result of one region compile. */
export interface InstantCompiledRegion {
    entries: InstantEntry[];
    stats: InstantStats;
    /** True when the token cap forced entry dropping. */
    capped: boolean;
}
export declare const DEFAULT_INSTANT_OPTIONS: InstantCompileOptions;
export declare function compileInstantRegion(nodes: readonly CompilerNode[], options: InstantCompileOptions, maxTokens: number): InstantCompiledRegion;
/** Join compiled entries into the checkpoint text (blank-line separated). */
export declare function joinInstantEntries(entries: readonly InstantEntry[]): string;
/** Rough token estimate of a message list (chars/4 + envelope). */
export declare function estimateMessagesTokens(messages: readonly RawMessage[]): number;
