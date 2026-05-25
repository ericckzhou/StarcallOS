# StarcallOS

> **Claims of understanding need evidence.**

You read a chapter, highlight a few sentences, and tell yourself you got it. A week later, you can't explain it. A month later, you can't tell which parts you remember and which you confused with something else.

StarcallOS closes that gap. You read your sources, but you only get to claim you understand a concept once you've **explained it in your own words and survived a grader**. Every attempt is stored, replayable, and tied back to the page that taught you — so the system can always answer *why does it think you understand this?*

It works on any subject: textbooks, papers, lecture notes, legal opinions, clinical guidelines, language grammars, internal docs.

![demo](docs/demo.gif)

---

## Every screen answers one of three questions

Borrowed verbatim from the philosophy in [plan.md](PLAN.md) — these are the only questions the app cares about, and every surface earns its space by answering at least one:

| Question | Where you answer it |
|---|---|
| **What do I claim to understand?** | Concept list · Overview · Mastery stage badges |
| **What evidence supports that claim?** | Challenge Me · Source preview · History · Your notes |
| **What should I study or test next?** | Review queue · `never reviewed` / `recognizes` chips · stage progression |

If a screen doesn't answer one of those, it doesn't ship. No second-brain, no infinite-graph explorer, no LLM tutor chat.

---

## The loop

```
1.  Drop in a source        →  PDF, paper, lecture notes, anything
2.  Watch it extract        →  candidate concepts pulled out deterministically (zero LLM)
3.  Promote what matters    →  you pick which ones are worth learning
4.  Enrich on demand        →  one LLM call grounds the definition in THIS source
5.  Challenge yourself      →  5 question kinds: definition / connection / application
                                 / misconception_resistance / compression
6.  Get graded              →  one of: understood · recognizes · gap · misconception
7.  Watch your stage climb  →  Unseen → Memorized → Can Explain → Connected → Compressed → Predicts Failures
```

You can fall out of the loop at any step and the work you did stays. You can re-extract a source without losing the concepts you promoted or the attempts you made.

---

## Source-grounded, not source-confused

Concept names are ambiguous across domains. **The enricher reads the actual source title, section path, and verbatim quotes before answering**, so:

> "RAG" inside an **AI engineering** book →  
> Retrieval-Augmented Generation
>
> "RAG" inside a **project management** doc →  
> Red / Amber / Green status

> "Mole" inside a **chemistry** textbook →  
> 6.022 × 10²³ entities
>
> "Mole" inside a **biology** field guide →  
> the small burrowing mammal

The grader sees the same context. No domain bias, no default associations.

---

## What's in the box

- **Structural PDF parsing** — headings by font/position, headers/footers/TOC/index stripped, broken headings merged across line breaks
- **Deterministic candidate extraction** — weighted `concept_score`, lexicon-driven gates, no LLM in the ingestion path
- **Local-first SQLite storage** — your reading, attempts, and notes live on your machine, in one file
- **Pluggable LLM providers** — Groq and Anthropic, per-pass model selection, free path via "Ask ChatGPT" if you don't want to pay
- **Source-aware enrichment** — definitions anchored to the page you actually read
- **Five-kind challenge mode** — each kind has a contract, the grader enforces it
- **Compression-stage mastery** — six stages, climbable
- **User-authored notes** — your own follow-ups attached to a concept, never overwritten by anything else
- **Append-only event log** — every state change is auditable

---

## Quickstart

```sh
git clone https://github.com/ericckzhou/StarcallOS
cd StarcallOS
pnpm install
pnpm -C packages/shared build
pnpm -C packages/services build
pnpm -C apps/desktop dev
```

Add an LLM key in **Settings** (or skip — extraction works with zero keys), drop a PDF in, promote a candidate.

---

## Why "Starcall"

> *Concepts are stars. Prerequisite edges are constellation lines. Understanding is the act of mapping the sky.*

Starcall is what the system does when it tells you which concept to study next — it summons the star you should look at now, given what you've already mapped and what's drifting back into the dark.

The constellation metaphor is locked, not decorative: the Concept Map renders concepts as stars (brightness from evidence strength, color from mastery stage), the Study Next screen centers the called star, and the timelines read as star-evolution charts.

---

## Philosophy in five lines

- **No-evidence = no-claim.** A concept doesn't become "understood" because you say so. It becomes understood when you've explained it and the grader agreed.
- **Source-grounded over plausible.** A confident wrong answer is worse than "I don't know."
- **Retrieval over recognition.** Highlighting is not learning.
- **Misconceptions are first-class data.** What you almost-believed is more valuable than what you correctly recalled.
- **The grader is the resolver.** It must stay predictable. If you can't anticipate the score your own answer deserves, the grader has become a black box.

Longer version in [PLAN.md](PLAN.md) under *Philosophical lens*.

---

## Architecture

```
PDF or text source
       ↓
structural parsing        (font, position, headings, footers stripped)
       ↓
candidate extraction      (deterministic — zero LLM)
       ↓
you promote what matters  (the human is in the loop on purpose)
       ↓
source-grounded enrichment   (1 LLM call per concept, lazy)
       ↓
challenge tasks (5 kinds)    (1 LLM call per concept, lazy)
       ↓
graded evidence records      (append-only)
       ↓
compression-stage mastery + replayable lineage
```

Each layer has a single responsibility and a single direction of dependency. See [ARCHITECTURE.md](ARCHITECTURE.md) for the contributor-level architecture notes.

---

## Stack

- **Electron** desktop shell
- **TypeScript** + **React** renderer
- **Node.js** service layer (no DOM, no Electron imports)
- **node:sqlite** local storage (no native deps)
- **Groq** and **Anthropic** LLM providers (configurable per pass)

---

## Anti-goals

What this is **not** trying to become:

- An Obsidian / Roam clone
- A second brain or knowledge base
- An infinite-zoom force-directed graph explorer
- An LLM-as-tutor chat surface
- A flashcards / SM-2 spaced-repetition app
- A summarization tool
- A passive note-taker

If you're looking for any of those, this isn't it. This is a **learning verifier**.

---

## Contributing

- Architecture and contributor notes: [ARCHITECTURE.md](ARCHITECTURE.md)
- Full product spec and philosophy: [PLAN.md](PLAN.md)

```sh
pnpm test
pnpm typecheck
pnpm build
```
