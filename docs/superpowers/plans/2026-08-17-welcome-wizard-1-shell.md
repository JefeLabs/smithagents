# Welcome Wizard, Plan 1 — The Shell

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the wizard's frame — first-run detection, a resumable step machine, the Name step, and the local/hosted fork with hosted visibly disabled — so later plans drop content into a shell that already works.

**Architecture:** A `WizardGate` mounted beside `AuthGate`, deciding between the wizard and the app. First run is the absence of a user record, which today the wire cannot express, so the swarm learns to say so. Resume state persists **on the user record** (the spec's anchor), not in browser storage, so quitting and returning works on a fresh profile.

**Tech Stack:** TypeScript ~6.0.0 (ESM, `.js` specifiers in swarm), Node >= 24, `node:test` + `node:assert/strict` (swarm), vitest + Testing Library (control-plane), React + TanStack Router/Query + zustand, HeroUI v3, biome 2.5.3, **pnpm** (never npm).

**Spec:** `docs/superpowers/specs/2026-08-15-welcome-wizard-design.md`. This plan implements the shell only — the spec's flow above the `── the app works from here ──` line, minus Subscriptions/Anderson (Plan 2) and the workspace step (Plan 3).

## Two findings that reshape Task 1

Both were measured against `main` @ `f07286b`, not assumed. Neither is in the spec, and both would have surfaced mid-implementation.

**1. The first-run sentinel is not expressible over the wire.** The spec says *"First run is detected by the absence of a user record."* But `redactUser` (`swarm/src/server.ts:2272-2276`) fabricates a placeholder:

```ts
const redactUser = (u: User | null) => ({
  id: u?.id ?? "me",
  name: u?.name ?? "You",
  connectors: (u?.connectors ?? []).map(redactConnector),
});
```

So `GET /me` on a fresh install returns `{id:"me", name:"You", connectors:[]}` — indistinguishable from a real user named "You". The client cannot detect first run at all. Task 1 makes the payload honest.

**2. `PUT /me` silently wipes the brain engine.** `buildUserUpdate` (`swarm/src/server.ts:4096-4104`) is an explicit allow-list literal returning only `id`, `name`, `default`, `connectors`, `voice`. It **drops `brainEngine`, `researchEngine`, and `agendaSweptDay`**.

The wizard's Name step calls `PUT /me`. Configure Anderson (Plan 2) writes `brainEngine`. So on any resume or Settings re-run, the Name step would erase Anderson's configuration and the brain would fall back to `SMITH_BRAIN_PROVIDER`. **This is the third instance of this bug class in this codebase** — `buildWorkspaceCreate` dropped `workKind` (fixed 2026-08-17), and doc-edit dropped unschema-ed fields before that. Task 1 fixes it and adds a test that names the class.

## Global Constraints

- Node >= 24; TypeScript ~6.0.0; ESM with `.js` import specifiers on every relative import in swarm.
- **pnpm, never npm.**
- **Every required step precedes every optional one.** Someone who abandons the wizard after a required step still has a working app.
- **Every step is resumable.** A user who quits mid-wizard returns to the step they left. The user record is the anchor; the local/hosted choice is remembered with it.
- **A failed probe is informative, never fatal.** Nothing in the wizard may strand the user.
- **Hosted is visible but disabled**, labelled "coming soon", and never appears alone — it always names the way forward (`→ notify me`, `smithagents.com`).
- **Mobile and tablet never see the local path** — they have no local path to offer.
- **The wizard is re-runnable from Settings.** Without this, testing it means destroying an install — which is exactly what happened while designing it, and it is why this is a Task, not polish.
- Baselines, measured on `main` @ `f07286b`:
  - swarm: **637 passing, 0 failing**; `tsc --noEmit` **12 errors** (pre-existing: `agent-sessions.ts`, `jira-sync.test.ts`, `server.ts`).
  - broker: **667 passing, 0 failing**; `tsc` 1 pre-existing error.
  - control-plane: **929 passing, 2 FAILING** — `HomePage.test.tsx > picking another session backs out of an explicitly-opened composer` and `MapStage.test.tsx > offers a pan-mode toggle in the zoom controls cluster`. Both pre-date this work. **Confirm by NAME, never by count. A third failure is yours.**
  - control-plane `tsc --noEmit`: 10 pre-existing errors (`map/nodes.test.tsx`, `NewContextModal.test.tsx`, `WorkspaceManagerModal.test.tsx`, `dashboardSpec.ts`).
  - One pre-existing biome violation at `swarm/src/capabilities.test.ts:615`.
- Measurement traps:
  - Typecheck swarm with `cd swarm && ./node_modules/.bin/tsc --noEmit`. **Never `npx tsc` from the repo root** — decoy placeholder package.
  - tsc ANSI-colorizes. Strip first (`sed 's/\x1b\[[0-9;]*m//g'`) and count with `grep -c 'error TS'`. **Never `grep -oE 'Found [0-9]+ error'`** — that line does not exist in this invocation and returns empty, which looks exactly like success. Cross-check the exit code.
  - `node:test` summary lines start with `ℹ`, not `#`.
  - A `cd` to a path **outside the project** is silently dropped inside a compound Bash command.
- Codebase rules that this plan's UI must respect, each learned the hard way:
  - **No route loaders, ever.** The WebSocket lives above the router; data arrives by push. Do not add a TanStack Router `loader`.
  - **Organisms are router-free.** An organism takes props and callbacks; it does not import the router.
  - **`aria-disabled` implies `pointer-events: none` in this stylesheet.** The disabled hosted option must remain readable and its "notify me" link must remain clickable — so the *option* is disabled, not the whole block. Verify by test, not by eye.
  - **State boundary:** server state via TanStack Query, forms via RHF, UI state via zustand. Wizard *progress* is server state (it lives on the user record), not zustand.

## Scope

**In:** the honest first-run sentinel; `PUT /me` preserving unlisted fields; wizard progress persisted on the user record; `WizardGate`; the step machine with resume; the Name step; the local/hosted fork with hosted disabled; platform gating; the Settings re-run entry.

**Out, deliberately:** Subscriptions and Configure Anderson (Plan 2); the workspace step and the work-kind question (Plan 3); voice, location, integrations, crew (Plan 4); the hosted branch beyond a disabled control; running installers; billing; and the two runtime prerequisites (`packaged-runtime`, `env-free-runtime`), which are separate specs and outrank the wizard for a stranger but not for a developer running from a clone.

---

### Task 1: The user record tells the truth

**Files:**
- Modify: `swarm/src/users.ts` (the `User` interface)
- Modify: `swarm/src/server.ts` (`redactUser` `:2272`, `PUT /me` `:2283`, `buildUserUpdate` `:4096`)
- Test: `swarm/src/server.test.ts`
- Modify: `control-plane/src/api/types.ts` (`MeRecord` `:288`)

**Interfaces:**
- Produces: `MeRecord` gains `placeholder: boolean` and `setup?: { mode?: "local" | "hosted"; step?: string }`.
- `buildUserUpdate(existing, body)` preserves every field it does not explicitly set, and accepts `setup`.

- [ ] **Step 1: Write the failing tests**

Append to `swarm/src/server.test.ts`:

```ts
test("buildUserUpdate: PRESERVES fields it does not set — the brain engine survives a rename", () => {
  // This is the third instance of this bug class in this codebase
  // (buildWorkspaceCreate dropped workKind; doc-edit dropped unschema-ed
  // fields). An allow-list literal silently erases everything not listed, and
  // the wizard's very first step calls PUT /me.
  const existing = {
    id: "me",
    name: "Edwin",
    default: true,
    brainEngine: { kind: "api" as const, provider: "gemini" },
    researchEngine: { cli: "claude" },
    agendaSweptDay: "2026-08-17",
  };

  const merged = buildUserUpdate(existing as never, { name: "Edwina" });

  assert.equal(merged.name, "Edwina", "the rename applies");
  assert.deepEqual(merged.brainEngine, { kind: "api", provider: "gemini" }, "brainEngine survives");
  assert.deepEqual(merged.researchEngine, { cli: "claude" }, "researchEngine survives");
  assert.equal(merged.agendaSweptDay, "2026-08-17", "agendaSweptDay survives");
});

test("buildUserUpdate: creates a usable record when there is no existing user", () => {
  const created = buildUserUpdate(null, { name: "Edwin" });
  assert.equal(created.id, "me");
  assert.equal(created.name, "Edwin");
  assert.equal(created.default, true);
});

test("buildUserUpdate: records wizard progress, and omitting it preserves what was there", () => {
  const first = buildUserUpdate(null, { name: "Edwin", setup: { mode: "local", step: "fork" } });
  assert.deepEqual(first.setup, { mode: "local", step: "fork" });

  const renamed = buildUserUpdate(first, { name: "Edwina" });
  assert.deepEqual(renamed.setup, { mode: "local", step: "fork" }, "progress is not lost by an unrelated update");
});

test("redactUser: says PLAINLY whether a real user record exists", () => {
  // The spec detects first run by "the absence of a user record", but the old
  // payload fabricated {name:"You"} for null — indistinguishable from a real
  // user named You. The client could not detect first run at all.
  const fresh = redactUser(null);
  assert.equal(fresh.placeholder, true, "no saved user yet");

  const real = redactUser({ id: "me", name: "You", default: true } as never);
  assert.equal(real.placeholder, false, "a REAL user named 'You' is not a placeholder");
  assert.equal(real.name, "You");
});

test("redactUser: exposes setup progress so the wizard can resume", () => {
  const u = redactUser({ id: "me", name: "Edwin", setup: { mode: "local", step: "fork" } } as never);
  assert.deepEqual(u.setup, { mode: "local", step: "fork" });
});

test("redactUser: still never leaks a connector secret", () => {
  const u = redactUser({
    id: "me",
    name: "Edwin",
    connectors: [{ id: "c1", vendorId: "atlassian", label: "acme", fields: { email: "e@x.com", apiToken: "SECRET" } }],
  } as never);
  assert.equal(JSON.stringify(u).includes("SECRET"), false, "redaction is not weakened by the new fields");
});
```

**`redactUser` is currently a closure inside `registerRoutes` (`server.ts:2272`), so it is not importable.** Export it as a module-level function alongside `buildUserUpdate` and `redactConnector`, matching this file's stated convention ("unit-testable without booting the server"), and have the two routes call it. Do not change its redaction behaviour — the last test above pins that.

- [ ] **Step 2: Run them to verify they fail**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  --test-name-pattern 'buildUserUpdate|redactUser' 'src/server.test.ts' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | head -20
```

Expected: FAIL — `redactUser` is not exported, and `buildUserUpdate` drops the preserved fields.

- [ ] **Step 3: Add the fields to `User`**

In `swarm/src/users.ts`, extend the interface:

```ts
  /**
   * How far through the welcome wizard this user got, and which branch they
   * chose. Persisted on the record rather than in browser storage because the
   * spec makes the user record the resume anchor — a fresh browser profile must
   * still resume where the person left off.
   */
  setup?: { mode?: "local" | "hosted"; step?: string };
```

- [ ] **Step 4: Make `buildUserUpdate` preserve, not enumerate**

Replace the allow-list literal at `swarm/src/server.ts:4096`:

```ts
/**
 * Merge a PUT /me body onto the existing record.
 *
 * SPREADS the existing record rather than enumerating fields. The previous
 * allow-list literal silently dropped brainEngine, researchEngine and
 * agendaSweptDay on every rename — and the welcome wizard's first step is a
 * rename, so it would have erased the brain engine the user configured two
 * steps later. Enumerating fields here has now cost this codebase three
 * separate bugs; spread and override.
 */
export function buildUserUpdate(existing: User | null, body: { name?: string; setup?: User["setup"] }): User {
  return {
    ...(existing ?? {}),
    id: existing?.id ?? "me",
    name: body.name?.trim() || existing?.name || "You",
    default: true,
    ...(body.setup !== undefined ? { setup: { ...existing?.setup, ...body.setup } } : {}),
  };
}
```

Update `PUT /me`'s body cast at `:2284` to `{ name?: string; setup?: User["setup"] }` so `setup` reaches the merge.

- [ ] **Step 5: Make `redactUser` honest, and export it**

Move it out of `registerRoutes` to module level:

```ts
/**
 * The wire shape of the operator. `placeholder` is the first-run sentinel: the
 * spec detects first run by "the absence of a user record", but this function
 * fabricates a default when there is none, so absence has to be stated
 * explicitly or the client cannot see it. A real user named "You" is NOT a
 * placeholder.
 */
export function redactUser(u: User | null) {
  return {
    id: u?.id ?? "me",
    name: u?.name ?? "You",
    connectors: (u?.connectors ?? []).map(redactConnector),
    placeholder: u === null,
    setup: u?.setup,
  };
}
```

Both routes keep calling it; delete the closure.

- [ ] **Step 6: Widen the client type**

In `control-plane/src/api/types.ts:288`:

```ts
export interface MeRecord {
  id: string;
  name: string;
  connectors: ConnectorInstanceRecord[];
  /** True when no user record is saved yet — the wizard's first-run sentinel. */
  placeholder?: boolean;
  /** How far through the welcome wizard this user got. */
  setup?: { mode?: "local" | "hosted"; step?: string };
}
```

Optional on the client so an older broker's payload still type-checks.

- [ ] **Step 7: Verify**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  'src/*.test.ts' 'src/**/*.test.ts' > /tmp/w1-suite.txt 2>&1; echo "exit=$?"
sed 's/\x1b\[[0-9;]*m//g' /tmp/w1-suite.txt | grep -E "^ℹ (tests|pass|fail)"
cd swarm && ./node_modules/.bin/tsc --noEmit > /tmp/w1-tsc.txt 2>&1; echo "tsc-exit=$?"
echo "errors=$(sed 's/\x1b\[[0-9;]*m//g' /tmp/w1-tsc.txt | grep -c 'error TS')"
cd control-plane && npx tsc --noEmit 2>&1 | tail -3
npx biome check swarm/src/server.ts swarm/src/server.test.ts swarm/src/users.ts control-plane/src/api/types.ts
```

Expected: **643 pass / 0 fail** (637 + 6); `errors=12`. **A pre-existing test that asserted `redactUser` drops a field is a real signal** — report it rather than deleting it.

- [ ] **Step 8: Commit**

```bash
git add swarm/src/users.ts swarm/src/server.ts swarm/src/server.test.ts control-plane/src/api/types.ts
git commit -m "fix(me): the user record stops lying about first run, and stops dropping fields

GET /me fabricated {name:\"You\"} when no user existed, so first run was
undetectable from the client. And PUT /me enumerated fields, silently wiping
brainEngine/researchEngine/agendaSweptDay on every rename — the wizard's first
step is a rename. Third bug of that class here; spread and override instead."
```

---

### Task 2: The gate and the step machine

**Files:**
- Create: `control-plane/src/organisms/WizardGate.tsx`
- Create: `control-plane/src/organisms/WizardGate.test.tsx`
- Create: `control-plane/src/lib/wizardSteps.ts`
- Create: `control-plane/src/lib/wizardSteps.test.ts`
- Modify: wherever `AuthGate` is mounted (find it: `grep -rn "<AuthGate" control-plane/src`)

**Interfaces:**
- Produces:
  - `WIZARD_STEPS: readonly string[]` — the ordered step ids this plan ships: `["name", "fork"]`. Later plans insert their own.
  - `nextStep(current: string): string | null` · `resumeStep(setup?: {step?: string}): string` — pure, testable without React.
  - `<WizardGate>{children}</WizardGate>` — renders the wizard when `me.placeholder` or setup is incomplete, otherwise the app.
- Consumes: `getMe` and `MeRecord.placeholder`/`.setup` from Task 1.

- [ ] **Step 1: Write the failing tests**

Create `control-plane/src/lib/wizardSteps.test.ts`. Keep the step logic pure so resume is testable without rendering:

```ts
import { describe, expect, it } from "vitest";
import { isSetupComplete, nextStep, resumeStep, WIZARD_STEPS } from "./wizardSteps";

describe("wizard step machine", () => {
  it("orders every required step before any optional one", () => {
    expect(WIZARD_STEPS[0]).toBe("name");
    expect(WIZARD_STEPS).toContain("fork");
  });

  it("resumes at the step the user left, not at the beginning", () => {
    expect(resumeStep({ step: "fork" })).toBe("fork");
  });

  it("resumes at the first step when there is no progress", () => {
    expect(resumeStep(undefined)).toBe("name");
    expect(resumeStep({})).toBe("name");
  });

  it("resumes at the first step when the stored step is unknown", () => {
    // A step id from a newer build, or a typo in a hand-edited record. Never
    // strand the user on a step that does not exist.
    expect(resumeStep({ step: "no-such-step" })).toBe("name");
  });

  it("advances through the steps and reports the end", () => {
    expect(nextStep("name")).toBe("fork");
    expect(nextStep(WIZARD_STEPS[WIZARD_STEPS.length - 1])).toBeNull();
  });

  it("is complete only when the last step is done", () => {
    expect(isSetupComplete({ step: "name" })).toBe(false);
    expect(isSetupComplete({ step: "done" })).toBe(true);
    expect(isSetupComplete(undefined)).toBe(false);
  });
});
```

Create `control-plane/src/organisms/WizardGate.test.tsx`, matching the render/stub conventions already in `control-plane/src/organisms/` (read `AuthGate`'s or `LoginScreen`'s test first and use the same mechanism — do not introduce a second):

```tsx
it("shows the wizard on a fresh install (no user record)", async () => {
  stubMe({ id: "me", name: "You", connectors: [], placeholder: true });
  render(<WizardGate><div>THE APP</div></WizardGate>);

  expect(await screen.findByRole("heading", { name: /welcome/i })).toBeInTheDocument();
  expect(screen.queryByText("THE APP")).toBeNull();
});

it("shows the app for a real user who finished setup", async () => {
  stubMe({ id: "me", name: "Edwin", connectors: [], placeholder: false, setup: { step: "done" } });
  render(<WizardGate><div>THE APP</div></WizardGate>);

  expect(await screen.findByText("THE APP")).toBeInTheDocument();
});

it("does NOT treat a real user named 'You' as a fresh install", async () => {
  // The exact case the old wire shape could not distinguish.
  stubMe({ id: "me", name: "You", connectors: [], placeholder: false, setup: { step: "done" } });
  render(<WizardGate><div>THE APP</div></WizardGate>);

  expect(await screen.findByText("THE APP")).toBeInTheDocument();
});

it("resumes an unfinished setup at the step the user left", async () => {
  stubMe({ id: "me", name: "Edwin", connectors: [], placeholder: false, setup: { step: "fork" } });
  render(<WizardGate><div>THE APP</div></WizardGate>);

  expect(await screen.findByRole("group", { name: /local or hosted/i })).toBeInTheDocument();
});

it("shows the app rather than stranding the user when /me cannot be reached", async () => {
  // A failed probe is informative, never fatal. Blocking the whole app behind a
  // failed GET /me would be worse than skipping the wizard.
  stubMeFailure();
  render(<WizardGate><div>THE APP</div></WizardGate>);

  expect(await screen.findByText("THE APP")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run them to verify they fail**

```bash
cd control-plane && npx vitest run src/lib/wizardSteps.test.ts src/organisms/WizardGate.test.tsx 2>&1 | tail -12
```

Expected: FAIL — neither module exists.

- [ ] **Step 3: Implement the step machine**

Create `control-plane/src/lib/wizardSteps.ts`. Pure and router-free:

```ts
/**
 * The wizard's ordered steps and the pure logic over them.
 *
 * Kept out of the components so resume behaviour is testable without rendering,
 * and so later plans can insert their steps by editing one array. Every REQUIRED
 * step precedes every optional one (spec) — someone who abandons the wizard
 * after a required step still has a working app.
 */
export const WIZARD_STEPS = ["name", "fork"] as const;

export type WizardStep = (typeof WIZARD_STEPS)[number];

/** Sentinel stored once the last step is done. */
export const SETUP_DONE = "done";

export type Setup = { mode?: "local" | "hosted"; step?: string } | undefined;

/**
 * Where to resume. An unknown step id — a record written by a newer build, or a
 * hand-edited one — restarts rather than stranding the user on a step that does
 * not exist.
 */
export function resumeStep(setup: Setup): WizardStep {
  const step = setup?.step;
  return (WIZARD_STEPS as readonly string[]).includes(step ?? "") ? (step as WizardStep) : WIZARD_STEPS[0];
}

/** The next step, or null at the end. */
export function nextStep(current: string): WizardStep | null {
  const i = (WIZARD_STEPS as readonly string[]).indexOf(current);
  return i >= 0 && i < WIZARD_STEPS.length - 1 ? WIZARD_STEPS[i + 1] : null;
}

export function isSetupComplete(setup: Setup): boolean {
  return setup?.step === SETUP_DONE;
}
```

- [ ] **Step 4: Implement the gate**

Create `control-plane/src/organisms/WizardGate.tsx`, modelled on `AuthGate` (read it first — same query/gate shape):

```tsx
/**
 * Decides between the welcome wizard and the app.
 *
 * Mounted beside AuthGate: authentication first, then setup. First run is the
 * absence of a saved user record, which the swarm reports as `placeholder`
 * (GET /me fabricates a default record, so absence has to be stated).
 *
 * A failed /me is NOT a gate. Blocking the app behind an unreachable probe
 * would strand the user with no way forward, which the spec forbids — so an
 * error falls through to the app.
 */
export function WizardGate({ children }: { children: ReactNode }) {
  const { data: me, isLoading, isError } = useQuery({ queryKey: ["me"], queryFn: () => api.getMe() });

  if (isLoading) return <div className="wizard-gate__splash" aria-busy="true" />;
  if (isError || !me) return <>{children}</>;

  const needsSetup = me.placeholder === true || (me.setup !== undefined && !isSetupComplete(me.setup));
  if (!needsSetup) return <>{children}</>;

  return <WelcomeWizard initialStep={resumeStep(me.setup)} me={me} />;
}
```

**Note the `needsSetup` condition carefully.** A user with **no** `setup` field at all and `placeholder: false` is an existing install from before this feature — they must NOT be dragged into the wizard. Only a fresh install (`placeholder`) or a genuinely half-finished setup (`setup` present but incomplete) opens it. Add a test for the pre-existing-user case if the brief's list does not already cover it, and report that you did.

`WelcomeWizard` is the step host — for this task it may render a heading and the current step's placeholder; Task 3 fills in the real steps. Keep it router-free (organisms take props and callbacks).

- [ ] **Step 5: Mount it**

Find where `AuthGate` is mounted (`grep -rn "<AuthGate" control-plane/src`) and wrap the same children with `WizardGate` **inside** `AuthGate` — authentication precedes setup. Do not add a router loader; the WebSocket lives above the router and data arrives by push.

- [ ] **Step 6: Verify and commit**

```bash
cd control-plane && npx vitest run src/lib/wizardSteps.test.ts src/organisms/WizardGate.test.tsx 2>&1 | tail -8
cd control-plane && npx vitest run > /tmp/w2-cp.txt 2>&1; echo "exit=$?"
grep -E "Tests " /tmp/w2-cp.txt | tail -2; grep -E "^ FAIL" /tmp/w2-cp.txt | head -4
cd control-plane && npx tsc --noEmit 2>&1 | tail -3
npx biome check control-plane/src/lib/wizardSteps.ts control-plane/src/lib/wizardSteps.test.ts \
  control-plane/src/organisms/WizardGate.tsx control-plane/src/organisms/WizardGate.test.tsx
git add control-plane/src/lib/wizardSteps.ts control-plane/src/lib/wizardSteps.test.ts \
  control-plane/src/organisms/WizardGate.tsx control-plane/src/organisms/WizardGate.test.tsx
git commit -m "feat(wizard): a gate and a resumable step machine

First run is the absence of a user record, now reported as placeholder. Resume
state lives on the record, not in browser storage, so a fresh profile still
returns to the step the person left. An unreachable /me falls through to the
app rather than stranding anyone."
```

Expected: **940 passing, 2 failing** (929 + 11), and the 2 are the named baseline pair.

---

### Task 3: Name, and the fork with hosted disabled

**Files:**
- Create: `control-plane/src/organisms/WizardNameStep.tsx`
- Create: `control-plane/src/organisms/WizardForkStep.tsx`
- Modify: the `WelcomeWizard` host from Task 2
- Test: `control-plane/src/organisms/WizardGate.test.tsx` (or sibling step tests, matching the file layout Task 2 established)

**Interfaces:**
- Consumes: `nextStep`, `SETUP_DONE` from `wizardSteps.ts`; `updateMe` from the api module.
- Each step is a controlled organism: props in, `onDone(patch)` out. **No router imports.**

- [ ] **Step 1: Write the failing tests**

```tsx
it("name: creates the user record and advances", async () => {
  const onDone = vi.fn();
  render(<WizardNameStep initialName="" onDone={onDone} />);

  await userEvent.type(screen.getByLabelText(/name/i), "Edwin");
  await userEvent.click(screen.getByRole("button", { name: /continue/i }));

  expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ name: "Edwin" }));
});

