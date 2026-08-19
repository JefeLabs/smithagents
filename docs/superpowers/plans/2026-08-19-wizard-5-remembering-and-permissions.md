# Wizard Plan 5 — Remembering, and what I may do

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The wizard's Step 5 — whether Anderson remembers, and what he may do without asking — wired to what actually exists.

**Architecture:** One screen, two halves, both answered into `setup` on `PUT /me` like every other step. The memory half is a real preference the brain already honours; the permissions half is a new three-by-three matrix that no consumer reads yet, and this plan says so rather than implying otherwise.

**Tech Stack:** React 19, vitest + @testing-library/react, TypeScript ~6.0.0, biome 2.5.3.

**Spec:** `docs/superpowers/specs/2026-08-18-welcome-wizard-local-setup.md`, Step 5 of 6.
**Roadmap:** `docs/superpowers/plans/2026-08-18-wizard-sequence-roadmap.md`

## What is already true — measured 2026-08-19

| Claim | Reality |
|---|---|
| Conversation memory | **Exists and works.** `broker/src/memory.ts` — durable facts recalled per turn |
| Memory needs embeddings | **False, by explicit decision, twice.** `memory.ts`: *"Deliberately dependency-free. Recall is lexical (term overlap, IDF-weighted, recency-tilted) rather than vector similarity: the corpus is small, human text, and a few hundred entries per workspace."* `main.ts:464` repeats it for topic search |
| Embeddings / vector store | **Nothing.** No vector store, no `.gguf`, no download path anywhere |
| Permissions | `buildPermissionGrant` exists in `swarm/src/squads.ts`, but it is **squad-and-task scoped with glob patterns** — a precedent for storing permissions, not a shape to reuse |
| `~/.smithagents/anderson` | **Zero implementation.** The state root is set at boot from `SMITH_STATE_ROOT`; nothing reads an "anderson" path |

## Three rulings this plan carries

**1. The embeddings fork is asked, not built.** The spec offers a ~90MB download because *"your login can't do that part"* — but memory works today without embeddings, and the code says so deliberately in two places. Edwin's ruling: keep the question, defer the capability.

So the screen **records** whether deeper recall is wanted and **renders no download control**, because a button that downloads nothing is a dead feature — the exact pattern Task 1 of plan 4 shipped and had to be found by hand. When an embeddings backend exists, the control appears beside an answer already collected.

**2. Not split into 5a/5b.** The roadmap recommended splitting *"if 5a's scope grows once its own spec exists."* It shrank instead — with embeddings deferred, the memory half is one radio pair. One screen, one plan.

**3. The storage path is shown, not edited.** The spec renders `~/.smithagents/anderson ✎`. Relocating a live state root mid-wizard means moving agents, sessions, worktrees and queue while the broker holds them open; that is not a wizard-sized change. This plan **displays** the real path so the answer to "where do you keep this" is honest, and leaves relocation out. Reject this ruling if the pencil was load-bearing.

## Global Constraints

- **Every answer is sent EXPLICITLY, in both directions.** The server merges `setup`, so an omitted field leaves an earlier run's answer standing. This bug class has now been fixed three times in this wizard (`voice`, then `smallTalk`/`worldAware`).
- **No dead controls.** A control that cannot do its job must not render. See ruling 1.
- **`brokerFetch` resolves on non-2xx.** Any write must check `res.ok`; an unchecked response reports a silent success.
- **Lint baseline is zero diagnostics**, `biome check` must pass on touched files.
- **`tsx` strips types in broker/swarm tests**; in control-plane, `pnpm --filter control-plane typecheck` is the type gate.
- Run one CP test file with: `cd control-plane && npx vitest run src/organisms/<File>.test.tsx`
- Two CP suite failures (`HomePage` composer, `MapStage` pan-mode) are **pre-existing on main** — verify against main before attributing any failure to this work.

---

## File Structure

