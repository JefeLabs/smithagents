# Welcome Wizard 3 — Preflight Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the wizard's flat step list with one preflight screen whose answers select the sequence that follows, and give every setup step a working Back.

**Architecture:** `wizardSteps.ts` stops being a flat array. Preflight becomes a single screen collecting name, voice, and mode; the setup sequence is computed from those answers. `WizardGate` gains `goBack` alongside `advance`, both persisting. `WizardNameStep` and `WizardForkStep` merge into `WizardPreflightStep`.

**Tech Stack:** React 19, TypeScript, react-hook-form, vitest + Testing Library, HeroUI Pro (`Stepper`, `RadioButtonGroup`).

**Spec:** `docs/superpowers/specs/2026-08-15-welcome-wizard-design.md` — see its **"Revision, 2026-08-17: preflight, and intent before requirements"** section, which this plan implements.

## Scope

**In:** the preflight screen, the derived sequence, back navigation, and the two label corrections.

**Out, deliberately:** the Voice setup step, the Location step, and the Workspace step are each their own plan. This plan builds the *mechanism* that conditionally includes them and **persists the voice answer** so it is ready — it does not build those screens. A sequence entry for a screen that does not exist would be a dead route.

## Global Constraints

- **pnpm, never npm.** Run gates from the repo root.
- **Baselines, confirmed by name.** control-plane vitest **979 pass / 2 fail**
  (`HomePage` composer-backs-out, `MapStage` pan-mode-toggle — both
  pre-existing); `tsc --noEmit` **10 errors**, all pre-existing; swarm
  **649 pass / 0 fail**. A third control-plane failure is yours.
- **biome baseline is 6 errors / 2 warnings / 1 info, NOT zero.** Measured on
  `origin/main` in a detached worktree and byte-identical to this branch, so
  none of it is ours and none of it blocks. Do not "fix" it here.
- **biome measurement trap:** run it as `pnpm exec biome check .` with cwd
  inside the tree being checked. Running from the repo root **against a path
  argument** resolves config from the cwd instead and inflates the count to
  34/53/9. A number nothing like the baseline above means the cwd is wrong,
  not that the branch broke something.
- **Count `tsc` errors with `grep -c 'error TS'`** after stripping ANSI, and
  cross-check the exit code. `grep -oE 'Found [0-9]+ error'` prints nothing
  without `--pretty` and reads as zero.
- **`data-step` stays on the wizard host root.** Existing tests assert through
  it rather than any step's internal markup.
- **Native `disabled`, not `aria-disabled` alone.** react-aria's roving-focus
  walker filters on `input:not([disabled])`, so `aria-disabled` alone leaves a
  control keyboard-activatable. The disabled Cloud option needs **both**:
  native `disabled` to stop focus, `aria-disabled` because this stylesheet's
  `pointer-events: none` keys off it. HeroUI's `RadioButtonGroup.Item` can
  **never** emit `aria-disabled` — react-aria's
  `filterDOMProps(props, {labelable: true})` drops it — so the disabled option
  stays a hand-authored native `<input type="radio">` in a `<label>`, exactly
  as `WizardForkStep` does today. **Carry that code across; do not re-derive
  it.**
- **`brokerFetch` never throws on a non-2xx** — client fns resolve with
  `{error?: string}`. A `.catch` alone catches only network rejections. Keep
  the two failure shapes distinct, as `advance` already does.
- **Setup merges; it never clears.** `buildUserUpdate` persists
  `{...existing.setup, ...body.setup}`, so **omitting a field keeps its old
  value**. Verified live. Any answer change must send the explicit new value.
- **Do not regress the styling** on this branch: the panel, the sticky footer
  (`.wizard-gate__footer`), the `headingLevel` prop, and the two-up card grid.
- Four themes exist — default, light, midnight, **sand**.

---

## Verified preconditions

Measured on the live install before this plan was written, so no task needs to
re-establish them:

