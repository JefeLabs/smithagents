# HeroUI Phase 1a — Workspace Creation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Claimed by:** Claude session d21f90fd on branch `heroui-phase-1a`, 2026-08-09.
In progress — do not execute in parallel from another checkout.

**APPROVED 2026-08-09.** The spec's deferral gates are both cleared, and one of them
rested on a factual error that the spec still carries — amend it before quoting it:

- *"Evidence the library still ships."* The spec reads `1.0.0-beta.8` as published
  **2026-03-30**. That is npm's `time.created` field — the date `1.0.0-alpha.0` first
  published. `npm view @heroui-pro/react time` gives beta.8 = **2026-08-03**. Cadence is
  roughly monthly (beta.5 May 28 → beta.6 Jun 16 → beta.7 Jul 8 → beta.8 Aug 3), and OSS
  `@heroui/react@3.2.4` shipped 2026-08-07. **Judge cadence from `time["<version>"]`,
  never `time.created`.**
- *"What a Pro seat entitles past beta."* Wrong question — entitlement is not
  version-gated. One-time purchase, a **1-year Updates Window**, and perpetual access to
  whatever shipped inside it. Declining renewal freezes you at the latest eligible
  version rather than breaking anything.

Spec Risk 1 (a pre-1.0 library owning the whole view layer) still stands on its own
merits; only the stagnation evidence for it was false.

**Goal:** Migrate `NewWorkspaceModal` and `WorkspaceManagerModal` (776 LOC, 26 form
inputs) to HeroUI, establishing the react-hook-form ↔ react-aria adapter layer that
Phases 1b, 1c and 2 all depend on.

**Architecture:** HeroUI's field components are react-aria controlled components —
`onChange` hands back a **value**, not a DOM event — so RHF's `register()` cannot be
spread onto them. Four thin adapters in `src/molecules/form/` bridge `useController` to
HeroUI's field API once, so no organism ever writes a `<Controller>` by hand. The form
model, the validation rules, and every `toRecord`/`toForm` function are untouched — this
is a swap of the input layer only.

**Tech Stack:** React 19, TypeScript 5.6 (strict), `@heroui/react` 3.2.4,
`@heroui-pro/react` 1.0.0-beta.8, react-hook-form 7.85.0, Tailwind v4, Vitest 4 + jsdom,
Testing Library, Biome, pnpm.

**Spec:** `docs/superpowers/specs/2026-08-08-heroui-pro-adoption-design.md` (Phase 1,
"Workspace creation" row)

## Global Constraints

- Package manager is **pnpm**, run from `control-plane/`. Never `npm`. The untracked
  `package.json` + `package-lock.json` at repo root is a scratch install — do not use,
  do not modify, do not commit it.
- **No change to `queries/`, `stores/`, `api/`, or any react-hook-form form model.**
  This is a view-layer migration. `WorkspaceFormValues`, `NewWorkspaceFormValues`,
  `toForm`, `toRecord`, `keyList`, `filled`, `blankForm`, `emptyRepo` are all
  **byte-identical** when this phase ends.
- **No redesign, with exactly one approved exception:** `NewWorkspaceModal` is repaged as
  a three-step stepper (Task 5), per Edwin's 2026-08-09 ruling. Everything else — and
  all of `WorkspaceManagerModal` — keeps the same layout, colors, borders and radii,
  verified by screenshot in all four themes (dark, light, midnight, sand). Do not treat
  the stepper ruling as licence to restyle anything else.
- **Interactive elements use `onPress`, not `onClick`.** HeroUI v3 is react-aria based.
  A handler passed as `onClick` to a HeroUI `Button` silently never fires.
- **`useForm` / `useFieldArray` and the open-keyed `reset()` effect MUST stay in the
  top-level modal component, above `ModalShell`.** Established by Task 4's review, which
  read the source rather than the docs: `Modal.Backdrop` wraps react-aria's
  `ModalOverlay` and **unmounts its DOM subtree** when closed — it does not hide it with
  CSS. Today's form state survives a close only because both modals hold it in the
  permanently-mounted parent, above the old `if (!open) return null`, and `register()`'s
  ref callback re-hydrates fresh inputs from it on reopen. Moving `useForm` inside
  `ModalShell`'s children would wipe every field on close, and the existing tests would
  not catch it — they render the modal already open. The natural port preserves this;
  the failure mode is "tidying" the hooks downward.
- `pnpm typecheck` (`tsc --noEmit`), `pnpm lint`, and `pnpm test` must all pass before
  every commit. Currently green at 395 tests / 46 files — the count only goes up.
- Branch is `heroui-phase-1a`, created off `main` after Phase 0 merges.
- **Do not touch `components.css` yet.** Classes for these two modals become dead but
  stay until Phase 3 deletes the file wholesale. Deleting them piecemeal makes the
  screenshot diff for *other* surfaces unexplainable.

---

## The one thing this phase exists to prove

`@heroui/react`'s `TextField` is typed:

```
| `value`    | `string`                  | Current value (controlled)             |
| `onChange` | `(value: string) => void` | Handler called when the value changes  |
```

RHF's `register()` returns `{name, ref, onBlur, onChange}` where `onChange` expects a
**DOM event** and reads `event.target.value`. Spreading `register()` onto a `TextField`
therefore type-errors, and if forced through with a cast it writes `undefined` into the
form on every keystroke.

The fix is `useController`, whose `field.onChange` is `(...event: any[]) => void` and
which unwraps a bare value correctly — RHF checks `isObject(event) && event.target`
before reaching for `.target.value`, so a plain string passes through untouched. That
one fact is the whole seam. Task 1 encodes it once, with a test that would fail if a
future RHF version changed it.

## The two components the spec lists beyond a straight migration

Resolved with Edwin 2026-08-09. He chose to **widen this phase**: repage
`NewWorkspaceModal` as a stepper rather than migrate it as-is.

**`stepper` — IN SCOPE.** Task 5 repages the form into three steps (Details, Colour,
Repos). This is a deliberate, approved appearance change, and it is the **only** one in
Phase 1a — `WorkspaceManagerModal` (Task 6) still preserves its current layout exactly.
The existing 204-line test suite is expected to be rewritten; Task 5 Step 1 handles that
as its own commit, before any component change.

**`drop-zone` — OUT OF SCOPE, and not by preference.** It cannot do the job:

`DropZone` is a **file-upload** component. Its API is `DropZone.Input` with
`accept` / `multiple` / `onSelect(files: FileList)`, plus `FileList`, `FileName`,
`FileProgress` and an upload `status` of `'uploading' | 'complete' | 'failed'`. There is
no directory mode anywhere in its documented surface.

The field it would fill is `repos.N.path` — an **absolute filesystem path**
(`/Users/me/code/acme-web`) that the broker hands to git. A browser `File` object exposes
`name` and `webkitRelativePath` and **never** an absolute path; that is a browser
security boundary, not a library limitation. A drop-zone here would collect an upload the
broker cannot act on.

The native Tauri picker behind `hasNativeFolderPicker()` already returns real paths and
stays as-is. If a browser-side drop target is wanted later, the only mechanism that can
work is Tauri's `getCurrentWebview().onDragDropEvent()`, which yields real paths — but
Tauri is a retired surface, so that is a product decision, not a migration step.

**Recorded for Edwin. Not blocking; nothing else in this plan depends on it.**

## File Structure

