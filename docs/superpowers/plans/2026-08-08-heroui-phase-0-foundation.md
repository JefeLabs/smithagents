# HeroUI Pro — Phase 0 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Claimed by:** Claude session f09d8ae9 on branch `heroui-phase-0`, 2026-08-09.
In progress — do not execute in parallel from another checkout.

**Goal:** Install HeroUI + Tailwind v4 into `control-plane`, make its CSS pipeline
deterministic, eliminate the three class collisions, and define HeroUI's theme
variables from the existing token system — with the app rendering pixel-identical and
no component using HeroUI yet.

**Architecture:** `tokens.css` becomes the definition of HeroUI's variables rather
than a system beside them. CSS cascade layers (`@layer legacy, heroui, overrides`)
make ordering deterministic regardless of import order. Three bare class names are
renamed with an `sm-` prefix so HeroUI's own `.chip` / `.avatar` and Tailwind's
`.hidden` are unobstructed.

**Tech Stack:** React 19, Vite 6, TypeScript, Vitest 4 + jsdom, Testing Library,
Biome, pnpm. Adding: `tailwindcss@4`, `@tailwindcss/vite`, `@heroui/react`,
`@heroui/styles`, `@heroui-pro/react`, `react-aria-components`.

**Spec:** `docs/superpowers/specs/2026-08-08-heroui-pro-adoption-design.md`

## Global Constraints

- Package manager is **pnpm**, run from `control-plane/`. Never `npm`. The untracked
  `package.json` + `package-lock.json` at repo root is a scratch install — do not use,
  do not modify, do not commit it.
- Tailwind must be **v4**. HeroUI v3 does not work with Tailwind v3.
- No component may import from `@heroui/react` or `@heroui-pro/react` in Phase 0
  except the canary in Task 4.
- The app must render **pixel-identical** at the end of Phase 0. Phase 0 changes no
  appearance.
- There are **four** themes: `:root` (dark, default), `[data-theme="light"]`,
  `[data-theme="midnight"]`, `[data-theme="sand"]`. Every one must define the full
  HeroUI variable set.
- Verification commands, run from `control-plane/`: `pnpm typecheck`, `pnpm lint`,
  `pnpm test`. All three must pass before any task is called done.
- Commit after every task. Use `git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents`
  and verify the reported `[branch hash]` and file count after each commit.

---

## File Structure

**Created:**
- `control-plane/src/styles/heroui.css` — layer declaration + HeroUI/Tailwind imports.
  Single responsibility: own the CSS pipeline's entry order.
- `control-plane/src/styles/tokens.test.ts` — asserts every theme block defines the
  full HeroUI variable set. Guards the invariant that a new theme cannot silently
  omit variables.
- `control-plane/src/atoms/HeroCanary.tsx` — a throwaway component proving the
  pipeline works end to end. Deleted at the start of Phase 1.
- `control-plane/src/atoms/HeroCanary.test.tsx`

**Modified:**
- `control-plane/package.json` — dependencies
- `control-plane/vite.config.ts` — add `@tailwindcss/vite` plugin
- `control-plane/src/main.tsx:5-7` — CSS import order
- `control-plane/src/styles/components.css` — wrap in `@layer legacy`; rename 3 classes
- `control-plane/src/styles/tokens.css` — add HeroUI variables to 4 theme blocks
- `control-plane/src/atoms/Chip.tsx`, `src/molecules/BoardCard.tsx`,
  `src/organisms/{WorkspaceManagerModal,MapStage,AgentRoster}.tsx` — `.chip` rename
- `control-plane/src/atoms/Avatar.tsx`, `src/molecules/{AgentAvatar,AvatarGeneratorBlock}.tsx`
  — `.avatar` rename
- `control-plane/src/molecules/DiscordIdentityPanel.tsx:14,27,33` — `.hidden` rename
- `control-plane/src/molecules/BoardCard.test.tsx`, `src/organisms/BoardStage.test.tsx`
  — assertions referencing `chip`

---

### Task 1: Install and wire the CSS pipeline

