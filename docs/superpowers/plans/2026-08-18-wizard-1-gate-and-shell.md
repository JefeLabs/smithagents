# Wizard Sequence, Plan 1 — the gate, Anderson's voice, and the shell rules

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace preflight with Anderson's gate, and install the four shell rules the rest of the sequence assumes — the chip, honest `Step n of 6` progress, Skip-with-a-stated-default, and "Just pick sensible things for me".

**Architecture:** `WizardGate` keeps its two-phase shape (gate, then a sequence computed from the answers). The gate becomes a component that introduces Anderson and asks two questions. A step *registry* replaces the flat title/description map, so each step declares its own skip default and can be re-run alone; "Just pick sensible things for me" is that registry applied end to end. The theme is hoisted above the gate so the wizard stops rendering light on a dark machine.

**Tech Stack:** React 19, TypeScript, react-hook-form, HeroUI + HeroUI Pro, vitest + Testing Library, Playwright for the walk.

**Spec:** `docs/superpowers/specs/2026-08-18-welcome-wizard-local-setup.md`
**Roadmap:** `docs/superpowers/plans/2026-08-18-wizard-sequence-roadmap.md`

## Global Constraints

- **The spec's copy IS the design.** Where this plan and the spec disagree about
  wording, the spec wins. Anderson speaks in the **first person** throughout and
  **asks** rather than instructs.
- **pnpm, never npm.** `pnpm --filter control-plane test -- <name>` does **not**
  filter — use `pnpm exec vitest run <name>` with cwd in `control-plane/`.
  swarm's tests are the node runner (`pnpm test`), not vitest.
- **Baselines, measured on `a763538`:** control-plane **1025 pass / 2 fail
  (1027)** — the two are `HomePage` composer-backs-out and `MapStage`
  pan-mode-toggle, both pre-existing; swarm **649/0**; control-plane
  `tsc --noEmit` **10**; biome (cwd `control-plane/`) **0 errors / 0 warnings /
  1 info**. A third *failure* is yours.
- **`MapStage.test.tsx` is load-fragile.** Two other tests in it fail
  transiently under full-suite load and pass in isolation. If you see a third
  failure there, re-run and check isolation before blaming your change — but
  **say that you did**, and never assume.
- **`tsc` counting:** `grep -c 'error TS'` after stripping ANSI, cross-checked
  against the exit code. `grep -oE 'Found [0-9]+ error'` prints nothing without
  `--pretty` and reads as zero.
- **Native `disabled`, not `aria-disabled` alone.** react-aria's roving-focus
  walker filters on `input:not([disabled])`. The disabled Cloud option needs
  **both** — native `disabled` to stop focus, `aria-disabled` because the
  stylesheet's `pointer-events: none` keys off it — and it must stay a
  hand-authored native `<input type="radio">`, because
  `filterDOMProps(props, {labelable: true})` drops `aria-disabled` from a real
  `RadioButtonGroup.Item` entirely.