| Path | Responsibility |
|---|---|
| `src/molecules/form/FormTextField.tsx` | `useController` → `TextField` + `Input`/`TextArea`. The seam. |
| `src/molecules/form/FormSelect.tsx` | `useController` → `Select`. Handles the `""` placeholder option. |
| `src/molecules/form/FormCheckbox.tsx` | `useController` → `Checkbox`. Boolean field, `isSelected`/`onChange`. |
| `src/molecules/form/FormColorSwatch.tsx` | `useController` → `ColorSwatchPicker`. Owns the hex-string ↔ `Color` marshalling and the transparent sentinel. |
| `src/molecules/form/ModalShell.tsx` | `Modal.Backdrop`/`Container`/`Dialog` wrapper replacing the hand-rolled `.scrim` + `onScrimClick`. |
| `src/molecules/form/index.ts` | Barrel. One import line per organism. |
| `src/organisms/NewWorkspaceModal.tsx` | Modified — markup only. |
| `src/organisms/WorkspaceManagerModal.tsx` | Modified — markup only. |
| `src/atoms/SegmentedControl.tsx` | **Deleted** in Task 7 — `RadioButtonGroup` replaces it. |
| `src/atoms/HeroCanary.tsx` | **Deleted** in Task 1 — the pipeline is now proven by real usage. |

---

### Task 1: Retire the canary, build the text-field seam

**Files:**
- Delete: `src/atoms/HeroCanary.tsx`, `src/atoms/HeroCanary.test.tsx`
- Create: `src/molecules/form/FormTextField.tsx`
- Test: `src/molecules/form/FormTextField.test.tsx`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `FormTextField<T extends FieldValues>(props: FormTextFieldProps<T>)` where
  `FormTextFieldProps<T> = { control: Control<T>; name: FieldPath<T>; label: string;
  labelHidden?: boolean; placeholder?: string; multiline?: boolean; rows?: number;
  hint?: ReactNode; rules?: RegisterOptions<T, FieldPath<T>> }`.
  Every later task and Phases 1b/1c import this.

  **`label` is required, `labelHidden` controls whether it is *visible*.** Twelve inputs
  across the two modals have no visible label today — dense repo rows and the Atlassian
  key fields name themselves by placeholder (`NewWorkspaceModal.tsx:193,203,204`;
  `WorkspaceManagerModal.tsx:395,424,443,444,464,469,470,471`). Always rendering a
  `<Label>` would add six visible labels per repo row and break Task 6's screenshot gate.
  Requiring `label` anyway means no field can ship unnamed, and `getByLabelText` resolves
  it in both modes because testing-library matches `aria-label` too — so tests query the
  same way regardless.

- [ ] **Step 1: Write the failing test**

Create `src/molecules/form/FormTextField.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useForm } from "react-hook-form";
import { describe, expect, it, vi } from "vitest";
import { FormTextField } from "./FormTextField";

interface Values {
  name: string;
  bio: string;
}

function Harness({ onValues }: { onValues: (v: Values) => void }) {
  const { control, handleSubmit } = useForm<Values>({
    mode: "onChange",
    defaultValues: { name: "", bio: "" },
  });
  return (
    <form onSubmit={handleSubmit(onValues)}>
      <FormTextField control={control} name="name" label="Workspace name" placeholder="acme" />
      <FormTextField control={control} name="bio" label="Description" multiline rows={3} />
      <button type="submit">save</button>
    </form>
  );
}

describe("FormTextField", () => {
  // This is the assertion the whole phase turns on. HeroUI's TextField calls
  // onChange with a STRING, not a DOM event. If RHF ever stops unwrapping a bare
  // value, this test fails and every migrated form is silently writing undefined.
  it("writes typed text into the form model, not undefined", async () => {
    const onValues = vi.fn();
    render(<Harness onValues={onValues} />);

    await userEvent.type(screen.getByLabelText("Workspace name"), "acme");
    await userEvent.click(screen.getByRole("button", { name: "save" }));

    expect(onValues).toHaveBeenCalledWith(
      expect.objectContaining({ name: "acme" }),
      expect.anything(),
    );
  });

  it("renders a textarea when multiline, an input otherwise", () => {
    render(<Harness onValues={vi.fn()} />);
    expect(screen.getByLabelText("Workspace name").tagName).toBe("INPUT");
    expect(screen.getByLabelText("Description").tagName).toBe("TEXTAREA");
  });

  it("associates the label with the control so getByLabelText resolves", () => {
    render(<Harness onValues={vi.fn()} />);
    expect(screen.getByLabelText("Workspace name")).toHaveAttribute("placeholder", "acme");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails for the right reason**

Run: `pnpm vitest run src/molecules/form/FormTextField.test.tsx`
Expected: FAIL — `Failed to resolve import "./FormTextField"`. Any *other* failure
means the harness is wrong; fix the test before writing the component.

- [ ] **Step 3: Write the adapter**

Create `src/molecules/form/FormTextField.tsx`:

```tsx
import { Description, FieldError, Input, Label, TextArea, TextField } from "@heroui/react";
import type { ReactNode } from "react";
import {
  type Control,
  type FieldPath,
  type FieldValues,
  type RegisterOptions,
  useController,
} from "react-hook-form";

interface FormTextFieldProps<T extends FieldValues> {
  control: Control<T>;
  name: FieldPath<T>;
  label: string;
  /**
   * Renders the accessible name without a visible <Label>. The dense rows this
   * adapter serves — repo rows, Atlassian keys — name their fields by placeholder
   * today and have no visible label; rendering one would change their layout,
   * which Task 6 is screenshot-gated against.
   */
  labelHidden?: boolean;
  placeholder?: string;
  /** Renders a TextArea instead of an Input. */
  multiline?: boolean;
  rows?: number;
  /** Secondary text under the label — the old `.wizard__hint` span. */
  hint?: ReactNode;
  rules?: RegisterOptions<T, FieldPath<T>>;
}

/**
 * The react-hook-form ↔ react-aria seam.
 *
 * HeroUI's TextField is a react-aria controlled component: `onChange` is
 * `(value: string) => void`, NOT a DOM event handler. That is why `register()`
 * cannot be spread onto it — `register().onChange` reads `event.target.value`
 * and would receive a bare string.
 *
 * `useController`'s `field.onChange` accepts either shape: RHF checks
 * `isObject(event) && event.target` before unwrapping, so a plain string passes
 * straight through. `FormTextField.test.tsx` asserts exactly that, so a future
 * RHF release that tightened the check would fail loudly here rather than
 * silently writing `undefined` into every migrated form.
 */
export function FormTextField<T extends FieldValues>({
  control,
  name,
  label,
  labelHidden = false,
  placeholder,
  multiline = false,
  rows,
  hint,
  rules,
}: FormTextFieldProps<T>) {
  const { field, fieldState } = useController({ control, name, rules });
  return (
    <TextField
      name={field.name}
      // `?? ""` keeps the field controlled from the first render. An undefined
      // value flips react-aria to uncontrolled mode and it never flips back —
      // the input then ignores `reset()` for the life of the mount.
      value={(field.value as string | undefined) ?? ""}
      onChange={field.onChange}
      onBlur={field.onBlur}
      isInvalid={fieldState.invalid}
      aria-label={labelHidden ? label : undefined}
    >
      {!labelHidden && <Label>{label}</Label>}
      {multiline ? (
        <TextArea ref={field.ref} placeholder={placeholder} rows={rows} />
      ) : (
        <Input ref={field.ref} placeholder={placeholder} />
      )}
      {hint != null && <Description>{hint}</Description>}
      {/* Children are REQUIRED. react-aria's FieldError renders its own validation
          context, and RHF's errors are invisible to it — a bare <FieldError /> is a
          permanently empty error region. Passing the message explicitly is the only
          thing that connects the two validation systems. */}
      <FieldError>{fieldState.error?.message}</FieldError>
    </TextField>
  );
}
```

**Why this matters more than it looks.** Today both target modals validate with
`filled = (v) => v.trim().length > 0`, which returns a bare boolean and therefore has no
message — so wiring this changes nothing visible right now. But this adapter is imported
by every later task and by Phases 1b and 1c. The first validator anywhere that returns a
string (`{ validate: (v) => filled(v) || "Workspace name is required" }`) would silently
lose it, and the loss would surface as "why doesn't my error show" three phases from now.
Connect it once, here.

- [ ] **Step 4: Run the test**

Run: `pnpm vitest run src/molecules/form/FormTextField.test.tsx`
Expected: PASS, 3 tests.

- [ ] **Step 5: Delete the canary**

The canary's job was to prove the CSS pipeline before any real component depended on
it. `FormTextField` now proves it with a component that ships.

```bash
git rm src/atoms/HeroCanary.tsx src/atoms/HeroCanary.test.tsx
```

- [ ] **Step 6: Verify nothing else referenced the canary**

Run: `grep -rn "HeroCanary" src`
Expected: no output.

- [ ] **Step 7: Full verification and commit**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all green; test count is 395 − 1 (canary) + 3 (adapter) = 397.

```bash
git add src/molecules/form/FormTextField.tsx src/molecules/form/FormTextField.test.tsx
git commit -m "feat: rhf-to-react-aria text field seam, retire the canary"
```

---

### Task 2: Select and checkbox adapters

**Files:**
- Create: `src/molecules/form/FormSelect.tsx`, `src/molecules/form/FormCheckbox.tsx`
- Test: `src/molecules/form/FormSelect.test.tsx`, `src/molecules/form/FormCheckbox.test.tsx`

**Interfaces:**
- Consumes: the `useController` pattern established in Task 1.
- Produces:
  - `FormSelect<T>(props: { control: Control<T>; name: FieldPath<T>; label: string;
    placeholder: string; options: Array<{ id: string; label: string }>;
    rules?: RegisterOptions<T, FieldPath<T>> })`
  - `FormCheckbox<T>(props: { control: Control<T>; name: FieldPath<T>; label: string })`

- [ ] **Step 1: Write the failing select test**

Create `src/molecules/form/FormSelect.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useForm } from "react-hook-form";
import { describe, expect, it, vi } from "vitest";
import { FormSelect } from "./FormSelect";