- **An unknown `setup` field survives the round trip.** A `PUT /me` carrying
  `setup.voice` came back from a subsequent `GET /me` intact. `buildUserUpdate`
  spreads rather than allow-lists, so persisting `voice` needs **no swarm
  change beyond widening the type** at `swarm/src/users.ts:48`.
- **The live install root is `~/.smithagents/`.** The repo's
  `swarm/.smith/users/me.json` is a stale artifact and is not what the running
  broker serves. Drive live checks through the API, not that file.

---

## File Structure

- `control-plane/src/lib/wizardSteps.ts` — **modify.** Preflight constant,
  answer-derived sequence, `nextStep`/`prevStep`/`resumeStep`.
- `control-plane/src/lib/wizardSteps.test.ts` — **modify.**
- `control-plane/src/organisms/WizardPreflightStep.tsx` — **create.** The one
  screen: name, voice, mode.
- `control-plane/src/organisms/WizardPreflightStep.test.tsx` — **create.**
- `control-plane/src/organisms/WizardNameStep.tsx` — **delete** (merged).
- `control-plane/src/organisms/WizardForkStep.tsx` — **delete** (merged; its
  hand-authored disabled radio moves into the preflight step).
- `control-plane/src/organisms/WizardGate.tsx` — **modify.** Preflight renders
  without an indicator; `goBack` added.
- `control-plane/src/organisms/WizardGate.test.tsx` — **modify.**
- `swarm/src/users.ts:48` — **modify.** Widen `setup` with `voice?: boolean`.

---

### Task 1: The sequence derives from the preflight answers

**Files:**
- Modify: `control-plane/src/lib/wizardSteps.ts`, `swarm/src/users.ts`
- Test: `control-plane/src/lib/wizardSteps.test.ts`

**Interfaces:**
- Produces, for Tasks 2 and 3:
  - `PREFLIGHT: "preflight"` — the single preflight step id
  - `SetupMode = "local" | "hosted"`
  - `Setup = { mode?: SetupMode; voice?: boolean; step?: string } | undefined`
  - `setupStepsFor(setup: Setup): readonly WizardStep[]`
  - `nextStep(current: string, setup: Setup): WizardStep | null`
  - `prevStep(current: string, setup: Setup): WizardStep | null`
  - `resumeStep(setup: Setup): WizardStep`
  - `WIZARD_STEP_META: Record<WizardStep, {title, description}>`

- [ ] **Step 1: Write the failing tests**

