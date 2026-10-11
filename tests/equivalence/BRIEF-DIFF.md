# Content-level differential: pi-blackhole brief vs this package's instant compiler

Pinned upstream: `k0valik/pi-blackhole@49ab560156fd53b6da1b568d5ade10287b89026c`
(sources vendored under `blackhole-brief/`, bundled by `build-blackhole.mjs`).

`differential-brief.mjs` feeds identical conversation vectors to the real
pi-blackhole compiler (`normalize` + `compileBrief`) and to this package's
`compileInstantRegion`/`joinInstantEntries` (default options), then prints
both checkpoints side by side. This is a **content-level** differential —
protocol shape equivalence is covered separately by `differential.mjs`.

## Status: aligned (2026-08-15, vectors V1–V12; V8 deliberately diverged 2026-10-11)

10 of 12 vectors now produce equivalent non-whitespace output. The remaining
divergences are deliberate design choices (see below).

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
| V10 | image label keeps mime type: `[image: image/png]` |
| V11 | `<skill name="X">…</skill>` → `[skill: X]` |
| V12 | mixed session: full row-for-row equivalence including the `[tool_error]` segment interrupt |

### Remaining divergence (intentional)
| Vector | pi-blackhole | dsh instant | Rationale |
|---|---|---|---|
| V8 | per-SECTION tool cap (8): tool results never break a section, so one agentic chain is one section and the cap chops most of it, `* (N earlier tool-call entries omitted)` without a pointer | per-MESSAGE cap (8): a turn is one assistant message (entries sharing one seq); the note carries `: seq N` | Real-session profile (285 messages): the section cap dropped 37/152 call rows (24%), all pointer-invisible, while no single assistant message exceeded 4 calls. Per-message keeps the chain visible at ~15% more checkpoint tokens and the note keeps dropped calls `#N`-navigable |
| V9 | empty user message dropped silently | `* [user message elided: noise-only] (seq N)` note | explicit elision marker keeps the loss visible and recallable; also `(...truncated from seq N)` keeps the truncation point instead of blackhole's bare `...(truncated)` |
| — (no upstream vector) | assistant text truncates head-only, `...(truncated)` | assistant text truncates DUAL-WINDOW: head ⅔ + tail ⅓ of the block budget around an `...(elided from seq N)...` mid marker (`truncateTextTokens`); user text and tool one-liners stay head-only | coding-agent conclusions sit at the END of assistant messages; head-only cut them off (real-session profile: 6/55 blocks, ~6.5K tokenizer tokens of tails dropped). User text keeps head-only (0/9 over budget in the profile; keeps V1 aligned) |
| — (no upstream vector) | identical one-liners merge only when ADJACENT; merged refs drop `-> result` pointers | repeats merge CHECKPOINT-WIDE into their LAST occurrence (last-wins; runs before the per-message cap so only distinct rows count against it); refs keep EVERY member call seq, and result pointers survive for the last member plus any failed result; segment headers left headless by drops are re-attached to the next surviving entry | real session: 26 of 33 repeated rows were cross-segment, so adjacency catches almost nothing there; global last-wins leaves 0 blind tool results on the profiled session (137 directly pointed + 15 superseded duplicates reachable via their surviving call rows) |

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