**Files:**
- Modify: `control-plane/package.json`
- Modify: `control-plane/vite.config.ts`
- Create: `control-plane/src/styles/heroui.css`
- Modify: `control-plane/src/main.tsx:5-7`

**Interfaces:**
- Consumes: nothing.
- Produces: a working Tailwind v4 + HeroUI stylesheet pipeline, and the cascade layer
  order `legacy, heroui, overrides`. Task 3 relies on `heroui.css` existing. Task 4
  relies on Tailwind utilities compiling.

- [ ] **Step 1: Install dependencies**

```bash
cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents/control-plane
pnpm add @heroui/react @heroui/styles @heroui-pro/react react-aria-components
pnpm add -D tailwindcss@4 @tailwindcss/vite
```

- [ ] **Step 2: Add the Tailwind Vite plugin**

In `control-plane/vite.config.ts`, add the import and the plugin. Keep every existing
option — the Tauri-related settings (`clearScreen`, port 1420, `envPrefix`) stay even
though Tauri is retired as a surface; removing them is out of scope.

```ts
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "0.0.0.0",
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    outDir: "dist",
    target: "es2021",
    sourcemap: true,
  },
});
```

- [ ] **Step 3: Create the layer-ordering entry stylesheet**

Create `control-plane/src/styles/heroui.css`. The `@layer` declaration must come
first — it fixes precedence by declaration order, so later imports cannot reorder it.

```css
/*
 * Layer order is declared here and nowhere else. Earlier layers lose to later ones,
 * so: legacy (components.css) loses to heroui, and both lose to overrides.
 *
 * This is what lets the hand-written sheet and HeroUI coexist without depending on
 * import order in main.tsx — which is fragile and invisible at the call site.
 */
@layer legacy, heroui, overrides;

@import "tailwindcss";
@import "@heroui/styles";
```

- [ ] **Step 4: Update the CSS import order in main.tsx**

`control-plane/src/main.tsx` currently has, at lines 5-7:

```ts
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
```

Replace with:

```ts
import "./styles/heroui.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
```

`heroui.css` goes first so the `@layer` declaration is parsed before any layered rule.
`tokens.css` and `base.css` stay unlayered — they define custom properties and element
selectors that must apply globally.

- [ ] **Step 5: Wrap components.css in the legacy layer**

At the very top of `control-plane/src/styles/components.css`, add:

```css
@layer legacy {
```

and at the very bottom of the file, add the closing brace:

```css
}
```

Do not re-indent the 2,896 lines in between. Indentation churn would make the diff
unreviewable and produce a misleading blame history for every rule in the file.

- [ ] **Step 6: Verify nothing changed**

```bash
cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents/control-plane
pnpm typecheck && pnpm lint && pnpm test
```

Expected: all pass. Test count unchanged from before this task.

- [ ] **Step 7: Visual smoke**

```bash
cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents/control-plane
pnpm dev
```

Open `http://localhost:1420`. Confirm the app looks unchanged. Cycle all four themes
via the `data-theme` attribute on `<html>` in devtools: unset (dark), `light`,
`midnight`, `sand`. Save screenshots to `.screenshots/phase0-before-<theme>.png` —
these are the parity baseline for Tasks 2–4 and for Phase 1.

- [ ] **Step 8: Commit**

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents add \
  control-plane/package.json control-plane/pnpm-lock.yaml \
  control-plane/vite.config.ts control-plane/src/main.tsx \
  control-plane/src/styles/heroui.css control-plane/src/styles/components.css
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents commit -m "feat: install heroui + tailwind v4, declare cascade layers