Replace the step-model tests in `control-plane/src/lib/wizardSteps.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  nextStep,
  PREFLIGHT,
  prevStep,
  resumeStep,
  setupStepsFor,
  WIZARD_STEP_META,
} from "./wizardSteps";

describe("preflight", () => {
  it("is one screen, not a list of steps", () => {
    expect(PREFLIGHT).toBe("preflight");
  });

  it("is never part of the sequence it selects", () => {
    expect([...setupStepsFor({ mode: "local" })]).not.toContain(PREFLIGHT);
  });
});

describe("the sequence derives from the answers", () => {
  it("local mode yields the local sequence", () => {
    expect([...setupStepsFor({ mode: "local" })]).toEqual(["subscriptions", "anderson"]);
  });

  it("no mode yields no sequence rather than defaulting to local", () => {
    // Defaulting would walk someone into CLI installation on a missing field.
    expect([...setupStepsFor({})]).toEqual([]);
    expect([...setupStepsFor(undefined)]).toEqual([]);
  });

  it("the voice answer is carried but adds no step in this plan", () => {
    // The Voice screen is a later plan. Until it exists, a sequence entry for
    // it would be a dead route — but the ANSWER must already round-trip.
    expect([...setupStepsFor({ mode: "local", voice: true })]).toEqual(["subscriptions", "anderson"]);
  });
});

describe("labels match the spec", () => {
  it("does not call the mode question Location — that is a different step", () => {
    expect(Object.values(WIZARD_STEP_META).map((m) => m.title)).not.toContain("Location");
  });

  it("names Configure Anderson, not Brain", () => {
    expect(WIZARD_STEP_META.anderson.title).toBe("Anderson");
  });
});

describe("nextStep", () => {
  it("leaves preflight for the first step of the chosen sequence", () => {
    expect(nextStep(PREFLIGHT, { mode: "local" })).toBe("subscriptions");
  });

  it("cannot leave preflight with no mode chosen", () => {
    expect(nextStep(PREFLIGHT, {})).toBeNull();
  });

  it("walks the sequence and ends at null", () => {
    expect(nextStep("subscriptions", { mode: "local" })).toBe("anderson");
    expect(nextStep("anderson", { mode: "local" })).toBeNull();
  });
});

describe("prevStep — the escape hatch a blocking step depends on", () => {
  it("goes back from the first setup step into preflight", () => {
    expect(prevStep("subscriptions", { mode: "local" })).toBe(PREFLIGHT);
  });

  it("goes back within the sequence", () => {
    expect(prevStep("anderson", { mode: "local" })).toBe("subscriptions");
  });

  it("cannot go back from preflight — it is the beginning", () => {
    expect(prevStep(PREFLIGHT, { mode: "local" })).toBeNull();
  });
});

describe("resumeStep", () => {
  it("starts at preflight with no record", () => {
    expect(resumeStep(undefined)).toBe(PREFLIGHT);
  });

  it("returns to preflight for a setup step saved with no mode", () => {
    expect(resumeStep({ step: "subscriptions" })).toBe(PREFLIGHT);
  });

  it("resumes a step the recorded answers actually contain", () => {
    expect(resumeStep({ mode: "local", step: "anderson" })).toBe("anderson");
  });

  it("restarts on a step id the sequence does not contain", () => {
    expect(resumeStep({ mode: "local", step: "not-a-step" })).toBe(PREFLIGHT);
  });
});
```

- [ ] **Step 2: Run the tests and verify they FAIL**

Run: `pnpm --filter control-plane test -- wizardSteps`
Expected: failures — `PREFLIGHT`, `prevStep`, `setupStepsFor` are not exported; `nextStep` takes a mode not a setup; `WIZARD_STEP_META` still has `fork: {title: "Location"}` and `brain`, not `anderson`.

If any assertion passes here, it is not discriminating — fix it before continuing.

- [ ] **Step 3: Rewrite the model**

Replace the step model in `control-plane/src/lib/wizardSteps.ts`:

```ts
/**
 * The wizard has two phases, and only the second is a sequence.
 *
 * PREFLIGHT is one screen asking three questions about intent — name, voice,
 * mode. It never appears in the step indicator, because an indicator over it
 * would assert an order that its own answers have not yet chosen. It never
 * blocks: none of its answers can be wrong.
 *
 * The SETUP sequence is computed from those answers. It is a function, not a
 * constant, because the spec makes voice add a step and mode select a branch —
 * neither is expressible as one flat array (which is what this file used to
 * hold, and what shipped the defects this rewrite fixes).
 */
export const PREFLIGHT = "preflight";

export type SetupMode = "local" | "hosted";

/** Every id the host can render, preflight included. */
export const WIZARD_STEPS = [PREFLIGHT, "subscriptions", "anderson"] as const;

export type WizardStep = (typeof WIZARD_STEPS)[number];

export type Setup = { mode?: SetupMode; voice?: boolean; step?: string } | undefined;

/**
 * Titles come from the spec's own flow map. Two had drifted and would have
 * collided with steps still to come: the mode question was titled "Location"
 * (which is the geolocation step) and Configure Anderson was titled "Brain".
 */
export const WIZARD_STEP_META: Record<WizardStep, { title: string; description: string }> = {
  [PREFLIGHT]: { title: "Welcome", description: "Tell us about you" },
  subscriptions: { title: "Subscriptions", description: "Connect a CLI or key" },
  anderson: { title: "Anderson", description: "Pick a brain" },
};

/**
 * The sequence these answers select.
 *
 * An absent mode yields NOTHING rather than defaulting to local: the mode
 * question is what establishes it, and assuming local would walk someone into
 * CLI installation on the strength of a missing field.
 *
 * `voice` is carried in `Setup` and persisted, but adds no step yet — the
 * Voice screen is a later plan, and an entry here for a screen that does not
 * exist would be a dead route. When that plan lands it inserts "voice" after
 * "subscriptions" here, and nothing else in this file changes.
 */
export function setupStepsFor(setup: Setup): readonly WizardStep[] {
  if (!setup?.mode) return [];
  if (setup.mode === "hosted") return [];
  return ["subscriptions", "anderson"];
}

/** The next step, or null at the end of the selected sequence. */
export function nextStep(current: string, setup: Setup): WizardStep | null {
  const steps = setupStepsFor(setup);
  if (current === PREFLIGHT) return steps[0] ?? null;
  const i = steps.indexOf(current as WizardStep);
  return i >= 0 && i < steps.length - 1 ? steps[i + 1] : null;
}

/**
 * The previous step, or null at the beginning.
 *
 * Load-bearing rather than a convenience: a later plan's Voice step BLOCKS on
 * two connectors, so without a way back, asking for voice without an
 * elevenlabs key is a gate that can be neither passed nor retracted. Back into
 * preflight is what makes that answer retractable.
 */
export function prevStep(current: string, setup: Setup): WizardStep | null {
  if (current === PREFLIGHT) return null;
  const steps = setupStepsFor(setup);
  const i = steps.indexOf(current as WizardStep);
  if (i > 0) return steps[i - 1];
  return PREFLIGHT;
}

/** Sentinel stored once the last step is done. */
export const SETUP_DONE = "done";

/**
 * Where to resume. A step the recorded answers do not contain — a record from
 * a newer build, a hand-edited one, or one saved before the mode was chosen —
 * returns to preflight rather than stranding the user on a step that the
 * current answers cannot reach.
 */
export function resumeStep(setup: Setup): WizardStep {
  const step = setup?.step;
  if (!step || step === PREFLIGHT) return PREFLIGHT;
  return setupStepsFor(setup).includes(step as WizardStep) ? (step as WizardStep) : PREFLIGHT;
}

export function isSetupComplete(setup: Setup): boolean {
  return setup?.step === SETUP_DONE;
}
```

Then widen the swarm-side type at `swarm/src/users.ts:48`:

```ts
  setup?: { mode?: "local" | "hosted"; voice?: boolean; step?: string };
```

- [ ] **Step 4: Run the tests and verify they PASS**

```bash
pnpm --filter control-plane test -- wizardSteps
pnpm --filter swarm test
```

Expected: the wizardSteps suite PASSES; swarm **649 pass / 0 fail**.

`WizardGate` still calls the old signatures and will not typecheck until Task 3 — that is expected here; do not patch it in this task.

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/lib/wizardSteps.ts control-plane/src/lib/wizardSteps.test.ts swarm/src/users.ts
git commit -m "refactor(wizard): the setup sequence is a function of the preflight answers"
```

---

### Task 2: One preflight screen — name, voice, mode

**Files:**
- Create: `control-plane/src/organisms/WizardPreflightStep.tsx`
- Create: `control-plane/src/organisms/WizardPreflightStep.test.tsx`
- Delete: `control-plane/src/organisms/WizardNameStep.tsx`, `control-plane/src/organisms/WizardForkStep.tsx` (and their test files)

**Interfaces:**
- Consumes from Task 1: `Setup`, `SetupMode`.
- Produces, for Task 3:
  ```ts
  export interface WizardPreflightStepProps {
    initialName: string;
    initialVoice?: boolean;
    initialMode?: SetupMode;
    onDone: (patch: { name: string; setup: Setup }) => void;
  }
  export function WizardPreflightStep(props: WizardPreflightStepProps): JSX.Element
  ```
  `onDone` always emits **explicit** `voice` and `mode` values — never omitted.

**Read before writing:** `WizardNameStep.tsx` (react-hook-form + `FormTextField`
+ the `.wizard-gate__footer` band) and `WizardForkStep.tsx` (the hand-authored
disabled radio and the long comment explaining why it must be hand-authored).
This task **merges** those two files. Carry their working code and their
comments across rather than re-deriving either.

- [ ] **Step 1: Write the failing tests**

Create `control-plane/src/organisms/WizardPreflightStep.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { WizardPreflightStep } from "./WizardPreflightStep";

