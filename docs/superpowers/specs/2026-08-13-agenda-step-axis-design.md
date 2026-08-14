# Agenda as a Pull Queue over the Step Axis — Design

**Date:** 2026-08-13 · **Status:** DRAFT, awaiting Edwin's review · **Supersedes:** the first draft of this file (per-user array + auto-stamping triggers), which pushed work onto the operator instead of letting them pull it.

Edwin's model, in his words:

> "the agenda tab is not like the other boards — it's what the user is working on that is on the user's plate or needs their attention, where queue would show on their queue"

> "the team boards represent state of the workflow — agenda represent the state of the step by a user"

> "on team board i should be able to see edwin is doing the Spec"

> "every morning all cards assigned to user would just be thrown back to the queue and user would drag things as what they are actively working on"

> "it's a team and it should fall into someone else's plate"

> "the source for my Agenda can be Maintenance, React and Deliver, I should see items in the queue or shared plate and grab it"

## The model

Two axes over one card, plus a shared pool that is a **query, not a state**.

| Axis | Question | Where it lives |
|---|---|---|
| **Workflow state** | Where is this work in the pipeline? | `card.columnId` on its home board |
| **Step state** | Who holds the current step, and are they on it today? | `card.agenda` — one holder |
| **Impediment** | Is it stuck? | `card.flag` (existing, unchanged) |

```
  Deliver · review ─┐
  React · triage    ├─→  SHARED QUEUE  ─grab→  MY PLATE  ─pick→  TODAY  ─→  DONE
  Maintain · triage ─┘      (derived)              │                │
                               ▲                   │                │
                               └──── release ──────┴─── morning ────┘
                                                        sweep
```

Nothing is ever assigned to a person. Work becomes *visible* in a shared queue and a person takes it. This is the kanban pull mechanic, and adopting it removes the auto-stamping machinery the first draft needed — along with the bug where declining a card re-offered it on the next trigger pass.

## Part 1 — Schema

**`WorkCard` gains one field** (swarm `work-items.ts`):

```ts
/** Who holds this card's CURRENT step, and whether they picked it for today.
    Orthogonal to columnId, like `flag`. Cleared when the card changes column:
    the step it described has ended. One holder — grabbing is exclusive. */
agenda?: {
  by: string;
  state: StepState;
  /** Entry into the CURRENT state — the same contract as CardFlag.since. The morning
      sweep re-stamps this, because reverting to plate really is entering a new state. */
  since: string;
  /** When it landed on this person's plate. Stamped once at grab and never touched
      again — not by a state flip, not by the sweep. This is the clock that answers
      "how long have I been sitting on this", which `since` cannot: a card worked
      yesterday would otherwise look brand new every morning. */
  grabbedAt: string;
};

export type StepState = "plate" | "today";

/** Append-only narrative: what the holder said they were doing, stamped each time
    someone claims this card for a day. Lives on the CARD, not inside `agenda`, so it
    survives the column change that clears the holder — it is the card's story, not the
    step's, and it is the substrate for Jira comments and AI summaries. Never rewritten. */
intents?: Array<{ at: string; by: string; text: string }>;
```

Single holder, not a list. "Grab it" is exclusive: the moment someone takes a card it leaves everyone else's shared queue. An **agent** holding work is not represented here — that is `delegation`, which already exists and already carries the execution state (`taskId`, `state`, `prUrl`) a human holder has no analogue for.

`done` is not a step state. Finishing a step means advancing the card on its team board, which clears `agenda` anyway.

**`WorkColumn` gains one field:**

```ts
/** This column structurally waits on a human — its unheld cards appear in the shared queue. */
gatesHuman?: boolean;
```

Seeded `true` by `BOARD_TEMPLATES` on exactly: `deliver/review`, `deliver/verify`, `reactive/triage`, `maintenance/triage`. **`release/sign-off` is deliberately excluded** — Edwin named Maintain, React and Deliver as the sources, twice. This is one boolean in a template; add it later if Release turns out to belong.

**`User` gains one field** (swarm `users.ts`):

```ts
/** Local YYYY-MM-DD of this user's last agenda sweep. Per-user because the sweep is per-user. */
agendaSweptDay?: string;
```

`WorkBoard.sweptDay` stays as it is, still governing the personal board's own cards.

## Part 2 — The shared queue is derived

There is no stored "queued" state and no code that writes one. A card appears in the shared queue when **all** of:

1. its board type is `maintenance`, `reactive`, or `deliver`;
2. it needs a human — its column has `gatesHuman`, **or** it carries a `flag`, **or** its `delegation.state` is `completed`/`failed`, **or** `jira.lastPushError` is set;
3. nobody holds it — `agenda` is absent;
4. no agent is mid-flight on it — `delegation.state` is not `working`.

Condition 4 is the distinction the whole feature exists to draw: a card an agent is actively working belongs to the agent, not the pool. Conditions 3 and 4 together are why releasing a card sticks — it returns to the pool because the pool *is* "nobody has it," not because anything was written.

## Part 3 — Invariants

