# React State Stack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the control plane's hand-rolled state layer with TanStack Query (broker-owned data), React Hook Form (user input), and Zustand (everything else), deleting `useBrokerChat.ts` and `StageContext.tsx`.

**Architecture:** Three layers with one dependency direction. `src/api/` holds React-free fetch functions. `src/queries/` wraps them in `useQuery`/`useMutation` behind a typed key factory. `src/stores/` holds a Zustand socket store that owns the WebSocket and writes frames into the Query cache, plus UI and audio stores. Components read via selectors and query hooks; nothing receives a broker fetch function as a prop.

**Tech Stack:** React 19, TypeScript 5.6 (strict), TanStack Router 1.170, TanStack Query 5.101, React Hook Form 7.85, Zustand 5.0, Vitest 4 + jsdom, Testing Library, Biome.

**Spec:** `docs/superpowers/specs/2026-08-08-react-state-stack-design.md`

## Global Constraints

- **Package manager is pnpm, never npm.** All commands run from `control-plane/`.
- **Lint/format is Biome**, not ESLint/Prettier: `pnpm lint`, `pnpm format`.
- **Exact versions:** `zustand@5.0.14`, `@tanstack/react-query@5.101.4`, `@tanstack/react-query-devtools@5.101.4` (dev), `react-hook-form@7.85.0`.
- **No `zod`, no `@hookform/resolvers`** in this branch. Form validation uses RHF's built-in `rules`. API schema validation is a separate follow-up branch.
- **No changes to `broker/`, `swarm/`, or `voice/`.** No new endpoints. The absent `GET /sessions` is handled client-side with `skipToken`.
- **No visual or behavioral change.** Every surface must look and behave exactly as on `main` @ `c1308f4`.
- **Broker base is `127.0.0.1:7790`.** Keep it a single exported constant; never inline it.
- `pnpm typecheck` (`tsc --noEmit`), `pnpm lint`, and `pnpm test` must all pass before every commit.
- Branch is `react-state-stack`, already created off `main` @ `c1308f4`.

## File Structure

| Path | Responsibility |
|---|---|
| `src/api/types.ts` | Every shared broker type. No logic, no React. |
| `src/api/broker.ts` | All 38 fetch sites as pure async functions. No React. |
| `src/queries/keys.ts` | Typed query-key factory — the single source of key truth. |
| `src/queries/http.ts` | Query/mutation hooks over HTTP-backed endpoints. |
| `src/queries/pushed.ts` | `skipToken` queries fed only by WebSocket frames. |
| `src/stores/socketStore.ts` | WebSocket lifecycle, `send`/mic, frame → cache wiring. |
| `src/stores/uiStore.ts` | Modals, panels, composer, tuner, grid params. |
| `src/stores/audioStore.ts` | `soundOn`, `micLive`, `audioBlocked`. |
| `src/stores/reset.ts` | Test-only: restore every store to initial state. |
| `src/providers/AppProviders.tsx` | `QueryClientProvider` + devtools. |
| `src/test/setup.ts` | Global `beforeEach` store reset; jest-dom matchers. |
| `src/test/renderWithProviders.tsx` | Render helper with a fresh `QueryClient`. |

**Deleted by the end:** `src/hooks/useBrokerChat.ts`, `src/hooks/useBrokerChat.test.ts`, `src/hooks/StageContext.tsx`, `src/hooks/StageContext.test.tsx`, `src/hooks/useCliToolHealth.ts`.

---

### Task 1: Extract shared types to `src/api/types.ts`

`useBrokerChat.ts` is doing double duty as the app's type module. **35 files reference it, but only `HomePage.tsx:112` and the test files actually call the hook** — the other 33 import types only. Extracting types first is mechanical, touches zero logic, and unblocks every later task.

**Files:**
- Create: `src/api/types.ts`
- Modify: `src/hooks/useBrokerChat.ts:1-170` (remove type declarations, import + re-export them)
- Test: no new test — existing suite is the regression gate

**Interfaces:**
- Produces: 19 exported types consumed by every later task — `ChatMessage`, `SpeechProfile`, `AudioFrame`, `RosterAgent`, `BrokerIdentityInfo`, `ComposeOp`, `ExecutionMode`, `SessionSummary`, `SessionFrame`, `ConnectorFieldDef`, `ConnectorVendorMeta`, `ConnectorInstanceRecord`, `WorkspaceRecord`, `MeRecord`, `ChannelsRecord`, `VoiceSettingsRecord`, `CliToolStatusRecord`, `CliToolListing`, `ApiKeyListing`

- [ ] **Step 1: Create the types module**

Move all 19 `export interface` / `export type` declarations from `src/hooks/useBrokerChat.ts` (lines 8–170) into `src/api/types.ts` **verbatim, including their doc comments**. Do not rewrite, rename, or "improve" any of them — this task must be a pure move.

The file begins:

```ts
/**
 * Every shared broker type. Kept React-free and dependency-free so both the
 * fetch layer (api/broker.ts) and the socket store can import it without
 * pulling in hooks.
 */

export interface ChatMessage {
  id: number;
  role: "user" | "broker" | "notice";
  text: string;
}

// ... the remaining 18 declarations, moved verbatim
```

- [ ] **Step 2: Re-export from the old location so nothing breaks yet**

At the top of `src/hooks/useBrokerChat.ts`, replace the deleted declarations with:

```ts
export type {
  ApiKeyListing,
  AudioFrame,
  BrokerIdentityInfo,
  ChannelsRecord,
  ChatMessage,
  CliToolListing,
  CliToolStatusRecord,
  ComposeOp,
  ConnectorFieldDef,
  ConnectorInstanceRecord,
  ConnectorVendorMeta,
  ExecutionMode,
  MeRecord,
  RosterAgent,
  SessionFrame,
  SessionSummary,
  SpeechProfile,
  VoiceSettingsRecord,
  WorkspaceRecord,
} from "../api/types";
```

Then add a value import for the ones the hook body uses:

```ts
import type {
  ApiKeyListing, AudioFrame, BrokerIdentityInfo, ChannelsRecord, ChatMessage,
  CliToolListing, ComposeOp, ConnectorInstanceRecord, ConnectorVendorMeta,
  ExecutionMode, MeRecord, RosterAgent, SessionFrame, SessionSummary,
  VoiceSettingsRecord, WorkspaceRecord,
} from "../api/types";
```

This keeps all 33 type importers compiling untouched.

- [ ] **Step 3: Verify nothing moved semantically**

Run: `pnpm typecheck && pnpm test`
Expected: typecheck clean, all 38 test files pass. If any type error appears, a declaration was altered during the move — diff it against `git show HEAD:src/hooks/useBrokerChat.ts`.

- [ ] **Step 4: Re-point the 33 type importers**

Rewrite each import that reads `from "../hooks/useBrokerChat"` (or `"./useBrokerChat"` / `"../../hooks/useBrokerChat"`) to the matching relative path for `src/api/types`. Find them with:

```bash
grep -rln "hooks/useBrokerChat\|\./useBrokerChat" src --include="*.ts" --include="*.tsx"
```

Leave `src/pages/HomePage.tsx`, `src/pages/HomePage.test.tsx`, `src/router.test.tsx`, and `src/hooks/useBrokerChat.test.ts` alone — they import the hook itself and get handled in later tasks.

- [ ] **Step 5: Remove the compatibility re-export**

Delete the `export type { ... } from "../api/types"` block added in Step 2. The hook keeps only its own `import type` line.

- [ ] **Step 6: Verify**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all pass. Test count unchanged (38 files).

- [ ] **Step 7: Commit**

```bash
git add src/api/types.ts src/hooks/useBrokerChat.ts src
git commit -m "refactor: extract broker types to api/types.ts"
```

---

### Task 2: Dependencies, providers, and the test harness

Nothing else can be tested until Query has a provider and Zustand singletons reset between tests. This task installs, wires, and proves both.

**Files:**
- Modify: `control-plane/package.json`, `control-plane/vitest.config.ts`
- Create: `src/providers/AppProviders.tsx`, `src/test/setup.ts`, `src/test/renderWithProviders.tsx`, `src/stores/reset.ts`
- Modify: `src/main.tsx`
- Test: `src/test/renderWithProviders.test.tsx`

**Interfaces:**
- Consumes: nothing
- Produces: `AppProviders({ children, client? })`, `renderWithProviders(ui, opts?): { client: QueryClient } & RenderResult`, `registerStoreReset(fn: () => void): void`, `resetAllStores(): void`

- [ ] **Step 1: Install**

```bash
cd control-plane
pnpm add zustand@5.0.14 @tanstack/react-query@5.101.4 react-hook-form@7.85.0
pnpm add -D @tanstack/react-query-devtools@5.101.4
```

