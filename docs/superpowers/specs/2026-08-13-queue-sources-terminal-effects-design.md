# Queue Sources + Terminal Side-Effects — Design

**Date:** 2026-08-13 · **Approved:** Edwin (chat: full source-kind registry now → generic origin+transform → context owns them → per-source cadence → engine "option A" → "yes write the spec")

Edwin's model: a board's two **edge columns** get configured behavior. The Queue (leftmost) has **sources** — where cards come from: "for some queue columns, the source of cards are just cards that reach successful completion on other boards", but boards like React and Maintain "define a external origin based on context sources that can be polled and analyzed to determine work items that need attention — a maintenance issue, something identified by observability system, a support request, library upgrade, etc." Even "a jira connector can be a context source for board — maybe for Plan." The termination column (rightmost) has **side-effects** — "allow a card to publish jira in idea board." Config is reached by a gear that "presents itself on the top right of the QUEUE column" on hover.

## Part 1 — Schema

**Context sources live on the context** (the one-context `Workspace` record, `.smith/workspaces/`):

```ts
/** A pollable external origin owned by this context. Absent field = no sources. */
sources?: Array<{
  id: string;                       // stable, generated at create
  name: string;                     // display name, e.g. "PROJ tickets", "spring-boot releases"
  preset: "jira" | "releases" | "topic" | "observability" | "support" | "custom";
  origin: {
    connectorId?: string;           // machine-level connector/credential ref (jira, http-auth)
    url?: string;                   // for http/rss/atom-style origins
    query?: string;                 // JQL for jira; topic text for topic; filter expr otherwise
  };
  cadence: "hourly" | "6h" | "nightly";   // default "nightly"
  transform:
    | { mode: "map" }                        // structured origins: fields map straight to card
    | { mode: "analyze"; prompt?: string };  // broker LLM judges findings into work items
  enabled: boolean;
}>;
```

`preset` picks the config form and default transform in the UI; the executor reads only `origin`/`transform` — presets are sugar, not kinds. Connector credentials stay in the existing registries; a source stores only the reference. Groupish records (contexts with `members`) carry no `sources` — sources belong to the workspace whose boards they feed, same rule as repos.

**Boards gain edge-column blocks** (swarm `work-items.ts`):

```ts
queue?: { sourceIds: string[] };                 // which context sources feed this board's intake
terminal?: { columnId?: string; effects: TerminalEffect[] };  // fire when a card ENTERS the terminal column

type TerminalEffect =
  | { kind: "publish-jira"; connectorId: string; projectKey: string }
  | { kind: "route"; toType: BoardTypeT; toColumn: string };
```

