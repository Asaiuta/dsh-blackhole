# Changelog

## 0.3.0 — 2026-10-11

- **Checkpoint-wide last-wins merge of repeated tool rows** (`mergeRepeatedToolRows`
  in `src/instant.ts`, third deliberate divergence from upstream — see
  `tests/equivalence/BRIEF-DIFF.md`): repeated one-liners (same rendered base)
  now collapse to their LAST occurrence across the WHOLE checkpoint, not just
  when adjacent — 26 of 33 repeated rows on the real profile were
  cross-segment, so adjacency caught almost nothing.  The merged row keeps
  EVERY member call seq; result pointers survive for the last member and any
  member whose result failed (an error is the reason the work continued —
  de-pointering it would hide that), and segment headers left headless by
  dropped rows are mechanically re-attached to the next surviving entry.  The
  merge runs BEFORE the per-message cap so only distinct rows count against
  it.  Real-session effect: tool mass 6,255 → 5,746 tokens, checkpoint
  11,811 → 11,302 (ratio 0.048 → 0.046), entries 225 → 204, and — with the
  eval's pointer-visibility metric upgraded to three tiers (pointed /
  superseded-duplicate-reachable-via-call-row / blind) — **0 blind tool
  results** (was 4).  Pinned by a new cross-segment merge case in
  `tests/instant-blackhole-align.mjs`.
- **Dual-window truncation for assistant text** (`truncateTextTokens` in
  `src/instant.ts`, second deliberate divergence from upstream — see
  `tests/equivalence/BRIEF-DIFF.md`): an assistant text over its 512-token
  block budget now keeps its head ⅔ AND tail ⅓, eliding the middle behind a
  `...(elided from seq N)...` marker, instead of head-only
  `...(truncated from seq N)`. Coding-agent conclusions sit at the END of
  assistant messages, and the real-session profile measured 6/55 blocks over
  budget with ~6.5K tokenizer tokens of tails systematically cut (worse for
  CJK: the tokenizer counts each character, so 512 tokens is half a page of
  Chinese). The tail window's density cap trims from its HEAD so the block's
  final tokens always survive. User text and tool one-liners stay head-only
  (no measured tail loss on user text; a one-liner's identity is its head).
  Reasoning blocks (when `includeReasoning`) get the same dual-window. The
  eval pins tail survival (`plan TAIL survives dual-window truncation`
  entity) and the real-session entity extraction mirrors the new transform.
- **Per-message tool cap with a navigable omission note** (`src/instant.ts`,
  deliberately diverges from upstream V8 — see
  `tests/equivalence/BRIEF-DIFF.md`): upstream pi-blackhole applies the
  8-tool-row cap per `[assistant]` section, but tool results never break a
  section, so a real agentic chain (one user turn, then dozens of calls) is
  ONE section and the cap chopped 37/152 call rows (24%) on the profiled
  real session — every dropped row's results pointer-invisible — while no
  single assistant message there exceeded 4 calls. The cap now counts rows
  per assistant message (a run of entries sharing one source seq) and the
  omission note carries that seq (`* (K earlier tool-call entries omitted:
  seq N)`), so dropped calls stay `#N`-navigable. Real-session effect:
  unreferenced tool results 42 → 5 (28% → 3%), `elidedToolRows` 37 → 0, at
  checkpoint 10,259 → 11,813 tokens (ratio 0.042 → 0.048). Pinned in
  `tests/instant-blackhole-align.mjs` (format + a cross-message no-fire
  case); all suites and both equivalence differentials pass.
- **Checkpoint-quality eval baseline** (`tests/eval-quality.mjs` +
  `tests/eval-fixtures.mjs`): measures the instant compiler where the
  regression suites only pin exact output. Two fixture sessions (a realistic
  coding turn exercising every compiler branch; a 30-turn session compiled
  under a tight cap) are run through the real `compileInstantRegion` and
  scored on four axes — token compression ratio, entity survival split into
  `verbatim` (string present) vs `pointed` (event seq navigable via `#N`
  recall), pointer integrity (every emitted `(seq N)` / `-> result M` /
  elision span resolves into the region, result refs land on tool-role
  messages), and compile determinism. Floor thresholds fail the eval on
  regression; findings (tool-result seqs no pointer references) are printed
  as the quantified worklist for future selection work. Baseline:
  coding-session ratio 0.213 with 7/7 verbatim + 6/6 pointed; capped
  long-session ratio 0.091 with newest entities intact. A third fixture,
  `real-session`, loads an actual recorded pi transcript (same
  `~/.pi/agent/sessions` source and proven pi→DSH projection as the
  equivalence harnesses; `DSH_EVAL_SESSION` pins a specific file, skip when
  none is present) — 285 real messages / 247K shadow tokens compile to
  ratio 0.042 with all tail entities intact.  Entity extraction mirrors the
  compiler's own transform chain (sanitize → self-talk strip → token
  truncation; `compressBash`/`clipArg` for call args) because whitespace-
  word windows misjudge CJK text (per-character tokenization).  Known gaps
  the eval surfaces: adjacent-merge rows keep call seqs but drop their
  `-> result` pointers, and cap-dropped call rows leave their results
  pointer-invisible (53/60 capped fixture, 42 on the real session).
  Companion `tests/eval-profile.mjs` profiles the real session's composition
  (shadow/checkpoint split, truncation losses, redundancy, pointer
  visibility) as the evidence base for selection-work priorities.  Companion `tests/eval-compare.mjs` runs the same real session through the
  vendored upstream pi-blackhole compiler and this package under one
  yardstick (size, entity recall by class, refs, loss counters).
