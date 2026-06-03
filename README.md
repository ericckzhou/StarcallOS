# StarcallOS

> **Claims of understanding need evidence.**

A local-first learning OS that turns any PDF or text source into evidence-backed
mastery: it pulls candidate concepts out of your source **deterministically**
(zero LLM by default), you promote what matters, then a grader pushes you from
"I read it" to "I can compress it to first principles."

Works on **any subject** — textbooks, papers, lecture notes, legal opinions,
clinical guidelines, language grammars, internal docs.

![demo](docs/demo.gif)

## Download

Get the latest build from the **[Releases page](https://github.com/ericckzhou/StarcallOS/releases/latest)** — a single portable `.exe` (Windows x64) that runs without installation.

> Because the build is unsigned, Windows may show a *"Windows protected your PC"* SmartScreen dialog on first launch. Click **More info → Run anyway**.

Add an LLM key in **Settings** if you want enrichment and grading (or skip — extraction works with zero keys), drop a PDF in, promote a candidate.

Jump to: [Why this, not another notes app](#why-this-not-another-notes-app) · [The loop](#the-loop) · [What's in the box](#whats-in-the-box) · [Build from source](#build-from-source) · [Architecture](ARCHITECTURE.md) · [Philosophy](PHILOSOPHY.md)

---

## Why this, not another notes app

You read a chapter, highlight a few sentences, and tell yourself you got it. A week later, you can't explain it. A month later, you can't tell which parts you remember and which you confused with something else.

StarcallOS closes that gap. You only get to claim you understand a concept once you've **explained it in your own words and survived a grader**. Every attempt is stored, replayable, and tied back to the page that taught you — so the system can always answer *why does it think you understand this?*

Every screen earns its space by answering one of three questions. If it doesn't, it doesn't ship. No second-brain, no infinite-graph explorer, no LLM tutor chat.

| Question | Where you answer it |
|---|---|
| **What do I claim to understand?** | Concept list · Overview · Mastery stage badges |
| **What evidence supports that claim?** | Challenges · Source preview · History · Your notes |
| **What should I study or test next?** | Review queue · spaced-repetition due scheduling (SM-2) · stage progression |

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

- **Structural PDF parsing** — headings by typography, spacing, isolation, indentation, section paths, and context; headers/footers/TOC/index/captions are penalized or stripped
- **Deterministic candidate extraction** — score parts, parser labels, context snippets, and `final_score`, with no LLM in the default ingestion path
- **Local-first SQLite storage** — your reading, attempts, and notes live on your machine, in one file
- **Pluggable LLM providers** — Groq and Anthropic, per-pass model selection, compact configured LLM filtering, and a free "Ask ChatGPT" path if you don't want to pay
- **Source-aware enrichment** — definitions anchored to the page you actually read
- **Challenge mode with XP** — task difficulty is tracked, history shows task kind/difficulty, and XP only counts the highest completed difficulty per concept/task kind
- **Side-by-side source preview** — continuous-scroll PDF that fits page width, zooms (− / % / +), lets you select and copy text, auto-jumps to the evidence page, and carries concept-scoped highlights and draggable sticky notes
- **Cross-source constellations** — link a concept to any other promoted concept across all your sources; the link reason can point at a specific piece of evidence (or its note) in the linked concept. The list is yours, never LLM-written
- **Star Hubs** — group concepts into named, color-coded hubs (cross-source) that render as nebula clusters on the Map; a dedicated **Hubs tab** manages them (create, rename, recolor, remove members, delete)
- **Concept tags** — add your own colored tags to a concept; reuse existing tags or create new ones
- **Find in source** — search the open source (matching pages in a PDF, inline match highlight in text), or scope the view to just the related pages
- **Highlights as evidence** — highlighting in the source creates an evidence entry; you can link a note to a highlight and click it to jump back to the page
- **Replayable challenges** — rename concepts inline, regenerate tasks (never re-asking a question you've already answered), and the grader always tells you what would push an answer to the next stage
- **Equation extraction and display** — formulas render with **KaTeX** and attach to nearby concepts/sections when possible
- **Undo-friendly deletes** — deleting a source, concept, or note gives you a 5-second undo
- **Profile customization** — local display name, avatar, XP stats, background image/video, and background opacity
- **User-authored notes** — your own follow-ups attached to a concept, styled with the overview fields and never overwritten by anything else
- **Multi-PDF import** — add several PDFs from one file-picker action
- **Large text import overlay** — paste long notes, articles, or transcripts as text sources
- **Manual CRUD where review needs it** — add/edit/delete promoted concepts, equations, relation candidates, misconception candidates, and equation candidates
- **Append-only event log** — every state change is auditable

<details>
<summary>Recent additions</summary>

- Deterministic PDF candidate parsing now uses typography, spacing, isolation,
  indentation, context snippets, score breakdowns, labels, and `final_score`.
- Candidate review supports bucket/tag/min-score filters, compact configured
  LLM topic filtering inside the topic-filter modal, manual ChatGPT filtering,
  conservative bulk promotion gates, and glass inline CRUD for relations,
  misconceptions, and equations.
- Equations are attached to nearby concept/section context and rendered with a
  lightweight LaTeX-ish display in concept overview and candidate review.
- Source preview is available beside all concept tabs, can be resized, remembers
  the logical page, re-anchors after tab/rail/zoom/layout changes, and supports
  concept-scoped PDF highlights plus draggable sticky notes.
- Profile now includes local avatar/name, XP/challenge stats, difficulty chart,
  background image/video upload, and background opacity.
- XP awards only the highest completed difficulty per concept/task kind, so the
  same question type cannot be farmed repeatedly.
- `+ PDF` supports importing multiple PDFs in one file-picker action; `+ Text`
  opens a centered workspace-sized import overlay.
- Concept search in the concept list and Candidate Review (`/` to focus); a
  per-concept **Paper** tab — a low-chrome autosaving scratchpad.
- Cross-source **constellation links** carry a required reason explaining the
  connection (directional, or mutual when both concepts link each other).
- **Constellation Map** (top-level "Map" tab): a force-directed star graph of
  your promoted concepts, focused on a selected source plus the concepts linked
  to it from other books; one-way vs mutual and same- vs cross-source links are
  drawn distinctly.
- **Star Hubs:** group concepts into named, color-coded hubs (cross-source) via
  multi-select in the concept list ("Add to ▾"). Hubs render as nebula clusters
  on the Map, and a dedicated **Hubs tab** manages them (create, rename, recolor,
  remove members, delete) — even hubs whose source was deleted. Hubs can also be
  **nested** into a tree (give a hub a parent in the Hubs tab) and **linked to
  each other** with labeled, directional connections that draw between nebulae on
  the Map. (Member roles are still planned.)
- **Note ↔ highlight ↔ evidence linking:** a highlight in the source also
  becomes a concept evidence entry; deleting either side keeps them in sync, and
  a note can link to a highlight and jump to its page.
- **Concept tags** with per-tag colors, picked from existing tags or created on
  the spot; the auto evidence-kind chips can be dismissed per concept.
- **Find in source** (page filter on PDF, inline match on text) and a
  "related pages only" view.
- **Equation rendering via KaTeX**, replacing the earlier homegrown view.
- **Export to Markdown or Anki** — a single concept (from its header), a whole
  source, or your entire library (from the Sources sidebar).
- **5-second undo** for deleting sources, concepts, and notes.

</details>

---

## Why "Starcall"

> *Concepts are stars. Prerequisite edges are constellation lines. Understanding is the act of mapping the sky.*

The constellation metaphor is locked, not decorative: the Concept Map renders concepts as stars (brightness from evidence strength, color from mastery stage), the Study Next screen centers the called star, and the timelines read as star-evolution charts.

---

## Philosophy in five lines

- **No-evidence = no-claim.** A concept doesn't become "understood" because you say so. It becomes understood when you've explained it and the grader agreed.
- **Source-grounded over plausible.** A confident wrong answer is worse than "I don't know."
- **Retrieval over recognition.** Highlighting is not learning.
- **Misconceptions are first-class data.** What you almost-believed is more valuable than what you correctly recalled.
- **The grader is the resolver.** It must stay predictable. If you can't anticipate the score your own answer deserves, the grader has become a black box.

Longer version in [PHILOSOPHY.md](PHILOSOPHY.md).

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


## Build from source

If you don't want to download the prebuilt `.exe`, you can run the dev shell or
produce your own portable build:

```sh
git clone https://github.com/ericckzhou/StarcallOS && cd StarcallOS
pnpm install
pnpm -C packages/shared build && pnpm -C packages/services build
pnpm -C apps/desktop dev          # hot-reload dev shell
# or
pnpm -C apps/desktop dist         # produces apps/desktop/dist/StarcallOS-*-portable-x64.exe
```

Requirements: Node **22.5+**, pnpm 11+. The app uses the built-in `node:sqlite`
module (no native bindings), which is experimental and only available on Node
22.5 or newer — older Node versions cannot run it. On Windows, packaging a portable `.exe`
locally needs either an elevated shell or Developer Mode enabled (electron-builder
unpacks signing tooling with symlinks). Otherwise let CI build it for you on tag push.

## Contributing

- Architecture and contributor notes: [ARCHITECTURE.md](ARCHITECTURE.md)
- Full product spec and philosophy: [PLAN.md](PLAN.md)

```sh
pnpm test
pnpm typecheck
pnpm build
```

## License

StarcallOS is licensed under the **GNU Affero General Public License v3.0**
(AGPL-3.0-only) — see [LICENSE](LICENSE).

In short: you are free to use, study, modify, and share it, but if you
distribute a modified version — or run one as a network service — you must
release your source under the same license. Copyright © 2026 Eric Zhou.

---

<sub>*"For the wisdom of this world is foolishness with God."* — 1 Corinthians 3:19 · See [PHILOSOPHY.md](PHILOSOPHY.md).</sub>