| file | responsibility |
| --- | --- |
| `control-plane/src/organisms/WizardMemoryStep.tsx` (create) | The screen: both halves, the shown path, explicit sends |
| `control-plane/src/organisms/WizardMemoryStep.test.tsx` (create) | Its tests |
| `control-plane/src/lib/wizardSteps.ts` (modify) | `Setup` gains the answers; `WIZARD_STEPS`/`setupStepsFor`/`STEP_DEFS` gain `memory` |
| `control-plane/src/lib/wizardSteps.test.ts` (modify) | Sequence, count, skip default |
| `control-plane/src/organisms/WizardGate.tsx` (modify) | Seeds and renders the step |
| `control-plane/src/organisms/WizardGate.test.tsx` (modify) | The last-step assertions move again |

---

### Task 1: The step — *Remembering, and what I may do*

**Files:**
- Create: `control-plane/src/organisms/WizardMemoryStep.tsx`
- Create: `control-plane/src/organisms/WizardMemoryStep.test.tsx`
- Modify: `control-plane/src/lib/wizardSteps.ts` (the `Setup` union)

**Interfaces:**
- Consumes: `Setup`, `WizardSaveState` from `../lib/wizardSteps`.
- Produces: `type PermissionStance = "ask" | "allow" | "never"`;
  `interface WizardPermissions { readFiles: PermissionStance; runCommands: PermissionStance; browseWeb: PermissionStance }` — **declared in `wizardSteps.ts`, not in the step**, because `Setup` carries it;
  `Setup` gains `remember?: boolean`, `deeperRecall?: boolean`, `permissions?: WizardPermissions`;
  and `WizardMemoryStep(props: { initialRemember?: boolean; initialDeeperRecall?: boolean; initialPermissions?: WizardPermissions; storagePath: string; onDone: (patch: { setup: Setup }) => void; onBack?: () => void; saveState?: WizardSaveState })`.

- [ ] **Step 1: Write the failing test**

```tsx
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { Setup } from "../lib/wizardSteps";
import { renderWithProviders } from "../test/renderWithProviders";
import { WizardMemoryStep } from "./WizardMemoryStep";

afterEach(cleanup);

const PATH = "~/.smithagents";
const base = { storagePath: PATH, onDone: () => {} };

describe("WizardMemoryStep", () => {
  it("opens remembering, with every permission asking first", () => {
    renderWithProviders(<WizardMemoryStep {...base} />);
    expect(screen.getByRole("radio", { name: /remember me/i })).toBeChecked();
    for (const cap of [/read your files/i, /run commands/i, /browse the web/i]) {
      const group = screen.getByRole("group", { name: cap });
      expect(within(group).getByRole("radio", { name: /ask first/i })).toBeChecked();
    }
  });

  it("renders NO download control — the capability does not exist yet", () => {
    renderWithProviders(<WizardMemoryStep {...base} />);
    // Ruling 1: the question is asked, the capability is deferred. A button
    // that downloads nothing is a dead control.
    expect(screen.queryByRole("button", { name: /download/i })).toBeNull();
    expect(screen.queryByText(/90\s*MB/i)).toBeNull();
  });

  it("shows where things are kept, and does not offer to move them", () => {
    renderWithProviders(<WizardMemoryStep {...base} />);
    expect(screen.getByText(PATH)).toBeTruthy();
    // Ruling 3: relocating a live state root is not a wizard-sized change.
    expect(screen.queryByRole("textbox", { name: /where/i })).toBeNull();
  });

  it("sends every answer explicitly, even when all are the defaults", async () => {
    const user = userEvent.setup();
    const patches: Array<{ setup: Setup }> = [];
    renderWithProviders(<WizardMemoryStep {...base} onDone={(p) => patches.push(p)} />);

    await user.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0].setup).toMatchObject({
      remember: true,
      deeperRecall: false,
      permissions: { readFiles: "ask", runCommands: "ask", browseWeb: "ask" },
    });
  });

  it("carries a changed stance through, per capability", async () => {
    const user = userEvent.setup();
    const patches: Array<{ setup: Setup }> = [];
    renderWithProviders(<WizardMemoryStep {...base} onDone={(p) => patches.push(p)} />);

    const runGroup = screen.getByRole("group", { name: /run commands/i });
    await user.click(within(runGroup).getByRole("radio", { name: /never/i }));
    await user.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0].setup.permissions).toEqual({
      readFiles: "ask",
      runCommands: "never",
      browseWeb: "ask",
    });
  });

  it("declining to remember still sends remember:false explicitly", async () => {
    const user = userEvent.setup();
    const patches: Array<{ setup: Setup }> = [];
    renderWithProviders(<WizardMemoryStep {...base} onDone={(p) => patches.push(p)} />);

    await user.click(screen.getByRole("radio", { name: /start fresh/i }));
    await user.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0].setup).toMatchObject({ remember: false });
  });

  it("a resumed record seeds every answer", () => {
    renderWithProviders(
      <WizardMemoryStep
        {...base}
        initialRemember={false}
        initialDeeperRecall={true}
        initialPermissions={{ readFiles: "allow", runCommands: "never", browseWeb: "ask" }}
      />,
    );
    expect(screen.getByRole("radio", { name: /start fresh/i })).toBeChecked();
    const readGroup = screen.getByRole("group", { name: /read your files/i });
    expect(within(readGroup).getByRole("radio", { name: /go ahead/i })).toBeChecked();
  });
});
```