const setup = (over = {}) => {
  const onDone = vi.fn();
  render(<WizardPreflightStep initialName="" onDone={onDone} {...over} />);
  return { onDone, user: userEvent.setup() };
};

describe("WizardPreflightStep", () => {
  it("asks all three questions on one screen", () => {
    setup();
    expect(screen.getByLabelText(/your name/i)).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /voice/i })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /local/i })).toBeInTheDocument();
  });

  it("requires a name — the record cannot be created without one", async () => {
    const { user } = setup();
    expect(screen.getByRole("button", { name: /continue/i })).toBeDisabled();
    await user.type(screen.getByLabelText(/your name/i), "Edwin");
    expect(screen.getByRole("button", { name: /continue/i })).toBeEnabled();
  });

  it("offers Cloud but cannot let it be chosen", () => {
    setup();
    const cloud = screen.getByRole("radio", { name: /cloud/i });
    // Native `disabled`, not aria-disabled alone: react-aria's roving-focus
    // walker filters on input:not([disabled]), so aria-disabled alone would
    // leave this arrow-key reachable and selectable.
    expect(cloud).toBeDisabled();
  });

  it("emits voice explicitly as false when not chosen, never omitted", async () => {
    // Setup MERGES: an omitted field keeps its previous value, so a user who
    // goes back and turns voice OFF must send false, not nothing.
    const { onDone, user } = setup({ initialName: "Edwin", initialVoice: true });
    await user.click(screen.getByRole("radio", { name: /^no$/i }));
    await user.click(screen.getByRole("button", { name: /continue/i }));
    expect(onDone).toHaveBeenCalledWith(
      expect.objectContaining({ setup: expect.objectContaining({ voice: false }) }),
    );
  });

  it("emits the name, the voice answer and the mode together", async () => {
    const { onDone, user } = setup();
    await user.type(screen.getByLabelText(/your name/i), "Edwin");
    await user.click(screen.getByRole("radio", { name: /^yes$/i }));
    await user.click(screen.getByRole("button", { name: /continue/i }));
    expect(onDone).toHaveBeenCalledWith({ name: "Edwin", setup: { voice: true, mode: "local" } });
  });

  it("seeds from prior answers so going back shows what was chosen", () => {
    setup({ initialName: "Edwin", initialVoice: true, initialMode: "local" });
    expect(screen.getByLabelText(/your name/i)).toHaveValue("Edwin");
    expect(screen.getByRole("radio", { name: /^yes$/i })).toBeChecked();
  });
});
```

- [ ] **Step 2: Run the tests and verify they FAIL**

Run: `pnpm --filter control-plane test -- WizardPreflightStep`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Build the screen**

Create `control-plane/src/organisms/WizardPreflightStep.tsx`. Requirements, all
load-bearing:

- One `<form>`, three fieldsets: name (`FormTextField`, react-hook-form,
  seeded from `initialName`), voice (a `RadioButtonGroup` of Yes/No with an
  accessible group name matching `/voice/i`, seeded from `initialVoice`,
  defaulting to **No**), mode (Local enabled and default-selected; **Cloud**
  hand-authored per `WizardForkStep`'s comment, carrying both `disabled` and
  `aria-disabled`, labelled "Coming soon", with the `notify me` link as a
  **sibling of the group**, never a descendant of the disabled node).
- Continue lives in `.wizard-gate__footer` and is disabled **only** while the
  name is blank after trimming — watched via `useWatch`, not `formState.errors`
  (errors only exist after a validation run, so a pristine blank form would
  otherwise have Continue enabled).
- `onDone({ name, setup: { voice, mode } })` — `voice` and `mode` **always
  present**, because setup merges and an omitted field keeps its old value.
- The user-facing word is **Cloud**; the emitted value stays `"hosted"`.

Then delete `WizardNameStep.tsx`, `WizardForkStep.tsx` and their test files.

- [ ] **Step 4: Run the tests and verify they PASS**

Run: `pnpm --filter control-plane test -- WizardPreflightStep`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A control-plane/src/organisms
git commit -m "feat(wizard): one preflight screen — name, voice, and where this runs"
```

