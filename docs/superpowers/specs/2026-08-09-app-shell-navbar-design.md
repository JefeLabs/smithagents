# App Shell Navbar — Design

**Status:** Approved to plan. Not started.
**Claimed by:** unclaimed — claim this header before executing
**Date:** 2026-08-09
**Surface:** `control-plane/` — app shell

Add a top navbar carrying the logo, a workspace selector, an alert icon, and (in cloud
mode) an operator avatar. The workspace selector becomes the app's single source of
workspace context, retiring the per-stage filters that own it today.

---

## Starting state (verified 2026-08-09)

- `ControlPlaneLayout.tsx` is a 6-slot fixed-position composition: `background`,
  `leftRail`, `rightRail`, `stage`, `hint`, `overlays`. There is no top slot.
- The **logo lives at the top of the left rail** (`ToolRail.tsx`), inside
  `<nav className="rail rail--left" aria-label="Tools and activity">`, and acts as Home.
- `ToolRail.tsx:30-31` carries an explicit prior decision:
  *"No operator avatar: there's no 'account' concept in an all-local, single-operator
  app — reintroduce it when cloud hosting makes identity meaningful."* This design is the
  sanctioned trigger for reversing it.
- **There is no global "current workspace."** Workspace context is owned three times,
  independently:
  - `BoardStage` holds `scope` state defaulting to `ALL_WORKSPACES`, with its own picker.
  - `MapStage` filters capabilities by workspace.
  - `SessionsPanel` has workspace filter chips.
- The *de facto* current workspace is `session.workspace` of the active session.
  `SessionSummary` carries `{id, title, workspace, updatedAt, active, runtime}`.
- **Cloud mode does not exist in the client.** The only trace in the repo is
  `swarm/src/server.ts:1707` describing it as a future seam. Nothing renders from it.

### What `activate()` actually does

`POST /sessions/:id/activate` → `broker/src/sessions.ts:106` and its caller at
`broker/src/main.ts:1030`:

```ts
const sessionRoutes = {
  activate(id) {
    const s = sessionManager.activate(id);   // this.activeId = id — a pointer swap
    if (!s) return `unknown session: ${id}`;
    brain.loadHistory(s.brainHistory);
    switchDiscord(s.workspace);
    textChannel.broadcast(sessionFrame());
    return null;
  },
};
```

Cheap. No process is spawned. **Do not confuse the broker's conversation sessions with
the swarm's agent sessions** — only the latter are one-CLI-agent-each, and that invariant
is not in play here. This is why auto-activating on workspace selection is safe.

`switchDiscord(s.workspace)` is worth understanding precisely, because it is easy to
read as more than it is. It sets `attendedDiscordWorkspace` and calls
`switchDiscordForWorkspace(name)` (`broker/src/main.ts:518-528`) — that is, it rebinds
**which workspace's Discord configuration the broker attends**: the bot token and the
text/voice channel lists that live on the workspace record and are edited in
`WorkspaceManagerModal`. Its documented purpose is so that a Discord-originated turn with
no active session lands in the workspace Discord is already attending rather than the
global default.

**It does not change which agents are in Discord.** Agent participation is per-agent
surface policy — `channels: {discord: "autojoin" | "on-request" | "disabled"}` on the
agent record, plus `POST /agents/:id/surfaces/:surface/join` — and is entirely
independent of workspaces. A workspace switch leaves every agent's surface policy and
presence untouched.

So the coupling is workspace → Discord *binding*, which is a workspace-level concern by
construction. Nothing about it is surprising and nothing about it needs UI copy.

---

## Decisions

1. **The workspace selector is the single source of workspace context.** Every stage
   reads it. `BoardStage`'s scope picker and `MapStage`'s filter are retired into it.
   Two controls that can disagree about which workspace Kanban is showing would be worse
   than today's three independent ones.
2. **Selecting a workspace activates that workspace's most recent session.** Chat follows
   the selection; it does not stay behind. Justified by the `activate()` reading above.
3. **The avatar ships as a slot gated on a `cloudMode` flag that is currently always
   false.** The component and its one gate are built now so the shell's layout is final;
   nothing renders until cloud is real.