1. **The step axis never writes the workflow axis, and vice versa.** Dragging on a team board writes `columnId`. Dragging a team card on Agenda writes `agenda.state`. No helper does both.
   **Exception, personal-board cards:** they have no workflow axis, so their `columnId` *is* their Agenda lane. Dragging one writes `columnId` and never touches `agenda`. The drag handler branches on `board.type === "personal"`.
2. **A column change clears `agenda`.** The step ended. Enforced inside the one card-move helper, not at call sites.
3. **Grab is exclusive and guarded.** Grabbing a card that already has a holder is an error, not an overwrite — two people pulling the same card at the same moment must not silently produce one winner and one confused loser.
4. **Release restores the pool by deletion.** Releasing removes `agenda` entirely; the card re-enters the shared queue by satisfying Part 2, with nothing left behind.
5. **`since` resets on a state change and survives a same-state re-stamp** — mirroring `CardFlag.since`.
6. **Entering `today` requires a stated intent.** Enforced in the domain helper, not the UI, so no route or script can move a card into today silently. `plate` never requires one — grabbing is cheap, committing your day is not.

## Part 4 — The morning sweep

> "every morning all cards assigned to user would just be thrown back to the queue"

`today` reverts to `plate` for that user, across every board. **It does not release the card.** Grabbing is a commitment that outlives the day; picking something for today is a daily declaration that does not. A card you grabbed last week is still yours this morning — it is simply no longer claimed for today until you say so.

The sweep re-stamps `since` (reverting to plate is genuinely entering a new state) and **never touches `grabbedAt`**. That split is what lets the plate lane show "on your plate 5 days" the morning after you worked something, instead of resetting its age every midnight.

Generalizes the existing `sweepPersonalBoard`, which already rolls Todo/Doing into Queue at local midnight under a `sweptDay` guard. Same midnight timer, **cron-only**, preserving the ruling at `swarm/src/server.ts:471`: if the server is down at 00:00 the sweep waits.

## Part 5 — Handing work on

Three distinct actions, previously conflated in one "Not Doing" lane:

| Intent | Mechanism | Result |
|---|---|---|
| "Not mine — someone take it" | **Release** | `agenda` cleared; card returns to the shared queue |
| "The crew should do this" | **Delegate** (exists) | `delegation` set; card leaves the pool while the agent works, and re-enters it if the agent fails |
| "This work shouldn't happen" | The team board's **terminal column** (exists) | `ideation/killed`, `maintenance/wont-do` |

So there is no handoff-to-a-named-person, and none is needed: a released card is visible to everyone in the shared queue, which is how it reaches someone else's plate. This also matters because **there is no roster of people** — `Workspace.members` is nested contexts, not humans, and there is exactly one user record (`{ id: "me" }`). The only other team members that exist are the crew, and delegation is already how work reaches them.

**Not Doing survives for personal todos only**, where it means "I've decided against this" and there is no team board to express that on.

**Retired:** the `Escalate to Agenda` routes in `BOARD_ROUTES` (reactive and maintenance `triage` → personal `queue`). They *move* the card onto the personal board, hiding it from the team. Under this design a React/Maintain triage card is already in the shared queue by Part 2; escalation is just grabbing it.

## Part 6 — Stating intent

> "placing on my plate assigns it to me — pulling to Doing (Today) should force user to state what they are doing — can be used by system to add comments to original jira or create ai summaries"

**Grab is the assignment.** Taking a card off the shared queue is what "assigned to me" means in this system; the holder chip on the team board is how everyone sees it. There is no separate assign step.

**Entering `today` demands a sentence.** Dragging a card into Today opens a required composer — "what are you doing with this?" — and the move does not commit until it is answered. Cancelling leaves the card on your plate. The check lives in `setStepState`, not the component, so the rule holds for every caller.

Each statement appends to `card.intents`. It is never rewritten and never cleared, including when the holder is cleared by a column change — the sentence someone wrote about the spec step stays true after the card moves to tech-design. That append-only log is what makes the next two things possible:

**Jira comments.** When the card carries `jira` and its board carries `jira`, appending an intent posts a comment on the issue: *"Edwin · today: chasing the flaky suite on main."* This mirrors the existing push-on-move, which transitions a linked issue when a card lands in a column with `jiraStatus` and records failures in `card.jira.lastPushError` rather than failing the write. Comment pushes follow the same contract — best-effort, never blocking the local move.

`jira-sync.ts` has `searchIssues`, `createIssue`, `importIssues` and `transitionIssue`; a `commentIssue` is new. Jira's v3 comment body is ADF, not a string, so the helper wraps plain text in a minimal `doc → paragraph → text` document.

**AI summaries** are enabled, not built. The log is the substrate a standup or status summary would read; generating them is separate work and out of scope here. Worth knowing before anyone plans it: the broker's API key is currently out of credits, so any LLM path is dead until that is resolved.

**Not built: pushing the assignee to Jira.** Jira's assignee endpoint needs an `accountId`, and nothing maps the local operator to a Jira account — `users.ts` has `id` and `name` only. Grab therefore assigns *in this system* and, on a linked card, announces itself as a comment. Real assignee sync needs an `accountId` on the user record and should be its own change.