- [ ] **Step 2: Write the store-reset registry**

Create `src/stores/reset.ts`:

```ts
/**
 * Zustand stores created with create() are module singletons, so their state
 * survives across tests in the same file. Every store registers its own
 * restore-to-initial function here, and the global test setup calls
 * resetAllStores() before each test.
 */
const resetters = new Set<() => void>();

export function registerStoreReset(fn: () => void): void {
  resetters.add(fn);
}

export function resetAllStores(): void {
  for (const reset of resetters) reset();
}
```

- [ ] **Step 3: Write the providers**

Create `src/providers/AppProviders.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

/**
 * Broker data is pushed over the WebSocket, so background refetching would
 * re-request what a frame already delivered. Refetch-on-focus and refetch-on-
 * reconnect are off app-wide; the socket store is the update path.
 */
export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { refetchOnWindowFocus: false, refetchOnReconnect: false, retry: 1 },
    },
  });
}

const appClient = makeQueryClient();

export function AppProviders({ children, client }: { children: ReactNode; client?: QueryClient }) {
  return <QueryClientProvider client={client ?? appClient}>{children}</QueryClientProvider>;
}
```

- [ ] **Step 4: Write the test setup**

Create `src/test/setup.ts`:

```ts
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";
import { resetAllStores } from "../stores/reset";

beforeEach(() => resetAllStores());
afterEach(() => cleanup());
```

- [ ] **Step 5: Point vitest at the setup file**

Rewrite `control-plane/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/test/setup.ts"],
  },
});
```

- [ ] **Step 6: Write the render helper**

Create `src/test/renderWithProviders.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, type RenderOptions, type RenderResult } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";

/**
 * A fresh QueryClient per test — retry off so failures surface immediately
 * instead of after backoff, gcTime 0 so nothing leaks between cases.
 * Returns the client so tests can seed the cache with setQueryData.
 */
export function renderWithProviders(
  ui: ReactElement,
  options?: RenderOptions & { client?: QueryClient },
): RenderResult & { client: QueryClient } {
  const client =
    options?.client ??
    new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0, refetchOnWindowFocus: false } },
    });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { ...render(ui, { wrapper, ...options }), client };
}
```

- [ ] **Step 7: Write the failing test**

Create `src/test/renderWithProviders.test.tsx`:

```tsx
import { useQuery } from "@tanstack/react-query";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithProviders } from "./renderWithProviders";

function Probe() {
  const { data } = useQuery({ queryKey: ["probe"], queryFn: async () => "live" });
  return <div>{data ?? "pending"}</div>;
}

describe("renderWithProviders", () => {
  it("supplies a QueryClient so hooks can run", async () => {
    renderWithProviders(<Probe />);
    expect(await screen.findByText("live")).toBeInTheDocument();
  });

  it("hands back the client so tests can seed the cache", async () => {
    const { client } = renderWithProviders(<Probe />);
    client.setQueryData(["probe"], "seeded");
    expect(await screen.findByText("seeded")).toBeInTheDocument();
  });

  it("isolates caches between renders", async () => {
    const first = renderWithProviders(<Probe />);
    first.client.setQueryData(["probe"], "first");
    const second = renderWithProviders(<Probe />);
    expect(second.client.getQueryData(["probe"])).toBeUndefined();
  });
});
```

- [ ] **Step 8: Run it**

Run: `pnpm test src/test/renderWithProviders.test.tsx`
Expected: PASS, 3 tests. If the jest-dom matchers are missing, `setupFiles` is not wired — recheck Step 5.

- [ ] **Step 9: Mount the provider in the app**

In `src/main.tsx`, wrap the existing root render in `<AppProviders>`. Import it from `./providers/AppProviders`. Change nothing else — the router stays exactly where it is, above and below unchanged.

- [ ] **Step 10: Verify and commit**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all pass; test file count is now 39.

```bash
git add package.json pnpm-lock.yaml vitest.config.ts src/providers src/test src/stores/reset.ts src/main.tsx
git commit -m "feat: add query/rhf/zustand deps, providers, and test harness"
```

---

### Task 3: Extract every fetch site into `src/api/broker.ts`

All 38 `fetch` calls become plain async functions with no React. This is the file the zod follow-up will later add schemas to, so it must stay hook-free.

**Files:**
- Create: `src/api/broker.ts`
- Test: `src/api/broker.test.ts`

**Interfaces:**
- Consumes: every type from `src/api/types.ts` (Task 1)
- Produces: `BROKER_BASE` plus these exact functions, each taking `base: string = BROKER_BASE` as its **last** parameter:

```ts
getAgents(base?): Promise<{ agents: RosterAgent[]; identity: BrokerIdentityInfo | null }>
getWorkspaces(base?): Promise<string[]>
getWorkspaceRecords(base?): Promise<WorkspaceRecord[]>
saveWorkspace(body: WorkspaceRecord, isNew: boolean, base?): Promise<{ error?: string; name?: string }>
removeWorkspace(name: string, base?): Promise<{ outcome?: string; error?: string }>
verifyWorkspaceAtlassian(name: string, base?): Promise<{ ok?: boolean; detail?: string; error?: string }>
verifyRepoGithub(name: string, repoName: string, base?): Promise<{ ok?: boolean; detail?: string; error?: string }>
getWorkspaceChannels(name: string, base?): Promise<ChannelsRecord>
saveWorkspaceChannels(name: string, body: Partial<ChannelsRecord> & { discordToken?: string }, base?): Promise<ChannelsRecord & { error?: string }>
verifyWorkspaceDiscord(name: string, base?): Promise<{ ok?: boolean; detail?: string; error?: string }>
getVoiceSettings(base?): Promise<VoiceSettingsRecord>
saveVoiceSettings(body: { stt?: { instanceId: string } | null; tts?: { instanceId: string } | null; hideInactive?: boolean }, base?): Promise<VoiceSettingsRecord & { error?: string }>
getMe(base?): Promise<MeRecord>
updateMe(body: { name?: string }, base?): Promise<MeRecord & { error?: string }>
getConnectorVendors(base?): Promise<ConnectorVendorMeta[]>
getMyConnectors(base?): Promise<ConnectorInstanceRecord[]>
addConnector(body: { vendorId: string; label: string; fields: Record<string, string | boolean> }, base?): Promise<ConnectorInstanceRecord & { error?: string }>
updateConnector(id: string, body: { label?: string; fields?: Record<string, string | boolean> }, base?): Promise<ConnectorInstanceRecord & { error?: string }>
deleteConnector(id: string, base?): Promise<{ ok?: boolean; error?: string }>
verifyConnector(id: string, extra?: Record<string, string>, base?): Promise<{ ok?: boolean; detail?: string; error?: string }>
getCliTools(base?): Promise<CliToolListing[]>
refreshCliTools(tool?: string, base?): Promise<CliToolListing[]>
setCliToolEnabled(id: string, enabled: boolean, base?): Promise<CliToolListing[] | { error: string }>
getExecutionModes(base?): Promise<Record<ExecutionMode, boolean>>
getContainers(base?): Promise<{ docker: { enabled: boolean } }>
setDockerEnabled(enabled: boolean, base?): Promise<{ docker: { enabled: boolean } }>
verifyContainers(base?): Promise<{ ok: boolean; detail: string }>
getApiKeys(base?): Promise<ApiKeyListing[]>
saveApiKey(id: string, key: string, base?): Promise<ApiKeyListing[] | { error: string }>
verifyApiKey(id: string, base?): Promise<ApiKeyListing[] | { error: string }>
deleteApiKey(id: string, base?): Promise<ApiKeyListing[] | { error: string }>
getActivity(name: string, base?): Promise<{ busy: boolean; label?: string; output?: string }>
postWorkAction(name: string, action: "steer" | "cancel", message?: string, base?): Promise<string | null>
getRemovalPreview(id: string, base?): Promise<{ outcome?: "delete" | "archive"; reasons?: string[]; error?: string }>
deleteAgent(id: string, base?): Promise<{ outcome?: string; error?: string }>
postSession(base: string, workspace: string, runtime: ExecutionMode, prompt: string): Promise<{ error?: string; status?: number }>
activateSession(id: string, base?): Promise<void>
resetSetup(base?): Promise<void>
```

`postSession` and `getExecutionModes` already exist as module-level exports in `useBrokerChat.ts` (lines 194 and 214) — **move them verbatim**, keeping `postSession`'s existing base-first parameter order so its current test keeps passing.

- [ ] **Step 1: Write the failing test**

