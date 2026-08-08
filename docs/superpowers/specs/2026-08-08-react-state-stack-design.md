# React state stack: TanStack Query + React Hook Form + Zustand

**Status:** specced, not yet claimed for execution
**Branch:** `react-state-stack` (off `main` @ `c1308f4`)
**Scope:** `control-plane/` only — the sole React app in the repo

## Problem

The control plane has no state library, so it hand-rolls all three kinds of state
it actually has.

`hooks/useBrokerChat.ts` is 751 lines holding 11 `useState`, one WebSocket, and
38 `fetch` sites, returning a single object with **51 keys**. `HomePage` destructures
all of it, then drills ~20 of those functions as props into `SettingsPanel`
(`HomePage.tsx:338-370`), which re-drills them into `ApiKeysGroup`, `CliToolsGroup`,
`ChannelsGroup`, `VoiceGroup`, and `ContainersGroup`. Each leaf then writes its own
cache-and-error layer by hand:

```ts
useEffect(() => void listApiKeys().then(setKeys).catch(() => setKeys(null)), [])
```

That is a query library, written 38 times, five layers from where the data is used.

Two more symptoms of the same gap:

- **Fat-context re-renders.** `stageValue` (`HomePage.tsx:200`) is a fresh object
  literal every render, so every `useStage()` consumer — `VoiceStage`, `BoardStage`,
  `MapStage`, `WorkStage` — re-renders on every broker frame, including chatter only
  the voice stage cares about. Context has no selector.
- **Hand-rolled invalidation.** `lastBoardUpdate` / `lastCapabilityUpdate`
  (`useBrokerChat.ts:240-243`) are sequence counters that exist only to force
  `BoardStage` / `MapStage` to refetch, threaded through `StageContext` to do it.

Form state is equally hand-rolled: `AddAgentModal` carries 31 `useState` for 14
controlled inputs; `WorkspaceManagerModal` 11 for 16 inputs.

## The rule

> **Query owns what the broker owns. RHF owns what the user is typing. Zustand owns the rest.**

Everything below follows from that single boundary.

| Layer | Owner | Contents |
|---|---|---|
| Broker-owned | **TanStack Query** | session, sessions, workspaces, transcript, roster, workspace records, connectors, cli-tools, api-keys, containers, voice settings, me, execution modes, boards, capabilities, activity |
| User typing | **React Hook Form** | `AddAgentModal` (14 inputs), `WorkspaceManagerModal` (16), `NewWorkspaceModal` (10), `CardSheet` (10), `MapStage` (9), `ConnectorFormModal` (4), `NewSessionScreen` (3) |
| Neither | **Zustand** | socket lifecycle + `connected`, `soundOn` / `micLive` / `audioBlocked`, theme, grid params, UI shell (which modal/panel/composer is open) |

That zustand ends up holding only things no server has an opinion about is the
signal the boundary is drawn correctly.

## Findings that constrain the design

### 1. Three pushed entries have no GET endpoint

Enumerating the broker's routes (`broker/src/text-channel.ts`) turns up `GET /agents`
and `GET /workspaces`, but **no `GET /sessions` and no `GET /session`**. Session
state and the transcript exist *only* as WebSocket push frames.

So those are Query entries with nothing to call. TanStack v5's `skipToken` is the
supported shape: the query never fetches, stays `pending`, and is fed exclusively by
`setQueryData`.

### 2. `skipToken` deletes `sessionKnown`

`sessionKnown` (`useBrokerChat.ts:237`, with a five-line comment justifying it)
hand-rolls the difference between "haven't heard from the broker yet" and "broker
confirmed zero sessions." Query already models exactly that:

```ts
const { status, data } = useSession()
status === "pending"                    // was: !sessionKnown
status === "success" && data === null   // was: sessionKnown && session === null
```

The composer's forced-open condition (`HomePage.tsx:155`) collapses accordingly.

### 3. Frames split by payload, not by topic

- **Frame carries data → `setQueryData`**: `session` (carries session + sessions +
  workspaces + full transcript), `roster`, `utterance`, `speech`, `notice`
- **Frame carries only an id → `invalidateQueries`**: `board-updated`,
  `capability-updated`

The second case is what `boardSeq` / `capSeq` were faking. Refetch-on-push is
explicitly rejected for the first case — it would re-request over HTTP data the
frame already delivered.

### 4. Audio frames are not cache data

The `onAudio` ref (`useBrokerChat.ts:246`) feeds `useSpokenReplies` PCM at frame
rate. That stays a direct subscriber callback on the socket store — never
`setQueryData`.

## Dependencies

```
zustand                          5.0.14
@tanstack/react-query            5.101.4
@tanstack/react-query-devtools   5.101.4   (dev)
react-hook-form                  7.85.0
```