## Goals

1. One workspace control instead of three.
2. A home for alert conditions that currently have none.
3. A shell whose layout does not need reshuffling when cloud identity lands.

## Two axes that must not be conflated

This design touches one of them and must leave the other alone.

**Workspace is a work-context lens.** Which boards, which story maps, which sessions.
It answers "what am I looking at". The navbar selector operates here, and nowhere else.

**Channels — Discord and the ones that follow — are how humans participate with the
crew.** They answer "how does a person reach these agents". Which agents appear on a
channel is per-agent surface policy (`channels: {discord: "autojoin" | "on-request" |
"disabled"}` on the agent record), set in the surface-policy popover, and it is
independent of workspaces entirely.

The one place the two touch is the broker's Discord *binding* — which workspace's bot
token and channel lists it is attending — and that is a workspace-level configuration by
construction, edited on the workspace record. It is not participation.

Concretely: **selecting a workspace must never change who is in a channel.** If a future
change to this surface would add or remove an agent from Discord, it has crossed into the
other axis and is out of scope.

### Why the control plane can be ambient and a channel cannot

In this app there is always an active session, so workspace context is **ambient** — the
user never states it, and `delegate` reads it off the session. That is the whole reason
this navbar can be a selector rather than a field on every instruction.

A channel has no such ambient. A Discord-originated turn arrives with no session of its
own, and today it falls back to `attendedDiscordWorkspace` — whichever workspace the
broker last switched to (`broker/src/main.ts:518-522`). That fallback is a guess, and a
guess about which workspace work lands in is the expensive kind.

**So on Discord the workspace context has to travel with the instruction**, not be
inferred from broker state. That is channel-adapter work and is **out of scope here** —
recorded because it is the boundary condition that explains why this design is safe: the
control plane may rely on ambient context precisely because it guarantees a session
exists, and no channel can make that guarantee.

A future channel-side change must not be built by making the navbar's lens global — that
would export an ambient the channel cannot honour.

## Non-goals

- No broker or swarm change. No new endpoints. Every action reuses existing wiring.
- No change to `api/`, `queries/`, or the socket store's frame handling.
- The left rail **is** rebuilt — on HeroUI `Sidebar`, with the logo moved to the navbar
  and the Plus repurposed from "New workspace" to "New session". What stays out of scope
  is changing *which* tools it offers: Sessions, Board, Map and Settings keep their
  meaning and their destinations.
- The **right** rail (`AgentRoster`) is untouched. It stays fixed-position and is HeroUI
  Phase 2 work, along with the last dnd-kit usage it carries.
- Cloud authentication itself. This design reserves the slot; it does not build login.

---

## Architecture

### There is already a source of truth: the active session

The workspace that matters is not a UI concept. It is already authoritative in the
broker, and it already governs real work (`broker/src/main.ts:288-298`):

```js
const executors = {
// Delegations land in the active session's workspace unless the brain names one.
delegate: (input) => broker.executors.delegate({
  ...input,
  workspace: input.workspace ?? sessionManager.activeOrNull()?.workspace ?? defaultWorkspaceName
}),
// Scoped to the current conversation's workspace only — never model-choosable.
lookup_ticket: (input) => broker.executors.lookup_ticket({
  ...input, workspace: sessionManager.activeOrNull()?.workspace ?? defaultWorkspaceName
}),
};
```

So the chain **instruction → session → workspace → dispatched work** exists and is
enforced server-side. Agents therefore do **not** carry a workspace of their own, and this
design must not give them one. An agent's current workspace is a property of the work it
was handed, derived from the session that handed it over.

**Consequence for this design: the navbar introduces no new source of truth.** The lens
*is* the active session's workspace, read from the session frame the socket store already
writes into the query cache:

```ts
const { data: session } = useSession();
const lensWorkspace = session?.workspace ?? null;
```

Selecting a workspace does not set a variable — it activates a session, the broker
broadcasts a new session frame, and every surface follows. One direction of flow, no
client copy to drift.