Layer order lives in heroui.css so precedence does not depend on import
order in main.tsx. components.css goes to the legacy layer unindented —
re-indenting 2896 lines would destroy the blame history."
```

Verify the output reports `[react-state-stack <hash>]` and **6 files changed**.
Do not include the repo-root `package.json` or `package-lock.json`.

---

### Task 2: Rename the three colliding classes

**Files:**
- Modify: `control-plane/src/styles/components.css` (3 rule families)
- Modify: `control-plane/src/atoms/Chip.tsx`, `src/atoms/Avatar.tsx`
- Modify: `control-plane/src/molecules/{BoardCard,AgentAvatar,AvatarGeneratorBlock,DiscordIdentityPanel}.tsx`
- Modify: `control-plane/src/organisms/{WorkspaceManagerModal,MapStage,AgentRoster}.tsx`
- Modify: `control-plane/src/molecules/BoardCard.test.tsx`, `src/organisms/BoardStage.test.tsx`

**Interfaces:**
- Consumes: the `legacy` layer from Task 1.
- Produces: `.chip`, `.avatar`, and `.hidden` are free for HeroUI and Tailwind. No
  later task depends on the new names beyond these files.

**Scope note — verified, do not widen:** only the bare **block** names collide.
`.chips`, `.avatar-gen`, `.avatar-gen__preview`, `.avatar__img`, `.modal`, `.modal-actions`,
and `.field` do **not** collide and must be left alone. HeroUI's avatar element is
`.avatar__image`, not `.avatar__img`.

- [ ] **Step 1: Run the existing tests to establish the baseline**

```bash
cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents/control-plane
pnpm test
```

Expected: PASS. Note the exact test count — it must be identical after the rename.
These tests are the regression check for this task; the rename is behavior-preserving,
so a changed count means something was missed.

- [ ] **Step 2: Rename `.chip` → `.sm-chip` in CSS**

In `control-plane/src/styles/components.css`, rename only the rules whose selector is
exactly `.chip` (3 rules). Leave `.chips` untouched — it is a container class with no
HeroUI counterpart.

- [ ] **Step 3: Rename `.chip` → `.sm-chip` in components**

Update the `className` string in each of these files. `src/atoms/Chip.tsx` is the
canonical one:

```tsx
export function Chip({ label, pressed, onToggle }: ChipProps) {
  return (
    <button type="button" className="sm-chip" aria-pressed={pressed} onClick={onToggle}>
      {label}
    </button>
  );
}
```

Then the same substitution in `src/molecules/BoardCard.tsx`,
`src/organisms/WorkspaceManagerModal.tsx`, `src/organisms/MapStage.tsx`, and
`src/organisms/AgentRoster.tsx`. In each, change only the standalone `chip` token
inside a `className` — do not touch `chips`, and do not touch the word `chip` in
comments, prop names, or identifiers.

- [ ] **Step 4: Update the two tests that assert on the chip class**

`src/molecules/BoardCard.test.tsx` and `src/organisms/BoardStage.test.tsx` reference
`chip` in assertions. Update those selectors to `sm-chip`.

- [ ] **Step 5: Rename the `.avatar` block → `.sm-avatar`**

In `components.css`, rename the rule whose selector is exactly `.avatar`, and its BEM
child `.avatar__img` → `.sm-avatar__img`. Renaming the block without its element would
leave inconsistent BEM and re-expose the element name to a future HeroUI release.

Leave `.avatar-gen` and `.avatar-gen__preview` alone — different block, no collision.

Then update `className` in `src/atoms/Avatar.tsx`, `src/molecules/AgentAvatar.tsx`,
and `src/molecules/AvatarGeneratorBlock.tsx`.

- [ ] **Step 6: Rename `.hidden` → `.sm-hidden`**

In `components.css` at line ~1207:

```css
.sm-hidden {
  display: none !important;
}
```

In `src/molecules/DiscordIdentityPanel.tsx`, three usages at lines 14, 27, 33:

```tsx
<div className={hidden ? "field sm-hidden" : "field"}>
```

```tsx
<div className={mode === "webhook" ? "" : "sm-hidden"}>
```

```tsx
<div className={mode === "bot" ? "" : "sm-hidden"}>
```

The `hidden` **prop name** on `DiscordIdentityPanelProps` stays as-is — it is a
TypeScript identifier, not a CSS class.

- [ ] **Step 7: Verify no bare collisions remain**

```bash
cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents/control-plane
grep -nE "^\.(chip|avatar|hidden)([ ,{:.]|$)" src/styles/components.css
```

Expected: **no output**. Any line printed is a missed rename.

```bash
grep -rnE 'className="[^"]*\b(chip|avatar|hidden)\b' src --include="*.tsx"
```

Expected: **no output**.

- [ ] **Step 8: Run the full suite**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Expected: all pass, with the **same test count** as Step 1.

- [ ] **Step 9: Visual smoke**

Run `pnpm dev` and compare against `.screenshots/phase0-before-<theme>.png` in all
four themes. Chips, avatars, and the Discord identity panel's hidden states must look
identical. A chip rendering unstyled means a `className` was missed.

- [ ] **Step 10: Commit**

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents add control-plane/src
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents commit -m "refactor: prefix the three classes that collide with heroui

.chip and .avatar are bare HeroUI OSS blocks; .hidden is a Tailwind core
utility. Only bare block names collide — BEM's block__element convention
shields the other 232 root classes, and .avatar__img is distinct from
HeroUI's .avatar__image."
```