Add `within` to the `@testing-library/react` import.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd control-plane && npx vitest run src/organisms/WizardMemoryStep.test.tsx`
Expected: FAIL — `Failed to resolve import "./WizardMemoryStep"`

- [ ] **Step 3: Extend `Setup`**

In `control-plane/src/lib/wizardSteps.ts`, inside the `Setup` object member, beside `worldAware`:

```ts
      /**
       * *Remembering, and what I may do.* All sent EXPLICITLY by
       * WizardMemoryStep, for the reason `voice` and `smallTalk` are: the
       * server merges setup, so an omitted field leaves an earlier answer
       * standing.
       */
      remember?: boolean;
      /**
       * Whether deeper recall is wanted, recorded ahead of the capability.
       * memory.ts is deliberately lexical and needs no embeddings today; this
       * is the answer a future backend reads, not a switch that does anything
       * now. No control offers a download while none exists.
       */
      deeperRecall?: boolean;
      permissions?: WizardPermissions;
```

And above `export type Setup`:

```ts
/** What Anderson may do without asking, per capability. */
export type PermissionStance = "ask" | "allow" | "never";

/**
 * Declared here rather than in the step, because `Setup` carries it on the
 * wire and two structurally-identical shapes for one field drift the moment
 * either is edited.
 */
export interface WizardPermissions {
  readFiles: PermissionStance;
  runCommands: PermissionStance;
  browseWeb: PermissionStance;
}
```

- [ ] **Step 4: Write the component**

```tsx
import { useState } from "react";
import type { PermissionStance, Setup, WizardPermissions, WizardSaveState } from "../lib/wizardSteps";

const CAPABILITIES: Array<{ key: keyof WizardPermissions; label: string }> = [
  { key: "readFiles", label: "Read your files" },
  { key: "runCommands", label: "Run commands" },
  { key: "browseWeb", label: "Browse the web" },
];

const STANCES: Array<{ value: PermissionStance; label: string }> = [
  { value: "ask", label: "Ask first" },
  { value: "allow", label: "Go ahead" },
  { value: "never", label: "Never" },
];

const DEFAULT_PERMISSIONS: WizardPermissions = { readFiles: "ask", runCommands: "ask", browseWeb: "ask" };

export interface WizardMemoryStepProps {
  initialRemember?: boolean;
  initialDeeperRecall?: boolean;
  initialPermissions?: WizardPermissions;
  /** The real state root, shown so "where do you keep this" has an honest answer. */
  storagePath: string;
  onDone: (patch: { setup: Setup }) => void;
  onBack?: () => void;
  saveState?: WizardSaveState;
}