it("name: will not continue on a blank name", async () => {
  const onDone = vi.fn();
  render(<WizardNameStep initialName="" onDone={onDone} />);

  await userEvent.click(screen.getByRole("button", { name: /continue/i }));

  expect(onDone).not.toHaveBeenCalled();
});

it("fork: offers local, and shows hosted as coming soon", async () => {
  render(<WizardForkStep onDone={vi.fn()} />);

  expect(screen.getByRole("radio", { name: /local/i })).toBeEnabled();
  const hosted = screen.getByRole("radio", { name: /hosted/i });
  expect(hosted).toHaveAttribute("aria-disabled", "true");
  expect(screen.getByText(/coming soon/i)).toBeInTheDocument();
});

it("fork: the disabled hosted option still names the way forward", async () => {
  // aria-disabled implies pointer-events:none in this stylesheet, so a naive
  // implementation that disables the whole block would also kill this link —
  // and a disabled control that someone wants, with no way forward, is the
  // frustration the spec calls out.
  render(<WizardForkStep onDone={vi.fn()} />);

  const notify = screen.getByRole("link", { name: /notify me/i });
  expect(notify).toHaveAttribute("href", expect.stringContaining("smithagents.com"));
  expect(notify).not.toHaveAttribute("aria-disabled");
});