- **UI 语言适配**：`/blackhole-mode` 与 `/blackhole-recall` 的人类可见文案
  （命令描述、状态页、切换确认、错误提示、OM 占位提示）改为简体中文，与
  桌面端界面语言一致。命令语法 token（`instant` / `llm` / `remote` …）与
  输入 hint 保持原样；模型可见的字符串（recall 工具描述、检查点内的
  `BLACKHOLE_RECALL_NOTE`、编译器输出格式）保持英文不变。
- **Recall tool rebuilt on the official `defineTool()` wrapper** (`dsh-blackhole/tools`,
  new `src/tools-plugin.ts`, `inject = ['tools']`): the probe-based attach the
  engine used for the recall tool had the same host-plane blindness as the
  commands path inside the preset group. The tool definition now goes through
  the official wrapper — author-DSL parameters compiled to enforced JSON
  Schema (`minimum`/`maximum`/`maxItems` are not in the DSL whitelist, so
  numeric bounds stay in the runtime clamps), argument validation before
  execute, and the structured `output.render` the desktop UI consumes. The
  session adapter moved to `recall.ts` (`adaptRecallSession`), shared by the
  plugin and the engine's host-plane fallback. New dependency
  `@deepseek-ai/dsh-tools@0.2.0-rc.2` (dev) and a `tests/tools-plugin.mjs`
  suite covering the wrapper, validation, execution, and render.
- **Command registration rebuilt on the official plugin pattern** (fixes the
  `/blackhole-mode` silence on the desktop preset): the engine's probe-
  and-observe registration (`get('commands')` + `internal/service` events)
  structurally cannot work inside the preset's isolated compaction group —
  the strict `get()` returns undefined while the commands fiber starts, and
  service events emitted on the host plane never reach group-scoped
  listeners. Commands now live in a dedicated inject-gated plugin
  (`dsh-blackhole/commands`, new `src/commands-plugin.ts`, dual-entry build),
  mounted inside the bundle patch's compaction group exactly like the
  official `dsh-command-compact`; the engine exposes the mode controller as
  a public seam (`ctx.compaction.modeController`). Definition shapes were
  verified against the real runtime (`name` regex, `input.hint`,
  `{ kind, text }` results) and smoke-load now exercises the plugin through
  the loader lifecycle.
- **DSH 0.2.0-rc.2 vocabulary alignment** (fixes a class of latent runtime
  crashes, not just type errors): the rc.2 message model promotes tool results
  to first-class tool-role messages, registers the `compact-checkpoint` source
  kind via module augmentation, replaces `document` blocks with `file`, and
  deprecates synchronous event reads (`session.events` → `snapshotEvents()`).
  The compiler, summary merger, Responses converter, and recall adapter were
  still written against the older vocabulary — in a real harness every
  compaction crashed at `resolveRegionSeqs()` (no `session.events`), tool
  results silently vanished from checkpoints, and prior checkpoints were
  never recognized. New `src/session-access.ts` normalizes both access shapes
  behind one seam; every consumer now handles rc.2 shapes natively while
  keeping the legacy forms as fallbacks (tests pin both).
- **smoke-load composition fixed**: the rc.2 token meter declares
  `static inject = ['sessionProjections']`, so the composition was missing
  `@deepseek-ai/dsh-session-projection` and the whole inject chain hung —
  `ctx.compaction` never resolved. The command-registration assertions were
  also stale (single-command era): they now verify both
  `/blackhole-recall` and `/blackhole-mode` mount/dispose symmetrically
  through the late-bound service lifecycle.
- **Type hygiene**: tsconfig `paths` pins `@deepseek-ai/cosmokit` to a
  nameable location (TS2742 declaration portability under pnpm), and it is
  now a devDependency. `tsc --noEmit` is back to zero errors.
- **Runtime mode switching** (`/blackhole-mode`): an optional command,
  registered alongside `/blackhole-recall` through the late-bound
  `dsh-commands` service, that shows or flips the routing engine's runtime
  state without a restart — the fallback chain (`instant` /
  `instant-then-llm` / `llm`) and the remote Responses gate (`remote on|off`).
  Switches are **sticky**: they persist into `runtime-mode.json` in the plugin
  state dir and are re-applied over the config defaults on every DSH start;
  `/blackhole-mode reset` (or deleting the file) returns to the config
  defaults, which remain the durable source of truth. Disabling remote (or
  landing any local checkpoint) still removes the session's persisted
  replacement history, preserving the checkpoint-supersedes-remote invariant.
  New module `src/mode-command.ts` (controller seam + parser + override-file
  persistence), engine state (`fallbackMode` / remote gate) made runtime-
  mutable, and `tests/mode-command.mjs` covering parsing, override-file
  round-trips (corrupt/foreign files ignored), sticky-across-restart
  semantics, and the engine-level remote-gate behavior.
- **Recall parity work**: added a durable-session recall index that searches
  transcript text, raw regexes, and bounded Write/Edit file content; supports
  `#N`, `#N:path`, `#N:file`, full/offset paging, ambiguity reporting,
  `mode:file`, paged content-bearing `mode:touched`, lineage/all scopes, and
  explicit expansion without exposing complete file bodies in ordinary pages.
  All rendered responses are UTF-8 capped at 50 KB, result/expansion counts
  are bounded, full entry text is materialized lazily, and unsafe regular
  expressions fall back to token search.
- Added optional `/blackhole-recall` registration through the late-bound
  `dsh-commands` service, alongside the existing late-bound `dsh-tools`
  registration. Both registrations honor Cordis service isolation, dispose
  with service removal or plugin teardown, and keep their host packages
  optional.
- **OM remains TODO by design**: exact 12-character lowercase OM IDs return an
  explicit message; observation/reflection ledger lookup and VCC↔OM reverse
  recall are not implemented yet.

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
