# Content-loss audit (real session) and impact on answer accuracy

Measured on a real pi session transcript (285 messages / 1.45MB JSONL; see
the default path in `differential-real-session.mjs`, override with
`DSH_EVAL_SESSION`): how much information compaction retains, and what it
costs a model asked to answer from the brief instead of the full context.

## 1. Compression ratio and what "loss" consists of

| Input part | chars | share | after compaction |
|---|---|---|---|
| tool results + tool args | 659,014 | 72.0% | **dropped**, only `* tool "arg" (seq N)` pointers remain |
| thinking (reasoning) | 232,904 | 25.4% | **dropped** (by design; pi-blackhole drops it too) |
| assistant text | 23,216 | 2.5% | ~93.5% kept, tail truncated |
| user text | 179 | 0.02% | fully kept |
| total | 915,313 | | output 21.9K (blackhole) / 24.2K (this port) |

Ratio ≈ **1:40**. 97% of the "loss" is tool results and thinking, which by
design never enter the brief; the conversation itself (user+assistant) is
kept almost verbatim (blackhole 93.5% / this port 103.2%).

## 2. Entity-level fidelity (hard facts: paths/filenames/symbols/URLs)

| Source | entities | blackhole kept | this port kept |
|---|---|---|---|
| user text | 0 ¹ | n/a | n/a |
| assistant text | 90 | 36 (40%) | 37 (41%) |
| tool results/args | 2,224 | 101 (5%) | 104 (5%) |
| tool error text | 55 | 11 (20%) | 11 (20%) |
| error first lines (18 real errors) | 18 | **all kept** | **all kept** |

¹ The audited session's user messages are short Chinese questions with no
path-like entities.

Reading:
- ~60% of assistant-text entities are lost — concentrated in the text tail
  beyond the 512-token cut;
- 95% of tool-result entities are lost, but tool **arguments** (paths/
  patterns) survive, so details are recoverable by re-running the tool;
- every error first line is kept (the 150-char policy works).

## 3. LLM A/B probe (5 factual questions, deepseek-v4-flash-free)

Group A = the full message window containing the answer; Group B = the
compaction brief of the whole session (24.2K chars). Instructions: answer
only from the given content; say "not in the brief" when absent.

| # | fact source | expected | A (full) | B (brief) | verdict |
|---|---|---|---|---|---|
| 1 | assistant text | v0.4.5 | v0.4.5 ✓ | v0.4.5 ✓ | lossless |
| 2 | tool error first line | D:\tmp\...\index.js | ✓ exact | ✓ exact | lossless |
| 3 | inside thinking ⚠ | textTokens=512 | 512 ✓ (read from reasoning) | "not in the brief" | reasoning dropped; refused, no hallucination |
| 4 | assistant text | \<compacted-summary\> | ✓ | ✓ exact | lossless |
| 5 | tool result only (dir listing) | 7 filenames | ✓ 7/7 | inferred 3/7 (index.js, compiler.js, region.js from later args), notes the ls output was cut | details degrade; direction & honesty hold |

Conclusion:
- **Established facts in the conversation (assistant text, error first
  lines): answer accuracy is unchanged after compaction (3/3 lossless)**;
- **Reasoning-sourced facts**: dropped by design; the model refuses instead
  of fabricating — no wrong answers, only "unknown";
- **Tool-result details**: precision degrades (Q5: 3/7 via pointers + later
  args), but the model never hallucinates the rest, and the kept `(seq N)`
  pointers + arguments make the details re-fetchable (tools can be re-run).

## 4. Verdict: three layers of accuracy impact

1. **No impact** (conclusions, error diagnosis, completed work): compaction
   is near-lossless; answer accuracy holds.
2. **Recoverable degradation** (tool details): answers become vaguer, but
   via `(seq N)` pointers and kept arguments the model can re-run the tool
   and recover ground truth; end-to-end agentic progress is unaffected.
3. **Structural omission** (reasoning): the model refuses, never asserts
   false facts; enable `includeReasoning` if reasoning review is required.

## Reproduce

```bash
node tests/equivalence/entity-fidelity.mjs          # entity-level retention
DSH_EVAL_KEY=... DSH_EVAL_BASE=... node tests/equivalence/eval-fidelity-llm.mjs [q1..q5]
                               # LLM A/B (OpenAI-compatible endpoint via env;
                               # default model deepseek-v4-flash-free)
```