---

### Task 3: The host renders preflight bare, greets, and goes back

**Files:**
- Modify: `control-plane/src/organisms/WizardGate.tsx`
- Test: `control-plane/src/organisms/WizardGate.test.tsx`

**Interfaces:**
- Consumes: Tasks 1 and 2.

- [ ] **Step 1: Write the failing tests**

Add to `control-plane/src/organisms/WizardGate.test.tsx`, using the file's
existing render helpers and its existing way of reading the host's `data-step`:

```tsx
it("shows no step indicator on preflight", async () => {
  renderGate({ placeholder: true, setup: undefined });
  expect(await screen.findByTestId("wizard-host")).toHaveAttribute("data-step", "preflight");
  expect(screen.queryByText("Subscriptions")).toBeNull();
});

it("does not greet by name on preflight, where the name is being asked for", () => {
  renderGate({ placeholder: true, setup: undefined });
  expect(screen.queryByText(/Welcome,/)).toBeNull();
});

it("greets by name on the first setup step", async () => {
  renderGate({ name: "Edwin", setup: { mode: "local", step: "subscriptions" } });
  expect(await screen.findByText("Welcome, Edwin")).toBeInTheDocument();
});

it("shows only the chosen sequence in the indicator", async () => {
  renderGate({ name: "Edwin", setup: { mode: "local", step: "subscriptions" } });
  expect(await screen.findByText("Subscriptions")).toBeInTheDocument();
  expect(screen.getByText("Anderson")).toBeInTheDocument();
  expect(screen.queryByText("Welcome")).toBeNull(); // preflight is not in it
});

it("goes back from the first setup step into preflight, and persists it", async () => {
  const { updateMe } = renderGate({ name: "Edwin", setup: { mode: "local", step: "subscriptions" } });
  await userEvent.click(await screen.findByRole("button", { name: /back/i }));
  expect(await screen.findByTestId("wizard-host")).toHaveAttribute("data-step", "preflight");
  // Persisted, or a reload would resume at the step they just left.
  expect(updateMe).toHaveBeenCalledWith(
    expect.objectContaining({ setup: expect.objectContaining({ step: "preflight" }) }),
  );
});

it("offers no Back on preflight — it is the beginning", async () => {
  renderGate({ placeholder: true, setup: undefined });
  await screen.findByTestId("wizard-host");
  expect(screen.queryByRole("button", { name: /back/i })).toBeNull();
});
```

- [ ] **Step 2: Run the tests and verify they FAIL**

Run: `pnpm --filter control-plane test -- WizardGate`
Expected: FAIL — no Back button exists, and the indicator renders on preflight.

- [ ] **Step 3: Rewrite the host**

In `WelcomeWizard`:

- Hold `name`, `voice` and `mode` in state, seeded from `me`, updated inside
  `advance` from the patch. They must update from the **patch**, not be read
  back from `me` — `advance` is optimistic, so a refetch would land a beat late
  and the greeting and sequence would lag a step behind.
- Compute `const answers = { mode, voice }` and pass it to `nextStep`,
  `prevStep` and `setupStepsFor`. In `advance`, read the mode from
  **`patch.setup?.mode ?? mode`** — the preflight patch carries the mode that
  selects the sequence being entered, and state would not be visible yet.
