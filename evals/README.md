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

`baselines/<pass>.json` is created by `--save-baseline` and should be
committed (none is recorded yet, so no run gates on regressions until one is).
A run without `--save-baseline` compares
against it and exits 1 if any metric drops by more than 0.03 (or rises, for
lower-is-better metrics such as `stage_mae`). Re-record the baseline only after
deliberately accepting a change. Bump the matching contract version in
`contracts/` whenever you change a prompt.

## Golden sets

`golden/*.jsonl` — one case per line; `//` lines are comments. Every case
carries `label_status`: `proposed` (drafted, unreviewed), `claude-reviewed`
(checked against the grader rubric and its calibration examples by Claude —
useful, but not an independent human judgment), or `reviewed` (a human
checked it). Relabelled cases carry a `review_note` saying what changed and
why. A human pass that promotes cases to `reviewed` is still the gold
standard.
The grader set covers each stage plus traps: verbatim restatement, vague
recognition, confident misconceptions, and answers that are correct in general
but go beyond the provided source.

Grow the sets from real usage: concepts and answers from your own library are
far better test cases than synthetic ones.

## Retrieval (RAG PR 1)

`evals/retrieval.mjs` measures chunk retrieval: keyword (SQLite FTS5 BM25),
vector (local embeddings) and hybrid (Reciprocal Rank Fusion). No LLM is
called. It is not part of CI: it needs the pinned textbook and, for the
vector modes, a local OpenAI-compatible embedding server.

```sh
ollama pull nomic-embed-text
pnpm eval:retrieval -- --pdf /path/to/b36-txtbook.pdf
pnpm eval:retrieval -- --pdf /path/to/b36-txtbook.pdf --keyword-only   # no embedding server
pnpm eval:retrieval -- --pdf /path/to/b36-txtbook.pdf --review         # local labelling sheet
pnpm eval:retrieval -- --pdf /path/to/b36-txtbook.pdf --save-baseline
```

Env: `RETRIEVAL_EVAL_PDF` (instead of `--pdf`), `EVAL_BASE_URL` (default
`http://127.0.0.1:11434/v1`), `EVAL_EMBED_MODEL` (default `nomic-embed-text`).

- **Dataset**: `golden/retrieval.jsonl`, 30 questions across seven categories
  (`exact_term`, `conceptual`, `multi_passage`, `equation`, `ambiguous`,
  `no_answer`, `false_premise`). `golden/retrieval.meta.json` pins the document
  by sha256; the runner refuses to score any other file. Each relevant passage
  is `{ key, page, anchor }`: the chunk key, plus page + a 60-character anchor so
  a label can be re-resolved after a chunker change (anything that no longer
  resolves is reported as "relabel needed"). The repo is public, so labels hold
  keys and anchors only, never chunk text.
- **Label status**: every case is currently `proposed`. Claude drafted the
  questions and picked relevant chunks by reading the chunk text, which it
  found partly by keyword search. That biases the labels toward passages that
  share words with the question, which in turn favours keyword retrieval.
  Treat all numbers as provisional until a human reviews them.
- **Reviewing**: `--review` writes `results/<stamp>-retrieval-review.md`
  (gitignored, because it contains book text). For each question it pools the
  top 10 from every mode and marks the currently labelled chunks (★). Tick
  every chunk that helps answer the question (or refutes a false premise), copy
  the keys, pages and anchors into `relevant`, and set `label_status` to
  `reviewed`. Pooling across all three modes is what corrects the
  keyword-search bias above.
- **Metrics** (`scoreRetrieval` in `packages/services/src/evals/metrics.ts`):
  Precision@K, Recall@K, MRR@K and coverage (at least one relevant chunk in the
  top K), at K = 5 and 10, overall and per category, over answerable
  questions. `no_answer` cases have no relevant set, so they are reported only
  through their mean top-1 cosine (vector mode). That is an abstention signal
  for later, not a threshold.
- **Cache**: chunk vectors are cached in `evals/.cache/` (gitignored), so
  re-runs embed nothing unless the chunker output changes.
- **Baseline**: `baselines/retrieval.json` records the configuration (document
  hash, chunker version, model, RRF k, pool) and the label status it was
  measured with. A drop of more than 0.03 in any metric fails the run.

