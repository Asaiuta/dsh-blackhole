# dsh-blackhole

**English** | [简体中文](README.zh-CN.md)

A DSH port of [`k0valik/pi-blackhole`](https://github.com/k0valik/pi-blackhole)'s
brief compiler (VCC conversation-compiler), wrapped in a dual-pipeline
compaction engine.

Drop-in replacement for the official `@deepseek-ai/dsh-compaction-basic`
backend that routes inside the single `summarize()` hook:

- **OpenAI (or any provider with a configured Responses endpoint)** — the
  official remote path: summarization is delegated to the **model server** via
  the Responses API `compaction_trigger` (the same protocol Codex's remote
  compaction uses), and the opaque replacement history is persisted per
  session;
- **remote failure** (no endpoint, missing key, timeout, protocol error) —
  by default the region is compiled locally by a **deterministic VCC-style
  compiler** (zero model calls, near-lossless `(seq N)` pointers back into
  the durable session log), with the native one-shot LLM summarizer available
  via `fallbackMode: "llm"`;
- **every other provider** — the local compiler, straight away, no network.

Remote compaction branch ports
[`algal/pi-openai-server-compaction`](https://github.com/algal/pi-openai-server-compaction)
(MIT). The local compiler is a **port of pi-blackhole's `brief.ts` compiler**
(VCC conversation-compiler, MIT; rule lineage: lllyasviel/VCC →
dsh-compaction-instant) — the differential suite pins content-level
equivalence against the real pi-blackhole sources (see *Equivalence*
below).

## Why

| | pi | DSH (this plugin) |
|---|---|---|
| Remote compaction v2 | via algal/kky42/lll9p extensions | **remote branch** of the routing engine |
| Zero-cost local compaction | pi-vcc / pi-blackhole (algorithmic) | **local compiler branch** (`fallbackMode: "instant"`) |
| Compaction seam | extension event hooks | `CompactionEngine.summarize()` — the official single customization hook |
| Fallback chain | — | instant → (optional) native LLM → fail |
| Opaque window persistence | pi session JSONL `compaction.details.remoteCompaction` | per-session JSON state under `$DSH_HOME/plugins/dsh-blackhole/state` |

## How it works

1. DSH decides to compact (pressure / overflow / `/compact`) and calls the
   engine's `summarize()` hook with the replayed conversation region.
2. The routed provider/model is resolved (durable request header first, agent
   options second) and matched against the configured `endpoints`.
3. **Remote branch** (matched endpoint): the region is converted into
   Responses input items (text, reasoning, tool calls/results), a
   `compaction_trigger` is appended, and the compaction response streams from
   `{baseUrl}/responses`. The assistant-authored summary becomes the readable
   checkpoint; the opaque `compaction` item plus the retained tail of user
   messages (Codex-style 20K token budget) is persisted per session. A later
   remote compaction for the same provider/model replays that opaque window
   and appends only the new trailing surface.
4. **Fallback**: any remote failure logs a warning and hands the region to
   the local compiler (`instant`, default) or the native LLM summarizer
   (`llm`). `instant-then-llm` tries the compiler first and only then the LLM.
5. **Local compiler branch** (no endpoint match, or fallback): a deterministic
   zero-model pass over the region that keeps ONLY original tokens — every
   tool call becomes one line `* bash "ls" (seq 2 -> result 3)`, tool results
   never occupy entries (one recall away via the pointer), reasoning is
   elided, long text truncates with `...(truncated from seq N)`, noise XML is
   stripped, and a token cap drops the oldest rows first with an explicit
   `[N entries elided: seqs a-b]` note. The `(seq N)` pointers resolve against
   the REAL durable session log (each flattened message is matched to its
   stored event by id), so a recall tool mounted next to this engine restores
   the exact original content.

The engine subclasses the official `BasicCompactionEngine`, so all pressure /
retention / policy knobs, the token-meter pricing, and the context-overflow
recovery behave exactly as upstream.

## Install

Requires DSH `0.1.0-rc.6` (web or headless profile).

```bash
# into the profile that serves your sessions
dsh plugin --profile web add dsh-blackhole
# or from a local tarball:
npm pack dsh-blackhole && dsh plugin --profile web add ./dsh-blackhole-0.2.0.tgz
```

The bundle patch:

- disables the official `compaction-basic` row (already disabled by the
  web-app bundle — idempotent),
- re-enables `command-compact` (the `/compact` command, which the web-app
  bundle disables; it is backend-independent),
- inserts this engine under its own row.

Exactly one `compaction` service ends up mounted; the dual pipeline lives
inside the engine.

## Configure

In the profile's settings (or `~/.dsh/settings.yaml` under the plugin key):

```yaml
dsh-blackhole:
  # inherited BasicCompactionEngine knobs (all optional, same defaults as
  # @deepseek-ai/dsh-compaction-basic):
  thresholdRatio: 0.75
  retainRatio: 0.25
  auto: true

  # Responses-assisted knobs:
  endpoints:
    # direct OpenAI Responses
    - provider: openai
      baseUrl: https://api.openai.com/v1
      apiKeyEnv: OPENAI_API_KEY
    # any OpenAI-compatible gateway that forwards the Responses API
    - provider: '*'
      baseUrl: https://my-gateway.example.com/v1
      apiKeyEnv: MY_GATEWAY_KEY
    # official Codex backend (needs the beta-feature header)
    - provider: openai-codex
      baseUrl: https://chatgpt.com/backend-api
      apiKeyEnv: CODEX_TOKEN
      headers:
        OpenAI-Beta: responses=experimental
        x-codex-beta-features: remote_compaction_v2
  timeoutMs: 120000      # abort the remote attempt after 2 min
  fallbackMode: instant  # instant | instant-then-llm | llm
  retainedMessageTokenBudget: 20000
  persistRemoteHistory: true
  stateDir: ~/.dsh/plugins/dsh-blackhole/state

  # Local compiler knobs (all optional):
  compileMaxTokens: 8192     # floor; scaled by checkpointScale on big regions
  checkpointScale: 0.1       # cap = max(compileMaxTokens, shadowed x scale)
  checkpointCap: 65536       # hard ceiling
  textTokens: 512            # per assistant text/reasoning block
  userTextTokens: 1024       # per user text block
  toolCallTokens: 128        # per tool one-liner
  includeReasoning: false
  stripNoiseXml: true
  noisePatterns: []          # empty = built-in VCC patterns
  toolArgTools: []           # empty = built-in whitelist
  hideTools: []              # e.g. [TodoWrite, ToolSearch]
```

Endpoint matching: `provider` matches the DSH provider route the latest request
ran on (exact, or `*` for any); `model` matches exact id or a `*` glob.
Authorization uses `apiKeyEnv` (env var name) or `apiKey` (inline — never
commit a real key).

`fallbackMode` semantics (applies to remote failures only):

| mode | remote ok | remote fails |
|---|---|---|
| `instant` (default) | server summary | local compiler (zero model calls) |
| `instant-then-llm` | server summary | local compiler; LLM only if the compiler itself fails |
| `llm` | server summary | native one-shot LLM summarizer |

The legacy `fallbackToLlm` boolean still maps: `false` forces `instant`;
`true` behaves like the default. Targets with **no matching endpoint** always
take the local compiler (or, in `llm` mode, the native LLM).

## Behavior notes

- **Images**: DSH stores image bytes in the attachment store, which a remote
  compaction call cannot resolve; image blocks are carried as an explicit
  "image content omitted" text visit instead of being silently dropped. The
  local compiler renders them as `[image] (seq N)` labels.
- **Checkpoint framing**: the engine returns plain text; the inherited
  backend wraps it in the standard `<compacted-summary>` checkpoint framing.
- **Deployments with agent presets**: presets mount their own compaction realm.
  If a preset also compacts, either disable `auto` on one side or drop the
  preset's compaction rows — two engines must not compact the same session.
- **Normal-turn opaque replay remains adapter-owned**: DSH's immutable
  `llm/stream` request has no message-rewrite hook. This package therefore
  provides the optional `responsesCompactionReplay` service. A Responses
  adapter should call `prepareInput({ sessionId, provider, model,
  trailingMessages, endpoint })` immediately before building its HTTP payload;
  it returns `[owned opaque replacement history, ...trailingMessages]`, including
  a final incomplete user/tool turn for the request being sent, or a portable
  conversion of the supplied DSH messages when no owned artifact is available.
  `replayHistory(...)` remains available for the compaction-side variant, which
  deliberately retains only completed trailing turns. Foreign provider/model
  state, legacy artifacts, endpoint mismatches, and fallback compactions are
  rejected or removed rather than replayed. The Responses compaction path uses
  the completed-turn contract automatically on the next compaction.

### Adapter wiring contract (`responsesCompactionReplay`)

The seam is one method call inside the adapter that serializes an ordinary
Responses request. `tests/protocol-smoke.mjs` pins the whole matrix as
executable assertions; this is the shape an adapter must implement:

```ts
// Inside the Responses adapter fiber:
const replay = ctx.get('responsesCompactionReplay') as
  import('dsh-blackhole').ResponsesCompactionReplay | undefined

// Immediately before building the HTTP payload for a NON-compaction turn:
const input = replay === undefined
  ? dshMessagesToResponseItems(trailing)
  : await replay.prepareInput({
      sessionId,            // agent/session id (the opaque window is keyed by it)
      provider,             // durable route: e.g. 'openai'
      model,                // durable model: e.g. 'gpt-5'
      trailingMessages: trailing, // the DSH Messages being sent this turn
      endpoint,             // optional; pass the base URL if known
    })
// builder.send({ model, input, stream: true, store: false, ... })
```

Contract semantics (all enforced by `RemoteCompactionStateStore`):

- **Owned artifact** (same provider/model/endpoint, versioned `details`):
  returns `[opaque replacement items, ...input items for `trailingMessages`]`,
  keeping a final incomplete user/tool turn (`includePending`) so the request
  being sent is not lost.
- **No state / foreign route / legacy artifact / endpoint mismatch**: returns
  the plain DSH→Responses conversion (fail closed — never a stale opaque
  window). `replayHistory()` returns `undefined` in exactly these cases.
- **Compaction turns**: do not call `prepareInput()` with the compaction
  intent — `RoutingCompactionEngine` already replays the completed-turn
  window internally when it summarizes. The service exists for ordinary
  conversation turns only.
- **Fallback compactions** invalidate the stored window (`state.remove`), so
  a later same-route turn starts from DSH messages and cannot skip the new
  local checkpoint.
- **Pure-text regions** compress less than tool-dense ones (tool results cost
  zero tokens in the compiled view); a region the compiler cannot shrink is
  rejected fail-closed, exactly like the upstream instant engine's shrink
  guarantee.

## Development

```bash
pnpm install
pnpm run typecheck   # tsc --noEmit against the rc.6 packages
pnpm run build       # esbuild → lib/index.js
node tests/smoke-load.mjs      # loader composition mounts the engine
node tests/protocol-smoke.mjs  # conversion/SSE/round-trip vs a local fake endpoint
node tests/hybrid-smoke.mjs    # compiler unit + routing (remote/instant/llm/compat)
node tests/equivalence/build-algal.mjs && node tests/equivalence/differential.mjs
                               # protocol equivalence vs the REAL upstream bundle
node tests/equivalence/build-blackhole.mjs && node tests/equivalence/differential-brief.mjs
                               # CONTENT-level differential vs the REAL pi-blackhole
                               # brief compiler (BRIEF-DIFF.md: 11/12 vectors aligned)
node tests/instant-blackhole-align.mjs
                               # regression suite pinning the aligned brief rules
node tests/equivalence/differential-real-session.mjs
                               # content differential on a REAL recorded pi session
                               # (live transcript, not synthetic vectors)
node tests/equivalence/entity-fidelity.mjs
                               # entity-level retention audit (paths/symbols/errors)
DSH_EVAL_KEY=... DSH_EVAL_BASE=... node tests/equivalence/eval-fidelity-llm.mjs
                               # LLM A/B: answer accuracy with full vs brief context
                               # (see FIDELITY.md; key/base/model/session via env)
```

## Equivalence to the upstream port

`tests/equivalence/` snapshots the upstream source at a pinned commit
(`algal/SOURCE.json`) and bundles it with pi dependencies stubbed (only the
computation helpers are replaced; the protocol code runs unmodified). The
differential test then feeds identical vectors to both implementations:
request body, replacement history (retention, 20K truncation, image
exemption, empty-message filtering), SSE parsing (success + every error
path), message conversion (pi↔DSH semantic projection), identity headers,
and a full local-endpoint round trip. **15/15 vectors pass.**

Differences that remain are platform adaptation, not protocol drift:

- **Eligibility detection**: upstream auto-detects direct OpenAI / Codex
  models from the pi-ai registry (host must be `api.openai.com`); this port
  matches a declared `endpoints` (provider + model glob), so it can also
  target your own gateway. The upstream host gate would reject exactly the
  deployments this plugin is for.
- **Checkpoint text source**: upstream runs a parallel local summary and
  stores the remote artifact as `details.remoteCompaction` (pi has that
  slot); DSH's `summarize()` returns one text, so this port surfaces the
  server-side summary text as the checkpoint and falls back per
  `fallbackMode`. One LLM call at most — and by default, none.
- **Images**: pi carries image bytes (→ `input_image`); DSH only has
  attachment ids, so image visits become explicit placeholder text.
- **Exposed knobs**: `retainedMessageTokenBudget` (upstream's fixed 20K),
  `timeoutMs`, `sendIdentityHeaders`, `installationId` are extra options;
  defaults reproduce upstream behavior exactly.

## License

MIT. Portions derived from
[algal/pi-openai-server-compaction](https://github.com/algal/pi-openai-server-compaction)
(MIT) and the compiler rules of
[`dsh-compaction-instant`](https://github.com/KitDoesIt/dsh-compaction-instant)
(MIT, VCC conversation-compiler port) — see LICENSE.