- Render the `Stepper` only when `step !== PREFLIGHT` and the sequence is
  non-empty, driven by `setupStepsFor(answers)`.
- Greet with `{name ? \`Welcome, ${name}\` : "Welcome"}`, and render the
  greeting only outside preflight — preflight's own screen asks for the name,
  so a greeting above it is either empty or redundant.
- Add `goBack`, mirroring `advance`'s persistence and its two failure shapes:
  ```ts
  const goBack = () => {
    const current = step;
    const prev = prevStep(current, { mode, voice });
    if (!prev) return;
    setError(null);
    setStep(prev);
    api.updateMe({ setup: { step: prev } })
      .then((result) => {
        if (result.error) { setStep(current); setError(result.error); return; }
        void qc.invalidateQueries({ queryKey: qk.me });
      })
      .catch(() => { /* optimistic, same as advance: a reject is ambiguous */ });
  };
  ```
- Render a Back button in `.wizard-gate__footer` on every step where
  `prevStep(...)` is non-null, and pass `goBack` down to the step components
  that own their own footer.
- Render `WizardPreflightStep` for `PREFLIGHT`, seeded with `initialName`,
  `initialVoice`, `initialMode` so going back shows the prior answers.
- `brain` → `anderson` in the step switch, importing `WizardBrainStep` under
  the `anderson` id.

- [ ] **Step 4: Run the tests and verify they PASS**

```bash
pnpm --filter control-plane test
pnpm --filter control-plane exec tsc --noEmit 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -c 'error TS'
pnpm exec biome check control-plane/src
```