Create `src/api/broker.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { getApiKeys, getWorkspaceRecords, saveApiKey, setCliToolEnabled } from "./broker";

afterEach(() => vi.unstubAllGlobals());

function stubJson(body: unknown, ok = true, status = 200) {
  const fetchMock = vi.fn(async () => ({ ok, status, json: async () => body }) as unknown as Response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("broker api", () => {
  it("unwraps the envelope key for list endpoints", async () => {
    stubJson({ keys: [{ id: "google", label: "Google" }] });
    const keys = await getApiKeys();
    expect(keys).toHaveLength(1);
    expect(keys[0]?.id).toBe("google");
  });

  it("returns [] when an envelope key is absent rather than throwing", async () => {
    stubJson({});
    expect(await getWorkspaceRecords()).toEqual([]);
  });

  it("posts the typed key to the right url", async () => {
    const fetchMock = stubJson({ keys: [] });
    await saveApiKey("google", "sk-live-123");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api-keys/google");
    expect(JSON.parse(String(init.body))).toEqual({ key: "sk-live-123" });
  });

  it("surfaces a broker error body instead of the parsed list", async () => {
    stubJson({ error: "unknown tool" }, false, 400);
    expect(await setCliToolEnabled("nope", true)).toEqual({ error: "unknown tool" });
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm test src/api/broker.test.ts`
Expected: FAIL — `Failed to resolve import "./broker"`.

- [ ] **Step 3: Write the module**

Create `src/api/broker.ts`. Port each function from `useBrokerChat.ts` by **lifting the body out of its `useCallback` unchanged** — same URL, method, headers, envelope key, and error handling. Do not "improve" error handling; the spec forbids behavior change.

Header and two representative shapes:

```ts
import type {
  ApiKeyListing, BrokerIdentityInfo, ChannelsRecord, CliToolListing,
  ConnectorInstanceRecord, ConnectorVendorMeta, ExecutionMode, MeRecord,
  RosterAgent, VoiceSettingsRecord, WorkspaceRecord,
} from "./types";

export const BROKER_BASE = "127.0.0.1:7790";

/** GET /api-keys — provider keys joined with redacted machine state. */
export async function getApiKeys(base: string = BROKER_BASE): Promise<ApiKeyListing[]> {
  const res = await fetch(`http://${base}/api-keys`);
  return ((await res.json()) as { keys?: ApiKeyListing[] }).keys ?? [];
}

/** PUT /api-keys/:id — returns the refreshed listing, or {error} on rejection. */
export async function saveApiKey(
  id: string,
  key: string,
  base: string = BROKER_BASE,
): Promise<ApiKeyListing[] | { error: string }> {
  const res = await fetch(`http://${base}/api-keys/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key }),
  });
  const body = (await res.json()) as { keys?: ApiKeyListing[]; error?: string };
  if (!res.ok || body.error) return { error: body.error ?? `broker returned ${res.status}` };
  return body.keys ?? [];
}
```

Work through the full signature list above in order. Cross-check each against its original by line number using `git show HEAD:src/hooks/useBrokerChat.ts`.

- [ ] **Step 4: Run the tests**

Run: `pnpm test src/api/broker.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Verify and commit**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all pass. `useBrokerChat.ts` is untouched and still works — this task only adds a parallel module.

```bash
git add src/api/broker.ts src/api/broker.test.ts
git commit -m "feat: extract broker fetch layer to api/broker.ts"
```

---

### Task 4: Query key factory and HTTP-backed query hooks

**Files:**
- Create: `src/queries/keys.ts`, `src/queries/http.ts`
- Test: `src/queries/http.test.tsx`

**Interfaces:**
- Consumes: everything from `src/api/broker.ts` (Task 3), `renderWithProviders` (Task 2)
- Produces: `qk` key factory; query hooks `useWorkspaceRecords`, `useWorkspaceChannels(name)`, `useConnectorVendors`, `useMyConnectors`, `useCliTools`, `useApiKeys`, `useContainers`, `useVoiceSettings`, `useMe`, `useExecutionModes`, `useActivity(name)`; mutation hooks `useSaveApiKey`, `useVerifyApiKey`, `useDeleteApiKey`, `useSetCliToolEnabled`, `useRefreshCliTools`, `useSaveWorkspace`, `useRemoveWorkspace`, `useAddConnector`, `useUpdateConnector`, `useDeleteConnector`, `useVerifyConnector`, `useSaveVoiceSettings`, `useUpdateMe`, `useSetDockerEnabled`, `useVerifyContainers`, `useSaveWorkspaceChannels`, `useVerifyWorkspaceDiscord`, `useVerifyWorkspaceAtlassian`, `useVerifyRepoGithub`

- [ ] **Step 1: Write the key factory**

Create `src/queries/keys.ts`:

```ts
/**
 * Every query key in the app. Centralised so an invalidation in the socket
 * store and a read in a component can never drift apart.
 */
export const qk = {
  session: ["session"] as const,
  sessions: ["sessions"] as const,
  workspaces: ["workspaces"] as const,
  transcript: ["transcript"] as const,
  roster: ["roster"] as const,
  workspaceRecords: ["workspace-records"] as const,
  workspaceChannels: (name: string) => ["workspace-channels", name] as const,
  connectorVendors: ["connector-vendors"] as const,
  myConnectors: ["my-connectors"] as const,
  cliTools: ["cli-tools"] as const,
  apiKeys: ["api-keys"] as const,
  containers: ["containers"] as const,
  voiceSettings: ["voice-settings"] as const,
  me: ["me"] as const,
  executionModes: ["execution-modes"] as const,
  activity: (name: string) => ["activity", name] as const,
  board: (id: string) => ["board", id] as const,
  boards: ["boards"] as const,
  capability: (id: string) => ["capability", id] as const,
  capabilities: ["capabilities"] as const,
};
```

- [ ] **Step 2: Write the failing test**

Create `src/queries/http.test.tsx`:

```tsx
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../test/renderWithProviders";
import { qk } from "./keys";
import { useApiKeys, useSaveApiKey } from "./http";

afterEach(() => vi.unstubAllGlobals());

function Probe() {
  const { data = [] } = useApiKeys();
  const save = useSaveApiKey();
  return (
    <div>
      <span data-testid="count">{data.length}</span>
      <button type="button" onClick={() => save.mutate({ id: "google", key: "sk-1" })}>
        save
      </button>
    </div>
  );
}

describe("http queries", () => {
  it("reads from the cache when it is seeded", async () => {
    const { client } = renderWithProviders(<Probe />);
    client.setQueryData(qk.apiKeys, [{ id: "google" }, { id: "openai" }]);
    expect(await screen.findByTestId("count")).toHaveTextContent("2");
  });

  it("a successful mutation invalidates its list so the UI refetches", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ keys: [{ id: "google" }] }) }) as unknown as Response),
    );
    const { client } = renderWithProviders(<Probe />);
    client.setQueryData(qk.apiKeys, []);
    await userEvent.click(screen.getByRole("button", { name: "save" }));
    expect(await screen.findByTestId("count")).toHaveTextContent("1");
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `pnpm test src/queries/http.test.tsx`
Expected: FAIL — `Failed to resolve import "./http"`.

- [ ] **Step 4: Write the hooks**

Create `src/queries/http.ts`. Every query hook is the same three-line shape; every mutation invalidates the list it affects.

```ts
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as api from "../api/broker";
import type { ApiKeyListing } from "../api/types";
import { qk } from "./keys";

export function useApiKeys() {
  return useQuery({ queryKey: qk.apiKeys, queryFn: () => api.getApiKeys() });
}

/**
 * The broker returns the refreshed list on success, so we write it straight
 * into the cache rather than invalidating and re-requesting what we just got.
 * An {error} response leaves the cache untouched and surfaces via mutation.data.
 */
export function useSaveApiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, key }: { id: string; key: string }) => api.saveApiKey(id, key),
    onSuccess: (result) => {
      if (Array.isArray(result)) qc.setQueryData<ApiKeyListing[]>(qk.apiKeys, result);
    },
  });
}
```

Write the remaining hooks from the Interfaces list following those two patterns:

- **Query hooks** (`useQuery`, `queryFn` calling the matching `api.*`): `useWorkspaceRecords` → `qk.workspaceRecords`, `useWorkspaceChannels(name)` → `qk.workspaceChannels(name)`, `useConnectorVendors` → `qk.connectorVendors`, `useMyConnectors` → `qk.myConnectors`, `useCliTools` → `qk.cliTools`, `useContainers` → `qk.containers`, `useVoiceSettings` → `qk.voiceSettings`, `useMe` → `qk.me`, `useExecutionModes` → `qk.executionModes`, `useActivity(name)` → `qk.activity(name)`.
- **Verify mutations** (fire-and-report; they return `{ok, detail}` and mutate no cache, so they have no `onSuccess` — the component reads `mutation.data`): `useVerifyConnector`, `useVerifyContainers`, `useVerifyWorkspaceDiscord`, `useVerifyWorkspaceAtlassian`, `useVerifyRepoGithub`.
- **List-returning mutations** (write the result back with `setQueryData` when `Array.isArray(result)`): `useVerifyApiKey`, `useDeleteApiKey` → `qk.apiKeys`; `useSetCliToolEnabled`, `useRefreshCliTools` → `qk.cliTools`.
- **Record-returning mutations** (write back when the result has no `error`): `useSaveVoiceSettings` → `qk.voiceSettings`, `useUpdateMe` → `qk.me`, `useSetDockerEnabled` → `qk.containers`, `useSaveWorkspaceChannels` → `qk.workspaceChannels(name)`.
- **Invalidating mutations** (the broker returns no list, so invalidate): `useSaveWorkspace`, `useRemoveWorkspace` → invalidate `qk.workspaceRecords` **and** `qk.workspaces`; `useAddConnector`, `useUpdateConnector`, `useDeleteConnector` → invalidate `qk.myConnectors` and `qk.me`.

- [ ] **Step 5: Run the tests**

Run: `pnpm test src/queries/http.test.tsx`
Expected: PASS, 2 tests.

- [ ] **Step 6: Verify and commit**

Run: `pnpm typecheck && pnpm lint && pnpm test`

```bash
git add src/queries
git commit -m "feat: add query key factory and http query hooks"
```

---

### Task 5: Push-only queries via `skipToken`

The broker has **no `GET /session` and no `GET /sessions`** — session state and the transcript arrive only as WebSocket frames. `skipToken` models that honestly: the query never fetches, stays `pending` until a frame lands, and is fed by `setQueryData`.

This is what deletes `sessionKnown`.

**Files:**
- Create: `src/queries/pushed.ts`
- Test: `src/queries/pushed.test.tsx`

**Interfaces:**
- Consumes: `qk` (Task 4), `renderWithProviders` (Task 2)
- Produces:
  - `useSession(): UseQueryResult<{ id: string; title: string; workspace: string; runtime: ExecutionMode } | null>`
  - `useSessions(): UseQueryResult<SessionSummary[]>`
  - `useWorkspaces(): UseQueryResult<string[]>`
  - `useTranscript(): UseQueryResult<ChatMessage[]>`
  - `useRoster(): UseQueryResult<{ agents: RosterAgent[]; identity: BrokerIdentityInfo | null }>`
  - `useSessionKnown(): boolean` — `true` once the first session frame has landed

- [ ] **Step 1: Write the failing test**

Create `src/queries/pushed.test.tsx`:

```tsx
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithProviders } from "../test/renderWithProviders";
import { qk } from "./keys";
import { useSession, useSessionKnown } from "./pushed";

function Probe() {
  const { data } = useSession();
  const known = useSessionKnown();
  return <div data-testid="state">{!known ? "unknown" : data === null ? "known-zero" : data.id}</div>;
}

describe("pushed queries", () => {
  it("starts unknown — never fetches, so it cannot resolve on its own", async () => {
    renderWithProviders(<Probe />);
    expect(await screen.findByTestId("state")).toHaveTextContent("unknown");
  });

  it("distinguishes a confirmed zero-session state from not-heard-yet", async () => {
    const { client } = renderWithProviders(<Probe />);
    client.setQueryData(qk.session, null);
    expect(await screen.findByTestId("state")).toHaveTextContent("known-zero");
  });

  it("reports the active session id once a frame lands", async () => {
    const { client } = renderWithProviders(<Probe />);
    client.setQueryData(qk.session, { id: "s1", title: "t", workspace: "w", runtime: "local-in-process" });
    expect(await screen.findByTestId("state")).toHaveTextContent("s1");
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm test src/queries/pushed.test.tsx`
Expected: FAIL — `Failed to resolve import "./pushed"`.

- [ ] **Step 3: Write the module**

Create `src/queries/pushed.ts`:

```ts
import { skipToken, useQuery } from "@tanstack/react-query";
import * as api from "../api/broker";
import type {
  BrokerIdentityInfo, ChatMessage, ExecutionMode, RosterAgent, SessionSummary,
} from "../api/types";
import { qk } from "./keys";

type ActiveSession = { id: string; title: string; workspace: string; runtime: ExecutionMode } | null;

/**
 * The broker exposes no GET for session state — it exists only as a WS frame.
 * skipToken means this query never fetches; the socket store fills it with
 * setQueryData. Until then it stays `pending`, which is exactly the
 * "haven't heard from the broker yet" state the old `sessionKnown` flag
 * hand-rolled.
 */
export function useSession() {
  return useQuery<ActiveSession>({ queryKey: qk.session, queryFn: skipToken, staleTime: Infinity });
}

/** True once the first session frame has been processed — replaces `sessionKnown`. */
export function useSessionKnown(): boolean {
  return useSession().status === "success";
}

export function useSessions() {
  return useQuery<SessionSummary[]>({ queryKey: qk.sessions, queryFn: skipToken, staleTime: Infinity });
}

export function useTranscript() {
  return useQuery<ChatMessage[]>({ queryKey: qk.transcript, queryFn: skipToken, staleTime: Infinity });
}

/**
 * Workspaces and roster DO have GETs (`GET /workspaces`, `GET /agents`), so
 * they get a real queryFn as a first-paint and reconnect fallback. The socket
 * frame is still the fast path and overwrites via setQueryData.
 */
export function useWorkspaces() {
  return useQuery<string[]>({ queryKey: qk.workspaces, queryFn: () => api.getWorkspaces() });
}

export function useRoster() {
  return useQuery<{ agents: RosterAgent[]; identity: BrokerIdentityInfo | null }>({
    queryKey: qk.roster,
    queryFn: () => api.getAgents(),
  });
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test src/queries/pushed.test.tsx`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/queries/pushed.ts src/queries/pushed.test.tsx
git commit -m "feat: add skipToken queries for websocket-pushed broker state"
```

---

### Task 6: The socket store

Owns the WebSocket, the reconnect backoff, `send`/`compose`/mic control, and the frame → cache wiring. **Connect must be idempotent** — React StrictMode mounts effects twice in dev, and two sockets would double every frame.

**Files:**
- Create: `src/stores/socketStore.ts`
- Test: `src/stores/socketStore.test.ts`

**Interfaces:**
- Consumes: `qk` (Task 4), `registerStoreReset` (Task 2), types (Task 1)
- Produces: `useSocketStore` with state `{ connected: boolean }` and actions `connect(qc: QueryClient, base?: string): void`, `disconnect(): void`, `send(text: string): void`, `compose(op: ComposeOp): void`, `micControl(type: "mic-start" | "mic-stop"): void`, `micAudio(pcm: ArrayBuffer): void`, `onAudioFrame(fn: (frame: AudioFrame) => void): () => void`

- [ ] **Step 1: Write the failing test**

Create `src/stores/socketStore.test.ts`:

```ts
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { qk } from "../queries/keys";
import { useSocketStore } from "./socketStore";

class FakeSocket {
  static last: FakeSocket | null = null;
  static count = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: unknown[] = [];
  constructor() {
    FakeSocket.last = this;
    FakeSocket.count++;
  }
  send(d: unknown) { this.sent.push(d); }
  close() { this.onclose?.(); }
}

beforeEach(() => {
  FakeSocket.count = 0;
  FakeSocket.last = null;
  vi.stubGlobal("WebSocket", FakeSocket);
});
afterEach(() => {
  useSocketStore.getState().disconnect();
  vi.unstubAllGlobals();
});