it("fork: choosing local advances with the mode recorded", async () => {
  const onDone = vi.fn();
  render(<WizardForkStep onDone={onDone} />);

  await userEvent.click(screen.getByRole("radio", { name: /local/i }));
  await userEvent.click(screen.getByRole("button", { name: /continue/i }));

  expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ setup: expect.objectContaining({ mode: "local" }) }));
});

it("fork: hosted cannot be chosen", async () => {
  const onDone = vi.fn();
  render(<WizardForkStep onDone={onDone} />);

  await userEvent.click(screen.getByRole("radio", { name: /hosted/i }));

  expect(onDone).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run them to verify they fail**

```bash
cd control-plane && npx vitest run src/organisms/WizardNameStep.test.tsx src/organisms/WizardForkStep.test.tsx 2>&1 | tail -10
```

(Adjust paths to whatever file layout Task 2 established.) Expected: FAIL — the components do not exist.

- [ ] **Step 3: Build the two steps**

Both are controlled organisms — props in, `onDone(patch)` out, no router, no direct fetch. The host owns persistence.

**Name:** a single text field and a Continue button, disabled while blank. The spec notes the CLI probe starts here in the background — **do not build the probe in this plan** (it belongs with Plan 2's subscriptions step); leave the seam and say so in a comment.

**Fork:** a radio group. Local is enabled and default-selected. Hosted carries `aria-disabled="true"` and a "Coming soon" label, with sub-copy `no CLI to install, works on any device` and a `→ notify me` link to `smithagents.com`.

**The link must stay outside whatever carries `aria-disabled`**, because this stylesheet gives `aria-disabled` `pointer-events: none` — disabling the whole block would kill the one affordance the spec insists on. Verify with the test above, not by eye.

Use HeroUI v3 components already used elsewhere in `organisms/`; **if you need a compound component's API, verify it against the HeroUI MCP rather than guessing** — that is a standing rule in this repo. Match the import package (`@heroui/react` vs `@heroui-pro/react`) that neighbouring organisms use.

- [ ] **Step 4: Wire them into the host**

The host renders the current step, and on `onDone(patch)` it: calls `updateMe({ ...patch, setup: { ...patch.setup, step: nextStep(current) ?? SETUP_DONE } })`, invalidates the `["me"]` query, and advances. Persisting the *next* step (rather than the current one) is what makes a quit-and-return land on the step the user had reached, not the one they already finished.

- [ ] **Step 5: Verify and commit**

```bash
cd control-plane && npx vitest run > /tmp/w3-cp.txt 2>&1; echo "exit=$?"
grep -E "Tests " /tmp/w3-cp.txt | tail -2; grep -E "^ FAIL" /tmp/w3-cp.txt | head -4
cd control-plane && npx tsc --noEmit 2>&1 | tail -3
npx biome check control-plane/src/organisms/Wizard*.tsx control-plane/src/organisms/Wizard*.test.tsx
git add control-plane/src/organisms/Wizard*.tsx control-plane/src/organisms/Wizard*.test.tsx
git commit -m "feat(wizard): the name step and the local/hosted fork

Hosted is visible, disabled and labelled coming soon, and never appears alone —
its notify-me link stays outside the aria-disabled element, since this
stylesheet gives aria-disabled pointer-events:none."
```

Expected: **946 passing, 2 failing** (940 + 6), the 2 being the named baseline pair.

---

### Task 4: Re-runnable from Settings, and platform gating

Without the re-run entry, testing the wizard means destroying an install — which is what happened while designing it, and it is why this is a task rather than polish. **On a developer machine that already has a user record, this is the only way to see the wizard at all**, including for Task 5's live smoke.

**Files:**
- Modify: the Settings surface (find it: `grep -rln "Settings" control-plane/src/organisms | head`)
- Modify: `control-plane/src/organisms/WizardGate.tsx`
- Test: the Settings component's existing test file, plus `WizardGate.test.tsx`

**Interfaces:**
- Produces: a Settings action that sets `setup.step` back to the first step, reopening the gate. It must **not** delete the user record — re-running setup is not a reset.

- [ ] **Step 1: Write the failing tests**

```tsx
it("settings: re-running setup reopens the wizard without destroying the user", async () => {
  const updateMe = vi.fn().mockResolvedValue({});
  renderSettings({ updateMe });

  await userEvent.click(screen.getByRole("button", { name: /re-run setup|run setup again/i }));

  expect(updateMe).toHaveBeenCalledWith(expect.objectContaining({ setup: expect.objectContaining({ step: "name" }) }));
  // The name is NOT cleared — this is a re-run, not a factory reset.
  expect(updateMe).not.toHaveBeenCalledWith(expect.objectContaining({ name: "" }));
});

it("gate: a phone never sees the local path", async () => {
  stubViewport({ width: 420 });
  stubMe({ id: "me", name: "You", connectors: [], placeholder: true });
  render(<WizardGate><div>THE APP</div></WizardGate>);

  expect(await screen.findByText(/works on any device|coming soon/i)).toBeInTheDocument();
  expect(screen.queryByRole("radio", { name: /local/i })).toBeNull();
});

it("gate: a desktop sees the local path", async () => {
  stubViewport({ width: 1440 });
  stubMe({ id: "me", name: "You", connectors: [], placeholder: true });
  render(<WizardGate><div>THE APP</div></WizardGate>);

  expect(await screen.findByRole("heading", { name: /welcome/i })).toBeInTheDocument();
});
```

**Match whatever viewport-stubbing mechanism this codebase already uses** — `grep -rn "matchMedia\|innerWidth" control-plane/src --include='*.test.tsx' | head`. If none exists, use the simplest thing consistent with the app's own responsive approach and **report which you chose and why**; do not invent a new abstraction for one test.

- [ ] **Step 2: Run them to verify they fail**, then implement

Platform gating: mobile/tablet have no local path to offer, so they see the hosted "coming soon" message instead of the local flow. This is a *message*, not a dead end — it must say what to do next.

- [ ] **Step 3: Verify and commit**

```bash
cd control-plane && npx vitest run > /tmp/w4-cp.txt 2>&1; echo "exit=$?"
grep -E "Tests " /tmp/w4-cp.txt | tail -2; grep -E "^ FAIL" /tmp/w4-cp.txt | head -4
cd control-plane && npx tsc --noEmit 2>&1 | tail -3
git add -A control-plane/src
git commit -m "feat(wizard): re-runnable from Settings, and never offered on mobile

Re-running setup rewinds the step; it does not delete the user. Without this,
testing the wizard means destroying an install."
```

---

### Task 5: Live smoke

**Files:** none. **No commit.** The spec calls this mandatory: *"Three defects shipped this session with green suites... Green tests do not prove reachability."* Two more shipped since, both caught only by a live check.

- [ ] **Step 1: Back up**

```bash
B=$(mktemp -d)/smithagents-prewizard
mkdir -p "$B" && cp -a ~/.smithagents "$B/smithagents"
echo "backup at $B"
```

Back up the **whole** state root, not just workspaces — this task touches the user record.

- [ ] **Step 2: Restart the swarm, and confirm the sentinel over the real wire**

```bash
PID=$(lsof -nP -iTCP:7777 -sTCP:LISTEN -t | head -1); kill "$PID"
until ! lsof -nP -iTCP:7777 -sTCP:LISTEN >/dev/null 2>&1; do sleep 1; done
cd swarm && nohup node --env-file=../.env --import tsx src/server.ts > /tmp/swarm-wizard.log 2>&1 &
until curl -s -m 3 http://127.0.0.1:7777/health > /dev/null; do sleep 1; done
curl -s -m 5 http://127.0.0.1:7777/me
```

Expected: the real user, with `"placeholder":false`. **If `placeholder` is absent, the broker or swarm is running stale code** — restart it before going further, or every later step measures nothing.

- [ ] **Step 3: Prove `PUT /me` no longer wipes the brain engine — the highest-value check here**

```bash
BEFORE=$(curl -s -m 5 http://127.0.0.1:7777/me/brain-engine); echo "  before: $BEFORE"
curl -s -m 10 -X PUT http://127.0.0.1:7777/me -H 'content-type: application/json' \
  -d '{"name":"Edwin"}' > /dev/null
AFTER=$(curl -s -m 5 http://127.0.0.1:7777/me/brain-engine); echo "  after:  $AFTER"
[ "$BEFORE" = "$AFTER" ] && echo "  PRESERVED" || echo "  WIPED — the bug is not fixed"
```

Send the user's **existing** name so this is a no-op rename. Getting `WIPED` here means Anderson would be silently reconfigured by the wizard's first step.

- [ ] **Step 4: Walk the wizard in the browser**

Start the control-plane dev server the way this repo does (`pnpm`, never npm — check `control-plane/package.json` scripts), open it, and:

1. Use the Settings re-run entry. The wizard opens at the Name step.
2. Confirm hosted is visibly disabled, says "coming soon", and its **notify-me link is still clickable** — this is the `aria-disabled` / `pointer-events:none` trap, and it is the one thing a unit test can pass while the real UI fails.
3. Enter a name, continue, choose Local, continue.
4. **Reload the page mid-wizard** and confirm it resumes at the step you left, not at the beginning.
5. Finish, and confirm the app appears.
6. Reload again and confirm the wizard does **not** reopen.

- [ ] **Step 5: Confirm nothing else was disturbed**

```bash
curl -s -m 5 http://127.0.0.1:7777/me | python3 -m json.tool
curl -s -m 5 http://127.0.0.1:7777/me/brain-engine
curl -s -m 5 http://127.0.0.1:7777/workspaces | python3 -c "
import sys,json; print('  workspaces:', [w['name'] for w in json.load(sys.stdin)['workspaces']])"
```

The user keeps their name, connectors and brain engine; workspaces are untouched.

- [ ] **Step 6: No commit.** If Step 3 or Step 4.2 fails, the branch does not merge.

---

## Self-review

**Spec coverage.** *"First run is detected by the absence of a user record"* → Task 1, which had to make absence expressible before anything could detect it. *"Every step is resumable... the user record is the anchor"* → Task 1's `setup` field plus Task 2's `resumeStep`, persisted server-side so a fresh browser profile resumes correctly. *"The wizard is re-runnable from Settings"* → Task 4, treated as a task because it is the only way to test on a real install. *"Hosted visible but disabled, never alone"* → Task 3, with the notify-me link pinned by a test against this repo's `aria-disabled` trap. *"Mobile and tablet never see the local path"* → Task 4. *"A failed probe is informative, never fatal"* → Task 2's error-falls-through-to-app test. The spec's Subscriptions, Anderson, workspace and optional steps are explicitly Plans 2–4 and are named in Scope.

**Placeholders.** None. Four steps defer to what the code actually is rather than inventing it — where `AuthGate` is mounted, which viewport-stubbing mechanism exists, which HeroUI package neighbouring organisms import, and the Settings surface's file — each naming the exact grep and requiring a report of what was found. Task 3 explicitly leaves the CLI-probe seam unbuilt and says which plan owns it.

**Type consistency.** `placeholder`, `setup`, `WIZARD_STEPS`, `WizardStep`, `SETUP_DONE`, `resumeStep`, `nextStep`, `isSetupComplete` are spelled identically in the swarm payload, the client type, the step module, and every test. `setup` has the same shape (`{mode?, step?}`) in `User`, `MeRecord`, and `buildUserUpdate`'s body type.

**Known risks, stated plainly.**
1. **`buildUserUpdate` changing from an allow-list to a spread widens what `PUT /me` can write.** That is the point — it was silently dropping three fields — but a spread means a caller could now set a field the route never intended to expose. The body type is the guard, and it is narrow (`name`, `setup`). Task 1's tests pin preservation; nothing pins *rejection* of an unexpected field, which is a real gap a reviewer should weigh.
2. **The gate's `needsSetup` condition has three states, not two**: fresh install, half-finished setup, and a pre-existing user with no `setup` field at all. The third must fall through to the app — an existing install must never be dragged into a wizard. Task 2 calls this out and asks for the test; it is the most likely place for a subtle bug.
3. **Platform gating by viewport is a proxy for "has no local path".** A narrow desktop window is not a phone. The spec's reasoning is about capability, not width, and this plan implements the cheap proxy. If that proves wrong, the fix is a capability check, not a wider breakpoint.
4. **Two runtime prerequisites remain unbuilt** — `packaged-runtime` and `env-free-runtime`. The spec says they outrank the wizard, and for a stranger they do: a packaged app starts no services and the broker will not boot without `.env`. This plan is therefore a **developer-machine** wizard until those land, which is a deliberate, recorded choice and not an oversight.
