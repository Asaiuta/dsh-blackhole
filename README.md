# dsh-compaction-responses

Codex-style **remote compaction** for DeepSeek Harness (DSH).

A drop-in replacement for the official `@deepseek-ai/dsh-compaction-basic` backend
that, when the routed provider has a configured Responses endpoint, delegates
the summarization to the **model server** via the Responses API
`compaction_trigger` (the same protocol Codex's remote compaction uses), and
persists the opaque replacement history per session. Any failure — no
endpoint, missing key, timeout, protocol error — **falls back to the native
one-shot LLM summarizer**, so a broken gateway never breaks compaction.

Port of [`algal/pi-openai-server-compaction`](https://github.com/algal/pi-openai-server-compaction)
(MIT) from the pi ecosystem to the DSH compaction seam.

## Why

| | pi | DSH (this plugin) |
|---|---|---|
| Remote compaction v2 | via algal/kky42/lll9p extensions | **this backend** |
| Compaction seam | extension event hooks | `CompactionEngine.summarize()` — the official single customization hook |
| Fallback | local summary | inherited native summarizer (`ctx.llm.stream()`) |
| Opaque window persistence | pi session JSONL `compaction.details.remoteCompaction` | per-session JSON state under `$DSH_HOME/plugins/dsh-compaction-responses/state` |

## How it works

1. DSH decides to compact (pressure / overflow / `/compact`) and calls the
   engine's `summarize()` hook with the replayed conversation region.
2. If the routed provider/model matches a configured `endpoints` entry, the
   region is converted into Responses input items (text, reasoning, tool
   calls/results), a `compaction_trigger` is appended, and the compaction
   response streams from `{baseUrl}/responses`.
3. The assistant-authored summary text from that response becomes the readable
   checkpoint DSH lands in the session log (so the session stays portable,
   forkable, and readable by any consumer).
4. The opaque `compaction` item plus the retained tail of user messages
   (Codex-style 20K token budget) is persisted per session for later
   provider-native replay.
5. Any failure logs a warning and inherits the native LLM summarizer.

The engine subclasses the official `BasicCompactionEngine`, so all pressure /
retention / policy knobs, the token-meter pricing, and the context-overflow
recovery behave exactly as upstream.

## Install

Requires DSH `0.1.0-rc.6` (web or headless profile).

```bash
# into the profile that serves your sessions
dsh plugin --profile web add dsh-compaction-responses
# or from a local tarball:
npm pack dsh-compaction-responses && dsh plugin --profile web add ./dsh-compaction-responses-0.1.0.tgz
```

The bundle patch:

- disables the official `compaction-basic` row (already disabled by the
  web-app bundle — idempotent),
- re-enables `command-compact` (the `/compact` command, which the web-app
  bundle disables; it is backend-independent),
- inserts this engine under its own row.

Exactly one `compaction` service ends up mounted.

## Configure

In the profile's settings (or `~/.dsh/settings.yaml` under the plugin key):

```yaml
dsh-compaction-responses:
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
      baseUrl: https://cdn.asaiuta.me/v1
      apiKeyEnv: MY_GATEWAY_KEY
    # official Codex backend (needs the beta-feature header)
    - provider: openai-codex
      baseUrl: https://chatgpt.com/backend-api
      apiKeyEnv: CODEX_TOKEN
      headers:
        OpenAI-Beta: responses=experimental
        x-codex-beta-features: remote_compaction_v2
  timeoutMs: 120000      # abort the remote attempt after 2 min
  fallbackToLlm: true    # false: fail loud instead of switching engines
  retainedMessageTokenBudget: 20000
  persistRemoteHistory: true
  stateDir: ~/.dsh/plugins/dsh-compaction-responses/state
```

Endpoint matching: `provider` matches the DSH provider route the latest request
ran on (exact, or `*` for any); `model` matches exact id or a `*` glob.
Authorization uses `apiKeyEnv` (env var name) or `apiKey` (inline — never
commit a real key).

## Behavior notes

- **Images**: DSH stores image bytes in the attachment store, which a remote
  compaction call cannot resolve; image blocks are carried as an explicit
  "image content omitted" text visit instead of being silently dropped.
- **Deployments with agent presets**: presets mount their own compaction realm.
  If a preset also compacts, either disable `auto` on one side or drop the
  preset's compaction rows — two engines must not compact the same session.
- **The persisted opaque window is a bridge, not a replay injector (yet)**:
  DSH's replay is log-driven; wiring the artifact back into future
  Responses requests (phase 2) needs a provider-request hook that DSH does not
  expose today.

## Development

```bash
pnpm install
pnpm run typecheck   # tsc --noEmit against the rc.6 packages
pnpm run build       # esbuild → lib/index.js
node tests/smoke-load.mjs      # loader composition mounts the engine
node tests/protocol-smoke.mjs  # conversion/SSE/round-trip vs a local fake endpoint
```

## License

MIT. Portions derived from
[algal/pi-openai-server-compaction](https://github.com/algal/pi-openai-server-compaction)
(MIT) — see LICENSE.
