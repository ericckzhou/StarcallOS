# LLM evals

Offline checks for the LLM passes. Each run makes live calls to the configured
LLM provider, so it is **not** part of `pnpm test` or CI.

```sh
GROQ_API_KEY=... pnpm eval                       # all passes, Groq heavy model
EVAL_PROVIDER=anthropic ANTHROPIC_API_KEY=... pnpm eval -- --pass grader
pnpm eval -- --pass grader --limit 5             # smoke run
EVAL_PROVIDER=local pnpm eval -- --model qwen2.5:7b   # local server (EVAL_BASE_URL)
pnpm eval -- --pass grader --save-baseline       # record the current numbers
```

Keys are read from the environment only, never from the app's `settings.json`.

## What is measured

| Pass | Metrics |
|---|---|
| `grader` | score accuracy, stage exact / within ±1 / MAE, score confusion matrix, unsupported-claim precision & recall (cases with `expects_unsupported`) |
| `lazy_tasks` | near-duplicate rate between tasks (token Jaccard ≥ 0.7), coverage of `expected_kinds`, failures |
| `topic_filter` | keep precision / recall / F1 / accuracy against term labels |

Metric code is pure TS in `packages/services/src/evals/metrics.ts` (unit-tested).

## Baselines and regressions

`baselines/<pass>.json` is committed. A run without `--save-baseline` compares
against it and exits 1 if any metric drops by more than 0.03 (or rises, for
lower-is-better metrics such as `stage_mae`). Re-record the baseline only after
deliberately accepting a change. Bump the matching contract version in
`contracts/` whenever you change a prompt.

## Golden sets

`golden/*.jsonl` — one case per line; `//` lines are comments. Every case
carries `label_status`. **`proposed` labels were drafted, not reviewed** — review
and relabel them (set `"label_status":"reviewed"`) before trusting the numbers.
The grader set covers each stage plus traps: verbatim restatement, vague
recognition, confident misconceptions, and answers that are correct in general
but go beyond the provided source.

Grow the sets from real usage: concepts and answers from your own library are
far better test cases than synthetic ones.
