/**
 * dsh-blackhole: dual-pipeline compaction backend for DeepSeek
 * Harness — official server-side Responses compaction v2 for OpenAI-routed
 * targets, with a deterministic VCC-style local compiler as the zero-cost
 * fallback and for every other provider.
 *
 * The default export is the hybrid `RoutingCompactionEngine`: it subclasses
 * the official `BasicCompactionEngine`, inheriting the whole
 * pressure/retention/replay machinery and the token-meter pricing, and
 * routes inside the single `summarize()` hook:
 *
 *   - OpenAI (or any provider with a configured Responses endpoint):
 *     remote Responses compaction v2 (the same protocol Codex's remote
 *     compaction uses), persisting the opaque replacement history;
 *   - remote failure (no endpoint, missing key, timeout, protocol error):
 *     local deterministic VCC-style compiler (zero model calls) by default,
 *     or the native one-shot LLM summarizer via `fallbackMode: "llm"`;
 *   - every other provider: local compiler, straight away.
 *
 * The local compiler is VCC's conversation-compiler principle ported into
 * DSH (rules adapted from the MIT-licensed `dsh-compaction-instant`): only
 * original tokens, every elision carries a `(seq N)` pointer resolved against
 * the real durable session log.
 *
 * @module dsh-blackhole
 */
export { RoutingCompactionEngine, resolveRegionSeqs } from './hybrid.ts';
export { RoutingCompactionEngine as default } from './hybrid.ts';
export type { HybridCompiledSummary } from './hybrid.ts';
export { ResponsesCompactionEngine } from './responses-engine.ts';
export { CompactionResponsesConfigSchema, HybridCompactionConfigSchema, responsesEndpointUrl, resolveEndpoints, } from './config.ts';
export type { CompactionResponsesConfig, CompactionFallbackMode, CompilerCompactionConfig, HybridCompactionConfig, ResponsesEndpointConfig, ResolvedResponsesEndpoint, } from './config.ts';
export { RemoteCompactionStateStore } from './remote-state.ts';
export type { RemoteCompactionStateEntry, ResponsesCompactionReplay } from './remote-state.ts';
export type { SummarizationInput, SummaryResult } from './engine-shared.ts';
export { compileInstantRegion, compileNoisePatterns, countTokens, collapseSkillText, compressBash, DEFAULT_ARG_TOOLS, DEFAULT_INSTANT_OPTIONS, DEFAULT_NOISE_PATTERNS, DEFAULT_TOOL_KEY_FIELDS, estimateEntryTokens, estimateMessagesTokens, firstLineOf, joinInstantEntries, parseToolArguments, PATH_KEYS, pickToolKeyArg, projectToolResultText, sanitize, stripNoiseXml, stripSelfTalkPrefix, tokenize, truncateTextTokens, truncateTokens, } from './instant.ts';
export type { CompilerNode, InstantCompileOptions, InstantCompiledRegion, InstantEntry, InstantEntryKind, InstantStats, RawBlock, RawMessage, RawSource, } from './instant.ts';
export { BLACKHOLE_RECALL_NOTE, compileBlackholeSummary, filterBlackholeNoise, normalizeBlackholeMessages, previousCheckpointSummary, } from './blackhole-summary.ts';
export type { BlackholeBlock, BlackholeMessage, BlackholeSummaryInput, NormalizedBlackholeBlock, } from './blackhole-summary.ts';
export { adaptRecallSession, createRecallTool, indexRecallSession, isOmMemoryId, OM_RECALL_TODO, rankRecallEntries, recallSession, registerRecallTool, } from './recall.ts';
export type { RecallDrillDown, RecallEntry, RecallEvent, RecallFileMatch, RecallFileOperation, RecallMode, RecallQuery, RecallResult, RecallScope, RecallSession, RecallToolDefinition, RecallToolRegistry, } from './recall.ts';
export { extractRecallFileOperations, findRecallFileMatches, parseRecallDrillDown, recallFileSearchText, renderRecallFileDrillDown, } from './recall-files.ts';
export { createRecallCommand, parseRecallCommandInput, RECALL_COMMAND_NAME, registerRecallCommand, } from './recall-command.ts';
export type { RecallCommandDefinition, RecallCommandInvocation, RecallCommandRegistry, RecallCommandResult, } from './recall-command.ts';
export { createModeCommand, MODE_COMMAND_NAME, parseModeCommandInput, registerModeCommand, clearRuntimeModeOverride, loadRuntimeModeOverride, saveRuntimeModeOverride, runtimeModeFilePath, RUNTIME_MODE_FILE, } from './mode-command.ts';
export type { BlackholeModeController, ModeCommandDefinition, ModeCommandInvocation, ModeCommandRegistry, ModeCommandResult, RuntimeModeOverride, } from './mode-command.ts';
export { deriveSessionMessage, readSessionEvents, } from './session-access.ts';
export type { SessionEventLike, SessionEventSource, } from './session-access.ts';
export { buildCompactionRequestBody, buildRemoteCompactionDetails, buildReplacementHistory, callResponsesCompactionV2, dshMessageToResponseItems, dshMessagesToResponseItems, mapCompactionUsage, parseCompactionV2Events, parseRemoteCompactionDetails, parseSseData, reconstructRemoteCompactionHistory, remoteCompactionModelKey, toolSchemasToResponseTools, } from './responses-v2.ts';
export type { RemoteCompactionV2Result, RemoteCompactionDetails, ResponseContentItem, } from './responses-v2.ts';