interface Values {
  connectorId: string;
}

const OPTIONS = [
  { id: "c1", label: "acme-gh" },
  { id: "c2", label: "personal-gh" },
];

function Harness({ onValues }: { onValues: (v: Values) => void }) {
  const { control, handleSubmit } = useForm<Values>({ defaultValues: { connectorId: "" } });
  return (
    <form onSubmit={handleSubmit(onValues)}>
      <FormSelect
        control={control}
        name="connectorId"
        label="GitHub connector"
        placeholder="pick a connector…"
        options={OPTIONS}
      />
      <button type="submit">save</button>
    </form>
  );
}

describe("FormSelect", () => {
  it("writes the chosen option's id into the form model", async () => {
    const onValues = vi.fn();
    render(<Harness onValues={onValues} />);

    await userEvent.click(screen.getByRole("button", { name: /GitHub connector/i }));
    await userEvent.click(await screen.findByRole("option", { name: "personal-gh" }));
    await userEvent.click(screen.getByRole("button", { name: "save" }));

    expect(onValues).toHaveBeenCalledWith(
      expect.objectContaining({ connectorId: "c2" }),
      expect.anything(),
    );
  });

  it("shows the placeholder while the field is empty", () => {
    render(<Harness onValues={vi.fn()} />);
    expect(screen.getByText("pick a connector…")).toBeDefined();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm vitest run src/molecules/form/FormSelect.test.tsx`
Expected: FAIL — unresolved import.

- [ ] **Step 3: Write `FormSelect`**

Create `src/molecules/form/FormSelect.tsx`:

```tsx
import { Label, Select } from "@heroui/react";
import {
  type Control,
  type FieldPath,
  type FieldValues,
  type RegisterOptions,
  useController,
} from "react-hook-form";

interface FormSelectProps<T extends FieldValues> {
  control: Control<T>;
  name: FieldPath<T>;
  label: string;
  /** Same contract as FormTextField's — see Task 1. Both GitHub-connector selects
      use a bare aria-label today (NewWorkspaceModal.tsx:205,
      WorkspaceManagerModal.tsx:472), so both pass this. */
  labelHidden?: boolean;
  /** Shown while the field is `""`. The old markup's disabled first <option>. */
  placeholder: string;
  options: Array<{ id: string; label: string }>;
  rules?: RegisterOptions<T, FieldPath<T>>;
}

/**
 * Same seam as FormTextField. Two differences worth knowing:
 *
 * `""` is not a selectable value — react-aria reads it as "nothing selected". So
 * the empty form value maps to `null` on the way in and back to `""` on the way
 * out, which is what makes the placeholder render and keeps the model all-strings
 * for `toRecord`. That round-trip is the whole point of this adapter; the prop
 * names around it are incidental.
 */
export function FormSelect<T extends FieldValues>({
  control,
  name,
  label,
  placeholder,
  options,
  rules,
}: FormSelectProps<T>) {
  const { field, fieldState } = useController({ control, name, rules });
  const current = (field.value as string | undefined) ?? "";
  return (
    <Select
      name={field.name}
      value={current === "" ? null : current}
      onChange={(key) => field.onChange(key == null ? "" : String(key))}
      onBlur={field.onBlur}
      isInvalid={fieldState.invalid}
      placeholder={placeholder}
      aria-label={labelHidden ? label : undefined}
    >
      {!labelHidden && <Label>{label}</Label>}
      <Select.Trigger />
      <Select.Popover>
        <ListBox>
          {options.map((o) => (
            <ListBox.Item key={o.id} id={o.id} textValue={o.label}>
              {o.label}
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}
```

> The names above are the REAL API, corrected 2026-08-09 after the first draft got
> all three wrong. `Select.Trigger` wraps `Select.Value` + `Select.Indicator`, and
> options live in a plain `ListBox`. `Checkbox` is likewise
> `Checkbox.Content > Checkbox.Control > Checkbox.Indicator`, not flat children.
> Verify with `mcp__heroui-pro__get_component_docs` before writing anyway — reading
> the docs is what caught this.

- [ ] **Step 4: Run the select test**

Run: `pnpm vitest run src/molecules/form/FormSelect.test.tsx`
Expected: PASS, 2 tests.

- [ ] **Step 5: Write the failing checkbox test**

Create `src/molecules/form/FormCheckbox.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useForm } from "react-hook-form";
import { describe, expect, it, vi } from "vitest";
import { FormCheckbox } from "./FormCheckbox";

interface Values {
  default: boolean;
}

function Harness({ onValues }: { onValues: (v: Values) => void }) {
  const { control, handleSubmit } = useForm<Values>({ defaultValues: { default: false } });
  return (
    <form onSubmit={handleSubmit(onValues)}>
      <FormCheckbox control={control} name="default" label="Default workspace" />
      <button type="submit">save</button>
    </form>
  );
}

describe("FormCheckbox", () => {
  it("writes a boolean, not a string or an event", async () => {
    const onValues = vi.fn();
    render(<Harness onValues={onValues} />);

    await userEvent.click(screen.getByRole("checkbox", { name: "Default workspace" }));
    await userEvent.click(screen.getByRole("button", { name: "save" }));

    expect(onValues).toHaveBeenCalledWith(
      expect.objectContaining({ default: true }),
      expect.anything(),
    );
  });
});
```

- [ ] **Step 6: Run it to confirm it fails**

Run: `pnpm vitest run src/molecules/form/FormCheckbox.test.tsx`
Expected: FAIL — unresolved import.

- [ ] **Step 7: Write `FormCheckbox`**

Create `src/molecules/form/FormCheckbox.tsx`:

```tsx
import { Checkbox } from "@heroui/react";
import { type Control, type FieldPath, type FieldValues, useController } from "react-hook-form";

interface FormCheckboxProps<T extends FieldValues> {
  control: Control<T>;
  name: FieldPath<T>;
  label: string;
}

/**
 * react-aria's Checkbox is `isSelected`/`onChange(boolean)` — note that unlike
 * TextField the handler already hands back the right primitive, so this adapter
 * is only here to keep organisms free of `useController` boilerplate.
 */
export function FormCheckbox<T extends FieldValues>({ control, name, label }: FormCheckboxProps<T>) {
  const { field } = useController({ control, name });
  return (
    <Checkbox
      name={field.name}
      isSelected={Boolean(field.value)}
      onChange={field.onChange}
      onBlur={field.onBlur}
    >
      {label}
    </Checkbox>
  );
}
```

- [ ] **Step 8: Run the checkbox test**

Run: `pnpm vitest run src/molecules/form/FormCheckbox.test.tsx`
Expected: PASS, 1 test.

- [ ] **Step 9: Verify and commit**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: green, 400 tests.

```bash
git add src/molecules/form/
git commit -m "feat: select and checkbox form adapters"
```

---

### Task 3: The colour picker, and the "no colour" problem

**Files:**
- Create: `src/molecules/form/FormColorSwatch.tsx`
- Test: `src/molecules/form/FormColorSwatch.test.tsx`
- Modify: `src/lib/workspace-color.ts` (add one exported constant, no behaviour change)

**Interfaces:**
- Consumes: `WORKSPACE_PALETTE` from `src/lib/workspace-color.ts`.
- Produces: `FormColorSwatch<T>(props: { control: Control<T>; name: FieldPath<T>; label: string })`
  and `NO_COLOR_SENTINEL: "#00000000"` exported from `src/lib/workspace-color.ts`.

**Why this task is not mechanical.** Both modals treat `""` as a real, selectable
option — the existing comment in `NewWorkspaceModal.tsx:165-166` says so explicitly:
*"'None' is a real option, not just the starting state — without it a picked swatch
could never be unpicked."* But `ColorSwatchPicker` is controlled by a react-aria `Color`
object (`parseColor("#8B5CF6")`), and `parseColor("")` throws. There is no null colour.

Three ways out. **Take option A** — it is the only one that keeps "None" a peer of the
other swatches, which is the behaviour the existing comment defends:

- **A (chosen):** add a fully transparent swatch, `#00000000`, as a real
  `ColorSwatchPicker.Item`. 8-digit hex is valid input to `parseColor`. The adapter maps
  `#00000000` ↔ `""` at the seam, so the form model and `toRecord` never learn about it.
- **B:** render the picker only when a colour is set, with a separate "clear" button.
  Adds a control that does not exist today and changes the layout.
- **C:** keep the existing hand-rolled radio `<fieldset>`. Cheapest, but leaves one
  surface un-migrated and Phase 3 would still have to do it.

- [ ] **Step 1: Add the sentinel to the colour module**

Modify `src/lib/workspace-color.ts` — append after the `WORKSPACE_PALETTE` declaration:

```ts
/**
 * The "no colour" swatch. Fully transparent 8-digit hex, because react-aria's
 * ColorSwatchPicker is controlled by a `Color` object and `parseColor("")` throws —
 * there is no null colour. `FormColorSwatch` maps this to and from the empty string
 * at the seam, so `WorkspaceRecord.color` never carries it and `toRecord` is unchanged.
 *
 * Deliberately NOT a member of WORKSPACE_PALETTE: `derivedColor()` picks from that
 * array by hash, and a transparent entry would make one workspace in eight invisible.
 */
export const NO_COLOR_SENTINEL = "#00000000";
```

- [ ] **Step 2: Write the failing test**

Create `src/molecules/form/FormColorSwatch.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useForm } from "react-hook-form";
import { describe, expect, it, vi } from "vitest";
import { WORKSPACE_PALETTE } from "../../lib/workspace-color";
import { FormColorSwatch } from "./FormColorSwatch";

interface Values {
  color: string;
}

function Harness({ onValues, initial = "" }: { onValues: (v: Values) => void; initial?: string }) {
  const { control, handleSubmit } = useForm<Values>({ defaultValues: { color: initial } });
  return (
    <form onSubmit={handleSubmit(onValues)}>
      <FormColorSwatch control={control} name="color" label="Colour" />
      <button type="submit">save</button>
    </form>
  );
}

describe("FormColorSwatch", () => {
  it("writes the picked palette colour as a plain hex string", async () => {
    const onValues = vi.fn();
    render(<Harness onValues={onValues} />);

    await userEvent.click(screen.getByRole("radio", { name: "Colour 1" }));
    await userEvent.click(screen.getByRole("button", { name: "save" }));

    expect(onValues).toHaveBeenCalledWith(
      expect.objectContaining({ color: WORKSPACE_PALETTE[0] }),
      expect.anything(),
    );
  });

  // The behaviour NewWorkspaceModal.tsx:165 defends: a picked swatch must be
  // un-pickable. The sentinel must never reach the form model.
  it("maps the transparent sentinel back to an empty string, so a colour can be unpicked", async () => {
    const onValues = vi.fn();
    render(<Harness onValues={onValues} initial={WORKSPACE_PALETTE[2]} />);

    await userEvent.click(screen.getByRole("radio", { name: "No colour" }));
    await userEvent.click(screen.getByRole("button", { name: "save" }));

    expect(onValues).toHaveBeenCalledWith(
      expect.objectContaining({ color: "" }),
      expect.anything(),
    );
  });

  it("selects the stored colour when the form is seeded from a record", () => {
    render(<Harness onValues={vi.fn()} initial={WORKSPACE_PALETTE[3]} />);
    expect(screen.getByRole("radio", { name: "Colour 4" })).toBeChecked();
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `pnpm vitest run src/molecules/form/FormColorSwatch.test.tsx`
Expected: FAIL — unresolved import.

- [ ] **Step 4: Write `FormColorSwatch`**

Create `src/molecules/form/FormColorSwatch.tsx`:

```tsx
import { ColorSwatchPicker, Label, parseColor } from "@heroui/react";
import { type Control, type FieldPath, type FieldValues, useController } from "react-hook-form";
import { NO_COLOR_SENTINEL, WORKSPACE_PALETTE } from "../../lib/workspace-color";

interface FormColorSwatchProps<T extends FieldValues> {
  control: Control<T>;
  name: FieldPath<T>;
  label: string;
}

/**
 * Workspace identity colour.
 *
 * The form model stores a plain hex string, `""` meaning "no colour" — that is
 * what `toRecord` and `PUT /workspaces/:name` expect, and it is unchanged here.
 * react-aria controls this component with a `Color` object instead, and has no
 * representation for "nothing picked", so the empty string is carried across the
 * seam as a fully transparent swatch (`NO_COLOR_SENTINEL`) and converted back on
 * the way in. Nothing outside this file ever sees the sentinel.
 */
export function FormColorSwatch<T extends FieldValues>({
  control,
  name,
  label,
}: FormColorSwatchProps<T>) {
  const { field } = useController({ control, name });
  const stored = (field.value as string | undefined) ?? "";

  return (
    <>
      <Label>{label}</Label>
      <ColorSwatchPicker
        aria-label={label}
        value={parseColor(stored === "" ? NO_COLOR_SENTINEL : stored)}
        onChange={(color) => {
          const hex = color.toString("hexa");
          field.onChange(hex.toLowerCase() === NO_COLOR_SENTINEL ? "" : color.toString("hex"));
        }}
      >
        <ColorSwatchPicker.Item color={NO_COLOR_SENTINEL} aria-label="No colour">
          <ColorSwatchPicker.Swatch />
          <ColorSwatchPicker.Indicator />
        </ColorSwatchPicker.Item>
        {WORKSPACE_PALETTE.map((c, i) => (
          <ColorSwatchPicker.Item key={c} color={c} aria-label={`Colour ${i + 1}`}>
            <ColorSwatchPicker.Swatch />
            <ColorSwatchPicker.Indicator />
          </ColorSwatchPicker.Item>
        ))}
      </ColorSwatchPicker>
    </>
  );
}
```

- [ ] **Step 5: Run the test**

Run: `pnpm vitest run src/molecules/form/FormColorSwatch.test.tsx`
Expected: PASS, 3 tests.

If the "No colour" item renders with `role="radio"` but a different accessible name,
read the rendered output with `screen.debug()` and correct the **test's** query — do not
loosen the assertion to `getAllByRole("radio")[0]`, which would pass even if the
sentinel mapping were broken.

- [ ] **Step 6: Verify and commit**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: green, 403 tests.

```bash
git add src/lib/workspace-color.ts src/molecules/form/FormColorSwatch.tsx src/molecules/form/FormColorSwatch.test.tsx
git commit -m "feat: colour swatch adapter with a transparent no-colour sentinel"
```

---

### Task 4: The modal shell

**Files:**
- Create: `src/molecules/form/ModalShell.tsx`, `src/molecules/form/index.ts`
- Test: `src/molecules/form/ModalShell.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: `ModalShell(props: { open: boolean; onClose: () => void; title: string;
  size?: "sm" | "md" | "lg" | "cover" | "full"; children: ReactNode })`, and a barrel
  `src/molecules/form/index.ts` re-exporting all five components.

Both modals hand-roll the same three things HeroUI already does: a `.scrim` div with
`role="dialog" aria-modal="true"`, an `onScrimClick` that compares
`e.target === e.currentTarget`, and two `biome-ignore` comments apologising for the
a11y rules that pattern breaks. `Modal.Backdrop` has `isDismissable` (default `true`)
plus a real focus trap, ESC handling and scroll lock — all three currently absent.

- [ ] **Step 1: Write the failing test**

Create `src/molecules/form/ModalShell.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ModalShell } from "./ModalShell";

describe("ModalShell", () => {
  it("renders nothing when closed", () => {
    render(
      <ModalShell open={false} onClose={vi.fn()} title="New workspace">
        <p>body</p>
      </ModalShell>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("exposes an accessible dialog named by its title when open", () => {
    render(
      <ModalShell open onClose={vi.fn()} title="New workspace">
        <p>body</p>
      </ModalShell>,
    );
    expect(screen.getByRole("dialog", { name: "New workspace" })).toBeDefined();
  });

  // Capability the hand-rolled scrim never had. Worth a test because it is the
  // stated reason for adopting the library at all.
  it("closes on Escape", async () => {
    const onClose = vi.fn();
    render(
      <ModalShell open onClose={onClose} title="New workspace">
        <p>body</p>
      </ModalShell>,
    );
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("closes when the backdrop is clicked", async () => {
    const onClose = vi.fn();
    render(
      <ModalShell open onClose={onClose} title="New workspace">
        <p>body</p>
      </ModalShell>,
    );
    await userEvent.click(screen.getByRole("dialog").parentElement as HTMLElement);
    expect(onClose).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm vitest run src/molecules/form/ModalShell.test.tsx`
Expected: FAIL — unresolved import.

- [ ] **Step 3: Write `ModalShell`**

Create `src/molecules/form/ModalShell.tsx`:

```tsx
import { Modal } from "@heroui/react";
import type { ReactNode } from "react";

interface ModalShellProps {
  open: boolean;
  onClose: () => void;
  title: string;
  size?: "sm" | "md" | "lg" | "cover" | "full";
  children: ReactNode;
}

/**
 * Replaces the hand-rolled `.scrim` both workspace modals carried: a bare div with
 * role="dialog", an onScrimClick comparing target to currentTarget, and two
 * biome-ignore lines for the a11y rules that pattern breaks.
 *
 * `Modal.Backdrop` is used WITHOUT a `<Modal>` wrapper on purpose. The wrapper
 * exists to pair a trigger with a dialog; these modals are opened from uiStore,
 * so there is no trigger to pair with and `isOpen`/`onOpenChange` drive it directly.
 *
 * Rendering null when closed preserves today's behaviour exactly: HomePage keeps
 * both modals permanently mounted and toggles `open`, and their open-keyed
 * `reset()` effects depend on the hooks above the early return still running.
 */
export function ModalShell({ open, onClose, title, size = "md", children }: ModalShellProps) {
  return (
    <Modal.Backdrop
      isOpen={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Modal.Container size={size}>
        {/* `aria-label` AND a visible `Modal.Heading` is deliberate, not an oversight.
            Both read from the same `title` prop so they cannot diverge, and the explicit
            label means the dialog has an accessible name even if a caller later passes
            custom header content. Verified against the docs: Modal.Dialog accepts
            `aria-label`, and Modal.Heading exists. Do not "simplify" one of them away. */}
        <Modal.Dialog aria-label={title}>
          <Modal.CloseTrigger />
          <Modal.Header>
            <Modal.Heading>{title}</Modal.Heading>
          </Modal.Header>
          <Modal.Body>{children}</Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm vitest run src/molecules/form/ModalShell.test.tsx`
Expected: PASS, 4 tests.

If the backdrop-click test cannot resolve the backdrop element via
`parentElement`, replace that query with `document.querySelector(".modal__backdrop")`
and add a comment naming it as the one class-based query in the suite, justified
because the backdrop has no accessible role of its own.

- [ ] **Step 5: Write the barrel**

Create `src/molecules/form/index.ts`:

```ts
export { FormCheckbox } from "./FormCheckbox";
export { FormColorSwatch } from "./FormColorSwatch";
export { FormSelect } from "./FormSelect";
export { FormTextField } from "./FormTextField";
export { ModalShell } from "./ModalShell";
```

- [ ] **Step 6: Verify and commit**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: green, 407 tests.

```bash
git add src/molecules/form/
git commit -m "feat: modal shell on Modal.Backdrop, replacing the hand-rolled scrim"
```

---

### Task 5: Repage `NewWorkspaceModal` as a stepper

**Files:**
- Modify: `src/organisms/NewWorkspaceModal.tsx` (markup + a `step` state; the form model
  and `submit` are unchanged)
- Test: `src/organisms/NewWorkspaceModal.test.tsx` (existing, 204 lines — **rewritten**
  in Step 1, as its own commit)

**Interfaces:**
- Consumes: `FormTextField`, `FormSelect`, `FormColorSwatch`, `ModalShell` from
  `../molecules/form`; `RadioButtonGroup` and `Stepper` from `@heroui-pro/react`.
- Produces: nothing new. The component's props are unchanged — `HomePage` is not touched,
  and `onCreated(name)` still fires with the server-slugged name.

**This is the one task in Phase 1a that changes how something looks**, per Edwin's
2026-08-09 ruling. `WorkspaceManagerModal` in Task 6 does not: it keeps its current
layout and is screenshot-gated against it. Do not let the stepper leak into that task.

The `submit` handler, `NewWorkspaceFormValues`, `blankForm`, `emptyRepo` and `filled` are
**byte-identical** when this task ends. Only how the fields are laid out changes. Verify
with `git diff` before committing.

- [ ] **Step 1: Rewrite the test suite for the stepped flow — as its own commit**

Run first: `pnpm vitest run src/organisms/NewWorkspaceModal.test.tsx` and record the
baseline count.

Unlike every other task in Phase 1, this suite **must** change: today's tests fill every
field on one page and submit, and after this task the fields live on three steps. Do the
rewrite **before** touching the component and commit it separately, so the component diff
carries no test edits and a reviewer can see exactly what behaviour was renegotiated.

Every existing assertion must survive in some form — the step it now runs on may change,
but the thing being asserted may not be dropped. Walk the current file test by test and
map each one; if an assertion has no home in the stepped flow, that is a behaviour
regression, not a test that outlived its purpose.

Add a `goToStep` helper at the top of the file so the rewrite does not repeat navigation
in every test:

```tsx
/** Advances the wizard by pressing "next" n times. Each press gates on the
    current step being valid, so callers must fill the fields first. */
async function goToStep(n: number) {
  for (let i = 0; i < n; i++) {
    await userEvent.click(screen.getByRole("button", { name: "next" }));
  }
}
```

Then add the three tests the stepper itself needs — these are new behaviour, so they are
written here, before the implementation:

```tsx
it("starts on Details with next disabled until the name is filled", async () => {
  renderModal();
  expect(screen.getByRole("button", { name: "next" })).toBeDisabled();
  await userEvent.type(screen.getByLabelText("Workspace name"), "acme");
  expect(screen.getByRole("button", { name: "next" })).toBeEnabled();
});

it("back returns to the previous step without losing what was typed", async () => {
  renderModal();
  await userEvent.type(screen.getByLabelText("Workspace name"), "acme");
  await goToStep(1);
  await userEvent.click(screen.getByRole("button", { name: "back" }));
  expect(screen.getByLabelText("Workspace name")).toHaveValue("acme");
});

// The submit button exists only on the last step; a stepper that let Enter
// submit from step 0 would POST a half-filled workspace.
it("does not offer create until the final step", async () => {
  renderModal();
  expect(screen.queryByRole("button", { name: /create workspace/i })).toBeNull();
});
```

Use the suite's existing render helper rather than inventing `renderModal` if one is
already there — read the top of the file first and match its name.

Commit this alone:

```bash
git add src/organisms/NewWorkspaceModal.test.tsx
git commit -m "test: rewrite new-workspace suite for the stepped flow"
```

- [ ] **Step 2: Capture the before-screenshots**

```bash
mkdir -p .screenshots/phase1a
```

With the broker running and the app on `http://localhost:1420`, open the New workspace
modal and capture it in all four themes. `.screenshots/` is gitignored — these are
local evidence, not artifacts.

```
.screenshots/phase1a/new-workspace-{dark,light,midnight,sand}-before.png
```

- [ ] **Step 3: Replace the imports and add the step model**

In `src/organisms/NewWorkspaceModal.tsx`, replace lines 1-6:

```tsx
import { RadioButtonGroup, Stepper } from "@heroui-pro/react";
import { Button } from "@heroui/react";
import { Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { type FieldPath, useFieldArray, useForm } from "react-hook-form";
import type { ConnectorInstanceRecord, WorkspaceRecord } from "../api/types";
import { FormColorSwatch, FormSelect, FormTextField, ModalShell } from "../molecules/form";
```

`SegmentedControl` and `WORKSPACE_PALETTE` are no longer imported here —
`RadioButtonGroup` replaces the first, `FormColorSwatch` owns the second.

Then add the step model above the component. Keeping it a module constant rather than
inlining it in JSX is what lets the "which fields gate this step" question have one
answer instead of three:

```tsx
/**
 * The wizard's three steps and the fields each one gates on.
 *
 * `gates` lists the fields RHF must find valid before `next` enables. Repos are
 * absent from every entry on purpose: they are a field array whose length changes
 * at runtime, so the last step gates on `isValid` for the whole form instead —
 * which is exactly what the single-page version's create button already did.
 */
const STEPS = [
  { title: "Details", description: "Name and links", gates: ["name"] },
  { title: "Colour", description: "Optional identity", gates: [] },
  { title: "Repos", description: "At least one", gates: [] },
] as const satisfies ReadonlyArray<{
  title: string;
  description: string;
  gates: ReadonlyArray<FieldPath<NewWorkspaceFormValues>>;
}>;
```

- [ ] **Step 4: Add the step state and the navigation gate**

Add to the component body, beside the existing `useState`s:

```tsx
  const [step, setStep] = useState(0);
  // `trigger` validates a subset of fields on demand — that is what lets `next`
  // gate on THIS step's fields rather than the whole form, which would keep it
  // disabled until the repos on step 2 were filled.
  const { trigger } = form; // add `trigger` to the useForm destructure

  const goNext = async () => {
    const gates = STEPS[step].gates;
    // A step with no gates (Colour) is always passable. `trigger([])` returns
    // true for an empty list, but calling it at all is wasted work.
    if (gates.length > 0 && !(await trigger([...gates]))) return;
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  };
```

The open-keyed reset effect must also reset the step, or reopening the modal lands on
whatever step the last session ended on. Add one line inside the existing effect — do
**not** add a second effect:

```tsx
  useEffect(() => {
    if (!open) return;
    reset(blankForm());
    setStep(0); // ← add this
    setError(null);
    void listMyConnectors().then(setConnectors);
  }, [open]);
```

- [ ] **Step 5: Replace the render body**

Replace everything from `if (!open) return null;` (line 134) to the closing `}` of the
component with:

```tsx
  const isLastStep = step === STEPS.length - 1;

  return (
    <ModalShell open={open} onClose={onClose} title="New workspace">
      <Stepper currentStep={step}>
        {STEPS.map((s) => (
          <Stepper.Step key={s.title}>
            <Stepper.Indicator />
            <Stepper.Content>
              <Stepper.Title>{s.title}</Stepper.Title>
              <Stepper.Description>{s.description}</Stepper.Description>
            </Stepper.Content>
            <Stepper.Separator />
          </Stepper.Step>
        ))}
      </Stepper>

      {/* Every step's fields stay MOUNTED and are hidden with `hidden`, never
          unmounted. FormTextField holds RHF state through useController, and
          unmounting a controlled field unregisters it — stepping forward and back
          would silently clear what the user typed. The `back` test asserts this. */}
      <div hidden={step !== 0}>
        <FormTextField control={control} name="name" label="Workspace name" placeholder="acme" rules={{ validate: filled }} />
        <FormTextField
          control={control}
          name="description"
          label="Description"
          placeholder="Marketing site + storefront"
        />
        <FormTextField
          control={control}
          name="linksText"
          label="Links"
          hint="one per line — docs, dashboards, tickets"
          multiline
          rows={3}
        />
      </div>

      <div hidden={step !== 1}>
        <FormColorSwatch control={control} name="color" label="Colour" />
      </div>

      <div hidden={step !== 2}>
      <p className="wizard__hint">Repos — every repo needs a GitHub connector before create enables.</p>
      {githubConnectors.length === 0 && (
        <p className="wizard__hint">No GitHub connectors yet — add one in Settings → Integrations first.</p>
      )}
      {fields.map((field, i) => (
        <div key={field.id} className="nw-repo-row">
          {/* `value` / `onChange(value: string)` and `Item value=` are VERIFIED against
              the docs' Controlled example. `orientation` is NOT: the Pro component's own
              API table lists only `layout: 'flex' | 'grid'` and inherits the rest from
              RadioGroup. If `orientation` does not pass through, use `layout="flex"` and
              set the direction in CSS — do not leave a prop that silently does nothing. */}
          <RadioButtonGroup
            aria-label={`Repo ${i + 1} source`}
            value={repoModes[i]?.mode ?? "existing"}
            onChange={(value) => setValue(`repos.${i}.mode`, value as DraftRepo["mode"])}
            orientation="horizontal"
          >
            <RadioButtonGroup.Item value="existing">
              <RadioButtonGroup.ItemContent>Existing repo</RadioButtonGroup.ItemContent>
              <RadioButtonGroup.Indicator />
            </RadioButtonGroup.Item>
            <RadioButtonGroup.Item value="new">
              <RadioButtonGroup.ItemContent>New folder</RadioButtonGroup.ItemContent>
              <RadioButtonGroup.Indicator />
            </RadioButtonGroup.Item>
          </RadioButtonGroup>
          <FormTextField control={control} name={`repos.${i}.name`} label="Repo name" labelHidden placeholder="web" rules={{ validate: filled }} />
          <FormTextField
            control={control}
            name={`repos.${i}.path`}
            labelHidden
            label="Path"
            placeholder={repoModes[i]?.mode === "new" ? "/Users/me/code/new-project" : "/Users/me/code/acme-web"}
            rules={{ validate: filled }}
          />
          {repoModes[i]?.mode === "new" && pickFolder && (
            <Button variant="secondary" onPress={() => void browse(i)}>
              Browse…
            </Button>
          )}
          <FormTextField control={control} name={`repos.${i}.owner`} label="GitHub owner" labelHidden placeholder="GitHub owner" rules={{ validate: filled }} />
          <FormTextField control={control} name={`repos.${i}.repo`} label="GitHub repo" labelHidden placeholder="GitHub repo" rules={{ validate: filled }} />
          <FormSelect
            control={control}
            name={`repos.${i}.connectorId`}
        labelHidden
            label="GitHub connector"
            placeholder="pick a connector…"
            options={githubConnectors.map((c) => ({ id: c.id, label: c.label }))}
            rules={{ required: true }}
          />
          <Button
            isIconOnly
            variant="ghost"
            onPress={() => remove(i)}
            isDisabled={fields.length <= 1}
            aria-label="Remove repo"
          >
            <X size={12} strokeWidth={2} />
          </Button>
        </div>
      ))}
      <Button variant="secondary" onPress={() => append(emptyRepo())}>
        <Plus size={11} strokeWidth={2.2} /> add another
      </Button>
      </div>

      {error && <p className="wizard__error">{error}</p>}

      {/* One footer for all three steps. `create workspace` renders only on the
          last step — a stepper that offered submit from step 0 would POST a
          half-filled workspace, which is what the third new test guards. */}
      <div className="nw-wizard__nav">
        <Button variant="secondary" onPress={() => setStep((s) => Math.max(s - 1, 0))} isDisabled={step === 0}>
          back
        </Button>
        {isLastStep ? (
          <Button
            variant="primary"
            onPress={() => void submit()}
            isDisabled={isSubmitting || !isValid}
          >
            {isSubmitting ? "creating…" : "create workspace"}
          </Button>
        ) : (
          <Button variant="primary" onPress={() => void goNext()} isDisabled={!canLeaveStep}>
            next
          </Button>
        )}
      </div>
    </ModalShell>
  );
}
```

`canLeaveStep` is what disables `next`, and it is computed from watched values — not from
`formState.errors`, which is only populated *after* a validation run and would leave
`next` enabled on a pristine empty form until the user had already pressed it once.

Add beside `goNext`:

```tsx
  // Watched values, not formState.errors: errors only exist after a validation run,
  // so gating on them would leave `next` enabled on a pristine form — exactly the
  // state the first new test exercises. `useWatch` re-renders on every keystroke,
  // which is what makes the button enable as soon as the field is filled.
  const values = useWatch({ control });
  const canLeaveStep = STEPS[step].gates.every((g) => filled(String(values[g] ?? "")));
```

Import `useWatch` from `react-hook-form` alongside `useForm` and `useFieldArray`.

Two constraints this places on `STEPS`, both currently satisfied:

- **Every `gates` entry must be a top-level field name.** `values[g]` is a plain property
  read, so a dotted path like `"atlassian.siteUrl"` would silently resolve to
  `undefined` and gate the step shut forever. Only `"name"` is gated today. If a nested
  field ever needs gating, switch that entry to `useWatch({ control, name: g })` rather
  than making the index lookup smarter.
- **A step with no gates is always passable** — `[].every(...)` is `true`, which is the
  behaviour the Colour step needs and gets for free.

`goNext` keeps its `trigger` call as well. The two are not redundant: `canLeaveStep`
disables the button, and `trigger` runs the real validators and surfaces field errors if
the button is ever reached another way (Enter key, a future keyboard shortcut).

Five deliberate changes to note in review:
- `if (!open) return null` is **gone** — `ModalShell` owns that, and the open-keyed
  `useEffect` above it must keep running on every render (it already did; the early
  return sat after all hooks).
- `onScrimClick` (lines 130-132) and its `MouseEvent` type import are **deleted**.
  `Modal.Backdrop`'s `isDismissable` replaces it, along with both `biome-ignore`
  comments that apologised for the hand-rolled version's a11y violations.
- `register` is no longer destructured from `useForm` — remove it from the destructure
  on line 67 or `tsc` will flag it unused. `control`, `handleSubmit`, `reset`,
  `setValue`, `watch`, `formState`, `trigger` all stay.
- `onClick`→`onPress` and `disabled`→`isDisabled` on every `Button`. A `Button` given
  `onClick` renders fine and silently does nothing.
- **Steps hide with `hidden`, they do not unmount.** `FormTextField` holds its value
  through `useController`; unmounting unregisters the field and loses the input. This is
  the single most likely way to break the stepper, and the `back` test is what catches it.

- [ ] **Step 6: Run the test**

Run: `pnpm vitest run src/organisms/NewWorkspaceModal.test.tsx`
Expected: PASS — the rewritten suite from Step 1, plus its three new stepper tests, with
**no further edits to the test file**. A test needing changes now (rather than in Step 1)
means the implementation drifted from the flow the tests agreed on.

- [ ] **Step 7: Screenshot capture**

Capture `new-workspace-{dark,light,midnight,sand}-after.png`, one per step (12 shots).

**This modal is the phase's one approved appearance change**, so there is no
before/after equality gate for it. Capture the shots as the record of what the stepper
now looks like, and check each theme for the things a restyle breaks silently: unreadable
indicator text, a separator that vanishes on a light ground, a footer that overlaps the
body at small heights.

- [ ] **Step 8: Verify and commit**

Run: `pnpm typecheck && pnpm lint && pnpm test`

```bash
git add src/organisms/NewWorkspaceModal.tsx
git commit -m "feat: repage NewWorkspaceModal as a three-step wizard on heroui"
```

---

### Task 6: Migrate `WorkspaceManagerModal`

**Files:**
- Modify: `src/organisms/WorkspaceManagerModal.tsx` (markup only, from line ~334 —
  everything below `if (!open) return null`)
- Test: `src/organisms/WorkspaceManagerModal.test.tsx` (existing, 352 lines)

**Interfaces:**
- Consumes: everything from `../molecules/form`.
- Produces: nothing new.

This is the same transformation as Task 5 over 16 inputs instead of 10, plus a checkbox
and a two-column layout. The form model (`WorkspaceFormValues`, `toForm`, `toRecord`,
`keyList`) is **not touched** — verify with `git diff --stat` in Step 6 that lines
1-160 of the file are unchanged.

- [ ] **Step 1: Run the existing test and record the baseline**

Run: `pnpm vitest run src/organisms/WorkspaceManagerModal.test.tsx`
Expected: PASS. Record the count.

This suite carries three `noNonNullAssertion` lint warnings today (lines 57, 82, 186).
Leave them — fixing them here mixes a lint cleanup into a migration diff.

- [ ] **Step 2: Capture before-screenshots**

```
.screenshots/phase1a/workspace-manager-{dark,light,midnight,sand}-before.png
```

- [ ] **Step 3: Replace the scrim and header**

Replace the `.scrim` div and `<section className="workspace-manager">` opening (and its
matching close) with `ModalShell`, keeping the two-column body:

```tsx
  return (
    <ModalShell open={open} onClose={onClose} title="Workspaces" size="lg">
      {loadError && <p className="wizard__error">{loadError}</p>}
      <div className="workspace-manager__body">
        {/* left column unchanged — it is a list of buttons, not form fields */}
        <div className="workspace-manager__list">{/* … existing markup … */}</div>
        <div className="workspace-manager__form">{/* … replaced in Step 4 … */}</div>
      </div>
      {/* ConfirmSheet stays exactly where it is */}
    </ModalShell>
  );
```

The left column keeps its existing markup and classes. It contains no form inputs, and
converting it would widen this diff for no gain — Phase 2 restyles it.

- [ ] **Step 4: Replace the 16 form inputs**

Inside `.workspace-manager__form`:

```tsx
<FormTextField control={control} name="name" label="Workspace name" placeholder="acme" rules={{ validate: filled }} />
<FormTextField control={control} name="description" label="Description" placeholder="Marketing site + storefront" />
<FormTextField
  control={control}
  name="linksText"
  label="Links"
  hint="one per line — docs, dashboards, tickets"
  placeholder="https://github.com/acme/web"
  multiline
  rows={3}
/>
<FormColorSwatch control={control} name="color" label="Colour" />
<FormCheckbox control={control} name="default" label="Default workspace" />

<div className="workspace-manager__atlassian">
  <span className="wizard__hint">Atlassian (Jira / Confluence)</span>
  <FormTextField
    control={control}
    name="atlassian.siteUrl"
    labelHidden
    label="Atlassian site URL"
    placeholder="https://acme.atlassian.net"
  />
  <FormSelect
    control={control}
    name="atlassian.connectorId"
    label="Atlassian connector"
    placeholder="pick a connector…"
    options={atlassianConnectors.map((c) => ({ id: c.id, label: c.label }))}
  />
  {/* Index 0 only — entries 1..N ride along untouched. See WorkspaceFormValues. */}
  <FormTextField
    control={control}
    name="atlassian.jiraProjectKeys.0"
    labelHidden
    label="Jira project key"
    placeholder="Jira project key (ACME)"
  />
  <FormTextField
    control={control}
    name="atlassian.confluenceSpaceKeys.0"
    labelHidden
    label="Confluence space key"
    placeholder="Confluence space key (DOCS)"
  />
  {/* verify button unchanged apart from onClick → onPress */}
</div>

<div className="workspace-manager__repos">
  <span className="wizard__hint">Repos</span>
  {fields.map((field, i) => (
    <div key={field.id} className="repo-row">
      <FormTextField control={control} name={`repos.${i}.name`} label="Repo name" labelHidden placeholder="web" rules={{ validate: filled }} />
      <FormTextField control={control} name={`repos.${i}.path`} label="Path" labelHidden placeholder="/Users/me/code/acme-web" rules={{ validate: filled }} />
      <FormTextField control={control} name={`repos.${i}.branch`} label="Branch" labelHidden placeholder="main" />
      <FormTextField control={control} name={`repos.${i}.owner`} label="GitHub owner" labelHidden placeholder="GitHub owner" />
      <FormTextField control={control} name={`repos.${i}.repo`} label="GitHub repo" labelHidden placeholder="GitHub repo" />
      <FormSelect
        control={control}
        name={`repos.${i}.connectorId`}
        labelHidden
        label="GitHub connector"
        placeholder="pick a connector…"
        options={githubConnectors.map((c) => ({ id: c.id, label: c.label }))}
      />
      {/* verify + remove buttons: onClick → onPress, disabled → isDisabled */}
    </div>
  ))}
</div>
```

Note the two Atlassian key fields keep their `.0` paths. Flattening them to a scalar
would drop entries 1..N on the next save — the file's own comment at lines 26-33
explains why, and `PUT /workspaces/:name` replaces the whole `atlassian` block.

- [ ] **Step 5: Convert every remaining `<button>` in this file**

Run: `grep -n "onClick=\|disabled=" src/organisms/WorkspaceManagerModal.tsx`
Every hit inside a HeroUI `Button` becomes `onPress=` / `isDisabled=`. Plain `<button>`
elements in the left column keep `onClick`. Both are correct; the failure mode is
mixing them up, so check each hit's element.

- [ ] **Step 6: Confirm the form model is untouched**

Run: `git diff -U0 src/organisms/WorkspaceManagerModal.tsx | grep "^[-+]" | grep -nE "toRecord|toForm|keyList|blankForm|emptyRepo|noAtlassian|WorkspaceFormValues"`
Expected: no output. Any hit means the migration reached into the model — revert that
hunk.

- [ ] **Step 7: Run the test and screenshots**

Run: `pnpm vitest run src/organisms/WorkspaceManagerModal.test.tsx`
Expected: PASS, same count as Step 1, no test edits.

Capture `workspace-manager-{dark,light,midnight,sand}-after.png`; compare structurally.

- [ ] **Step 8: Verify and commit**

Run: `pnpm typecheck && pnpm lint && pnpm test`

```bash
git add src/organisms/WorkspaceManagerModal.tsx
git commit -m "refactor: WorkspaceManagerModal onto heroui fields and modal shell"
```

---

### Task 7: Retire `SegmentedControl`, close the phase

**Files:**
- Delete: `src/atoms/SegmentedControl.tsx`
- Modify: whichever files still import it (determined in Step 1)

**Interfaces:**
- Consumes: `RadioButtonGroup` from `@heroui-pro/react`, used the same way as Task 5.
- Produces: nothing.

- [ ] **Step 1: Find the remaining consumers**

Run: `grep -rn "SegmentedControl" src`

`NewWorkspaceModal` stopped importing it in Task 5. If **any** other file still does,
migrate it here using the exact `RadioButtonGroup` block from Task 5 Step 4 — same
props, same two-item shape. If a consumer belongs to a Phase 1b/1c surface, leave it and
**skip to Step 4**: deleting the atom out from under another phase's branch is how merge
conflicts get manufactured. Record the decision in the commit message.

- [ ] **Step 2: Delete the atom (only if Step 1 found no remaining consumers)**

```bash
git rm src/atoms/SegmentedControl.tsx
```

- [ ] **Step 3: Confirm it is gone**

Run: `grep -rn "SegmentedControl" src`
Expected: no output.

- [ ] **Step 4: Full phase verification**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`

Expected: all green. Record the final test count; it must be ≥ 407 (395 baseline − 1
canary test file + 13 adapter tests), and **no test file may have been edited** —
confirm with:

```bash
git diff --stat main -- 'src/**/*.test.tsx' 'src/**/*.test.ts'
```

Expected: only the deleted `HeroCanary.test.tsx` and the four new adapter test files.
An edited pre-existing test file means a behaviour changed; investigate before merging.

- [ ] **Step 5: Confirm the CSS budget moved the right way**

Run: `pnpm build` and record `dist/assets/index-*.css`.

Phase 0 baseline was **457.28 kB (46.98 kB gzip)** with zero components using HeroUI.
Tailwind v4 scans source for utility usage, so this number changes as classes come into
use. It is recorded as evidence for the Phase 1b/1c plans, not as a pass/fail gate.

- [ ] **Step 6: UI smoke against a live broker**

Start the broker (`tmux` session `smith-broker`, port 7790) and `pnpm dev`. Then:

1. Open **New workspace**. Type a name, pick a colour, un-pick it, pick another.
2. Add a second repo row; remove it. Confirm the remove button is disabled at one row.
3. Pick a GitHub connector; confirm **create workspace** enables only when every
   required field is filled.
4. Create the workspace. Confirm the composer opens on the new workspace name.
5. Open **Workspaces** from the sessions panel. Edit the workspace, change its colour,
   save, reopen, and confirm the colour persisted.
6. Press **Escape** in each modal — new capability, previously ESC did nothing.
7. **Tab** through each modal and confirm focus never escapes to the page behind it —
   also new.

- [ ] **Step 7: Commit and open the branch for review**

```bash
git add -A
git commit -m "refactor: retire SegmentedControl, close heroui phase 1a"
```

---

## Notes for the Phase 1b and 1c implementers

- `src/molecules/form/` is yours to import, not to fork. If chat or kanban needs a field
  shape that is not here, add it here with a test rather than writing a `<Controller>`
  inline — the point of this phase was to have exactly one place where the react-aria
  value/event mismatch is handled.
- `onPress` not `onClick`, `isDisabled` not `disabled`. Every HeroUI interactive
  component. This is the single most likely silent bug in the whole migration.
- The `?? ""` in `FormTextField` is load-bearing. An `undefined` value flips react-aria
  to uncontrolled and it never flips back, which breaks `reset()` for the life of the
  mount — and every modal in this app is permanently mounted with an open-keyed reset.
</content>
</invoke>
