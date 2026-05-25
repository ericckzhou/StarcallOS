# StarcallOS

Source-grounded learning system for extracting concepts, tracking misconceptions, and building durable understanding from any technical or academic source — textbooks, papers, lecture notes, legal opinions, clinical guidelines, business strategy, language grammars, anything you actually need to learn.

![demo](docs/demo.gif)

```
Upload a source (PDF or text)
  → extract concepts deterministically
  → promote what matters
  → challenge yourself
  → track misconceptions
  → build long-term understanding
```

## Why This Exists

Most learning tools optimize for:

- summaries
- highlights
- passive consumption

StarcallOS optimizes for:

- **retrieval** — pull the idea out of your own head, not the page
- **explanation** — say it in your own words, get graded
- **misconception tracking** — the gap between what you think and what the source says
- **source-grounded enrichment** — definitions stay anchored to the book you actually read

## Show the Product

### Concept Extraction

![concepts](docs/screens/concepts.png)

Deterministic geometry parser pulls candidates straight out of headings, definitions, and recurring terms — works on:

- textbooks
- research papers
- lecture transcripts
- legal opinions and statutes
- clinical guidelines
- internal docs and runbooks
- any structured PDF or text source

Zero LLM cost during ingestion. You only spend tokens on the concepts *you* choose to study.

### Source-Grounded Enrichment

![enrichment](docs/screens/enrichment.png)

The enricher reads the source title, section path, and verbatim evidence quotes before answering. Ambiguous names get disambiguated by context, not by the model's default associations.

> "RAG" inside an AI engineering book →
> **Retrieval-Augmented Generation**
>
> NOT → Red-Amber-Green project status

> "Mole" inside a chemistry textbook →
> **unit of substance (6.022 × 10²³ entities)**
>
> NOT → small mammal, skin lesion, or spy

> "Force" inside a physics textbook →
> **vector quantity F = ma**
>
> NOT → workforce or military

### Challenge Mode

![challenge](docs/screens/challenge.png)

Five evidence kinds per concept, each with a strict contract:

- **definition** — state what it is
- **connection** — relate it to a pre-requisite or sibling idea
- **application** — use it on a concrete scenario
- **misconception_resistance** — spot and correct a plausible-but-wrong claim
- **compression** — explain it without naming it

Submit your answer, get graded, and watch your compression stage move from *Memorized* → *Connected* → *Predicts Failures*.

## Architecture / Pipeline

```
PDF or text source
       ↓
structural parsing      (font, position, headings, footers stripped)
       ↓
candidate extraction    (deterministic — zero LLM)
       ↓
human promotion         (you pick what's worth studying)
       ↓
source-grounded enrichment   (1 LLM call per concept, lazy)
       ↓
challenge tasks         (1 LLM call per concept, lazy)
       ↓
graded evidence records (per attempt, append-only)
       ↓
compression-stage mastery
```

## Technical Features

- structural PDF parsing with heading detection by font / position / boldness
- TOC, header/footer, page-number, and index stripping
- broken-heading merging across line breaks
- normalized concept candidates (acronym ↔ expansion, conservative stemming)
- weighted `concept_score` with deterministic reject-reason chips
- local-first SQLite storage (`node:sqlite`, no native deps)
- source-aware LLM enrichment with verbatim evidence anchoring
- misconception capture, surfacing, and decay
- compression-stage mastery model (0 → 5)
- append-only event log for auditability
- pluggable LLM providers (Groq, Anthropic) with per-pass model selection

## Quickstart

```sh
git clone https://github.com/yourname/StarcallOS
cd StarcallOS
pnpm install
pnpm -C packages/shared build
pnpm -C packages/services build
pnpm -C apps/desktop dev
```

Add an LLM API key in **Settings** (or skip — deterministic extraction works with zero keys configured), drop a PDF onto the sources list, and start promoting candidates.

## Philosophy

- **Understanding is observable.** If you can't explain it without the page in front of you, you don't know it yet.
- **Source-grounded over plausible.** A confident wrong answer is worse than "I don't know."
- **Retrieval over recognition.** Highlighting is not learning.
- **Misconceptions are first-class data.** What you almost-believed is more valuable than what you correctly recalled.
- **AI augments reasoning, it does not replace it.** The LLM grades your explanation; it doesn't pretend you wrote it.

## Future Direction

- spaced-repetition scheduler driven by compression-stage decay
- cross-source concept linking and dependency graphs
- shared concept libraries (export / import)
- mobile reading companion

## Stack

- **Electron** desktop shell
- **TypeScript** + **React** renderer
- **Node.js** service layer
- **node:sqlite** local storage
- **Groq** and **Anthropic** LLM providers (configurable per pass)

## Contributing

- Architecture and contributor notes: [AGENTS.md](AGENTS.md)
- Historical design context: [PLAN.md](PLAN.md) (not the current source of truth)

```sh
pnpm test
pnpm typecheck
pnpm build
```