Verify the reported file count is **12**: `components.css`, `Chip.tsx`, `Avatar.tsx`,
`BoardCard.tsx`, `AgentAvatar.tsx`, `AvatarGeneratorBlock.tsx`, `DiscordIdentityPanel.tsx`,
`WorkspaceManagerModal.tsx`, `MapStage.tsx`, `AgentRoster.tsx`, `BoardCard.test.tsx`,
`BoardStage.test.tsx`.

---

### Task 3: Token bridge

**Files:**
- Create: `control-plane/src/styles/tokens.test.ts`
- Modify: `control-plane/src/styles/tokens.css` (4 theme blocks)

**Interfaces:**
- Consumes: nothing from prior tasks (independent of the renames).
- Produces: every HeroUI semantic variable defined in all four themes. Task 4's canary
  depends on `--accent`, `--surface`, and `--foreground` resolving per theme.

**Why a test and not review discipline:** a theme block that omits a variable inherits
it from `:root` (dark). In `sand` or `light` that silently yields dark-on-light
components — a bug that looks like a styling opinion, and that no type checker or
linter can see.

- [ ] **Step 1: Write the failing test**

Create `control-plane/src/styles/tokens.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * HeroUI semantic variables that every theme must define. A theme that omits one
 * inherits :root's dark value, which silently produces unreadable components on
 * light themes. This list is the contract; grow it if HeroUI adds tokens we set.
 */
const REQUIRED = [
  "--background",
  "--foreground",
  "--surface",
  "--surface-foreground",
  "--overlay",
  "--overlay-foreground",
  "--muted",
  "--default",
  "--default-foreground",
  "--accent",
  "--accent-foreground",
  "--border",
  "--separator",
  "--focus",
  "--backdrop",
  "--field-background",
  "--field-foreground",
  "--success",
  "--warning",
  "--danger",
] as const;

/** The four theme blocks, by the selector that opens each one. */
const THEMES = [
  ":root {",
  ':root[data-theme="light"] {',
  ':root[data-theme="midnight"] {',
  ':root[data-theme="sand"] {',
] as const;

function blockFor(css: string, selector: string): string {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`theme block not found: ${selector}`);
  const end = css.indexOf("\n}", start);
  if (end < 0) throw new Error(`unterminated theme block: ${selector}`);
  return css.slice(start, end);
}

describe("tokens.css defines HeroUI variables for every theme", () => {
  const css = readFileSync(join(__dirname, "tokens.css"), "utf8");

  for (const selector of THEMES) {
    it(`${selector} defines all required HeroUI variables`, () => {
      const block = blockFor(css, selector);
      const missing = REQUIRED.filter((v) => !block.includes(`${v}:`));
      expect(missing).toEqual([]);
    });
  }
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents/control-plane
pnpm vitest run src/styles/tokens.test.ts
```

Expected: FAIL — four failing cases, each listing ~20 missing variables.

- [ ] **Step 3: Add HeroUI variables to the `:root` dark block**

In `control-plane/src/styles/tokens.css`, inside the existing `:root { … }` block,
after the current tokens and before `color-scheme: dark;`, add:

```css
  /* --- HeroUI semantic variables, defined from the tokens above --- */
  --background: var(--ground);
  --foreground: var(--text);
  --surface: var(--ground-2);
  --surface-foreground: var(--text);
  --overlay: var(--ground-2);
  --overlay-foreground: var(--text);
  --muted: var(--text-2);
  --default: var(--pill);
  --default-foreground: var(--text);
  --accent-foreground: #0b1020;
  --border: var(--pill-br);
  --separator: var(--rail-br);
  --focus: var(--accent);
  --backdrop: rgba(0, 0, 0, 0.6);
  --field-background: var(--pill);
  --field-foreground: var(--text);
  --field-placeholder: var(--text-dim);
  --field-border: var(--pill-br);
  --success: var(--online);
  --success-foreground: #04150e;
  --warning: #e8b64c;
  --warning-foreground: #1a1204;
  --danger: #e5484d;
  --danger-foreground: #fff1f1;
  --radius: 0.625rem;
  --border-width: 1px;
  --disabled-opacity: 0.5;
  --ring-offset-width: 2px;
```

`--accent` is **not** redefined — it already exists in every theme block, and HeroUI
derives `--accent-hover`, `--accent-soft`, and `--chart-1…5` from it automatically.

`--radius: 0.625rem` is 10px, matching the `border-radius: 10px` used throughout
`components.css` (`.map-story`, `.map-step__name`, `.modal`, `.chip`).

- [ ] **Step 4: Add the same variables to the three other theme blocks**

Repeat Step 3's block verbatim inside `:root[data-theme="light"]`,
`:root[data-theme="midnight"]`, and `:root[data-theme="sand"]`. Every `var(--…)` line
is copied unchanged — those resolve against whichever theme block is active. Only
these five hardcoded lines differ:

For **light** and **sand** (light grounds):
```css
  --accent-foreground: #ffffff;
  --success-foreground: #ffffff;
  --warning-foreground: #1a1204;
  --danger-foreground: #ffffff;
  --backdrop: rgba(0, 0, 0, 0.4);
```

For **midnight** (darker than default dark), use the same values as `:root`.

Every `var(--…)` reference resolves against whichever theme block is active, so the
`var()`-based lines are copied verbatim into all four.

Also add the same block to the `@media (prefers-color-scheme: light)` fallback at
line 33, using the light values — otherwise a user on system-light with no explicit
`data-theme` gets dark HeroUI components on a light ground.

- [ ] **Step 5: Run the test to verify it passes**

```bash
pnpm vitest run src/styles/tokens.test.ts
```

Expected: PASS — 4 passing cases. (5 blocks were edited; the `prefers-color-scheme`
fallback is covered by the visual smoke in Step 7, not by this test, because it is a
media query rather than a top-level selector.)

- [ ] **Step 6: Run the full suite**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Expected: all pass. Test count increases by exactly 4.

- [ ] **Step 7: Visual smoke**

Run `pnpm dev` and confirm all four themes still look identical to the Task 1
baseline screenshots. Nothing consumes these variables yet, so any visual change means
a token was accidentally overwritten rather than added.

Additionally, set the OS to light mode with no `data-theme` attribute and confirm the
`prefers-color-scheme` fallback renders light.

- [ ] **Step 8: Commit**

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents add \
  control-plane/src/styles/tokens.css control-plane/src/styles/tokens.test.ts
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents commit -m "feat: define heroui theme variables from tokens.css

tokens.css is now the definition of HeroUI's variables, not a system
beside them. --accent is left alone: HeroUI derives hover, soft, and the
chart series from it via color-mix.

The test exists because an omitted variable inherits :root's dark value,
which on light or sand renders dark-on-light and looks like a styling
opinion rather than a bug."
```

Verify the reported file count is **2**.

---

### Task 4: Canary — prove the pipeline end to end

**Files:**
- Create: `control-plane/src/atoms/HeroCanary.tsx`
- Create: `control-plane/src/atoms/HeroCanary.test.tsx`

**Interfaces:**
- Consumes: Task 1's pipeline, Task 3's variables.
- Produces: proof that a HeroUI component renders, is styled by the token bridge, and
  survives the jsdom test environment. **Deleted at the start of Phase 1** — its only
  job is to fail loudly here rather than midway through a real migration.

**Why this task exists:** Tasks 1–3 all pass with a completely broken HeroUI install,
because nothing imports HeroUI. Without a canary, the first real evidence that the
pipeline works arrives in the middle of Phase 1's workspace-creation migration, where
a pipeline bug is indistinguishable from a migration bug.

- [ ] **Step 1: Write the failing test**

Create `control-plane/src/atoms/HeroCanary.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HeroCanary } from "./HeroCanary";