- **`brokerFetch` never throws on a non-2xx.** A network failure REJECTS
  (ambiguous — stay optimistic); a server refusal RESOLVES with `{error}` (a
  firm no — roll back and show the server's sentence). Keep them distinct.
- **Setup MERGES, it never clears.** `buildUserUpdate` persists
  `{...existing.setup, ...body.setup}`, so an omitted field keeps its old value.
  Any answer change must send the explicit new value.
- **`data-step` stays on the host root.** Tests key off it. There is **no
  `data-testid`** in production markup in this repo — do not introduce one.
- **HeroUI's radio indicator is pinned** `absolute end-4 top-3` — it is a *card*
  component assuming a row wide enough for a corner dot. A shrink-wrapped
  horizontal option puts the indicator **on top of its own label**. jsdom has no
  layout, so no unit test can see it: any new horizontal radio row needs the
  indicator given its own column, and needs a browser check.
- Five themes exist — default, light, dark, midnight, **sand**.

---

## File Structure

- `control-plane/src/lib/wizardSteps.ts` — **modify.** The step registry:
  ids, titles, skip defaults, and the sequence function.
- `control-plane/src/lib/wizardSteps.test.ts` — **modify.**
- `control-plane/src/organisms/WizardGateStep.tsx` — **create.** Anderson's
  introduction plus the two questions. Replaces `WizardPreflightStep`.
- `control-plane/src/organisms/WizardGateStep.test.tsx` — **create.**
- `control-plane/src/organisms/WizardPreflightStep.tsx` — **delete** (renamed
  and re-voiced). Its two discrimination tests move across.
- `control-plane/src/molecules/WizardChip.tsx` — **create.** The persistent chip.
- `control-plane/src/molecules/WizardChip.test.tsx` — **create.**
- `control-plane/src/organisms/WizardGate.tsx` — **modify.** Chip, progress,
  skip, and the theme hoist's consumer.
- `control-plane/src/hooks/useTheme.ts` — **modify.** Becomes a provider so one
  instance owns the choice.
- `control-plane/src/App.tsx` — **modify.** Provider above `AuthGate`.
- `control-plane/src/styles/components.css` — **modify.** Chip and gate chrome.

---

### Task 1: The theme applies above the gate

**Files:**
- Modify: `control-plane/src/hooks/useTheme.ts`, `control-plane/src/App.tsx`,
  `control-plane/src/pages/HomePage.tsx`
- Test: `control-plane/src/hooks/useTheme.test.tsx`

**Why first:** every later task is verified by screenshot, and today **every
wizard screenshot is a lie** — the wizard renders light on a machine set to
midnight. Fixing it first makes the rest of this plan's visual evidence honest.

**The bug, proven live:** `localStorage["smith.theme"] === "midnight"` while the
wizard is on screen, yet `document.documentElement` has `data-theme === null`,
no `dark` class, and the panel paints `rgb(255,255,255)`. `useTheme()` is called
in exactly one place — `HomePage.tsx:144` — which sits inside `<RouterProvider>`
and is therefore a **child** of `WizardGate` (`App.tsx:10-14`). While the wizard
renders, `WizardGate` returns the wizard *instead of* `children`, so `HomePage`
never mounts and nothing ever sets `data-theme`.

**Interfaces:**
- Produces: `<ThemeProvider>` and a `useTheme()` that reads from it. Same
  `{ theme, setTheme }` shape, so `HomePage`'s switcher is unchanged apart from
  losing its own `useState`.

- [ ] **Step 1: Write the failing test**

Create `control-plane/src/hooks/useTheme.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { ThemeProvider, useTheme } from "./useTheme";

function Switcher() {
  const { theme, setTheme } = useTheme();
  return (
    <button type="button" onClick={() => setTheme("midnight")}>
      {theme}
    </button>
  );
}

afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

describe("ThemeProvider", () => {
  it("applies a stored theme even when nothing below it renders a switcher", () => {
    // The wizard case: WizardGate returns the wizard INSTEAD of children, so
    // HomePage never mounts. The theme must already be applied above it.
    localStorage.setItem("smith.theme", "midnight");
    render(
      <ThemeProvider>
        <div>the wizard, with no switcher anywhere beneath it</div>
      </ThemeProvider>,
    );
    expect(document.documentElement.getAttribute("data-theme")).toBe("midnight");
  });

  it("one instance owns the choice — a switcher below updates what the provider applied", async () => {
    // Two independent useState copies would diverge; this pins that they do not.
    localStorage.setItem("smith.theme", "light");
    render(
      <ThemeProvider>
        <Switcher />
      </ThemeProvider>,
    );
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    await userEvent.click(screen.getByRole("button"));
    expect(document.documentElement.getAttribute("data-theme")).toBe("midnight");
    expect(screen.getByRole("button")).toHaveTextContent("midnight");
  });

  it("system removes the attribute so the OS media query takes over", () => {
    localStorage.setItem("smith.theme", "system");
    render(<ThemeProvider><div /></ThemeProvider>);
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and verify it FAILS**

Run: `pnpm exec vitest run useTheme` with cwd in `control-plane/`
Expected: FAIL — `ThemeProvider` is not exported.

Record the message. Note that "module has no export" is a weak red: it proves
the file is new, not that the assertions discriminate. Confirm each assertion
would fail against a plausible wrong implementation — in particular, one that
keeps `useState` in every caller instead of sharing context (the second test is
the one that catches it).

- [ ] **Step 3: Convert the hook to a provider**

In `useTheme.ts`, keep both existing effects **exactly as they are** — the
`data-theme` effect and the separate HeroUI `.dark` mirroring effect, whose
comment explains why it must stay separate (`system` has to keep tracking the OS
after mount). Move the state into a context:

```tsx
const ThemeContext = createContext<{ theme: ThemeId; setTheme: (t: ThemeId) => void } | null>(null);

/**
 * Applies the theme ABOVE the wizard gate.
 *
 * `useTheme` used to be called in exactly one place — HomePage — which is a
 * child of WizardGate. While the wizard renders, WizardGate returns the wizard
 * INSTEAD of children, so HomePage never mounted and nothing ever set
 * `data-theme`: every wizard screen rendered light on a machine set to
 * midnight. Hoisting the application above the gate is the fix.
 *
 * A provider rather than a second `useTheme()` call at the root: two
 * independent `useState` copies of one conceptual choice diverge the moment
 * either calls `setTheme`, and the resulting bug (a stale instance re-applying
 * an old theme on remount) is exactly the kind that survives review.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<ThemeId>(() => (localStorage.getItem(STORE_KEY) as ThemeId) || "system");
  // …both existing effects, unchanged, live here…
  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside <ThemeProvider>");
  return ctx;
}
```

Wrap in `App.tsx`, **outside** `AuthGate` so it applies to every gate:

```tsx
<ThemeProvider>
  <AuthGate>
    <WizardGate>
      <RouterProvider router={router} />
    </WizardGate>
  </AuthGate>
</ThemeProvider>
```

`HomePage.tsx:144` needs no change — it already destructures `{ theme, setTheme }`.

- [ ] **Step 4: Run the tests and verify they PASS**

```bash
pnpm exec vitest run useTheme     # cwd control-plane/
pnpm exec vitest run              # full suite
pnpm exec tsc --noEmit 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -c 'error TS'
```

Expected: useTheme green; full suite **1025 pass / 2 fail** plus your additions;
`tsc` **10**. Any other test that rendered `HomePage` or `App` may now need the
provider — fix those, and say in your report how many and why.

- [ ] **Step 5: Verify it in a browser — this is the point of the task**

Dev server :1420. **Assert the viewport at 1280x900 first** (below 768px the
gate serves a compact screen). Set a theme, then force the wizard open by moving
`~/.smithagents/users/me.json` aside — do **not** try to `PUT` your way to a
first run, the server merges and the old record survives.

Confirm, and report the measured values: with `localStorage["smith.theme"]` set
to `midnight`, the wizard on screen has `documentElement.dataset.theme ===
"midnight"` and the panel background is **not** `rgb(255,255,255)`. Then restore
the record file.

- [ ] **Step 6: Commit**

```bash
git add control-plane/src/hooks/useTheme.ts control-plane/src/hooks/useTheme.test.tsx control-plane/src/App.tsx
git commit -m "fix(control-plane): apply the theme above the wizard gate"
```

---

### Task 2: Anderson introduces himself

**Files:**
- Create: `control-plane/src/organisms/WizardGateStep.tsx`,
  `control-plane/src/organisms/WizardGateStep.test.tsx`
- Delete: `control-plane/src/organisms/WizardPreflightStep.tsx` and its test
- Modify: `control-plane/src/organisms/WizardGate.tsx` (render the new component)

**Interfaces:**
- Consumes: `Setup`, `SetupMode` from `wizardSteps.ts`.
- Produces:
  ```ts
  export interface WizardGateStepProps {
    initialName: string;
    initialMode?: SetupMode;
    onDone: (patch: { name: string; setup: Setup }) => void;
    onPickForMe?: () => void;   // wired in Task 5; absent until then
  }
  ```
  `onDone` emits `mode` **explicitly** — setup merges, so an omitted field keeps
  its old value.

**Copy — verbatim from the spec, this is the deliverable:**

> **Hello! My name is Anderson.**
> Anderson Smith, but Anderson is fine. Let's get acquainted — a minute or so,
> and you can change your mind about any of it later.
>
> **What shall I call you?**
> `[ your name ]`
>
> **Where would you like me to live?**
> ○ **On your machine** — I run right here, and I can use logins you already have
> ○ **In the cloud** — nothing to install, I'm ready right away
>
> `[ Just pick sensible things for me ]`  `[ Nice to meet you → ]`

**Read before writing:** `WizardPreflightStep.tsx`. It carries a long comment
explaining why the disabled Cloud option **cannot** be a `RadioButtonGroup.Item`
and must be a hand-authored native radio carrying **both** `disabled` and
`aria-disabled`, and why the notify link is a **sibling** of the group rather
than a descendant of the disabled node. **Move that code and its comment across
verbatim.** Do not re-derive either.

- [ ] **Step 1: Write the failing tests**

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { WizardGateStep } from "./WizardGateStep";

const setup = (over = {}) => {
  const onDone = vi.fn();
  render(<WizardGateStep initialName="" onDone={onDone} {...over} />);
  return { onDone, user: userEvent.setup() };
};

describe("WizardGateStep", () => {
  it("Anderson introduces himself before asking for anything", () => {
    setup();
    expect(screen.getByText(/hello! my name is anderson/i)).toBeInTheDocument();
    expect(screen.getByText(/anderson smith, but anderson is fine/i)).toBeInTheDocument();
  });

  it("asks in the first person, not as a form", () => {
    setup();
    expect(screen.getByLabelText(/what shall i call you/i)).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /where would you like me to live/i })).toBeInTheDocument();
  });

  it("names what each choice means, not just its label", () => {
    setup();
    expect(screen.getByText(/i run right here, and i can use logins you already have/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing to install, i'm ready right away/i)).toBeInTheDocument();
  });

  it("cannot continue without a name", async () => {
    const { user } = setup();
    const go = screen.getByRole("button", { name: /nice to meet you/i });
    expect(go).toBeDisabled();
    await user.type(screen.getByLabelText(/what shall i call you/i), "Edwin");
    expect(go).toBeEnabled();
  });

  it("the cloud option carries aria-disabled, not just native disabled", () => {
    // toBeDisabled() alone does NOT discriminate: react-aria forces
    // `disabled: isDisabled` onto the input OUTSIDE the filterDOMProps
    // allowlist that drops aria-disabled, so a wrong RadioButtonGroup.Item
    // passes identically. Only aria-disabled — which the stylesheet's dimming
    // and pointer-events:none key off — tells them apart.
    setup();
    expect(screen.getByRole("radio", { name: /in the cloud/i })).toHaveAttribute("aria-disabled", "true");
  });

  it("the cloud option cannot be reached with arrow keys", async () => {
    // react-aria's roving-focus walker filters on `input:not([disabled])`;
    // aria-disabled never enters it. Without native `disabled`, ArrowDown lands
    // here and react-aria reads the focused input's `.value` — which defaults
    // to "on" for a value-less radio, corrupting `mode`.
    const { onDone, user } = setup({ initialName: "Edwin" });
    const machine = screen.getByRole("radio", { name: /on your machine/i });
    const cloud = screen.getByRole("radio", { name: /in the cloud/i });
    machine.focus();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).not.toBe(cloud);
    await user.click(screen.getByRole("button", { name: /nice to meet you/i }));
    expect(onDone.mock.calls[0][0].setup.mode).toBe("local");
  });

  it("emits the mode explicitly, never omitted", async () => {
    // Setup MERGES: an omitted field keeps its previous value.
    const { onDone, user } = setup();
    await user.type(screen.getByLabelText(/what shall i call you/i), "Edwin");
    await user.click(screen.getByRole("button", { name: /nice to meet you/i }));
    expect(onDone).toHaveBeenCalledWith({ name: "Edwin", setup: { mode: "local" } });
  });

  it("shows the name already given when returning to the gate", () => {
    setup({ initialName: "Edwin", initialMode: "local" });
    expect(screen.getByLabelText(/what shall i call you/i)).toHaveValue("Edwin");
  });
});
```

- [ ] **Step 2: Run and verify they FAIL**

Run: `pnpm exec vitest run WizardGateStep` (cwd `control-plane/`)
Expected: FAIL — module not found.

**That red proves only that the file is new.** Before continuing, state for each
assertion what wrong implementation would also pass it. The `aria-disabled` and
arrow-key tests exist precisely because `toBeDisabled()` does not discriminate.

- [ ] **Step 3: Build it**

Requirements, all load-bearing:
- Anderson's introduction renders **above** the questions, as prose, not a
  heading with form labels beneath.
- The name field's accessible name is *"What shall I call you?"*.
- The mode group's accessible name is *"Where would you like me to live?"*, and
  each option carries its **explanatory line**, not just a label.
- **On your machine** is enabled and default-selected. **In the cloud** is the
  hand-authored native radio carried across from `WizardPreflightStep`, with
  both attributes, labelled per the spec, with the notify link a **sibling** of
  the group.
- `[ Nice to meet you → ]` is the primary action, disabled — via native
  `disabled` — only while the name is blank after trimming, gated on a watched
  value rather than `formState.errors` (errors only exist after a validation
  run, so a pristine blank form would otherwise have it enabled).
- `[ Just pick sensible things for me ]` renders as a secondary action and calls
  `onPickForMe` when given. **Task 5 wires it**; here it is inert when the prop
  is absent, and that is expected.
- Reuse the existing `.wizard-fork-step__*` class names for the mode rows. They
  are not dead: `WizardGate`'s compact screen shares
  `.wizard-fork-step__notify`, and renaming CSS mid-restructure risks visual
  regressions no test can see.

Delete `WizardPreflightStep.tsx` and its test, and point `WizardGate` at the new
component.

- [ ] **Step 4: Run the tests and verify they PASS**

```bash
pnpm exec vitest run WizardGateStep
pnpm exec vitest run
pnpm exec tsc --noEmit 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -c 'error TS'
```

Expected: green; suite at baseline plus your delta — **account for the delta**,
since you deleted a suite and added one; `tsc` **10**.

- [ ] **Step 5: Prove the discrimination survived the move**

Swap the Cloud option for `<RadioButtonGroup.Item value="hosted" isDisabled>`,
re-run, and confirm the **`aria-disabled` test fails** while `toBeDisabled()`
still passes — that pairing is the signature of the wrong-but-plausible
implementation these two tests exist to catch. Restore the file and confirm
`git diff` shows only your intended changes.

- [ ] **Step 6: Commit**

```bash
git add -A control-plane/src/organisms
git commit -m "feat(wizard): Anderson introduces himself and asks two questions"
```

---

### Task 3: The chip

**Files:**
- Create: `control-plane/src/molecules/WizardChip.tsx`, `.test.tsx`
- Modify: `control-plane/src/organisms/WizardGate.tsx`,
  `control-plane/src/styles/components.css`

**Spec:** on continue the gate *"collapses into a persistent, clickable chip:
`Anderson · On your machine ✎`"*. Editing it mid-flow **keeps** name, small
talk, current events, memory and permissions; it **clears** brain source, models
and voice backend — **and says so specifically**. Before the provider step it
switches silently.

**Interfaces:**
- Produces:
  ```ts
  export interface WizardChipProps {
    name: string;
    mode: SetupMode;
    /** Steps already answered, so the chip knows whether editing costs anything. */
    clears: readonly string[];
    onEdit: () => void;
  }
  ```

- [ ] **Step 1: Write the failing tests**

```tsx
describe("WizardChip", () => {
  it("shows who I am and where I live", () => {
    render(<WizardChip name="Edwin" mode="local" clears={[]} onEdit={vi.fn()} />);
    expect(screen.getByRole("button", { name: /anderson/i })).toHaveTextContent(/on your machine/i);
  });

  it("switches silently when nothing has been answered yet", async () => {
    const onEdit = vi.fn();
    render(<WizardChip name="Edwin" mode="local" clears={[]} onEdit={onEdit} />);
    await userEvent.click(screen.getByRole("button", { name: /anderson/i }));
    expect(onEdit).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says specifically what changing it would clear, and does not clear until confirmed", async () => {
    const onEdit = vi.fn();
    render(
      <WizardChip name="Edwin" mode="local" clears={["where I think", "what I think with"]} onEdit={onEdit} />,
    );
    await userEvent.click(screen.getByRole("button", { name: /anderson/i }));
    const dialog = await screen.findByRole("dialog");
    // "and says so specifically" — the named things, not a generic warning.
    expect(within(dialog).getByText(/where I think/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/what I think with/i)).toBeInTheDocument();
    expect(onEdit).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: /change it/i }));
    expect(onEdit).toHaveBeenCalledOnce();
  });

  it("a generic warning is not enough — it names them", async () => {
    // Discriminates against a plausible wrong implementation that shows a
    // count or a blanket "you will lose your answers".
    render(<WizardChip name="Edwin" mode="local" clears={["voice"]} onEdit={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /anderson/i }));
    expect(within(await screen.findByRole("dialog")).getByText(/voice/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run and verify they FAIL** — `pnpm exec vitest run WizardChip`.
  Record the messages, and note which assertions a naive implementation would
  also pass.

- [ ] **Step 3: Build the chip**, and render it in `WizardGate` on every step
  after the gate, never on the gate itself. The `clears` list is derived from
  which steps have answers today — with only two steps in the sequence at this
  point, that is *where I think* and *what I think with* once they exist; until
  then, pass the steps this build actually has and say so in the report rather
  than inventing names for screens that do not exist.

- [ ] **Step 4: Verify** — `pnpm exec vitest run`, `tsc`, biome, at baseline.

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(wizard): the gate collapses to a chip that says what editing costs"
```

---

### Task 4: Honest progress, and Skip with a stated default

**Files:**
- Modify: `control-plane/src/lib/wizardSteps.ts`, its test,
  `control-plane/src/organisms/WizardGate.tsx`

**Spec:** *"Every step after the gate carries a **Skip** that applies a stated
default… Progress reads honestly as `Step n of 6` because the branch was settled
at the gate."*

**Interfaces:**
- Produces:
  ```ts
  export interface WizardStepDef {
    id: WizardStep;
    title: string;
    /** Shown ON the skip control: what skipping will do. Never bare "Skip". */
    skipLabel: string;
    /** The patch a skip applies. Explicit values only — setup merges. */
    skipDefault: () => Setup;
  }
  export function stepsFor(setup: Setup): readonly WizardStepDef[];
  export function progressFor(step: string, setup: Setup): { n: number; of: number } | null;
  ```
  `progressFor` returns `null` for the gate — it has no number, per the spec.

- [ ] **Step 1: Write the failing tests**

```ts
describe("progress is honest", () => {
  it("the gate has no number at all", () => {
    expect(progressFor(PREFLIGHT, { mode: "local" })).toBeNull();
  });

  it("counts within the sequence the answers actually selected", () => {
    const p = progressFor("subscriptions", { mode: "local" });
    expect(p).toEqual({ n: 1, of: stepsFor({ mode: "local" }).length });
  });

  it("never reports a total the sequence does not contain", () => {
    // The spec's "Step n of 6" is honest ONLY because the branch is settled at
    // the gate. A hardcoded 6 would lie for any shorter sequence.
    const of = progressFor("subscriptions", { mode: "local" })?.of;
    expect(of).toBe(stepsFor({ mode: "local" }).length);
  });
});

describe("skip applies a stated default", () => {
  it("every step after the gate has one", () => {
    for (const s of stepsFor({ mode: "local" })) {
      expect(s.skipLabel.trim()).not.toBe("");
      expect(s.skipLabel.toLowerCase()).not.toBe("skip");   // it must STATE the default
      expect(s.skipDefault()).toBeTypeOf("object");
    }
  });

  it("a skip default sends explicit values, never an empty patch", () => {
    // Setup merges, so `{}` silently keeps whatever was there — which is not
    // "the default", it is "whatever happened before".
    for (const s of stepsFor({ mode: "local" })) {
      expect(Object.keys(s.skipDefault() ?? {}).length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Run and verify they FAIL.** Expected: `stepsFor`,
  `progressFor`, `WizardStepDef` are not exported.

- [ ] **Step 3: Replace the flat meta map with the registry.** `WIZARD_STEP_META`
  becomes `stepsFor(setup)` returning definitions. Keep the `Record<WizardStep,
  …>` compiler-enforced completeness — a step id with no definition must be a
  type error, not a lookup miss. Render the skip control in `WizardGate`'s
  footer using `skipLabel`, applying `skipDefault()` through the same `advance`
  path a normal answer takes, so persistence and both failure shapes are shared
  rather than duplicated.

- [ ] **Step 4: Verify.** Suite, `tsc` 10, biome. Report the delta.

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(wizard): honest Step n of N, and a Skip that states its default"
```

---

### Task 5: "Just pick sensible things for me"

**Files:**
- Modify: `control-plane/src/organisms/WizardGate.tsx`,
  `control-plane/src/organisms/WizardGateStep.tsx`, their tests

The gate's secondary action applies **every** registered step default at once
and finishes setup. It is Task 4's registry applied end to end — not a second
set of defaults, which would drift.

- [ ] **Step 1: Write the failing tests**

```tsx
it("applies every step's stated default and finishes", async () => {
  const { updateMe } = renderGate({ placeholder: true, setup: undefined });
  await userEvent.type(await screen.findByLabelText(/what shall i call you/i), "Edwin");
  await userEvent.click(screen.getByRole("button", { name: /just pick sensible things for me/i }));

  const patch = updateMe.mock.calls.at(-1)?.[0];
  expect(patch.name).toBe("Edwin");
  expect(patch.setup.step).toBe(SETUP_DONE);
  // Composed from the registry, not a second hardcoded list — if a step's
  // default changes, this follows it.
  for (const s of stepsFor({ mode: "local" })) {
    for (const [k, v] of Object.entries(s.skipDefault() ?? {})) {
      expect(patch.setup[k]).toEqual(v);
    }
  }
});

it("still needs a name — it picks the other things, not that one", async () => {
  renderGate({ placeholder: true, setup: undefined });
  expect(await screen.findByRole("button", { name: /just pick sensible things for me/i })).toBeDisabled();
});
```

- [ ] **Step 2: Run and verify they FAIL.**
- [ ] **Step 3: Implement** — compose the patch from `stepsFor(...)`, never a
  second literal.
- [ ] **Step 4: Verify.** Suite, `tsc`, biome.
- [ ] **Step 5: Commit**

```bash
git commit -am "feat(wizard): Just pick sensible things for me"
```

---

### Task 6: The two existing steps speak in Anderson's voice

**Files:**
- Modify: `control-plane/src/organisms/WizardSubscriptionsStep.tsx`,
  `control-plane/src/organisms/WizardBrainStep.tsx`, their tests

Copy only. **Do not change behaviour** — not the gate on Subscriptions, not the
candidate filtering on the brain step, not the "Skip for now" escape that exists
because a user whose only CLI the server refuses was otherwise trapped forever,
and not the shared in-flight guard on Back.

These two steps are replaced wholesale by Plan 2. They are re-voiced here anyway
so this plan leaves a **coherent** wizard rather than one that introduces itself
warmly and then reverts to form-speak two screens later.

- Subscriptions → *"Where should I get my thinking from, {name}?"* with the
  spec's supporting line.
- Brain → *"Which of these should I use, and for what?"*, replacing "Set up
  Anderson".

- [ ] **Step 1:** Write a test per step asserting the new heading and that the
  existing behaviour tests still pass untouched.
- [ ] **Step 2:** Run, verify they fail on the copy only.
- [ ] **Step 3:** Change the copy. `{name}` threads from the host.
- [ ] **Step 4:** Verify — the behaviour suites must be **unchanged**, not
  merely passing. Say in the report which files you did *not* touch.
- [ ] **Step 5: Commit**

```bash
git commit -am "feat(wizard): the remaining steps speak in Anderson's voice"
```

---

### Task 7: Walk it in a browser

**Files:** none expected; commit any fix this finds.

A green suite has failed **three** times on this feature to catch what a browser
saw at once: a Continue button 1187px below the fold, a last step that could not
save at all, and a radio indicator painted on top of its own label. jsdom has no
layout and no theme.

- [ ] **Step 1: Assert the environment.** Viewport **1280x900**, confirmed —
  below 768px the gate serves a compact screen. Services: :1420, :7790, :7777.
  Back up `~/.smithagents/users/me.json`, then **move it aside** for a genuine
  first run; you cannot `PUT` your way there, because setup merges.

- [ ] **Step 2: Walk the gate.** Anderson's introduction reads as prose; there
  is **no progress number and no step indicator**; Cloud is visible, explained,
  and unreachable by arrow keys; `Nice to meet you` is disabled until a name is
  typed, via native `disabled`.

- [ ] **Step 3: Walk the chip.** After continuing, the chip shows
  `Anderson · On your machine`. Click it with nothing answered — it switches
  silently. Answer a step, click it again — it **names** what would be cleared,
  and cancelling clears nothing.

- [ ] **Step 4: Progress and skip.** Each step shows `Step n of N` matching the
  sequence actually selected. Each skip control **states its default** rather
  than saying "Skip". Skipping persists — confirm via
  `curl -s http://127.0.0.1:7790/me` that the default was written, then reload
  and confirm the step is not re-asked.

- [ ] **Step 5: "Just pick sensible things for me."** From a fresh first run,
  type a name and click it. The wizard finishes and the app opens. Confirm via
  curl that every registered default was persisted.

- [ ] **Step 6: All five themes**, including **sand**, on the gate and on one
  step — and confirm the theme fix from Task 1 still holds with the wizard open.

- [ ] **Step 7: Restore.** Put the record file back, confirm the app opens and
  the wizard does not reappear on reload. Diff the record **file** against your
  backup — `GET /me` does **not** serialize `agendaSweptDay`, so a curl-vs-file
  diff would report a phantom wipe of the canary.

- [ ] **Step 8:** Commit any fix, or record that the walk found none.

---

## Self-Review

**Spec coverage.** Gate copy and both questions (Task 2); the chip and its
clear-semantics (Task 3); `Step n of 6` honesty and Skip-with-a-stated-default
(Task 4); "Just pick sensible things for me" (Task 5); Anderson's voice
everywhere the wizard currently speaks (Tasks 2 and 6). Steps 1–6 of the spec's
sequence are **out of scope** — this plan installs the shell they will hang off.

**Deliberately not done:** per-step re-run *after* setup completes (the spec's
"each is re-runnable on its own afterward") needs a surface outside the wizard —
Settings' "re-run setup" currently restarts the whole thing. Flagged for the
roadmap rather than half-built here.

**Type consistency.** `WizardStepDef`/`stepsFor`/`progressFor` are introduced in
Task 4 and consumed in Task 5; Task 3's `clears` is a `readonly string[]` of
titles drawn from the same registry. `WizardGateStepProps.onPickForMe` is
declared optional in Task 2 and supplied in Task 5, so neither task leaves a
broken call site.

**Known risk.** Task 4 replaces `WIZARD_STEP_META`, which Task 2's component and
the host both read. Tasks 2 and 4 therefore touch the same module in sequence —
run them in order, and expect Task 4 to update whatever Task 2 left pointing at
the old map.