This is also the real justification for Decision 2. Selecting a workspace *must* activate
a session, because otherwise the thing you are looking at and the thing your next
instruction would act on could disagree — and the instruction would silently win.

**"All workspaces"** is the one thing with no session to represent it. It is a
**view-only** override in `uiStore` (`aggregateView: boolean`), read exclusively by
`BoardStage`'s aggregate rendering. It never affects dispatch, and it never changes the
active session. If that override is on, the navbar still shows which session is active,
because that is still where work would land.

### Selecting a workspace

```
select(X):
  uiStore.activeWorkspace = X
  sessions = all sessions where session.workspace === X
  if sessions is non-empty:
      activateSession(most recent by updatedAt)
  else:
      openComposer(locked: X)
```

Both branches are flows that already exist and are already wired — `SessionsPanel` calls
`api.activateSession` and `uiStore.openComposer(ws)` today. This design adds no new
network call.

`null` ("All workspaces") selects no session and leaves the active one alone: it is a
viewing lens across every workspace, which is what `BoardStage`'s aggregate scope already
means.

### The selector is context-aware: one active workspace, many viewed

Edwin, 2026-08-09: *"this would allow to select multiple workspaces on one kanban view."*

This is not two behaviours bolted onto one control. It surfaces a split the rest of this
design already implies: **the dropdown does two different jobs, and only on the voice
stage do they coincide.**

| Job                   | Cardinality         | Drives                                                                                |
| --------------------- | ------------------- | ------------------------------------------------------------------------------------- |
| **Active workspace**  | exactly one, always | the active session, and therefore every delegation, `lookup_ticket` and `search_docs` |
| **Viewed workspaces** | one or more         | what Board and Map render — nothing else                                              |

You cannot activate three sessions, so the first can never be a set. But looking at three
workspaces' boards at once requires activating nothing, so the second was never really
bound to one.

**Behaviour by stage:**

- **Voice / chat** — single-select only. Picking a workspace activates its newest session,
  exactly as described above. Viewing and dispatch are the same thing here.
- **Board / Map** — the active workspace is still single-select and still shown as such,
  and additional workspaces can be toggled *into the view*. The active session is
  untouched by those toggles.

**"All workspaces" becomes the degenerate case** of the same mechanism rather than a
separate mode — it is "every workspace selected", not a magic sentinel. The
`aggregateView: boolean` this spec proposed earlier is replaced by
`viewedWorkspaces: ReadonlySet<string> | "*"` in `uiStore`, still view-only, still never
affecting dispatch.

**Why this is cheap: the rendering already exists.** `tabsFor(boards, scope)`
(`src/lib/board-aggregate.ts:67`) already emits `clustered: true` tabs that span several
workspaces' boards — that is what `ALL_WORKSPACES` produces today. Multiselect is a
narrower input to a path that is already built and already tested. The filter changes
from an equality check to a set membership check:

```ts
// today — scope is a single name
const matchesToday = boards.filter(
  (b) => b.type === type && (all ? Boolean(b.workspaceId) : b.workspaceId === scope),
);
// multi — scope is a set
const matchesMulti = boards.filter(
  (b) => b.type === type && (all ? Boolean(b.workspaceId) : selected.has(b.workspaceId ?? "")),
);
```

and `clustered` becomes `all || selected.size > 1`.

**Creating anything while viewing many: one rule, applied everywhere.**

Multiselect makes every *create* affordance ambiguous — if you are looking at three
workspaces' boards and press "new session", which workspace does it belong to? Edwin
raised this about the rail's Plus, and it is the same question the add-card control
already faces.

So it gets one answer, not two:

> **You may look at many, but you may only create in one. When the view is unambiguous,
> create there silently. When it is not, ask.**

Concretely, and both of these already have the wiring:

- **Rail Plus → new session.** `openComposer(locked?)` locks the workspace when given a
  name and leaves the picker open when not. So: `openComposer(activeWorkspace)` when
  exactly one workspace is viewed, `openComposer()` — unlocked, user picks — when several
  are. `NewSessionScreen` already renders a workspace picker when `lockedWorkspace` is
  undefined; nothing new is built.