## Part 7 — Rendering

**Team board.** One holder chip per card: the person's name and whether they're on it today. Unheld cards render nothing. Agent-held cards keep the existing delegation badge — one holder line either way, two records underneath.

**Agenda tab.** `useBoards()` already fetches every board in one query, and `board-aggregate.ts` already supports one tab spanning many boards (`AggCard` carries `boardId`/`workspaceId`). Changes:

- `tabsFor` currently gives the personal tab `boardIds: [personal.id]`; Agenda's descriptor becomes every board id.
- Four lanes: **Shared queue · My plate · Today · Done**.
- Team cards occupy Shared queue / My plate / Today. **Done holds personal todos only** — a team card's "done" is expressed by advancing it on its board, at which point it leaves the Agenda entirely. This is the one asymmetry left and it is explicable on screen.
- Team cards carry a dashed provenance chip — home board and workflow column ("Deliver · review").
- Shared queue is not drag-reorderable and its cards are not draggable into Today directly; **grab** is a button on the card, and grabbing lands it in My plate.
- Lanes sort personal cards first by `order` (drag-reorderable, unchanged), then team cards by **`grabbedAt`** oldest-first — the longest-held work floats up, and stays up whether or not you touched it yesterday. Sorting by `since` here would reshuffle the lane every midnight. `order` is per-column-per-board and renumbered per board, so it cannot order a cross-board lane. The shared queue sorts by how long the card has been waiting — `flag.since` when flagged, else `updatedAt`.
- A card on your plate shows its age from `grabbedAt` ("5d"), which is the visible half of "it's still on your plate."

- Dropping into **Today** opens the intent composer inline on the card. It is a required field: the drop is optimistic-free — nothing is written until the sentence is submitted, and cancelling returns the card to its lane with no PATCH at all. This is the one gesture in the app that cannot be completed by dragging alone, which is deliberate: the friction is the feature.
- A card in Today shows its latest intent beneath the title, so the lane reads as a list of commitments rather than a list of titles.

The app already renders intake-lane cards at 85% grayscale / 0.75 opacity, restored on hover, with the comment *"intake cards sit grey until someone picks them up."* Applying that treatment to the shared queue gives the pool its visual distinction for free.

## Part 8 — Out of scope

- Assigning to a named human. Needs a second user record; the passkey/cloud work is the seam where that arrives.
- Agent holders in `agenda`. Delegation covers it.
- History of past steps. Entries clear on advance, not archived.
- Per-workspace scoping of the Agenda. It stays context-invariant: your plate is your plate regardless of the workspace filter. This reverses `tabsFor`'s current "not a function of the dropdown" comment, which must be updated rather than left contradicting the code.

## Open decisions for Edwin

1. **Release/sign-off** is excluded from the sources on a literal reading of "Maintenance, React and Deliver." One boolean to add if that was an omission rather than a decision.
2. **Identity.** The default record is `{ id: "me", name: "You" }`; for the chip to read "Edwin" that record's `name` must be set to Edwin. The chip renders `user.name`.
3. **Exclusive grab** is read from the word "grab." If two people should be able to hold one step (co-writing a spec), `agenda` must be a list from the start — widening it later rewrites every read site.

## Testing

Swarm (node test runner, pure helpers, no server boot):

- `grabCard` sets the holder; grabbing a held card throws.
- `releaseCard` deletes the field entirely — no empty object left behind.
- `setStepState` flips plate↔today; `since` resets on change, survives a same-state re-stamp.
- A column change clears `agenda`; a same-column reorder does not.
- `sharedQueue`: includes a gated unheld card on deliver/reactive/maintenance; excludes one on plan/ideation/release; excludes a held card; excludes one with `delegation.state === "working"`; includes one whose delegation `failed`; includes a flagged card in an ungated column.
- `sweepUserAgenda`: `today → plate` across boards; never releases; second call same day is a no-op; other users untouched; `agendaSweptDay` persists even when nothing moved; **`intents` is never truncated by a sweep**; **`grabbedAt` survives while `since` is re-stamped** — a card grabbed three days ago and worked yesterday still reports three days.
- `setStepState` into `today` throws without an intent, and throws on a whitespace-only one; into `plate` needs none.
- Each entry into `today` appends one entry to `intents`; a same-state re-stamp does not append twice.
- `intents` survives the column change that clears `agenda`.
- `commentIssue` posts an ADF document, not a bare string; a failed comment push records `lastPushError` and does not throw.

Control-plane (vitest + jsdom):

- `collectAgendaCards` gathers the user's cards per lane and excludes other holders'.
- `sharedQueueCards` derives the pool across boards and respects all four conditions.
- Lane ordering: personal cards (by `order`) precede team cards (by `since`).
- Grab issues a grab PATCH and no `columnId` patch.
- Dragging a **team** card between plate and today patches `agenda.state` only.
- Dragging a **personal** card patches `columnId` only. Both directions need a test or the drag branch silently collapses.
- Team board renders one holder chip; unheld renders none.