/**
 * The wizard's *Remembering, and what I may do* step.
 *
 * Remembering already works — `broker/src/memory.ts` recalls lexically and
 * says in its own header that it needs no embeddings at this corpus size. So
 * the spec's "your login can't do that part" download is NOT offered: the
 * preference for deeper recall is recorded, and a control appears only once
 * something can act on it.
 *
 * The storage path is shown rather than edited. Moving a live state root means
 * relocating agents, sessions, worktrees and the queue while the broker holds
 * them open — not a wizard-sized change.
 */
export function WizardMemoryStep({
  initialRemember = true,
  initialDeeperRecall = false,
  initialPermissions = DEFAULT_PERMISSIONS,
  storagePath,
  onDone,
  onBack,
  saveState = "idle",
}: WizardMemoryStepProps) {
  const [remember, setRemember] = useState(initialRemember);
  const [deeperRecall, setDeeperRecall] = useState(initialDeeperRecall);
  const [permissions, setPermissions] = useState<WizardPermissions>(initialPermissions);

  const set = (key: keyof WizardPermissions, value: PermissionStance) =>
    setPermissions((p) => ({ ...p, [key]: value }));

  return (
    <section>
      <h2>Remembering, and what I may do</h2>

      <fieldset>
        <legend>Should I remember our conversations?</legend>
        <label>
          <input type="radio" name="remember" checked={remember} onChange={() => setRemember(true)} />
          Yes, remember me
        </label>
        <label>
          <input type="radio" name="remember" checked={!remember} onChange={() => setRemember(false)} />
          Start fresh each time
        </label>
      </fieldset>

      {remember && (
        <label>
          <input type="checkbox" checked={deeperRecall} onChange={(e) => setDeeperRecall(e.target.checked)} />
          Tell me when I can recall things more deeply than by wording
        </label>
      )}

      <fieldset>
        <legend>What may I do without asking?</legend>
        {CAPABILITIES.map((cap) => (
          <fieldset key={cap.key} aria-label={cap.label}>
            <legend>{cap.label}</legend>
            {STANCES.map((s) => (
              <label key={s.value}>
                <input
                  type="radio"
                  name={cap.key}
                  checked={permissions[cap.key] === s.value}
                  onChange={() => set(cap.key, s.value)}
                />
                {s.label}
              </label>
            ))}
          </fieldset>
        ))}
      </fieldset>

      <p>
        Where I keep all this: <code>{storagePath}</code>
      </p>

      <footer>
        {onBack && (
          <button type="button" onClick={onBack} disabled={saveState === "saving"}>
            Back
          </button>
        )}
        <button
          type="button"
          disabled={saveState === "saving"}
          onClick={() => onDone({ setup: { remember, deeperRecall, permissions } })}
        >
          Continue
        </button>
      </footer>
    </section>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd control-plane && npx vitest run src/organisms/WizardMemoryStep.test.tsx`
Expected: PASS, 7 tests

- [ ] **Step 6: Typecheck, lint, commit**

```bash
pnpm --filter control-plane typecheck
npx biome check --write control-plane/src/organisms/WizardMemoryStep.tsx control-plane/src/organisms/WizardMemoryStep.test.tsx control-plane/src/lib/wizardSteps.ts
git add control-plane/src/organisms/WizardMemoryStep.tsx control-plane/src/organisms/WizardMemoryStep.test.tsx control-plane/src/lib/wizardSteps.ts
git commit -m "feat(control-plane): wizard step 5 — remembering, and what I may do"
```

---

### Task 2: Into the sequence

**Files:**
- Modify: `control-plane/src/lib/wizardSteps.ts` (`WIZARD_STEPS`, `setupStepsFor`, `STEP_DEFS`)
- Modify: `control-plane/src/lib/wizardSteps.test.ts`
- Modify: `control-plane/src/organisms/WizardGate.tsx`
- Modify: `control-plane/src/organisms/WizardGate.test.tsx`

**Interfaces:**
- Consumes: `WizardMemoryStep` and `PermissionStance` from Task 1.
- Produces: the id `"memory"` in `WizardStep`; `stepsFor({mode:"local"})` returns five entries ending in `memory`.

- [ ] **Step 1: Write the failing test**

Append to `control-plane/src/lib/wizardSteps.test.ts`:

```ts
describe("Remembering joins the sequence", () => {
  it("comes after talk, making the local sequence five steps", () => {
    expect(setupStepsFor({ mode: "local" })).toEqual(["sources", "roles", "voice", "talk", "memory"]);
  });

  it("counts as step 5 of 5", () => {
    expect(progressFor("memory", { mode: "local" })).toEqual({ n: 5, of: 5 });
    expect(progressFor("talk", { mode: "local" })).toEqual({ n: 4, of: 5 });
  });

  it("carries the spec's own section name", () => {
    expect(stepsFor({ mode: "local" }).find((s) => s.id === "memory")?.title).toBe(
      "Remembering, and what I may do",
    );
  });

  it("its skip default sets EVERY answer explicitly — remember, and all three stances", () => {
    // A partial patch would leave one answer standing from an earlier run.
    expect(stepsFor({ mode: "local" }).find((s) => s.id === "memory")?.skipDefault()).toEqual({
      remember: true,
      deeperRecall: false,
      permissions: { readFiles: "ask", runCommands: "ask", browseWeb: "ask" },
    });
  });

  it("is unconditional — the step ASKS, so a record already carrying answers still reaches it", () => {
    expect(setupStepsFor({ mode: "local", remember: false })).toEqual([
      "sources",
      "roles",
      "voice",
      "talk",
      "memory",
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd control-plane && npx vitest run src/lib/wizardSteps.test.ts`
Expected: FAIL — the sequence is four entries and `STEP_DEFS` has no `memory` key.

- [ ] **Step 3: Implement the registry entry**

In `control-plane/src/lib/wizardSteps.ts`:

```ts
export const WIZARD_STEPS = [PREFLIGHT, "sources", "roles", "voice", "talk", "memory"] as const;
```

In `setupStepsFor`, return:

```ts
  return ["sources", "roles", "voice", "talk", "memory"];
```

In `STEP_DEFS`, after `talk`:

```ts
  memory: {
    title: "Remembering, and what I may do",
    description: "What I keep, and what I may do without asking",
    skipLabel: "Skip — I'll remember, and ask before doing anything",
    // Every answer, always. Asking first is the safe stance and the one a user
    // who never reached this screen would expect; remembering is on because it
    // already works and costs nothing.
    skipDefault: () => ({
      remember: true,
      deeperRecall: false,
      permissions: { readFiles: "ask", runCommands: "ask", browseWeb: "ask" },
    }),
  },
```

- [ ] **Step 4: Fix the assertions that encoded four steps**

`stepsFor` is compile-checked, so `tsc` finds the registry gap; the tests below encode the old length and must be updated, not weakened:

- `setupStepsFor({ mode: "local" })` — three occurrences in `wizardSteps.test.ts`, each gains `"memory"`.
- the titles array gains `"Remembering, and what I may do"`.
- `progressFor` literals move from `of: 4` to `of: 5`, and a `memory` line is added.
- the `nextStep` walk gains `expect(nextStep("talk", { mode: "local" })).toBe("memory")` and `expect(nextStep("memory", { mode: "local" })).toBeNull()`.
- In `WizardGate.test.tsx`: `Step 1 of 4` → `Step 1 of 5` (two places); the Skip-on-talk test now expects `step: "memory"` rather than `SETUP_DONE` and `data-step` `"memory"`; the two **last-step** footer tests move from `talk` to `memory` — they have moved roles → voice → talk → memory, once per appended step, and their comment already says so.

- [ ] **Step 5: Render it in the gate**

In `WizardGate.tsx`, beside the other seeds:

```ts
  const [remember, setRemember] = useState(me.setup?.remember);
  const [deeperRecall, setDeeperRecall] = useState(me.setup?.deeperRecall);
  const [permissions, setPermissions] = useState(me.setup?.permissions);
```

In `advance`'s setter block:

```ts
    if (patch.setup?.remember !== undefined) setRemember(patch.setup.remember);
    if (patch.setup?.deeperRecall !== undefined) setDeeperRecall(patch.setup.deeperRecall);
    if (patch.setup?.permissions !== undefined) setPermissions(patch.setup.permissions);
```

And after the `talk` block:

```tsx
          {step === "memory" && (
            <WizardMemoryStep
              initialRemember={remember}
              initialDeeperRecall={deeperRecall}
              initialPermissions={permissions}
              storagePath="~/.smithagents"
              onDone={advance}
              onBack={onBack}
              saveState={saveState}
            />
          )}
```

Import `WizardMemoryStep` beside `WizardTalkStep`.

- [ ] **Step 6: Run the touched suites**

Run: `cd control-plane && npx vitest run src/lib/wizardSteps.test.ts src/organisms/WizardGate.test.tsx src/organisms/WizardMemoryStep.test.tsx`
Expected: PASS, all three files.

- [ ] **Step 7: Typecheck, lint, commit**

```bash
pnpm --filter control-plane typecheck
npx biome check --write control-plane/src/lib/wizardSteps.ts control-plane/src/organisms/WizardGate.tsx control-plane/src/lib/wizardSteps.test.ts control-plane/src/organisms/WizardGate.test.tsx
git add control-plane/src
git commit -m "feat(control-plane): wizard — Remembering joins the sequence, Step n of 5"
```

---

### Task 3: Walk it

- [ ] **Step 1: Confirm a browser that can click is available**

Plan 4's walk was blocked because the only browser tool could load and screenshot but not click. Check first; if clicking is still unavailable, **say so and stop** rather than reporting a walk that did not happen.

- [ ] **Step 2: Prove the record, which needs no browser**

```bash
cp ~/.smithagents/users/me.json /tmp/me.json.bak
curl -s -X PUT http://127.0.0.1:7790/me -H 'content-type: application/json' \
  -d '{"setup":{"remember":false,"deeperRecall":false,"permissions":{"readFiles":"allow","runCommands":"never","browseWeb":"ask"}}}'
python3 -c "import json;print(json.load(open('$HOME/.smithagents/users/me.json'))['setup'])"
```

Expected: every field present, merged beside `voice`/`smallTalk`/`worldAware` rather than replacing them.

- [ ] **Step 3: Walk the screen, if clicking is possible**

Defaults render (remember yes, all three asking); a changed stance survives Continue; `Step 5 of 5`; the skip applies the stated default; **no download control and no 90MB copy appears anywhere**; the path is shown and not editable.

- [ ] **Step 4: Restore**

```bash
cp /tmp/me.json.bak ~/.smithagents/users/me.json
```

Restore `setup.step: "done"` if the walk changed it.

- [ ] **Step 5: Report what was and was not observed**

State plainly which proofs ran. "Verified by unit tests" is not a walk — that conflation is what hid a dead feature for a whole plan in this same wizard.

---

## Self-Review

**Spec coverage.** The remember question (Task 1), the permissions matrix (Task 1), the storage path (Task 1, shown per ruling 3), sequence and count (Task 2), the walk (Task 3). The embeddings fork is asked but not built, per ruling 1.

**Gaps, stated rather than hidden:**

- **Nothing consumes `permissions` yet.** The wizard records three stances that no executor reads — agents are not gated by them today. This plan deliberately ships the *answer* without the *enforcement*, and that is the same shape as the dead feature found in plan 4. It is acceptable only because a recorded preference is inert rather than misleading, whereas a download button implies a capability. **If enforcement is wanted before the question is asked, this plan should not run.**
- **`deeperRecall` has no consumer either**, by the same ruling.
- The storage path is hardcoded to `~/.smithagents` in the gate rather than read from the running broker's actual state root. A follow-up should read it, so the screen cannot claim a path the install is not using.
