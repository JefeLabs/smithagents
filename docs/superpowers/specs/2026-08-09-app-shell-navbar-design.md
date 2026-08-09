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
activate(id) {
  const s = sessionManager.activate(id);   // this.activeId = id — a pointer swap
  if (!s) return `unknown session: ${id}`;
  brain.loadHistory(s.brainHistory);
  switchDiscord(s.workspace);
  textChannel.broadcast(sessionFrame());
  return null;
}
```

Cheap. No process is spawned. **Do not confuse the broker's conversation sessions with
the swarm's agent sessions** — only the latter are one-CLI-agent-each, and that invariant
is not in play here. This is why auto-activating on workspace selection is safe.

It is *not* side-effect-free, though: `switchDiscord(s.workspace)` rebinds the Discord
channel. Selecting a workspace therefore moves the crew's Discord presence. Intended, but
it means the selector reaches outside the UI.

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

## Non-goals

- No broker or swarm change. No new endpoints. Every action reuses existing wiring.
- No change to `api/`, `queries/`, or the socket store's frame handling.
- Not a redesign of the left rail's tools. The rail keeps its tools; only the logo moves.
- Cloud authentication itself. This design reserves the slot; it does not build login.

---

## Architecture

### `activeWorkspace` — one new piece of client state

Lives in `uiStore` as `activeWorkspace: string | null`, where `null` means
"All workspaces". Client-only: a workspace is a lens, not a runtime thing, and the broker
has no concept to persist against.

**Seeding.** On the first session frame, initialise it to that session's `workspace`. A
navbar selection overrides it thereafter. This is what avoids a "pick a workspace" empty
state on open — you land wherever you were working.

The seed must fire once, not on every frame, or a session frame arriving after a manual
selection would silently yank the lens back. Gate it on the store's own value still being
un-set rather than on a render-count ref.

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

### What reads `activeWorkspace`

| Surface | Today | After |
|---|---|---|
| `BoardStage` | own `scope` state + in-stage picker | reads `activeWorkspace`; **picker deleted** |
| `MapStage` | own workspace filter | reads `activeWorkspace` |
| `SessionsPanel` | workspace filter chips | chips follow `activeWorkspace` |
| Voice / chat | follows the active session | unchanged — the session follows the selection instead |

`BoardStage`'s existing scope-keyed reset effect (which clears `addingCard`, `cardTitle`
and `open` when scope changes) must now key on `activeWorkspace`. Its reasoning is
unchanged and documented at `BoardStage.tsx:213-219`; only the input moves.

### Navbar composition

Left to right:

1. **Logo** — moved out of `ToolRail`. Keeps its Home behaviour and its
   `aria-label="Home"`. The rail then starts with its first tool.
2. **Workspace selector** — lists un-archived workspaces plus "All workspaces".
3. *(spacer)*
4. **Alert icon** — count badge; press opens a list; each row navigates to its subject.
5. **Avatar** — renders only when `cloudMode` is true.

The navbar is a second landmark alongside the rails, so it needs its own `aria-label`
distinct from the rail's `"Tools and activity"`.

### Alerts

The alert icon aggregates conditions that already exist and are surfaced inconsistently
or not at all. It introduces **no new detection** — it is a view over derived state:

| Condition | Source today | Surfaced today |
|---|---|---|
| Agent's CLI engine inactive | `useEngineWarnings()` (`queries/health.ts`) | per-agent badge in the roster |
| Boards failed to load | `boardErrors` from `useBoards()` | inline in `BoardStage` |
| Jira push failed for a card | `card.jira.lastPushError` | a card-level class + title attribute |
| Broker disconnected | `socketStore.connected` | the composer goes quiet |

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

- `activeWorkspace` seeding: asserts it takes the first session frame's workspace, and
  that a **later** frame does not overwrite a manual selection.
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

1. **The Discord side effect.** `activate()` rebinds Discord to the session's workspace,
   so a workspace selection moves the crew's presence in a way the UI does not currently
   explain. Consider whether the selector should say so.
2. **Retiring `BoardStage`'s picker is a behaviour change**, not a refactor: aggregate
   scope stops being per-stage. Someone watching an aggregate board while chatting in one
   workspace will find the board follows the chat now.
3. **`CLOUD_MODE = false` is dead code until cloud lands.** Acceptable because it is one
   constant and one branch, but if the hosted switchboard slips indefinitely, this should
   be deleted rather than left as permanent scaffolding.
</content>