- **Board add-card.** Already hidden under `ALL_WORKSPACES` scope
  (`addable={scope === ALL_WORKSPACES ? [] : …}`). Extend the same condition to "more than
  one workspace viewed" rather than inventing a second rule.

Note this is *not* the same as falling back to the active workspace. Defaulting silently
to the active session's workspace would be unambiguous to the code and surprising to the
user, who is looking at three boards and has no reason to expect one of them to win. The
ambiguity is real, so surface it rather than resolving it by convention.

**Two rules this must not break:**

- **Cards still resolve by `cardId`, never by the tab's board.** A tab spanning three
  workspaces makes this more load-bearing, not less — `BoardStage` already looks up
  `boards.find((b) => b.cards.some((c) => c.id === cardId))` for exactly this reason.
- **Creating a card needs an unambiguous target.** Today the add control is hidden under
  `ALL_WORKSPACES` scope (`addable={scope === ALL_WORKSPACES ? [] : …}`). The same rule
  applies whenever more than one workspace is viewed: **you may look at many, but you may
  only add to one.** Hide the add control unless exactly one workspace is selected.

### Saved workspace groups — specced, deliberately NOT in this plan

Edwin, 2026-08-09: *"allow user to define custom groupings of workspaces to generate
custom views, but still allow selecting single workspaces."*

Coherent, and it fits the split above without straining it: **a group is a view, never a
dispatch target.** Selecting one changes what Board and Map render and leaves the active
session exactly where it was — the same rule multiselect follows. Single-workspace
selection is unaffected and still activates a session.

**A saved group is a named multiselect.** That is not a simplification, it is the whole
implementation: the mechanism it needs is `viewedWorkspaces`, which does not exist yet.
So this is strictly downstream — not a preference about ordering, a dependency. Build
multiselect, live with it, then decide whether ad-hoc selection is actually painful
enough to warrant saved groups and a management UI.

The dropdown would then have three kinds of entry, which is the point at which its
information design needs real thought rather than another bullet in this spec:

- individual workspaces — single-select, activates a session
- saved groups — multi-view, activates nothing
- "All workspaces" — the degenerate group

**The real decision is persistence, and it is not obvious.**

| Option                                   | Cost                                                                                  | Consequence                                                                                                                                           |
| ---------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client-only (`uiStore` + `localStorage`) | zero broker change; honours this spec's current non-goals                             | groups are per-browser. Lost on another machine, lost on a cache clear. A group you built across eight workspaces is real work to lose.               |
| On `MeRecord`                            | small broker change — one field; `GET`/`PUT /me` already exist and PUT already merges | groups follow the operator, survive reinstall, and are already in the right shape for the hosted switchboard, where "operator" becomes a real account |

**Recommendation: `MeRecord`.** Groups are operator preference, and operator preference
should follow the operator rather than the browser. `MeRecord` is `{id, name, connectors}`
today with a live merging PUT, so this is adding a field to an existing record — not a new
endpoint, and not a schema invention.

That does break this spec's *"No broker or swarm change"* non-goal. Recorded as a
decision for Edwin rather than resolved here — and one that only needs making when this
work actually starts, which is after the navbar ships.

### "New workspace…" lives in the selector

The dropdown's last item opens the create-workspace flow (`setNewWorkspaceOpen(true)`).
Creating a workspace is a workspace-switching action — you make one in order to work in
it — so the control that switches workspaces is where it belongs, and it is the
conventional place users look for it.

**`ToolRail`'s Plus tool is repurposed, not deleted** — see below.

### The rail becomes a HeroUI `Sidebar`

Edwin, 2026-08-09. `ToolRail` is rebuilt on `Sidebar` rather than kept as a hand-rolled
`<nav className="rail rail--left">`. This pulls the rail's migration forward out of HeroUI
Phase 2 — correct, because this design already restructures it (logo out, Plus
repurposed) and doing both at once avoids touching it twice.

**The one thing that makes this bigger than a component swap.** `Sidebar.Provider` owns
layout: `.sidebar__provider` is `flex min-h-svh w-full` and `Sidebar.Main` is `flex-1`.
The current shell is fixed-position throughout — `.rail--left` and `.rail--right` are
fixed, the dot-grid canvas is a fixed underlay, and the board/map stages clear the rails
with `inset 0 72px`. Adopting `Sidebar` converts the left side of the shell from
fixed-position to flow.