describe("HeroCanary", () => {
  it("renders a HeroUI Button as an accessible button", () => {
    render(<HeroCanary />);
    expect(screen.getByRole("button", { name: "Canary" })).toBeInTheDocument();
  });

  it("applies HeroUI's BEM class, proving the stylesheet resolved", () => {
    const { container } = render(<HeroCanary />);
    expect(container.querySelector(".button")).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents/control-plane
pnpm vitest run src/atoms/HeroCanary.test.tsx
```

Expected: FAIL — `Cannot find module './HeroCanary'`.

- [ ] **Step 3: Write the component**

Create `control-plane/src/atoms/HeroCanary.tsx`:

```tsx
import { Button } from "@heroui/react";

/**
 * Phase 0 canary. Proves the HeroUI + Tailwind pipeline resolves and that the token
 * bridge feeds it. Delete this file and its test at the start of Phase 1 — the real
 * migrated surfaces replace its job.
 *
 * HeroUI v3 needs no provider, and uses onPress rather than onClick.
 */
export function HeroCanary() {
  return <Button>Canary</Button>;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm vitest run src/atoms/HeroCanary.test.tsx
```

Expected: PASS — 2 cases.

If the second case fails while the first passes, the component works but the
stylesheet did not resolve: re-check `heroui.css`'s `@import "@heroui/styles"` and
that `main.tsx` imports `heroui.css` first.

- [ ] **Step 5: Verify it renders in the real app, then remove the mount**

Temporarily render `<HeroCanary />` inside `src/App.tsx`. Run `pnpm dev` and confirm:
the button is visibly styled (not an unstyled native button), and its colors track
the theme — cycle `data-theme` through `light`, `midnight`, and `sand` and confirm the
button's background follows `--accent` in each.

A button that renders but ignores the theme means Task 3's variables are defined on a
selector HeroUI is not reading. Fix before proceeding.

Then **revert the `App.tsx` edit**. The canary stays in the tree as a tested component
but is not mounted.

- [ ] **Step 6: Run the full suite**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Expected: all pass. Test count increases by exactly 2 from Task 3.

- [ ] **Step 7: Confirm App.tsx is clean**

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents diff --stat control-plane/src/App.tsx
```

Expected: **no output**. Any diff means the temporary mount from Step 5 was not
reverted.

- [ ] **Step 8: Commit**

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents add control-plane/src/atoms/HeroCanary.tsx control-plane/src/atoms/HeroCanary.test.tsx
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents commit -m "test: add heroui pipeline canary

Tasks 1-3 all pass with a broken HeroUI install, because nothing imports
it. This fails loudly here instead of midway through Phase 1, where a
pipeline bug and a migration bug look identical.

Delete at the start of Phase 1."
```

Verify the reported file count is **2**.

---

## Phase 0 Done Criteria

- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm test` all pass from `control-plane/`.
- [ ] `grep -nE "^\.(chip|avatar|hidden)([ ,{:.]|$)" src/styles/components.css` → no output.
- [ ] All four themes render identical to the Task 1 baseline screenshots.
- [ ] A HeroUI `Button` renders styled and theme-tracking in the real app.
- [ ] The repo-root `package.json` / `package-lock.json` are still untracked and unmodified.
- [ ] No file outside `control-plane/` was changed.

## Next

Phase 1 begins with **workspace creation** (`NewWorkspaceModal`, `WorkspaceManagerModal`,
776 LOC) — form-heavy and identity-free, so it proves the react-hook-form ↔ react-aria
`Controller` seam before anything user-visible depends on it. Write that plan when
Phase 0 merges, not before: it should be informed by whatever Phase 0 taught about how
the beta behaves in this codebase.

Delete `HeroCanary.tsx` and `HeroCanary.test.tsx` as the first step of Phase 1.
