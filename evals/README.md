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
| `lazy_tasks` | near-duplicate rate between tasks (token Jaccard ≥ 0.7), coverage of `expected_kinds`, lexical gap targeting (adaptive cases), failures; with `--judge`, LLM-judge metrics (below) |
| `topic_filter` | keep precision / recall / F1 / accuracy against term labels |

Metric code is pure TS in `packages/services/src/evals/metrics.ts` (unit-tested).

### LLM judge for tasks (`--judge`)

```sh
EVAL_PROVIDER=anthropic ANTHROPIC_API_KEY=... pnpm eval -- --pass lazy_tasks --judge --judge-model <model>
```

A second call per case (`judgeTaskSet`, `packages/services/src/evals/task_judge.ts`)
rates the generated set. Per task it says whether the task is answerable from
the concept, tests understanding rather than recall, and targets a recorded
learner gap (paraphrases count, which the lexical `gap_targeting` proxy misses).
It also rates the whole set 1 to 5. Metrics: `judge_quality` ((q−1)/4),
`judge_answerable`, `judge_understanding`, `judge_gap_targeting`,
`judge_failed`. The judge model defaults to the eval model (`--judge-model` or
`EVAL_JUDGE_MODEL` overrides). Judge metrics are compared with a baseline only
when it was recorded with the same judge model.

The judge is a model too. On 2026-11-26 `qwen3.5:4b` judging its own sets
marked the consistent-hashing adaptive set as missing both gaps although task 2
(virtual nodes) and task 3 (hot key) target them exactly. Use a stronger judge
than the generator, treat judge numbers as a second opinion, and keep the
deterministic metrics as the regression gate. No judge baseline is recorded yet.

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
carries `label_status`: `proposed` (drafted, unreviewed), `independent-reviewed`
(relabelled by a second, independent model pass over the pooled passages; not a
human audit), `claude-reviewed`
(checked against the grader rubric and its calibration examples by Claude —
useful, but not an independent human judgment), or `reviewed` (a human
checked it). Relabelled cases carry a `review_note` saying what changed and
why. All four golden sets were promoted to `reviewed` on 2026-11-26 on the
project owner's sign-off.
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
- **Label status**: every case is `reviewed` (2026-11-26). Claude drafted
  the questions and first labels by reading chunk text it found partly by
  keyword search, which biased them toward keyword retrieval. All 30 were then
  relabelled from the pooled review sheet (top 10 of every mode) by an
  independent model pass: 21 cases changed, including the 6 that no longer
  resolved after the running-header fix; each case's `review_note` says what
  changed. The project owner then signed the set off as `reviewed`.
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

### Baseline: limitations

`baselines/retrieval.json` (re-recorded 2026-11-26 on the
labels now marked `reviewed`, layout 0.5.3) is a starting point to measure
changes against. It is not a quality claim:

- The labels were relabelled by an independent model pass and then signed
  off (see "Label status" above); they are still a single 30-question set.
- There are only 27 answerable questions from one textbook, with one embedding
  model (`nomic-embed-text`) and one chunker configuration.
- Hybrid MRR@5 0.797 vs keyword 0.731 and vector 0.719; hybrid has a relevant
  passage in the top 5 for every answerable question (coverage 1.000). Per
  question, hybrid beat keyword on MRR@5 8 times, lost once, tied 18 times:
  sign test p ≈ 0.039. On the earlier Claude-drafted labels it was 6/1/20,
  p ≈ 0.125, consistent with those labels favouring keyword matches.
- Re-record the baseline after a human review.

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
    in-section follower of the top 2, at the same 6-passage budget. Re-checked
    on the relabelled set: recall within the passages sent
    0.759 to 0.794 (multi-passage 0.762 to 0.825) but conceptual fell 0.819 to
    0.778; end to end citation precision 0.673 to 0.702 and dropped citations
    0.140 to 0.096, but two false-premise questions became plain declines
    (supported 0.963 to 0.889). Still off. Per-section caps and skipping
    adjacent chunks lowered recall on both label sets.
  - *Pre-model abstention*: top-1 vector similarity does not separate the 3
    unanswerable questions (0.604, 0.681, 0.708) from answerable ones (as low
    as 0.629), and the model already declines all 3 itself. Not shipped;
    revisit with more unanswerable questions in the golden set.
- **Caveats**: the same labels as the retrieval eval. Only 3 unanswerable questions, so
  abstention is a coarse signal.

## Comparing PDF parsers (Docling)

Both the retrieval and the Ask eval take `--parser docling`, which segments the
pinned textbook through a local `docling-serve` (`EVAL_DOCLING_URL`, default
`http://127.0.0.1:5001`) instead of the built-in parser. The converted JSON is
cached in `.cache/docling-<sha>.json` and the chunks go to a separate cache DB.
A Docling run is never compared with, or saved as, the built-in baseline.

The golden labels are built-in chunk keys, so for Docling they are mapped
mechanically: the labelled passage's text (from the built-in chunking) is
matched to Docling chunks within 2 pages that are mostly made of that passage
(at least 70% of the chunk's content words occur in it) and cover a real part
of it (at least 20%). It is a lookup of the same passage, not a new relevance
judgment, but it does change the relevant sets (2.65 chunks per question vs
1.96), so compare MRR and coverage rather than recall.

Measured 2026-11-26 on b36 (docling 2.153.0, CPU, 164 s for 275 pages;
`nomic-embed-text`, `qwen3.5:4b`; relabelled set):

| | built-in | Docling |
|---|---|---|
| chunks | 657 | 832 |
| hybrid MRR@5 / Cov@5 / Cov@10 | 0.797 / 1.000 / 1.000 | 0.651 / 0.889 / 1.000 |
| Ask: grounded / supported | 0.704 / 0.963 | 0.778 / 0.963 |
| Ask: grounded on equation questions | 0.40 | 0.80 |
| Ask: dropped citations | 0.140 | 0.055 |
| Ask: citation precision (mapped labels for Docling) | 0.673 | 0.635 |
| candidates: total / strong (score >= 0.5) | 295 / 38 | 356 / 112 |

Built-in retrieval ranks the labelled passages higher (part of the gap may be
the mechanical label mapping, 5 labels of which do not map); Docling answers
cite formulas far more reliably and its candidate list loses the
table-of-contents noise. Docling stays opt-in. (On the earlier Claude-drafted
labels retrieval looked level: MRR@5 0.617 vs 0.596.)