describe("socketStore", () => {
  it("opens exactly one socket even when connect is called twice (StrictMode)", () => {
    const qc = new QueryClient();
    useSocketStore.getState().connect(qc);
    useSocketStore.getState().connect(qc);
    expect(FakeSocket.count).toBe(1);
  });

  it("writes a session frame into the query cache instead of refetching", () => {
    const qc = new QueryClient();
    useSocketStore.getState().connect(qc);
    FakeSocket.last?.onmessage?.({
      data: JSON.stringify({
        type: "session",
        session: { id: "s1", title: "t", workspace: "w", runtime: "local-in-process" },
        sessions: [],
        workspaces: ["w"],
        transcript: [{ role: "user", text: "hi" }],
      }),
    });
    expect(qc.getQueryData(qk.session)).toMatchObject({ id: "s1" });
    expect(qc.getQueryData(qk.workspaces)).toEqual(["w"]);
    expect(qc.getQueryData(qk.transcript)).toHaveLength(1);
  });

  it("appends an utterance to the transcript rather than replacing it", () => {
    const qc = new QueryClient();
    qc.setQueryData(qk.transcript, [{ id: 0, role: "user", text: "first" }]);
    useSocketStore.getState().connect(qc);
    FakeSocket.last?.onmessage?.({ data: JSON.stringify({ type: "speech", text: "second" }) });
    expect(qc.getQueryData(qk.transcript)).toHaveLength(2);
  });

  it("invalidates rather than writes for id-only frames", () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    useSocketStore.getState().connect(qc);
    FakeSocket.last?.onmessage?.({ data: JSON.stringify({ type: "board-updated", boardId: "b1" }) });
    expect(spy).toHaveBeenCalledWith({ queryKey: qk.board("b1") });
  });

  it("routes audio frames to subscribers, never to the cache", () => {
    const qc = new QueryClient();
    const heard: unknown[] = [];
    useSocketStore.getState().connect(qc);
    const off = useSocketStore.getState().onAudioFrame((f) => heard.push(f));
    FakeSocket.last?.onmessage?.({ data: JSON.stringify({ type: "audio", mime: "audio/mp3", dataB64: "AA" }) });
    expect(heard).toHaveLength(1);
    off();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm test src/stores/socketStore.test.ts`
Expected: FAIL — `Failed to resolve import "./socketStore"`.

- [ ] **Step 3: Write the store**

Create `src/stores/socketStore.ts`. Port the frame handling from `useBrokerChat.ts:249-320` unchanged in behavior, redirecting each `setX` to a cache write.

```ts
import type { QueryClient } from "@tanstack/react-query";
import { create } from "zustand";
import { BROKER_BASE } from "../api/broker";
import type { AudioFrame, ChatMessage, ComposeOp, SessionFrame } from "../api/types";
import { qk } from "../queries/keys";
import { registerStoreReset } from "./reset";

const RECONNECT_MS = 2000;

interface SocketState {
  connected: boolean;
  connect: (qc: QueryClient, base?: string) => void;
  disconnect: () => void;
  send: (text: string) => void;
  compose: (op: ComposeOp) => void;
  micControl: (type: "mic-start" | "mic-stop") => void;
  micAudio: (pcm: ArrayBuffer) => void;
  onAudioFrame: (fn: (frame: AudioFrame) => void) => () => void;
}

// Module-scoped, not store state: these are imperative handles, and putting a
// live socket in reactive state would notify every subscriber on reconnect.
let socket: WebSocket | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let disposed = false;
let nextId = 0;
const audioSubs = new Set<(frame: AudioFrame) => void>();

function append(qc: QueryClient, role: ChatMessage["role"], text: string) {
  qc.setQueryData<ChatMessage[]>(qk.transcript, (list = []) => [...list, { id: nextId++, role, text }]);
}

export const useSocketStore = create<SocketState>((set, get) => ({
  connected: false,

  connect: (qc, base = BROKER_BASE) => {
    if (socket) return; // idempotent — StrictMode double-mounts this
    disposed = false;
    const open = () => {
      const ws = new WebSocket(`ws://${base}/events`);
      socket = ws;
      ws.onopen = () => set({ connected: true });
      ws.onmessage = (e) => {
        const frame = JSON.parse(String(e.data)) as
          | { type: "utterance" | "speech" | "notice"; text: string }
          | { type: "roster"; agents: unknown[]; identity?: unknown }
          | { type: "config"; audio: boolean }
          | ({ type: "audio" } & AudioFrame)
          | { type: "board-updated"; boardId: string }
          | { type: "capability-updated"; capabilityId: string }
          | SessionFrame;

        switch (frame.type) {
          case "session":
            qc.setQueryData(qk.session, frame.session);
            qc.setQueryData(qk.sessions, frame.sessions);
            qc.setQueryData(qk.workspaces, frame.workspaces);
            nextId = 0;
            qc.setQueryData<ChatMessage[]>(
              qk.transcript,
              frame.transcript.map((t) => ({ id: nextId++, role: t.role, text: t.text })),
            );
            return;
          case "roster":
            qc.setQueryData(qk.roster, { agents: frame.agents, identity: frame.identity ?? null });
            return;
          case "audio":
            for (const fn of audioSubs) fn(frame);
            return;
          case "board-updated":
            qc.invalidateQueries({ queryKey: qk.board(frame.boardId) });
            return;
          case "capability-updated":
            qc.invalidateQueries({ queryKey: qk.capability(frame.capabilityId) });
            return;
          case "notice":
            append(qc, "notice", frame.text);
            return;
          case "utterance":
            append(qc, "user", frame.text);
            return;
          case "speech":
            append(qc, "broker", frame.text);
            return;
          default:
            return;
        }
      };
      ws.onclose = () => {
        set({ connected: false });
        socket = null;
        if (!disposed) timer = setTimeout(open, RECONNECT_MS);
      };
      ws.onerror = () => ws.close();
    };
    open();
  },

  disconnect: () => {
    disposed = true;
    if (timer) clearTimeout(timer);
    timer = null;
    socket?.close();
    socket = null;
    set({ connected: false });
  },

  send: (text) => socket?.send(JSON.stringify({ type: "utterance", text })),
  compose: (op) => socket?.send(JSON.stringify({ type: "compose", ...op })),
  micControl: (type) => socket?.send(JSON.stringify({ type })),
  micAudio: (pcm) => socket?.send(pcm),

  onAudioFrame: (fn) => {
    audioSubs.add(fn);
    return () => audioSubs.delete(fn);
  },
}));

registerStoreReset(() => {
  useSocketStore.getState().disconnect();
  audioSubs.clear();
  nextId = 0;
  useSocketStore.setState({ connected: false });
});
```

Cross-check `send` and `compose` payload shapes against `useBrokerChat.ts:330-350` before moving on — a wrong frame type silently no-ops.

- [ ] **Step 4: Run the tests**

Run: `pnpm test src/stores/socketStore.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Verify and commit**

Run: `pnpm typecheck && pnpm lint && pnpm test`

```bash
git add src/stores/socketStore.ts src/stores/socketStore.test.ts
git commit -m "feat: add socket store wiring broker frames into the query cache"
```

---

### Task 7: UI and audio stores

**Files:**
- Create: `src/stores/uiStore.ts`, `src/stores/audioStore.ts`
- Test: `src/stores/uiStore.test.ts`

**Interfaces:**
- Consumes: `registerStoreReset` (Task 2), `GridParams`/`GRID_DEFAULTS` from `src/hooks/useDotGrid.ts`
- Produces:
  - `useUiStore` — state `{ modalOpen, editingId, tunerOpen, gridParams, sessionsOpen, composer, settingsOpen, workspacesOpen, newWorkspaceOpen, removing, voiceNotice }`; actions `openAddAgent()`, `openEditAgent(id)`, `closeAgentModal()`, `toggleTuner()`, `setGridParam(key, value)`, `resetGrid()`, `toggleSessions()`, `closeSessions()`, `openComposer(locked?)`, `closeComposer()`, `setSettingsOpen(open)`, `setWorkspacesOpen(open)`, `setNewWorkspaceOpen(open)`, `setRemoving(next)`, `setVoiceNotice(text | null)`
  - `useAudioStore` — state `{ soundOn, micLive, audioBlocked }`; actions `toggleSound()`, `setMicLive(live)`, `setAudioBlocked(blocked)`

- [ ] **Step 1: Write the failing test**

Create `src/stores/uiStore.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { GRID_DEFAULTS } from "../hooks/useDotGrid";
import { useUiStore } from "./uiStore";

describe("uiStore", () => {
  it("the + button always creates, never edits", () => {
    useUiStore.getState().openEditAgent("manuel");
    useUiStore.getState().closeAgentModal();
    useUiStore.getState().openAddAgent();
    expect(useUiStore.getState().editingId).toBeNull();
    expect(useUiStore.getState().modalOpen).toBe(true);
  });

  it("closing the agent modal clears the edit target", () => {
    useUiStore.getState().openEditAgent("manuel");
    useUiStore.getState().closeAgentModal();
    expect(useUiStore.getState().editingId).toBeNull();
    expect(useUiStore.getState().modalOpen).toBe(false);
  });

  it("opening the composer with a locked workspace pins it", () => {
    useUiStore.getState().openComposer("acme");
    expect(useUiStore.getState().composer).toEqual({ locked: "acme" });
  });

  it("resetGrid restores every default", () => {
    useUiStore.getState().setGridParam("gap", 999);
    useUiStore.getState().resetGrid();
    expect(useUiStore.getState().gridParams).toEqual(GRID_DEFAULTS);
  });

  it("state does not leak between tests", () => {
    expect(useUiStore.getState().modalOpen).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm test src/stores/uiStore.test.ts`
Expected: FAIL — `Failed to resolve import "./uiStore"`.

- [ ] **Step 3: Write the UI store**

Create `src/stores/uiStore.ts`:

```ts
import { create } from "zustand";
import type { AgentSeed } from "../data/agents";
import { GRID_DEFAULTS, type GridParams } from "../hooks/useDotGrid";
import { registerStoreReset } from "./reset";

/** Agent slated for removal; `outcome` stays unset until a preview succeeds. */
export interface RemovalTarget {
  entry: AgentSeed;
  outcome?: "delete" | "archive";
  reasons: string[];
  error?: string;
  busy?: boolean;
}

interface UiState {
  modalOpen: boolean;
  editingId: string | null;
  tunerOpen: boolean;
  gridParams: GridParams;
  sessionsOpen: boolean;
  composer: { locked?: string } | null;
  settingsOpen: boolean;
  workspacesOpen: boolean;
  newWorkspaceOpen: boolean;
  removing: RemovalTarget | null;
  voiceNotice: string | null;
  openAddAgent: () => void;
  openEditAgent: (id: string) => void;
  closeAgentModal: () => void;
  toggleTuner: () => void;
  setGridParam: (key: keyof GridParams, value: number) => void;
  resetGrid: () => void;
  toggleSessions: () => void;
  closeSessions: () => void;
  openComposer: (locked?: string) => void;
  closeComposer: () => void;
  setSettingsOpen: (open: boolean) => void;
  setWorkspacesOpen: (open: boolean) => void;
  setNewWorkspaceOpen: (open: boolean) => void;
  setRemoving: (next: RemovalTarget | null | ((prev: RemovalTarget | null) => RemovalTarget | null)) => void;
  setVoiceNotice: (text: string | null) => void;
}

const initial = {
  modalOpen: false,
  editingId: null,
  tunerOpen: false,
  gridParams: GRID_DEFAULTS,
  sessionsOpen: false,
  composer: null,
  settingsOpen: false,
  workspacesOpen: false,
  newWorkspaceOpen: false,
  removing: null,
  voiceNotice: null,
} satisfies Partial<UiState>;

export const useUiStore = create<UiState>((set) => ({
  ...initial,
  openAddAgent: () => set({ modalOpen: true, editingId: null }),
  openEditAgent: (id) => set({ modalOpen: true, editingId: id }),
  closeAgentModal: () => set({ modalOpen: false, editingId: null }),
  toggleTuner: () => set((s) => ({ tunerOpen: !s.tunerOpen })),
  setGridParam: (key, value) => set((s) => ({ gridParams: { ...s.gridParams, [key]: value } })),
  resetGrid: () => set({ gridParams: GRID_DEFAULTS }),
  toggleSessions: () => set((s) => ({ sessionsOpen: !s.sessionsOpen })),
  closeSessions: () => set({ sessionsOpen: false }),
  openComposer: (locked) => set({ composer: { locked } }),
  closeComposer: () => set({ composer: null }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setWorkspacesOpen: (workspacesOpen) => set({ workspacesOpen }),
  setNewWorkspaceOpen: (newWorkspaceOpen) => set({ newWorkspaceOpen }),
  setRemoving: (next) =>
    set((s) => ({ removing: typeof next === "function" ? next(s.removing) : next })),
  setVoiceNotice: (voiceNotice) => set({ voiceNotice }),
}));

registerStoreReset(() => useUiStore.setState(initial));
```

- [ ] **Step 4: Write the audio store**

Create `src/stores/audioStore.ts`:

```ts
import { create } from "zustand";
import { registerStoreReset } from "./reset";

interface AudioState {
  soundOn: boolean;
  micLive: boolean;
  audioBlocked: boolean;
  toggleSound: () => void;
  setMicLive: (live: boolean) => void;
  setAudioBlocked: (blocked: boolean) => void;
}

const initial = { soundOn: true, micLive: false, audioBlocked: false };

export const useAudioStore = create<AudioState>((set) => ({
  ...initial,
  toggleSound: () => set((s) => ({ soundOn: !s.soundOn })),
  setMicLive: (micLive) => set({ micLive }),
  setAudioBlocked: (audioBlocked) => set({ audioBlocked }),
}));

registerStoreReset(() => useAudioStore.setState(initial));
```

Check `src/hooks/useSpokenReplies.ts` for the current `soundOn` default before committing to `true` — mirror whatever it uses today.

- [ ] **Step 5: Run the tests**

Run: `pnpm test src/stores/uiStore.test.ts`
Expected: PASS, 5 tests. The last one proves the global reset works.

- [ ] **Step 6: Verify and commit**

Run: `pnpm typecheck && pnpm lint && pnpm test`

```bash
git add src/stores/uiStore.ts src/stores/uiStore.test.ts src/stores/audioStore.ts
git commit -m "feat: add ui and audio stores"
```

---

### Task 8: Migrate `HomePage` and delete `StageContext`

The keystone. `HomePage` drops from 425 lines and 14 `useState` to roughly 150 lines and zero. `StageContext` disappears because every field it carried is now a query key or a store selector.

**Files:**
- Modify: `src/pages/HomePage.tsx` (whole file), `src/router.tsx:1-90`
- Delete: `src/hooks/StageContext.tsx`, `src/hooks/StageContext.test.tsx`
- Modify: `src/pages/HomePage.test.tsx`, `src/router.test.tsx`
- Modify: every stage organism that called `useStage()` — `VoiceStage.tsx`, `BoardStage.tsx`, `MapStage.tsx`, `WorkStage.tsx`

**Interfaces:**
- Consumes: `useSocketStore` (Task 6), `useUiStore`/`useAudioStore` (Task 7), `useSession`/`useSessions`/`useWorkspaces`/`useTranscript`/`useRoster`/`useSessionKnown` (Task 5), `useExecutionModes`/`useWorkspaceRecords` (Task 4)
- Produces: a `HomePage` with no broker props passed to any child

- [ ] **Step 1: Connect the socket at app scope**

In `src/pages/HomePage.tsx`, replace the `useBrokerChat` call with:

```tsx
const qc = useQueryClient();
const connect = useSocketStore((s) => s.connect);
const disconnect = useSocketStore((s) => s.disconnect);
useEffect(() => {
  connect(qc);
  return () => disconnect();
}, [qc, connect, disconnect]);
```

`connect` is idempotent (Task 6), so StrictMode's double-invoke opens one socket.

- [ ] **Step 2: Replace the state cluster with selectors**

Delete all 14 `useState` calls at `HomePage.tsx:33-57`, `:123`, and `:134`. Read each value from the UI store with a **narrow selector** — one field per call, never the whole store, or you reintroduce the re-render problem the migration exists to fix:

```tsx
const modalOpen = useUiStore((s) => s.modalOpen);
const editingId = useUiStore((s) => s.editingId);
const openAddAgent = useUiStore((s) => s.openAddAgent);
// ...one per field actually used in this component
```

- [ ] **Step 3: Replace the composer-visible condition**

The old condition (`HomePage.tsx:155`) needed `sessionKnown`. Replace with:

```tsx
const { data: session, status: sessionStatus } = useSession();
const composer = useUiStore((s) => s.composer);
const connected = useSocketStore((s) => s.connected);
// A confirmed zero-session broker forces the composer open; "not heard yet" does not.
const composerVisible =
  composer !== null || (connected && sessionStatus === "success" && session === null);
```

Delete the five-line comment about `sessionKnown` — it documents a flag that no longer exists.

- [ ] **Step 4: Delete the modes/records refetch effect**

Remove the `useEffect` at `HomePage.tsx:158-166` and the `modes`/`wsRecords` state. `NewSessionScreen` calls `useExecutionModes()` and `useWorkspaceRecords()` itself in Task 9. Query's `staleTime` handles the "refetch when it reopens" requirement that effect was written for.

- [ ] **Step 5: Delete `StageContext` and rewire the stages**

```bash
git rm src/hooks/StageContext.tsx src/hooks/StageContext.test.tsx
```

Remove `<StageProvider value={stageValue}>` and the whole `stageValue` object (`HomePage.tsx:200-218`) from `HomePage`. In `src/router.tsx`, delete the `useStage()` calls and pass nothing — each stage now reads what it needs directly:

- `VoiceStage` → `useTranscript()`, `useRoster()`, `useSocketStore((s) => s.send)`, `useAudioStore`
- `BoardStage` → `useRoster()` and its own board queries (Task 10)
- `MapStage` → its own capability queries (Task 10)
- `WorkStage` → `useRoster()`, `useActivity(name)`, and a work-action mutation

- [ ] **Step 6: Rewrite `HomePage.test.tsx`**

The old suite module-mocks `useBrokerChat` and hands back a 51-key object (`HomePage.test.tsx:38-60`). Replace that with cache seeding — mock only the socket store's `connect` so no real WebSocket opens:

```tsx
vi.mock("../stores/socketStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../stores/socketStore")>();
  return actual; // real store; connect() is a no-op because WebSocket is stubbed below
});

beforeEach(() => {
  vi.stubGlobal("WebSocket", class { close() {} } as unknown as typeof WebSocket);
});

it("forces the composer open when the broker confirms zero sessions", async () => {
  const { client } = renderWithProviders(<HomePage />);
  useSocketStore.setState({ connected: true });
  client.setQueryData(qk.session, null);
  client.setQueryData(qk.sessions, []);
  client.setQueryData(qk.workspaces, ["acme"]);
  expect(await screen.findByRole("heading", { name: /new session/i })).toBeInTheDocument();
});
```

Preserve every existing assertion's **intent**; only the setup mechanism changes. Where a test previously set `sessionKnown: true`, it now seeds `qk.session` — that is the same statement.

- [ ] **Step 7: Verify**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all pass. `grep -rn "useStage\|StageContext" src` returns nothing.

- [ ] **Step 8: Commit**

```bash
git add -A src
git commit -m "refactor: move HomePage to stores and queries, delete StageContext"
```

---

### Task 9: Settings groups read their own data

Removes the ~20 function props threaded `HomePage → SettingsPanel → *Group` (`HomePage.tsx:338-370`).

**Files:**
- Modify: `src/organisms/SettingsPanel.tsx`, `src/organisms/settings/ApiKeysGroup.tsx`, `CliToolsGroup.tsx`, `ChannelsGroup.tsx`, `VoiceGroup.tsx`, `ContainersGroup.tsx`, `IntegrationsGroup.tsx`, `GeneralGroup.tsx`, `src/organisms/NewSessionScreen.tsx`
- Modify: the matching `.test.tsx` for each

**Interfaces:**
- Consumes: every hook from Task 4
- Produces: `SettingsPanel` with props `{ open, onClose, onReset, theme, onThemeChange }` only

- [ ] **Step 1: Migrate one group and its test first**

Take `ApiKeysGroup`. Delete its four function props and call the hooks:

```tsx
export function ApiKeysGroup() {
  const { data: keys = [] } = useApiKeys();
  const save = useSaveApiKey();
  const verify = useVerifyApiKey();
  const remove = useDeleteApiKey();
  // render exactly as before; replace `await saveApiKey(id, key)` with
  // `await save.mutateAsync({ id, key })`
}
```

- [ ] **Step 2: Update its test to seed the cache**

`ApiKeysGroup.test.tsx` currently passes fakes as props. Replace with:

```tsx
it("renders a card per provider with masked last4, never the key", async () => {
  const { client } = renderWithProviders(<ApiKeysGroup />);
  client.setQueryData(qk.apiKeys, [listing({ hasKey: true, last4: "9876", verified: true })]);
  await screen.findByText(/•••• 9876/);
  expect(screen.getByText("valid")).toBeInTheDocument();
});
```

Keep `pillForApiKey`'s pure-function tests exactly as they are — they take no props and need no provider.

- [ ] **Step 3: Run it**

Run: `pnpm test src/organisms/settings/ApiKeysGroup.test.tsx`
Expected: PASS, same assertion count as before.

- [ ] **Step 4: Repeat for the remaining groups**

Apply the identical two-step shape to each, mapping props to hooks:

| Component | Old props | New hooks |
|---|---|---|
| `CliToolsGroup` | `listCliTools`, `refreshCliTools`, `setCliToolEnabled` | `useCliTools`, `useRefreshCliTools`, `useSetCliToolEnabled` |
| `ChannelsGroup` | `listWorkspaceRecords`, `getWorkspaceChannels`, `saveWorkspaceChannels`, `verifyWorkspaceDiscord` | `useWorkspaceRecords`, `useWorkspaceChannels(name)`, `useSaveWorkspaceChannels`, `useVerifyWorkspaceDiscord` |
| `VoiceGroup` | `getVoiceSettings`, `saveVoiceSettings`, `listMyConnectors` | `useVoiceSettings`, `useSaveVoiceSettings`, `useMyConnectors` |
| `ContainersGroup` | `getContainers`, `setDockerEnabled`, `verifyContainers` | `useContainers`, `useSetDockerEnabled`, `useVerifyContainers` |
| `IntegrationsGroup` | `listConnectorVendors`, `listMyConnectors`, `addConnector`, `updateConnector`, `deleteConnector`, `verifyConnector` | `useConnectorVendors`, `useMyConnectors`, `useAddConnector`, `useUpdateConnector`, `useDeleteConnector`, `useVerifyConnector` |
| `NewSessionScreen` | `workspaces`, `records`, `sessions`, `modes` | `useWorkspaces`, `useWorkspaceRecords`, `useSessions`, `useExecutionModes` |

`NewSessionScreen` keeps `lockedWorkspace`, `forced`, `onSend`, and `onCancel` as props — those are caller intent, not broker data.

- [ ] **Step 5: Strip `SettingsPanel`'s pass-through props**

Delete all 20 broker function props from `SettingsPanel.tsx`'s interface and its JSX. Then delete the matching 20 lines from `HomePage.tsx:338-370`.

- [ ] **Step 6: Verify and commit**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all pass. `grep -n "listApiKeys\|listCliTools\|getVoiceSettings" src/pages/HomePage.tsx` returns nothing.

```bash
git add -A src
git commit -m "refactor: settings groups fetch their own data via query hooks"
```

---

### Task 10: Board and Map stages onto Query

Deletes the `lastBoardUpdate` / `lastCapabilityUpdate` seq-counter mechanism — Task 6 already replaced it with real invalidation.

**Files:**
- Modify: `src/organisms/BoardStage.tsx`, `src/organisms/MapStage.tsx`, `src/organisms/CardSheet.tsx`
- Create: `src/queries/work.ts`
- Modify: `src/organisms/BoardStage.test.tsx`, `src/organisms/MapStage.test.tsx`

**Interfaces:**
- Consumes: `qk.board`, `qk.boards`, `qk.capability`, `qk.capabilities` (Task 4)
- Produces: `useBoards()`, `useBoard(id)`, `useCapabilities(workspace)`, `useCapability(id)`, plus mutations `useCreateBoard`, `useCreateCard`, `useMoveCard`, `useCreateCapability`

- [ ] **Step 1: Locate the current fetches**

`BoardStage` and `MapStage` fetch through the swarm work API rather than `useBrokerChat`. Read both files' `useEffect` blocks and list every URL before writing hooks — the plan does not assume their shapes, and each must be ported verbatim into `src/api/work.ts` following Task 3's pattern.

- [ ] **Step 2: Write the query hooks**

Create `src/queries/work.ts` wrapping those functions with `qk.board(id)` / `qk.capability(id)` keys, matching Task 4's structure exactly.

- [ ] **Step 3: Delete the seq-counter effects**

In `BoardStage.tsx`, remove the `useEffect` that watches `lastBoardUpdate.seq` and refetches. In `MapStage.tsx`, remove the equivalent for `lastCapabilityUpdate`. Task 6's `invalidateQueries` already does this — leaving both in place causes a double refetch on every frame.

- [ ] **Step 4: Verify the invalidation path end-to-end**

Add to `src/organisms/BoardStage.test.tsx`:

```tsx
it("refetches the board when a board-updated frame arrives", async () => {
  const { client } = renderWithProviders(<BoardStage />);
  client.setQueryData(qk.board("b1"), { id: "b1", cards: [] });
  const spy = vi.spyOn(client, "invalidateQueries");
  useSocketStore.getState().connect(client);
  FakeSocket.last?.onmessage?.({ data: JSON.stringify({ type: "board-updated", boardId: "b1" }) });
  expect(spy).toHaveBeenCalledWith({ queryKey: qk.board("b1") });
});
```

- [ ] **Step 5: Verify and commit**

Run: `pnpm typecheck && pnpm lint && pnpm test`

```bash
git add -A src
git commit -m "refactor: board and map stages onto query, drop seq-counter refetch"
```

---

### Task 11: Forms onto React Hook Form

Seven components, 66 controlled inputs. RHF's `useForm` is per-mount, so wizard state resets on close for free — no store needed.

**Files:**
- Modify: `src/organisms/AddAgentModal.tsx` (31 `useState` → RHF + ~4), `WorkspaceManagerModal.tsx` (11 → ~2), `NewWorkspaceModal.tsx` (8 → ~1), `CardSheet.tsx` (11 → ~2), `MapStage.tsx` (13 → ~3), `settings/ConnectorFormModal.tsx`, `NewSessionScreen.tsx`
- Modify: each component's test

**Interfaces:**
- Consumes: `react-hook-form@7.85.0`
- Produces: no new exports; prop signatures unchanged except removed state props

- [ ] **Step 1: Start with the smallest — `ConnectorFormModal` (4 inputs)**

```tsx
import { useForm } from "react-hook-form";

interface ConnectorFormValues {
  label: string;
  fields: Record<string, string>;
}

const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<ConnectorFormValues>({
  defaultValues: { label: existing?.label ?? "", fields: existing?.fields ?? {} },
});

<input {...register("label", { required: "a label is required" })} />
{errors.label && <span className="field-error">{errors.label.message}</span>}
```

Replace the manual `busy` state with `isSubmitting`, and the manual disable condition with `formState.isValid`.

- [ ] **Step 2: Run its test**

Run: `pnpm test src/organisms/settings/ConnectorFormModal.test.tsx`
Expected: PASS. Tests type into fields by label and assert on submit payloads — RHF is uncontrolled, so `userEvent.type` still works unchanged.

- [ ] **Step 3: Migrate `NewWorkspaceModal` (10 inputs)**

Use `useFieldArray` for the repos list rather than an index-keyed `useState` array:

```tsx
const { fields, append, remove } = useFieldArray({ control, name: "repos" });
```

Preserve the existing validation exactly — `WorkspaceManagerModal.tsx:212` shows the current rule: name non-empty, and every repo's `name` and `path` non-empty. Express it as `register("name", { required: true })` and the same on each repo field. Do not add validation the app did not have.

- [ ] **Step 4: Migrate `WorkspaceManagerModal` (16 inputs)**

Same `useFieldArray` shape for repos. Keep `canSave` semantics by using `formState.isValid` with `mode: "onChange"`.

- [ ] **Step 5: Migrate `CardSheet` (10) and `MapStage` (9)**

`MapStage`'s `stepNames`, `storyTexts`, and `planTexts` are `Record<string, string>` keyed by id — these become RHF fields registered dynamically as `register(\`stepNames.${id}\`)`. Keep `activeId`, `creating`, and `error` as plain `useState`; they are not form fields.

- [ ] **Step 6: Migrate `AddAgentModal` (14 inputs, 31 `useState`)**

The biggest one, and the reason RHF earns its place. Fields that become RHF: `name`, `role`, `gender`, `backstory`, `hint`, `model`, `language`, `voiceId`, `voiceSearch`, and the `reactions` / `answers` records. Fields that stay `useState`: `step`, `mode`, `catalog`, `voices`, `generating`, `busy`, `error` — these are wizard machinery and fetched data, not user input.

One `useForm` at the modal root spans all steps; step navigation does not remount it, so values persist across steps and reset on close.

```tsx
const { register, handleSubmit, watch, setValue, reset } = useForm<AgentFormValues>({
  defaultValues: emptyAgent,
});
// Prefilling from a premade card or an edit target replaces the manual setX cascade:
useEffect(() => { if (editing) reset(toFormValues(editing)); }, [editing, reset]);
```

- [ ] **Step 7: Verify and commit**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all pass. Manually confirm the wizard resets: open, type a name, close, reopen — the field must be empty.

```bash
git add -A src
git commit -m "refactor: migrate forms to react-hook-form"
```

---

### Task 12: Fold remaining fetchers, delete `useBrokerChat`, final verification

**Files:**
- Delete: `src/hooks/useBrokerChat.ts`, `src/hooks/useBrokerChat.test.ts`, `src/hooks/useCliToolHealth.ts`, `src/hooks/useCliToolHealth.test.ts`
- Modify: `src/hooks/useSurfacePolicy.ts`, `src/hooks/useSpokenReplies.ts`, `src/hooks/useVoiceStatus.ts`
- Create: `src/queries/health.ts`

**Interfaces:**
- Consumes: `useRoster`, `useCliTools`
- Produces: `useEngineWarnings(): Record<string, string>`

- [ ] **Step 1: Replace `useCliToolHealth` with a derived query**

`computeEngineWarnings` (`useCliToolHealth.ts:11`) is already a pure function — keep it verbatim, move it to `src/queries/health.ts`, and derive the join from two existing queries instead of a bespoke double-fetch:

```ts
import { computeEngineWarnings } from "./health";

export function useEngineWarnings(): Record<string, string> {
  const { data: tools = [] } = useCliTools();
  const { data: roster } = useRoster();
  return computeEngineWarnings(tools, roster?.agents ?? []);
}
```

Move `computeEngineWarnings`'s existing tests over unchanged — it is a pure function and its test needs no provider.

- [ ] **Step 2: Simplify `useSurfacePolicy`**

It hand-rolls request-generation cancellation (`generationRef`, `useSurfacePolicy.ts:88-96`) to discard stale `/agents` responses. Query does that natively via query keys. Replace the fetch and the generation guard with `useRoster()`, keeping the pure `joinNowVisible` helper and the mutation paths as-is.

- [ ] **Step 3: Rewire `useSpokenReplies`**

It currently takes `(messages, roster, enabled)` positionally from `HomePage`. Change its signature to take no data arguments and read `useTranscript()` and `useRoster()` itself. Subscribe to audio frames via `useSocketStore.getState().onAudioFrame(...)` in an effect, replacing the `audioSink` ref relay at `HomePage.tsx:61` and `:114`.

- [ ] **Step 4: Delete the old hook**

```bash
git rm src/hooks/useBrokerChat.ts src/hooks/useBrokerChat.test.ts src/hooks/useCliToolHealth.ts src/hooks/useCliToolHealth.test.ts
```

`useBrokerChat.test.ts`'s three `renderHook` cases test WebSocket reconnect and frame handling — that coverage now lives in `socketStore.test.ts` (Task 6). Before deleting, read those three tests and confirm each behavior has an equivalent assertion there; port anything missing rather than losing it.

- [ ] **Step 5: Confirm every deletion target is gone**

Run:
```bash
grep -rn "useBrokerChat\|StageContext\|useStage\|sessionKnown\|lastBoardUpdate\|lastCapabilityUpdate" src
```
Expected: no output.

- [ ] **Step 6: Full verification**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all pass, zero skipped tests.

- [ ] **Step 7: UI smoke against a live broker**

Start the broker, then `pnpm dev`, and confirm each behaves exactly as on `main` @ `c1308f4`:

1. Zero-session boot forces the composer open; creating a session dismisses it.
2. Session switching from the sessions panel loads that session's transcript.
3. Board drag between columns persists; tab switching preserves scope; a card sheet opens and closes.
4. Map authoring adds an activity, a step, and a story.
5. Agent creation wizard completes; reopening it shows empty fields.
6. Every Settings group loads, saves, and verifies.
7. Voice: mic toggle, spoken replies, and the audio-blocked hint.

- [ ] **Step 8: Commit**

```bash
git add -A src
git commit -m "refactor: delete useBrokerChat, fold remaining fetchers into queries"
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| Deps at exact versions, pnpm | 2 |
| No zod / resolvers | Global Constraints |
| Query owns broker-owned data | 4, 5, 9, 10 |
| RHF owns user input | 11 |
| Zustand owns the rest | 6, 7 |
| `skipToken` for session/transcript; `sessionKnown` deleted | 5, 8 |
| Frame carries data → `setQueryData`; id-only → `invalidateQueries` | 6 |
| Audio frames bypass the cache | 6, 12 |
| `api/broker.ts` React-free as the zod seam | 3 |
| Delete `useBrokerChat`, `StageContext`, ~20 props, seq counters | 8, 9, 10, 12 |
| Test harness: fresh QueryClient, store reset | 2 |
| StrictMode double-connect | 6, 8 |
| `useSurfacePolicy` + `useCliToolHealth` fold in | 12 |
| Acceptance criteria 1–5 | 12 |

**Type consistency:** `qk` keys are defined once in Task 4 and referenced by exact name in 5, 6, 8, 9, 10. Store action names in Task 7's Interfaces match their Task 8 call sites. `api.*` function names in Task 3's list match the `queryFn` bodies in Task 4.

Two drift bugs found and fixed during this review, recorded so a reader knows they were checked rather than missed:
- Task 5's `useWorkspaces` called `api.getWorkspaces()`, which Task 3's signature list did not define (it had `getWorkspaceRecords`, a different endpoint returning full records rather than names). `getWorkspaces(base?): Promise<string[]>` added to Task 3.
- Task 9's migration table referenced `useWorkspaceChannels`, `useVerifyWorkspaceDiscord`, `useVerifyContainers`, and `useVerifyConnector`, none of which Task 4 produced. All four added to Task 4, plus `useVerifyWorkspaceAtlassian` and `useVerifyRepoGithub` for the same reason — `WorkspaceManagerModal` calls both.

**Known imprecision, flagged deliberately:** Task 10 does not name Board/Map's exact endpoint URLs. Those go through the swarm work API rather than `useBrokerChat`, and inventing signatures I have not read would be worse than an explicit read-first step — hence Task 10 Step 1.
