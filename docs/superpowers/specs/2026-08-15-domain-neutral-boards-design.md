# Domain-Neutral Work Kinds — Design

**Status:** design, awaiting review
**Date:** 2026-08-15
**Feeds:** the welcome wizard's *what kind of work do you do?* question
**Related:** [welcome wizard](2026-08-15-welcome-wizard-design.md)

## Problem

The board vocabulary that ships is product-development shaped, and specifically
enough that it reads wrong for anyone else:

- `plan`: queue → **spec** → **tech-design** → **decomposed** → ready
- `deliver`: queue → ready → in-progress → review → verify → **merged**

"Tech design", "decomposed", and above all **"Merged"** — a git word — are not
the words a marketing, sales, consulting, content, creator or trading team uses. There are
**no column CRUD routes** (`POST /work/boards` and `POST /work/capabilities` are
the only work mutations), so a user cannot fix this themselves.

The *skeleton* is fine. Ideate → Plan → Deliver → Release, with React and
Maintain alongside, describes most knowledge work. Only the vocabulary is
parochial.

## Two changes, in order

### 1. Neutral column ids

Column ids are the contract: `BOARD_ROUTES` matches on them
(`e.from === columnId`), the agenda axis stores one per card, and the shared
queue keys off them. They should therefore mean something in every domain.

| Board | Old id | New id |
|---|---|---|
| plan | `spec` | `define` |
| plan | `tech-design` | `design` |
| plan | `decomposed` | `breakdown` |
| deliver | `merged` | `complete` |
| release | `cut` | `prepare` |
| release | `regression` | `validate` |

`plate`, `today`, `intake`, `scoping`, `confirm`, `killed`, `triage`, `diagnose`,
`fix`, `doing`, `done`, `wont-do`, `not-doing`, `queue`, `ready`, `in-progress`,
`review`, `verify`, `ship`, `rollback`, `closed` and `sign-off` already read
correctly outside software and are left alone.

**Do this now: the migration is currently free.** Cards carry `columnId`, so an
id rename normally rewrites every stored card. The reference install was reset on
2026-08-15 and holds **zero** cards, which will not be true again. A migration
must still ship for other checkouts — `normalizeBoard`'s `queued` → `queue` card
rewrite is the precedent — but it is authored against an empty install rather
than a live one.

The migration must rewrite, in one pass: `board.columns[].id`, every card's
`columnId`, and every `BOARD_ROUTES` entry. Any card whose `columnId` matches no
column after migration is a defect, not a tolerable orphan — assert it.

### 2. Vocabularies as data, not a union

With neutral ids in place, each work kind supplies **labels only**. Nothing
downstream notices, because ids never change.

| Work kind | `define` | `design` | `breakdown` | `complete` |
|---|---|---|---|---|
| Product / software | Spec | Tech design | Decomposed | Merged |
| Marketing | Brief | Concept | Assets | Live |
| Sales | Discovery | Proposal | Terms | Closed-won |
| Consulting | Scope | Approach | Work packages | Delivered |
| Content | Brief | Outline | Sections | Published |
| Influencer / creator | Hook | Concept | Shot list | Posted |
| Trading | Thesis | Sizing | Orders | Closed |

**Work kinds must be data, not a TypeScript union.** This list went from three
domains to seven in the course of one conversation and was still growing when it
was written down; a union makes every new domain a release. The codebase already settled this question
elsewhere — `AgentEngine.stereotype` is an open `string`, and personas load as
config rather than being enumerated in code. A vocabulary file keyed by work kind
follows that precedent, and makes "bring your own vocabulary" a product
capability rather than a code change, which matters most for teams whose words
are their differentiator.

`BOARD_TEMPLATES[boardType]` therefore gains a work-kind dimension consulted **at
seed time only**. `board.columns` is already persisted per board, and the
template is otherwise read only for the `gatesHuman` backfill, so no stored data
changes shape from labels alone.

### 3. Source presets are parochial too

`ContextSource.preset` is a hardcoded set — `jira | releases | topic |
observability | support | custom` — and every entry except `topic` and `custom`
is a software word. `SOURCE_PRESETS` is a closed `Set`, so the same problem as
the board vocabulary exists one layer down.

It has the same cheap fix, for the same reason: the type comments `preset` as
**"UI sugar — executors read origin/transform"**, so presets are presentational.
New presets need no executor changes, only data.

A work kind therefore bundles **two** things:

| Work kind | Board vocabulary | Source presets |
|---|---|---|
| Product / software | Spec · Tech design · Decomposed · Merged | jira · releases · observability · support |
| Marketing | Brief · Concept · Assets · Live | campaign metrics · brand mentions · competitor |
| Sales | Discovery · Proposal · Terms · Closed-won | CRM · inbound · pipeline |
| Influencer / creator | Hook · Concept · Shot list · Posted | youtube · tiktok · instagram · x · comments · trends |
| Content | Brief · Outline · Sections · Published | topic · keyword · publication |
| Trading | Thesis · Sizing · Orders · Closed | tickers · filings · news |

**Influencer and content are deliberately separate kinds.** They look similar in
board vocabulary and differ entirely in sources: content work is usually
long-form through one channel, while a creator runs many channels at once and
repurposes one idea across them. The distinguishing need is *many sources and a
publishing flow*, which is a `ContextSource` story rather than a labelling one —
and the polling-plus-transform machinery for it already ships.

`custom` already accepts an arbitrary `origin: {url, query}` with an
`analyze` transform, so these presets add discoverability rather than capability.

## A note on fit

`review` and `verify` carry `gatesHuman: true`, and those gates land more
squarely outside software than in it: brand or legal approval is a harder, more
genuine human gate than a code review, which agents increasingly perform
themselves. The approval machinery was built for software and is a stronger
selling point to marketing and sales.

## Error handling

- **An unknown work kind falls back to product/software**, never to an empty
  board. A vocabulary file is user-editable data and will eventually be wrong.
- **A vocabulary missing a label falls back to the default label for that id**,
  per column, so a partial file degrades one cell rather than breaking a board.
- **Vocabulary changes never rewrite existing boards.** Labels are chosen at seed
  time; retitling a live board is a separate, explicit action.

## Testing

Unit: the id migration (old board in → new board out, cards rewritten, no
orphans), route integrity after rename, vocabulary lookup with a missing label,
unknown work kind falling back.

**A migration test with a positive control.** Assert that a board built on the
old ids actually fails validation before migration, so the test cannot pass
against a no-op — a measurement that never ran looks exactly like a clean result.

## Out of scope

Column CRUD for users (renaming or adding columns per board), retitling existing
boards when a vocabulary changes, per-card vocabulary overrides, and any new
source *executor* — presets are presentation over the existing
origin/transform mechanism, not new polling capability.
