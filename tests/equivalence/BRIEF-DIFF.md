# Content-level differential: pi-blackhole brief vs this package's instant compiler

Pinned upstream: `k0valik/pi-blackhole@49ab560156fd53b6da1b568d5ade10287b89026c`
(sources vendored under `blackhole-brief/`, bundled by `build-blackhole.mjs`).

`differential-brief.mjs` feeds identical conversation vectors to the real
pi-blackhole compiler (`normalize` + `compileBrief`) and to this package's
`compileInstantRegion`/`joinInstantEntries` (default options), then prints
both checkpoints side by side. This is a **content-level** differential —
protocol shape equivalence is covered separately by `differential.mjs`.

## Status: aligned (2026-08-15, vectors V1–V12)

11 of 12 vectors now produce equivalent non-whitespace output. The remaining
divergence is a deliberate design choice (see below).

### Aligned behaviors ✅
| Vector | Behavior |
|---|---|
| V1 | user text truncation budgets (word-based vs token estimate; similar effective length) |
| V2 | self-talk filler stripped from assistant text (`hmm/wait/actually/…`, ≤2 passes) |
| V3 | bash compressed (cd-strip, pipe-tail strip, 120-char cap) |
| V4 | capitalized `Read`/`Edit`/`Write` + generic path-key fallback keep the target path |
| V5 | failed tool results kept as `[tool_error] name (#N/seq N)` + first line (150 chars) |
| V6 | `thinking` blocks elided by both |
| V7 | identical tool one-liners merged: `* Grep "surrogate" (seq 0, seq 0, seq 0) x3` |
| V8 | per-turn tool cap (8), tail wins, `* (N earlier tool-call entries omitted)` note |
| V10 | image label keeps mime type: `[image: image/png]` |
| V11 | `<skill name="X">…</skill>` → `[skill: X]` |
| V12 | mixed session: full row-for-row equivalence including the `[tool_error]` segment interrupt |

### Remaining divergence (intentional)
| Vector | pi-blackhole | dsh instant | Rationale |
|---|---|---|---|
| V9 | empty user message dropped silently | `* [user message elided: noise-only] (seq N)` note | explicit elision marker keeps the loss visible and recallable; also `(...truncated from seq N)` keeps the truncation point instead of blackhole's bare `...(truncated)` |

### Reference conventions (both use the same semantics, different index spaces)
- `(#N)` = pi conversation message index vs `(seq N)` = durable DSH event seq;
  the instant compiler additionally emits `-> result M` pointers, which
  blackhole lacks.

## New config knobs added for the alignment

`toolErrorChars` (default 150, 0 disables), `bashCap` (default 120, 0
disables), `collapseSkills` (default true), `stripSelfTalk` (default true),
`mergeToolLines` (default true), `toolsPerTurn` (default 8, 0 disables) —
all validated in `CompactionResponsesConfigSchema` and threaded through
`RoutingCompactionEngine`. Setting any to their old behavior is possible:
e.g. `{ toolErrorChars: 0, bashCap: 0, collapseSkills: false, stripSelfTalk: false, mergeToolLines: false, toolsPerTurn: 0 }`
reproduces the pre-alignment compiler.

## How to run

```bash
node tests/equivalence/build-blackhole.mjs   # rebuild vendored bundle
node tests/equivalence/differential-brief.mjs
node tests/instant-blackhole-align.mjs       # pinned regression suite for the alignment
```