### Provisional baseline: limitations

`baselines/retrieval.json` (2026-11-23) is a starting point to measure
changes against. It is not a quality claim:

- All 30 labels are `proposed` (Claude-drafted) and have not been reviewed by
  a human. The labels will stay `proposed` until the maintainer reviews the
  dataset.
- The labels are biased toward keyword matches (see "Label status" above).
- There are only 27 answerable questions from one textbook, with one embedding
  model (`nomic-embed-text`) and one chunker configuration.
- Hybrid led keyword on MRR@5 with 6 wins, 1 loss and 20 ties per question.
  A sign test gives p ≈ 0.125, which is not significant.
- Re-record the baseline (`--save-baseline`) after the human review, and
  report the comparison against this one.

## Ask answers

`evals/ask.mjs` runs the 30 retrieval golden questions through the real
`askSources` pipeline (hybrid retrieval → local model → citation
verification) and scores the answers. No LLM judge: every metric is
something the pipeline can check deterministically. Not part of CI. It needs
the pinned textbook, the embedding server and a local chat model.

```sh
pnpm eval:ask -- --pdf /path/to/b36-txtbook.pdf --model qwen3.5:4b
pnpm eval:ask -- --pdf /path/to/b36-txtbook.pdf --model qwen3.5:4b --limit 5   # smoke run, never gated
pnpm eval:ask -- --pdf /path/to/b36-txtbook.pdf --model qwen3.5:4b --save-baseline
```

Env: `EVAL_ASK_MODEL` (instead of `--model`), plus the retrieval eval's
`RETRIEVAL_EVAL_PDF`, `EVAL_BASE_URL` and `EVAL_EMBED_MODEL`. The runner
refuses to score if retrieval falls back to keyword-only, since that is not
what the app runs.

- **Metrics** (`scoreAsk` in `packages/services/src/evals/metrics.ts`):
  - answerable questions: share `grounded`, `supported` (grounded or partial),
    `declined` (insufficient / no_passages), `unsupported` and `failed`
    (model error → retrieval only);
  - unanswerable questions: correct abstention rate (declined);
  - citation precision: share of verified citations that point at a labelled
    relevant chunk, plus the share of supported answers citing at least one;
  - dropped-citation rate (quotes that failed verification);
  - latency p50 / p95 (reported, not gated: it depends on the machine).
- **Diagnostic**: answerable questions declined although a relevant passage
  was in the prompt are listed by id. That separates generation misses from
  retrieval misses.
- **Baseline**: `baselines/ask.json` (metrics only; the per-run results file
  contains answer text and stays in the gitignored `results/`). Local answers
  vary from run to run even at temperature 0, so the regression tolerance is
  0.075 (two questions out of 27), not the 0.03 the other evals use.
- **Statuses**: `qualified` (the model flagged the passages as insufficient
  but still gave a hedged answer with at least one verified citation) counts as
  supported, not declined. Before it existed, the false-premise questions were
  all scored as declines although the model cited the refuting passage.
- **Experiments recorded here so they are not re-run blindly**:
  - *Neighbor expansion* (`--neighbors`; off in the app): top 4 hits plus the
    in-section follower of the top 2, at the same 6-passage budget. Retrieval
    recall within the passages sent rose from 0.715 to 0.756 (multi-passage
    0.604 to 0.750). End to end it raised citation precision (0.522 to 0.556)
    and lowered dropped citations (0.140 to 0.096), but two false-premise
    questions went back to plain declines (supported 0.962 to 0.885). Per-section
    caps and skipping adjacent chunks lowered recall.
  - *Pre-model abstention*: top-1 vector similarity does not separate the 3
    unanswerable questions (0.604, 0.681, 0.708) from answerable ones (as low
    as 0.629), and the model already declines all 3 itself. Not shipped;
    revisit with more unanswerable questions in the golden set.
- **Caveats**: the same `proposed` labels as the retrieval eval, so citation
  precision inherits their keyword bias. Six labels currently do not resolve
  after the running-header layout fix (they need relabelling), which lowers
  citation precision for those questions. Only 3 unanswerable questions, so
  abstention is a coarse signal.
