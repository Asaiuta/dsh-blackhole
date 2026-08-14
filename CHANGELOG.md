# Changelog

## 0.1.0 (2026-08-15)

- Initial release: Responses-assisted compaction backend for DSH.
- `ResponsesCompactionEngine extends BasicCompactionEngine` — inherits the
  official pressure/retention/replay machinery and token-meter pricing,
  overrides the single `summarize()` hook.
- Responses compaction v2 (`compaction_trigger`) against configurable
  endpoints (direct OpenAI / compatible gateways / Codex backend).
- Readable checkpoint text extracted from the compaction response; opaque
  replacement history persisted per session under
  `$DSH_HOME/plugins/dsh-compaction-responses/state`.
- Graceful fallback to the inherited native LLM summarizer on any failure
  (configurable via `fallbackToLlm`).
- Bundle patch: disables the official `compaction-basic` row, re-enables
  `command-compact`, inserts the engine — exactly one `compaction` service.
- Port of algal/pi-openai-server-compaction (MIT); attribution in LICENSE.