Consequences, all of which are work rather than blockers:

- `ControlPlaneLayout` restructures: `Sidebar.Provider` wraps, `Sidebar` replaces the
  `leftRail` slot, and `Sidebar.Main` holds everything else. The `topBar`, `rightRail`,
  `stage` and `overlays` slots keep their meaning.
- **The stages' `inset 0 72px` no longer applies on the left** — the sidebar takes real
  width instead of being overlaid. The right inset still clears the roster rail, which
  stays fixed and is Phase 2 work.
- The **dot-grid canvas must stay a fixed underlay behind everything**, not a flow child.
  It is `position: fixed` today and should remain so.

**What comes for free, and is why this is worth doing:**

- `collapsible="icon"` collapses to a 48px icon-only rail with automatic tooltips per
  item — which is what the rail already is at 72px, except it now also has a real
  expanded state with labels. `defaultOpen={false}` preserves today's icon-only feel.
- Client-side routing is documented for TanStack Router specifically:
  `<Sidebar.Provider navigate={(href) => router.navigate({ to: href })}>` with `href` and
  `isCurrent` on items. That **retires `ToolRail`'s `activeRoute` string comparison** —
  the `tool.route !== null && tool.route === activeRoute` check becomes `isCurrent`.
- `Sidebar.Mobile` renders a Sheet below 768px, which the fixed rail never did.

**Two things to decide during implementation, not now:**

- `toggleShortcut` defaults to `mod+b`. The app already binds a bare `g` for the grid
  tuner (`HomePage.tsx:165-171`), so there is no collision today — but if the app ever
  grows a command palette, disable it with `toggleShortcut={false}` rather than fighting it.
- `Sidebar.MenuItem` is built on RAC `TreeItem`, which **cannot render as an `<a>`** by
  HTML spec. Navigation is programmatic. Any test asserting a link role must become a
  press assertion.

### The rail's Plus becomes "New session"

The Plus at `ToolRail.tsx:7` stops meaning "New workspace" and becomes **"New session"**,
opening the composer locked to the current workspace:

```tsx
<ToolRail onNewSession={() => openComposer(session?.workspace)} />
```

`openComposer(locked)` already exists and already does exactly this — `NewSessionScreen`
reads `lockedWorkspace={composer?.locked}`, so passing the current workspace pins the new
session to it. No new wiring.

This gives the shell a clean split, which is the reason to have two chrome surfaces at
all rather than one:

| Surface   | Question it answers                                                         |
| --------- | --------------------------------------------------------------------------- |
| Navbar    | **Which workspace** am I in — switch it, or make a new one                  |
| Left rail | **What do I do in it** — new session, browse sessions, board, map, settings |

Creating a workspace is a switching action, so it sits in the switcher. Creating a session
is work *inside* the current workspace, so it sits with the tools. Neither surface has an
affordance that belongs to the other.

`SessionsPanel` keeps its own create entry — that is browse-then-create, a different
intent from the rail's create-now, and both already route through `openComposer`.

`NewWorkspaceModal` itself is unchanged. Its `onCreated(name)` already calls
`openComposer(name)`, so a workspace created from the selector lands the user in a
composer for it — which is exactly the "select a workspace with no sessions" path, and
arrives there without a special case.

### What follows the session's workspace

| Surface         | Today                               | After                                                                  |
| --------------- | ----------------------------------- | ---------------------------------------------------------------------- |
| `BoardStage`    | own `scope` state + in-stage picker | reads the session's workspace (or `aggregateView`); **picker deleted** |
| `MapStage`      | own workspace filter                | reads the session's workspace                                          |
| `SessionsPanel` | workspace filter chips              | chips follow the session's workspace                                   |
| Voice / chat    | follows the active session          | unchanged — the session follows the selection instead                  |