Expected: **979 pass / 2 fail** (the two named) adjusted for the tests this
plan adds and the step tests it deletes — report the actual number and account
for the delta. **10** `tsc` errors. **0** biome diagnostics.

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/organisms/WizardGate.tsx control-plane/src/organisms/WizardGate.test.tsx
git commit -m "feat(wizard): greet by name, derive the indicator, and let every step go back"
```

---

### Task 4: Configure Anderson says what it is

**Files:**
- Modify: `control-plane/src/organisms/WizardBrainStep.tsx`
- Test: `control-plane/src/organisms/WizardBrainStep.test.tsx`

The step already filters correctly to installed providers — `tools.filter(t => t.active)`
plus API providers whose key is `verified === true`. **Do not change that
logic.** This task is copy and framing only.

- [ ] **Step 1: Write the failing test**

```tsx
it("frames the step as setting Anderson up, and says where the options come from", () => {
  renderStep();
  expect(screen.getByRole("heading", { name: /set up anderson/i })).toBeInTheDocument();
  expect(screen.getByText(/installed provider tools/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run it and verify it FAILS**

Run: `pnpm --filter control-plane test -- WizardBrainStep`
Expected: FAIL — the current copy is "What should Anderson — the conversational host — use to reply?" with no heading.

- [ ] **Step 3: Change the copy**

Replace the prompt with a heading and body matching the spec's name for this
step:

- Heading (`<h2>`, since the host owns the page's `<h1>`): **"Set up Anderson"**
- Body: **"Anderson needs a brain. Choose from your installed provider tools."**
- Keep the existing empty-state hint for zero candidates unchanged; keep
  `aria-labelledby` wired to whatever element now carries the prompt text.

- [ ] **Step 4: Run the tests and verify they PASS**

Run: `pnpm --filter control-plane test -- WizardBrainStep`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/organisms/WizardBrainStep.tsx control-plane/src/organisms/WizardBrainStep.test.tsx
git commit -m "feat(wizard): Set up Anderson — name the step and where its options come from"
```

---

### Task 5: Walk it in a real browser

**Files:** none expected; commit any fix this finds.

A green suite has already failed twice on this branch to catch a screen the
user rejected on sight. This task is not optional.

- [ ] **Step 1: Reset to a genuine first run**

The dev server is at http://localhost:1420 against the broker on :7790. The
live record is `~/.smithagents/users/me.json` — **not** the repo's
`swarm/.smith/users/me.json`, which is a stale artifact. Back it up first:

```bash
cp ~/.smithagents/users/me.json /tmp/me.backup.json
curl -s -X PUT http://127.0.0.1:7790/me -H 'content-type: application/json' \
  -d '{"setup":{"step":"preflight"}}'
```

- [ ] **Step 2: Walk forward, screenshotting each screen**

Confirm and report evidence for each:
1. Preflight shows all three questions, **no indicator**, **no Back**, and no
   personalized greeting.
2. Continue is disabled until a name is typed, via a **native `disabled`**
   attribute.
3. Cloud is visible, labelled coming soon, **cannot** be selected — and
   ArrowDown from Local does not land on it.
4. The first setup step greets **"Welcome, <name>"** with no reload.
5. The indicator shows exactly `Subscriptions` and `Anderson`.
6. Continue is visible without scrolling on the Subscriptions step — report its
   measured `getBoundingClientRect().top`.

- [ ] **Step 3: Walk backward — the point of the whole plan**

From the Subscriptions step, press Back. Confirm: preflight reappears **with
the prior answers still filled in**, and a **reload** stays on preflight rather
than jumping forward to where the user had reached.

Then change the voice answer from Yes to No, Continue, and confirm via
`curl -s http://127.0.0.1:7790/me` that the stored `setup.voice` is **`false`**
and not still `true`. Setup merges rather than clears, so this is the assertion
that proves the answer was sent explicitly.

- [ ] **Step 4: Confirm nothing else was lost**

Diff `curl -s http://127.0.0.1:7790/me` against `/tmp/me.backup.json` and
confirm nothing outside `name` and `setup` changed — `agendaSweptDay` in
particular. `buildUserUpdate` has silently wiped fields on this codebase before.

- [ ] **Step 5: Themes, then restore**

Check all four themes — default, light, midnight, **sand** — on preflight and
on one setup step. Then:

```bash
cp /tmp/me.backup.json ~/.smithagents/users/me.json
curl -s http://127.0.0.1:7790/me
```

Confirm the app opens normally and the wizard does not reappear on reload.

- [ ] **Step 6: Commit any fix**

```bash
git add -A
git commit -m "fix(wizard): <what the walk actually found>"
```

If the walk found nothing, say so in the report and make no commit.

---

## Self-Review

**Spec coverage.** The 2026-08-17 revision's four requirements: preflight is
one non-blocking screen (Task 2); the sequence derives from its answers
(Task 1); back navigation exists and persists (Tasks 1 and 3); the two drifted
labels are corrected (Tasks 1 and 4). The revision's Voice, Location and
Workspace steps are explicitly out of scope — see **Scope** — with Task 1
carrying and persisting the voice answer so the later plan inserts one array
entry and nothing else.

**Placeholder scan.** Task 2's Step 3 is prose rather than a code block. That
is deliberate and bounded: it merges two existing files whose code and comments
the task is told to carry across verbatim, and reproducing
`WizardForkStep`'s hand-authored radio here would invite an implementer to
retype rather than move it — the exact failure mode that comment exists to
prevent. Every requirement in that step is testable by Task 2's Step 1 tests.

**Type consistency.** `nextStep`/`prevStep`/`setupStepsFor` all take `Setup`
(not a bare mode) across Tasks 1 and 3. `WIZARD_STEP_META` is keyed by
`WizardStep`, which includes `PREFLIGHT`, so the compiler rejects a missing or
stale entry. `anderson` replaces `brain` as an id in Task 1 and in the host's
switch in Task 3 — the component file keeps its `WizardBrainStep` name, which
Task 4 leaves alone.

**Known risk.** `resumeStep` sends any unrecognized step back to preflight,
including a valid step whose mode was cleared. That is deliberate — re-asking
three cheap questions beats stranding someone — but it means a corrupted
`mode` costs the user their place. Task 1 pins both branches.