Cards gain the dedup stamp: `sourceRef?: { sourceId: string; itemKey: string }` (generalizing feeds' `repoKey`).

- The **intake column** is the board's `queue` column when it has one (Deliver/React/Maintain today), else its **first** column — which is how a source binds to Plan or Ideate without inventing columns.
- The **terminal column** is `terminal.columnId`, defaulting to the board's **last** column. It is editable in the gear sheet because "last" is wrong where an exception lane sits rightmost — Release ends in Rollback; its terminal is Ship.
- `route` reuses the existing `routedFrom` stamp and route validation. It is the formalization of "cards that reach successful completion on other boards feed queues" — automatic on terminal entry rather than manual-only.
- Existing `board.jira` import config is superseded: migration turns it into a `jira` context source bound to that board's queue (Plan being the expected case). The manual "import from Jira" card-sheet path keeps working during the transition.

## Part 2 — Execution: broker polls, swarm reacts (Edwin: option A)

**Inflow = broker.** The feeds engine (`broker/src/feeds/`) generalizes from "releases + topics" to "every context source":

- A scheduler runs each enabled source when due (per-source cadence; the existing nightly cron sweep is the `nightly` tick, `hourly`/`6h` are additional timers in the same loop).
- Polling: rss/atom/http already exist. A **thin Jira JQL search client** is added broker-side — the one duplication option A accepts. Both Jira clients (broker poll, swarm publish) pin the same REST API version; the known `/search` endpoint drift risk is handled once, in a shared note both files cite.
- Transform `map`: structured origin fields → card title/notes (per-preset mapping tables, e.g. Jira issue key/summary/url → title + jira chip). Transform `analyze`: the broker's own brain/LLM path (which already writes release cards with plans) judges raw findings into zero or more work items; `prompt` augments the built-in triage instruction. **No ApiRuntime dependency in v1.**
- Carding: through the same swarm board API `feeds/cards.ts` uses today, targeting the **intake column** of every board whose `queue.sourceIds` includes the source. `boardTypeFor` (security→reactive, else→maintenance) is **replaced** by bindings — migration seeds equivalent bindings, and migrated rows keep landing in the column today's engine uses, so behavior is unchanged on day one.
- Dedup: each carded item stamps `sourceRef` (Part 1); a source never re-cards an item whose ref already exists on the board.

**Outflow = swarm.** Terminal effects fire inside `moveCard`/`routeCard` when the destination is the board's terminal column — synchronously with the mutation the swarm already owns:

- `publish-jira`: creates the issue via the swarm's existing Atlassian client, stamps `card.jira {key, url}`; failure stamps `jira.lastPushError` (existing field, existing UI treatment) and does not block the move.
- `route`: copies the card into the target board's queue with `routedFrom` appended; missing target board = no-op logged, the move itself never fails on an effect.
- Effects are idempotent per card: a card re-entering the terminal column does not re-publish (the `jira` stamp / `routedFrom` entry is the guard).

## Part 3 — UI: the edge-column gear

- Hovering the Queue column reveals a **gear button top-right of the column header** (opacity 0 → 1 on `.board-column:hover`, always visible on keyboard focus — the aria-hidden-decoration trap from the droplist work does not apply: this is a real button, focusable, labeled "Configure queue sources"). The terminal column gets the same gear ("Configure completion effects").
- The gear opens a sheet (same Sheet family as CardSheet):
  - **Queue sheet**: this queue's bound sources as toggles; the context's full source list beneath; "Add source" opens the preset picker (Jira / Releases / Topic / Observability / Support inbox / Custom URL) pre-filling the generic origin/transform fields; per-source cadence select; internal routing intake (which boards' terminal `route` effects point here) listed **read-only**.
  - **Terminal sheet**: which column is the terminal (defaults to last; Release picks Ship); the effects list; add publish-jira (connector + project key) or route (board type + column, validated against the existing route table).
- Writes go through new swarm routes: sources CRUD on the context record (`PATCH /workspaces/:name` extension or dedicated `/workspaces/:name/sources`), edge blocks via a board `PATCH`. The control plane follows the Query/RHF/zustand boundary rule (server state in TanStack Query, forms in RHF).
- The same source list appears later in the workspace editor (Integrations tab); the gear is the v1 door. Not in v1: a machine-wide "all polling" dashboard.

## Part 4 — Migration & testing

**Migration** (boot, one-way, logged — `normalizeBoard` precedent):

1. Boards: stamp `queue: {sourceIds: []}` / `terminal: {effects: []}` on boards that lack them. Empty = today's behavior; nothing changes until configured.
2. Feeds: each derived release source and each topic becomes a context `sources` row (`preset: "releases" | "topic"`, cadence nightly, transform analyze) bound to the queue of the board `boardTypeFor` would have picked — security releases keep landing on React, the rest on Maintain, byte-for-byte.
3. `board.jira` (where present): becomes a `jira` source (`preset: "jira"`, origin from the board's connector/site/project/jql, transform map) bound to that board's queue.

**Testing:**

- Swarm: edge-block schema round-trips; terminal-effect firing on `moveCard` into the terminal column — including a repointed one (publish stamps / route copies / idempotency / effect-failure never blocks the move); sources CRUD on the context record incl. the groupish-records-carry-no-sources rule.
- Broker: scheduler due-time math per cadence; jira poll → map transform → card shape; analyze transform judged via the existing feeds test seams; dedup by `sourceRef`; binding-driven targeting reproduces `boardTypeFor` on migrated rows (the regression test for step 2).
- Control plane: gear visibility (CSS-pinned like the tooltip lesson — jsdom can't see hover; live smoke verifies), sheet CRUD flows in jsdom, route validation on the terminal sheet.
- Live smoke before merge: one jira source polled into Plan's queue; one card walked to a terminal column with publish-jira configured against a test project.

**Explicitly out of v1:** retiring the broker executor into swarm (follow-up), machine-wide polling dashboard, per-source poll history UI, webhook-push origins (polling only), group-owned sources.