`BoardStage`'s existing scope-keyed reset effect (which clears `addingCard`, `cardTitle`
and `open` when scope changes) must now key on the session's workspace. Its reasoning is
unchanged and documented at `BoardStage.tsx:213-219`; only the input moves.

### Navbar composition

Left to right:

1. **Logo** — moved out of `ToolRail`. Keeps its Home behaviour and its
   `aria-label="Home"`. The rail then starts with its first tool.
2. **Workspace selector** — lists un-archived workspaces, "All workspaces", and
   **"New workspace…"** as its final item.
3. *(spacer)*
4. **Alert icon** — count badge; press opens a list; each row navigates to its subject.
5. **Avatar** — renders only when `cloudMode` is true.

The navbar is a second landmark alongside the rails, so it needs its own `aria-label`
distinct from the rail's `"Tools and activity"`.

### Alerts

The alert icon aggregates conditions that already exist and are surfaced inconsistently
or not at all. It introduces **no new detection** — it is a view over derived state:

| Condition                   | Source today                                | Surfaced today                       |
| --------------------------- | ------------------------------------------- | ------------------------------------ |
| Agent's CLI engine inactive | `useEngineWarnings()` (`queries/health.ts`) | per-agent badge in the roster        |
| Boards failed to load       | `boardErrors` from `useBoards()`            | inline in `BoardStage`               |
| Jira push failed for a card | `card.jira.lastPushError`                   | a card-level class + title attribute |
| Broker disconnected         | `socketStore.connected`                     | the composer goes quiet              |

Derive the aggregate the way `useEngineWarnings` already does — a pure function over
existing query data, in `queries/`, not a fetch. Invalidating any underlying key then
refreshes the badge with no bespoke refresh path.

`voiceNotice` is deliberately excluded: it is transient and self-dismissing after 6s, and
belongs to the moment rather than to a list you review later.

### Cloud mode

One exported flag, read in one place:

```ts
/**
 * Cloud mode is not implemented. The hosted switchboard (see the hosted-switchboard
 * direction) is what will make operator identity meaningful; until then this is false
 * and the avatar never renders.
 *
 * Deliberately a single constant rather than a query: there is no endpoint to ask, and
 * inventing one would be building the seam twice.
 */
export const CLOUD_MODE = false;
```

When cloud lands this becomes a real signal. Everything downstream of it — the avatar,
its menu, its login affordance — is written against the flag, not against the constant.

---

## Testing

- The lens follows the session frame: a frame naming workspace X puts Board, Map and the
  sessions list on X, with no client-side workspace variable involved.
- Selecting a workspace with sessions activates the most recent by `updatedAt`.
- Selecting a workspace with no sessions opens the composer locked to it and activates
  nothing.
- Selecting "All workspaces" leaves the active session untouched.
- `BoardStage` and `MapStage` render the selected workspace's content, driven by the
  store rather than by an in-stage control.
- The alert aggregate is a pure function and is tested as one, table-driven, the way
  `computeEngineWarnings` already is.
- The avatar does not render while `CLOUD_MODE` is false.

The two stages' existing suites must keep passing. Where they drive the retired in-stage
picker, they change to setting `activeWorkspace` — a test-only change to *how* the
workspace is chosen, never to what is then asserted.

## Sequencing against the HeroUI migration

This touches `ControlPlaneLayout`, `ToolRail`, `BoardStage` and `MapStage`. The last two
are exactly what **HeroUI Phase 1c** migrates.

**Build the navbar first.** Phase 1c then inherits a `BoardStage` that no longer owns its
scope, which is strictly less to migrate. The reverse order does the scope retirement
twice — once against the dnd-kit implementation and again after.

Phase 1a (workspace creation) is independent of this and can proceed in parallel; it
touches neither stage.

## Risks

1. **Retiring `BoardStage`'s picker is a behaviour change**, not a refactor: aggregate
   scope stops being per-stage. Someone watching an aggregate board while chatting in one
   workspace will find the board follows the chat now.
2. **`CLOUD_MODE = false` is dead code until cloud lands.** Acceptable because it is one
   constant and one branch, but if the hosted switchboard slips indefinitely, this should
   be deleted rather than left as permanent scaffolding.
