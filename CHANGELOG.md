# Changelog

## 0.2.0 (2026-08-15)

- **Content-loss audit on a real session** (`tests/equivalence/FIDELITY.md`):
  entity-level fidelity (assistant-text entities 41% kept, tool-result 5% but
  re-runnable via kept args, error first-lines 18/18 kept) plus a 5-question
  LLM A/B (full window vs brief, deepseek-v4-flash-free): answers sourced in
  assistant text/error lines stay exact after compaction; thinking-sourced
  answers are refused (no hallucination); tool-result details degrade to
  partial inference, never fabrication.
- **Real-session content equivalence** (`tests/equivalence/differential-real-session.mjs`):
  end-to-end differential against pi-blackhole's compileBrief on a live pi
  session transcript (287 messages incl. 152 real tool calls): 24/26
  normalized lines byte-identical, remaining 2 lines differ only in
  truncation-point offset (200-word vs token-budget cut). Two real gaps
  found and fixed in the process: (1) non-whitelisted tools like `ls`/
  `fffind` lost their path/pattern argument — extraction now follows
  pi-blackhole for EVERY tool (empty `toolArgTools` = extract-all default,
  non-empty list opts back into whitelist-only); (2) truncated assistant
  text kept line breaks where blackhole flattens to one dense line — the
  truncated path now flattens whitespace too.

- **Dual-pipeline routing**: the default export is now `RoutingCompactionEngine`
  — routes inside the single `summarize()` hook:
  - OpenAI (or any provider with a matching `endpoints` entry) → remote
    Responses compaction v2 with persisted replacement history;
  - remote failure → local deterministic VCC-style compiler by default
    (`fallbackMode: "instant"`), or the native LLM summarizer (`"llm"`),
    or compiler-then-LLM (`"instant-then-llm"`);
  - no endpoint match → local compiler straight away.
- New dependency-free compiler module `src/instant.ts`: VCC
  conversation-compiler principle ported to DSH (rules adapted from the
  MIT-licensed `dsh-compaction-instant`), zero model calls, only original
  tokens — one-line tool calls with `(seq N -> result M)` pointers, tool
  results never occupy entries, reasoning elided by default, noise XML
  stripped, `...(truncated from seq N)` markers, token-cap elision with
  explicit `[N entries elided: seqs a-b]` notes.
- Real durable seq resolution: flattened region messages are matched to the
  session event log by message id, so every `(seq N)` pointer stays valid
  for a recall tool mounted next to this engine.
- New compiler config knobs: `compileMaxTokens`, `checkpointScale`,
  `checkpointCap`, `textTokens`, `userTextTokens`, `toolCallTokens`,
  `includeReasoning`, `stripNoiseXml`, `noisePatterns`, `toolKeyFields`,
  `toolArgTools`, `hideTools`.
- `fallbackMode` replaces `fallbackToLlm` (legacy boolean still maps:
  `false` → `instant`, `true` → default).
- Existing `ResponsesCompactionEngine` remains exported unchanged.
- New test suite `tests/hybrid-smoke.mjs` (compiler unit + routing matrix).
- Blackhole/VCC structured checkpoint sections (`Session Goal`, files,
  commits, outstanding context, preferences), previous-checkpoint merge, and
  a durable `recall` footer are now emitted by the local branch.
- Added a dsh-tools-compatible recall registry seam with active-lineage,
  file/touched-file, regex, drill-down, and offset/limit search. Registration
  follows Cordis service arrival/removal, so dsh-tools stays optional.
- Versioned Responses v2 details now enforce provider/model ownership; later
  remote compactions replay the prior opaque window, while fallback or route
  changes invalidate it. Normal conversation-turn injection remains an
  adapter-owned bridge via `RemoteCompactionStateStore.prepareInput()` (with
  nullable `replayHistory()` retained for adapters that need to branch).
- Adapter contract now pinned by tests: `prepareInput()`/`replayHistory()`
  fail closed on foreign provider/model, legacy (unversioned) artifacts, and
  endpoint mismatches; fallback compactions invalidate stored state.
- Added the first CONTENT-level differential against the real pi-blackhole
  brief compiler (vendored `49ab560`, `differential-brief.mjs`): protocol
  equivalence was already proven, but checkpoint-text equivalence is NOT —
  see `tests/equivalence/BRIEF-DIFF.md` for the divergence ledger (tool-error
  bodies, capitalized Read/Edit/Write args, bash compression, skill
  collapse, tool-line merging, per-turn tool cap, self-talk stripping).
- **Brief rules aligned with pi-blackhole (49ab560)**: failed tool results
  now keep `[tool_error] name (seq N)` + first line (`toolErrorChars`, 150),
  bash one-liners are semantically compressed (`bashCap`, 120), capitalized
  `Read`/`Edit`/`Write` plus a generic path-key fallback keep the target
  path, `<skill name="X">…</skill>` blocks collapse to `[skill: X]`
  (`collapseSkills`), assistant self-talk fillers are stripped
  (`stripSelfTalk`), identical tool one-liners merge into `… xN`
  (`mergeToolLines`), at most `toolsPerTurn` (8) tool rows survive per
  assistant turn with a `* (N earlier tool-call entries omitted)` note,
  image labels keep the mime type, and untruncated text whitespace is
  flattened (VCC brief style). Setting the new knobs to `0`/`false`
  reproduces the pre-alignment compiler. Content differential now shows
  11/12 vectors equivalent; the only remaining divergence is the explicit
  noise-only elision note (intentional). New pinned regression suite
  `tests/instant-blackhole-align.mjs`.

## 0.1.0 (2026-08-15)

- Initial release: Responses-assisted compaction backend for DSH.
- `ResponsesCompactionEngine extends BasicCompactionEngine` — inherits the
  official pressure/retention/replay machinery and token-meter pricing,
  overrides the single `summarize()` hook.
- Responses compaction v2 (`compaction_trigger`) against configurable
  endpoints (direct OpenAI / compatible gateways / Codex backend).
- Readable checkpoint text extracted from the compaction response; opaque
  replacement history persisted per session under
  `$DSH_HOME/plugins/dsh-blackhole/state`.
- Graceful fallback to the inherited native LLM summarizer on any failure
  (configurable via `fallbackToLlm`).
- Bundle patch: disables the official `compaction-basic` row, re-enables
  `command-compact`, inserts the engine — exactly one `compaction` service.
- Port of algal/pi-openai-server-compaction (MIT); attribution in LICENSE.
