# Philosophy

> *"Let no man deceive himself. If any man among you seemeth to be wise in
> this world, let him become a fool, that he may be wise. For the wisdom of
> this world is foolishness with God."*
> — 1 Corinthians 3:18–19

## The conceit StarcallOS refuses

The fashionable way to build this product is obvious. Throw the whole PDF at a
large model, ask it for the "key concepts," let it write the definitions, let it
grade the answers, and ship a chat box. It demos beautifully. It is also the
wisdom of this world: confident, plausible, and quietly unaccountable. When the
model invents a concept that isn't in your source, or grades a wrong answer as
correct because it pattern-matched to its training data, there is no thread to
pull. You cannot ask it *why does it think this?* and get an answer grounded in
the page you actually read.

StarcallOS takes the foolish path on purpose:

- It extracts candidate concepts **deterministically** — typography, spacing,
  isolation, section paths — with **zero LLM in the default path**. A slower,
  dumber parser that you can audit beats a clever one you have to trust.
- The **human promotes** what matters. The machine does not get to decide what
  you are trying to learn.
- The LLM is invited in **late and narrow** — one grounded call to enrich a
  concept against *this* source's title and verbatim quotes, one to generate a
  challenge, one to grade. Never to decide what's true on its own authority.
- Every claim of understanding is backed by **replayable evidence**. The system
  can always answer *why does it think you understand this?*

The bet is that the boring, accountable pipeline outlasts the impressive,
unaccountable one — that being able to show your work is worth more than looking
wise.

## The five lines

- **No-evidence = no-claim.** A concept doesn't become "understood" because you
  say so. It becomes understood when you've explained it and the grader agreed.
- **Source-grounded over plausible.** A confident wrong answer is worse than
  "I don't know."
- **Retrieval over recognition.** Highlighting is not learning.
- **Misconceptions are first-class data.** What you almost-believed is more
  valuable than what you correctly recalled.
- **The grader is the resolver.** It must stay predictable. If you can't
  anticipate the score your own answer deserves, the grader has become a black
  box — and a black box is just the wisdom of this world wearing a UI.

## Why "Starcall"

> *Concepts are stars. Prerequisite edges are constellation lines.
> Understanding is the act of mapping the sky.*

The constellation metaphor is load-bearing, not decorative: the Concept Map
renders concepts as stars (brightness from evidence strength, color from mastery
stage), and the timelines read as star-evolution charts. You are not collecting
notes. You are charting what you actually know, and being honest about the dark
between the stars.

---

The longer product spec and historical lens live in [PLAN.md](PLAN.md);
contributor-level architecture lives in [ARCHITECTURE.md](ARCHITECTURE.md).