Installed with **pnpm** (control-plane's package manager).

**No `zod` / `@hookform/resolvers`.** Validation across these forms is "required,
non-empty, valid path" — RHF's built-in `rules` covers it. A schema layer for that
is weight without payoff. Revisit if validation grows real branching.

## Architecture

```
src/
  api/broker.ts              38 fetch sites → pure functions, zero React
  queries/
    keys.ts                  typed key factory
    useSession.ts            skipToken, socket-fed
    useRoster.ts             GET /agents, socket-refreshed
    useWorkspaces.ts  useConnectors.ts  useCliTools.ts
    useApiKeys.ts     useContainers.ts  useVoiceSettings.ts
    useBoards.ts      useCapabilities.ts
  stores/
    socketStore.ts           connection + send/mic + frame→cache wiring
    uiStore.ts               modals, panels, composer, tuner
    audioStore.ts            soundOn, micLive, audioBlocked
    reset.ts                 test-only: restore every store to initial
  providers/AppProviders.tsx
  test/renderWithProviders.tsx
```

Three layers, one direction of dependency: `api/` knows nothing about React;
`queries/` knows about `api/`; `stores/socketStore` knows about `queries/keys` and
the `QueryClient`. Nothing depends on `stores/uiStore` except components.

### Store topology

Domain stores as app-lifetime singletons via `create()`. No scoped/per-mount stores
are needed — RHF's `useForm` is per-mount by nature, which dissolves the wizard-reset
hazard that would otherwise apply to `AddAgentModal`.

## Deletions

- **`hooks/useBrokerChat.ts`** — 751 lines, 51 return keys
- **`hooks/StageContext.tsx`** — every field becomes a query key or a store selector,
  so stage routes stop needing a provider above them
- **~20 function props** threaded `HomePage → SettingsPanel → *Group`
  (`HomePage.tsx:338-370`); leaves call `useApiKeys()` directly
- `sessionKnown`, `lastBoardUpdate`, `lastCapabilityUpdate`, `boardSeq`, `capSeq`

Expected shape after: `HomePage` 425 → ~150 lines, `AddAgentModal` 31 `useState` →
RHF + ~4, `MapStage` 13 → ~3, `WorkspaceManagerModal` 11 → ~2, `CardSheet` 11 → ~2.

## Testing

38 test files exist. Two mechanical hazards:

- **Query needs a provider.** `test/renderWithProviders.tsx` supplies a fresh
  `QueryClient` per test (`retry: false`, `gcTime: 0`) so nothing leaks between cases.
- **Zustand stores are module singletons** — state survives across tests in the same
  file. `stores/reset.ts` plus a global `beforeEach` restores each store's initial
  state.

Tests currently mock `useBrokerChat` by passing fake functions as props. They instead
seed the cache — `qc.setQueryData(qk.apiKeys, [...])` — which is less setup than the
prop-mocking they replace.

## Sequencing

Single branch, single landing (`react-state-stack`, big bang). Internal work order:

1. deps + `AppProviders` + test helpers
2. `api/broker.ts` — extract all 38 fetch sites
3. `queries/` — key factory + hooks over every endpoint
4. `stores/` — socket, ui, audio
5. shell — `HomePage` + delete `StageContext`
6. stages — Board, Map, Voice, Work
7. modals — AddAgent, Workspace, NewWorkspace, CardSheet, Connector
8. delete `useBrokerChat.ts`

`pnpm test` runs throughout, but the intermediate states are not individually landed.

## Risks

- **Big bang across 38 test files is the real exposure** — no green checkpoint lands
  until the end. Accepted deliberately; mitigated by the fixed work order above.
- **StrictMode double-connect** — the socket currently opens in a `useEffect`. Moving
  it into a store requires `connect()` to be idempotent or refcounted, or dev mode
  opens two sockets.
- **`useSpokenReplies(messages, roster, !audioMode)`** consumes the transcript and
  roster positionally; it must be rewired to read both from Query.
- **`useSurfacePolicy` and `useCliToolHealth`** are independent fetchers not listed in
  `useBrokerChat`'s 51 keys; they fold into `queries/` as well.

## Out of scope

- No `zod` (see Dependencies)
- No changes to `broker/`, `swarm/`, or `voice/` — no new endpoints, including the
  absent `GET /sessions`; `skipToken` handles it client-side
- No visual or behavioral change. This is a state-plumbing migration; every surface
  must look and behave identically afterward.

## Acceptance criteria

1. `pnpm typecheck`, `pnpm lint`, and `pnpm test` all pass on the branch.
2. `useBrokerChat.ts` and `StageContext.tsx` no longer exist.
3. No component receives a broker fetch function as a prop.
4. In the seven RHF-migrated components, no `useState` backs a form field — remaining
   `useState` is limited to non-form concerns (e.g. `AddAgentModal`'s `step`,
   `BoardStage`'s `activeId`). Checked by review, not by grep count.
5. UI smoke: session create/activate, board drag + tab switch, map authoring, agent
   creation wizard, and every Settings group behave as they did on `c1308f4`.
