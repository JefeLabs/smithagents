# Artifact Launcher — Plan 3: Composer Unification (the ChatDock)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two duplicated chat boxes (`VoiceStage`'s and `DocRoute`'s) with **one persistent `ChatDock`** — transcript + composer — mounted once in the app shell, that repositions by route (`full` on `/`, `dock` on canvas/doc routes, `center` on dashboards, `hidden` on board/work) and never unmounts, so draft/mic/focus/scroll survive navigation.

**Architecture:** A pure `layoutForPath(pathname)` maps the route to a `ComposerVariant`. `HomePage` wires the chat's broker deps once and mounts `<ChatDock variant>` in a new `ControlPlaneLayout` slot inside `Sidebar.Main`, a sibling of `{stage}`. `ChatDock` absorbs `VoiceStage`'s hero/transcript/composer JSX; the composer's kind control renders as buttons in `full`/`center` and as a `<select>` in `dock`. `VoiceStage`/`VoiceRoute` retire; `DocumentStage` loses its `chat` prop and Resizable split, becoming document-only like `DiagramStage`.

**Tech Stack:** React 19 + TanStack Router/Query + zustand + HeroUI v3, vitest + Testing Library, biome 2.5.3, **unified pnpm workspace at root**.

## Global Constraints

- **Repo:** paths relative to the **smithagents** repo root. Execute in a **fresh worktree off `origin/main`** (branch `feat/composer-unification`) — Plan 2 already merged to main @ `ed23995`; `develop` is deleted, main is the only branch. `git -C`. Merge at the end by push-fast-forward to `main` (`git push origin HEAD:main` under the `ecruz165` account, then switch back to `edwin-skoolscout`), never in the shared checkout (the control-plane is live in `smith-cp-dev`).
- **Unified pnpm workspace:** `pnpm install` once at root. CP tests from `control-plane`: `pnpm test` (vitest), `pnpm exec tsc --noEmit`, `pnpm lint` (biome; exit 0 is clean — a non-zero exit is your own regression, see the two pre-existing warning files below), `pnpm build`.
- **HeroUI compound API is verified via the heroui-pro MCP before use — LAW.** `onPress` not `onClick` for HeroUI controls (plain `<button>`s use `onClick`).
- **CSS never touches `components.css`** (parallel-agent hazard — that file's own header says so). New chat-dock rules go in a **new `control-plane/src/styles/chatdock.css`**, imported in `heroui.css` as `layer(legacy)` beside `documents.css`.
- **Pre-existing lint warnings (NOT yours):** `Composer.tsx:13` + `VoiceStage.tsx:14` `noConfusingVoidType`; `IntegrationsGroup.test.tsx` + `VoiceGroup.test.tsx` `noNonNullAssertion`. Lint exits 0 with these 8 warnings. Retiring `VoiceStage.tsx` removes one of them — fine.
- **Depends on:** Plan 1 (`ArtifactKind`, `ARTIFACT_KINDS`, `familyForKind`, kind row) and Plan 2 (`DiagramStage` chat-free, `/diagram` route) — both shipped to main.
- Spec: `docs/superpowers/specs/2026-08-11-composer-artifact-launcher-design.md` — the **"Revision (2026-08-11): Composer unification — the ChatDock"** section at the end is authoritative for this plan.
- **Out of scope (→ Plan 3b):** full-screen focus mode (Esc, hide nav/rails, zoom-panel reposition). This plan is the lift + reposition + buttons→select ONLY.

## File structure

- Create: `control-plane/src/lib/composerLayout.ts` (+ test) — pure route→variant/kind maps.
- Modify: `control-plane/src/molecules/Composer.tsx` (+ test) — `kindControl` prop (buttons | select).
- Create: `control-plane/src/organisms/ChatDock.tsx` (+ test) — the persistent unit; absorbs VoiceStage's JSX.
- Modify: `control-plane/src/templates/ControlPlaneLayout.tsx` — new `chatDock` slot inside `Sidebar.Main`.
- Modify: `control-plane/src/pages/HomePage.tsx` (+ `HomePage.test.tsx`) — wire deps once, mount ChatDock, gate visibility.
- Modify: `control-plane/src/router.tsx` (+ `router.test.tsx`) — `VoiceRoute` renders `null`; `DocRoute` drops its composer.
- Modify: `control-plane/src/organisms/DocumentStage.tsx` (+ test) — drop `chat` prop + Resizable split (document-only).
- Delete: `control-plane/src/organisms/VoiceStage.tsx` (+ `VoiceStage.test.tsx`).
- Create: `control-plane/src/styles/chatdock.css`; Modify: `control-plane/src/styles/heroui.css` (import), `control-plane/src/styles/documents.css` (drop `.document-stage__chat`/`__dock*` rules now unused).

---

### Task 1: `layoutForPath` + `kindForPath` — pure route maps

**Files:**
- Create: `control-plane/src/lib/composerLayout.ts`
- Test: `control-plane/src/lib/composerLayout.test.ts`

**Interfaces (later tasks rely on these):**
```ts
export type ComposerVariant = "full" | "dock" | "center" | "hidden";
export function layoutForPath(pathname: string): ComposerVariant;
export function kindForPath(pathname: string): ArtifactKind; // which kind the dock highlights
```

- [ ] **Step 1: Write the failing test**
```ts
// control-plane/src/lib/composerLayout.test.ts
import { describe, expect, it } from "vitest";
import { kindForPath, layoutForPath } from "./composerLayout";

describe("layoutForPath", () => {
  it("/ is the full centerpiece", () => expect(layoutForPath("/")).toBe("full"));
  it("documents, diagrams and maps dock right", () => {
    expect(layoutForPath("/doc/d1")).toBe("dock");
    expect(layoutForPath("/diagram/d1")).toBe("dock");
    expect(layoutForPath("/map")).toBe("dock");
  });
  it("dashboards centers", () => expect(layoutForPath("/dashboards")).toBe("center"));
  it("board and work hide the chat", () => {
    expect(layoutForPath("/board")).toBe("hidden");
    expect(layoutForPath("/work/ignacio")).toBe("hidden");
  });
});

describe("kindForPath", () => {
  it("maps each surface to its kind", () => {
    expect(kindForPath("/")).toBe("chat");
    expect(kindForPath("/doc/d1")).toBe("documents");
    expect(kindForPath("/diagram/d1")).toBe("diagrams");
    expect(kindForPath("/map")).toBe("map");
    expect(kindForPath("/dashboards")).toBe("dashboards");
    expect(kindForPath("/board")).toBe("chat"); // hidden dock still needs a valid default
  });
});
```
- [ ] **Step 2: Run to verify fail** — `pnpm exec vitest run src/lib/composerLayout.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement**
```ts
// control-plane/src/lib/composerLayout.ts
import type { ArtifactKind } from "./artifactKinds";

export type ComposerVariant = "full" | "dock" | "center" | "hidden";

/** The chat box repositions by route; the URL is the single source of truth. */
export function layoutForPath(pathname: string): ComposerVariant {
  if (pathname === "/") return "full";
  if (pathname === "/dashboards") return "center";
  if (pathname.startsWith("/doc/") || pathname.startsWith("/diagram/") || pathname === "/map") return "dock";
  return "hidden"; // /board, /work/$agent, and anything unrouted
}

/** Which kind the dock highlights on each surface. */
export function kindForPath(pathname: string): ArtifactKind {
  if (pathname.startsWith("/doc/")) return "documents";
  if (pathname.startsWith("/diagram/")) return "diagrams";
  if (pathname === "/map") return "map";
  if (pathname === "/dashboards") return "dashboards";
  return "chat";
}
```
- [ ] **Step 4: Run to verify pass** — both suites green; `pnpm exec tsc --noEmit` clean.
- [ ] **Step 5: Commit** — `git commit -m "feat(cp): layoutForPath/kindForPath — route drives the composer's position"`

---

### Task 2: Composer kind control — buttons | select

**Files:**
- Modify: `control-plane/src/molecules/Composer.tsx` (add `kindControl` prop)
- Create: `control-plane/src/styles/chatdock.css` (the select rule; wire the import in Task 6's CSS or here)
- Test: `control-plane/src/molecules/Composer.test.tsx` (append)

**Interfaces:**
- Produces: `ComposerProps.kindControl?: "buttons" | "select"` (default `"buttons"`). `"buttons"` renders today's `composer__kind-group`. `"select"` renders a HeroUI `Select` of `ARTIFACT_KINDS` whose `onChange` calls `onPickKind(kind)`, `value={activeKind}`, `aria-label="Artifact kind"`. Only renders when `onPickKind` is wired.

- [ ] **Step 1: Verify the HeroUI Select compound API via the heroui-pro MCP** (`get_component_docs` for `Select`) — the composer already uses `Select`/`ListBox`/`Select.Trigger`/`Select.Value`/`Select.Popover` (lines 216-271); mirror that exact shape. LAW: confirm before writing.
- [ ] **Step 2: Write the failing tests**
```tsx
// append to control-plane/src/molecules/Composer.test.tsx
it("kindControl=select renders a kind picker that fires onPickKind", async () => {
  const onPickKind = vi.fn();
  render(<Composer onSend={vi.fn()} onPickKind={onPickKind} activeKind="documents" kindControl="select" />);
  const select = screen.getByRole("button", { name: /artifact kind/i }); // HeroUI Select.Trigger is a button
  await userEvent.click(select);
  await userEvent.click(await screen.findByRole("option", { name: "Diagrams" }));
  expect(onPickKind).toHaveBeenCalledWith("diagrams");
});
it("kindControl defaults to the button group", () => {
  render(<Composer onSend={vi.fn()} onPickKind={vi.fn()} activeKind="chat" />);
  expect(screen.getByRole("group", { name: /artifact kind/i })).toBeInTheDocument();
});
```
(Match the existing Composer.test.tsx imports — `render`, `screen`, `userEvent`, `vi`. If the file mocks `PromptInput`, keep that mock; the Select lives inside the same Shell.)
- [ ] **Step 3: Run to verify fail** — the select test FAILS (no such control).
- [ ] **Step 4: Implement.** Add `kindControl = "buttons"` to the destructured props (after `activeKind`). Replace the `{onPickKind && (…button group…)}` block (lines 150-168) with a branch:
```tsx
{onPickKind &&
  (kindControl === "select" ? (
    <Select
      className="composer__kind-select"
      aria-label="Artifact kind"
      value={activeKind}
      onChange={(key) => onPickKind(String(key) as ArtifactKind)}
    >
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {ARTIFACT_KINDS.map((k) => (
            <ListBox.Item key={k.kind} id={k.kind} textValue={k.label}>
              {k.label}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  ) : (
    // biome-ignore lint/a11y/useSemanticElements: a nav row, not a form fieldset
    <div className="composer__kind-group" role="group" aria-label="artifact kind">
      {ARTIFACT_KINDS.map((k) => (
        <button
          key={k.kind}
          type="button"
          className={`composer__kind${activeKind === k.kind ? " composer__kind--on" : ""}`}
          aria-pressed={activeKind === k.kind}
          onClick={() => onPickKind(k.kind)}
        >
          {k.label}
        </button>
      ))}
    </div>
  ))}
```
Add `.composer__kind-select` to `chatdock.css` (a toolbar-height Select, no field chrome — mirror `.composer .selector .select__trigger`).
- [ ] **Step 5: Run to verify pass** — new + existing Composer tests green; `pnpm exec tsc --noEmit` clean.
- [ ] **Step 6: Commit** — `git commit -m "feat(cp): composer kind control switches between buttons and a select"`

---

### Task 3: `ChatDock` — transcript + composer as one unit

**Files:**
- Create: `control-plane/src/organisms/ChatDock.tsx`, `control-plane/src/organisms/ChatDock.test.tsx`

**Interfaces:**
```ts
import type { ComposerVariant } from "../lib/composerLayout";
export interface ChatDockProps {
  variant: Exclude<ComposerVariant, "hidden">; // "full" | "dock" | "center"
  messages: ChatMessage[];
  onSend: ComposerProps["onSend"];
  targets?: RosterAgent[];
  brokerConnected: boolean;
  micLive: boolean;
  onMicToggle: () => void;
  soundOn: boolean;
  onSoundToggle: () => void;
  sttEnabled?: boolean;
  onVoiceBlocked?: () => void;
  showMicHero?: boolean;      // the `/` empty-hero MicHero; false hides it AND the composer mic buttons
  voiceNotice?: string | null;
  onPolish?: ComposerProps["onPolish"];
  onPickKind?: (kind: ArtifactKind) => void;
  activeKind?: ArtifactKind;
  shelf?: ReactNode;          // only rendered in the "full" variant
}
export function ChatDock(props: ChatDockProps): JSX.Element;
```
Renders `<section className={`chat-dock chat-dock--${variant}`} aria-label="Chat">`. `full` reproduces `VoiceStage`'s body: the `shelf`, the hero-intro ("The mic is yours, Edwin" + `MicHero`) when `messages.length === 0`, else the `Transcript`; then the composer with `kindControl="buttons"`. `dock`/`center`: the `Transcript` above the composer (no hero), `kindControl={variant === "dock" ? "select" : "buttons"}`. The composer's mic props follow the same `showMicHero` gate VoiceStage used.

- [ ] **Step 1: Write the failing tests**
```tsx
// control-plane/src/organisms/ChatDock.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatDock } from "./ChatDock";

const base = {
  onSend: vi.fn(), brokerConnected: true, micLive: false, onMicToggle: vi.fn(),
  soundOn: true, onSoundToggle: vi.fn(), onPickKind: vi.fn(),
} as const;

describe("ChatDock", () => {
  it("full + empty shows the mic hero", () => {
    render(<ChatDock variant="full" messages={[]} activeKind="chat" {...base} />);
    expect(screen.getByRole("region", { name: "Chat" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /the mic is yours/i })).toBeInTheDocument();
  });
  it("dock uses the select kind control, not the button group", () => {
    render(<ChatDock variant="dock" messages={[{ id: 1, role: "user", text: "hi" }]} activeKind="documents" {...base} />);
    expect(screen.queryByRole("group", { name: /artifact kind/i })).toBeNull();
    expect(screen.getByRole("button", { name: /artifact kind/i })).toBeInTheDocument();
  });
  it("dock does not show the hero", () => {
    render(<ChatDock variant="dock" messages={[]} activeKind="documents" {...base} />);
    expect(screen.queryByRole("heading", { name: /the mic is yours/i })).toBeNull();
  });
});
```
- [ ] **Step 2: Run to verify fail** — FAIL (module missing).
- [ ] **Step 3: Implement `ChatDock.tsx`** by moving `VoiceStage`'s JSX in and generalizing it: keep the `AnimatePresence` hero↔log for `full`; for `dock`/`center` render `<Transcript>` unconditionally above the composer; pass `kindControl` per variant; render `shelf` only when `variant === "full"`. Reuse `MicHero`, `Transcript`, `Composer`. Keep the greeting literal ("The mic is yours, Edwin") as-is.
- [ ] **Step 4: Run to verify pass** — 3 tests green; `pnpm exec tsc --noEmit` clean.
- [ ] **Step 5: Commit** — `git commit -m "feat(cp): ChatDock — transcript + composer, one unit, three variants"`

---

### Task 4: Lift ChatDock into the shell; retire VoiceStage

**Files:**
- Modify: `control-plane/src/templates/ControlPlaneLayout.tsx` (new `chatDock` slot)
- Modify: `control-plane/src/pages/HomePage.tsx` (wire deps, mount, gate) + `HomePage.test.tsx`
- Modify: `control-plane/src/router.tsx` (`VoiceRoute` → `null`) + `router.test.tsx`
- Delete: `control-plane/src/organisms/VoiceStage.tsx` + `VoiceStage.test.tsx`

**Interfaces:**
- `ControlPlaneLayoutProps` gains `chatDock?: ReactNode`, rendered inside `Sidebar.Main` after `{stage}`.
- `HomePage` computes `variant = layoutForPath(pathname)`, and renders the dock only when `variant !== "hidden"` **and** not `composerVisible` (session-birth owns the screen). It wires: `messages` (`useTranscript`), `onSend: api.postUtterance`, `targets: roster`, `brokerConnected: connected`, mic/sound from `audioStore`, `sttEnabled`/`onVoiceBlocked`, `showMicHero: !hideMic`, `onPolish: api.polishDraft`, `onPickKind: makePickKind(...)` (export it from `router.tsx` or lift it to a shared module), `activeKind: kindForPath(pathname)`, and `shelf` (the `shelfDocs`→`ArtifactShelf` currently built in `VoiceRoute`, with the family-aware `onOpen` from Plan 2).

- [ ] **Step 1: Write the failing tests** (extend `HomePage.test.tsx`)
```tsx
it("mounts the chat dock on / and hides it on /board", async () => {
  // render at "/" (seed a session so the birth screen is not forced)
  renderHome("/", seedActiveSession);
  expect(await screen.findByRole("region", { name: "Chat" })).toBeInTheDocument();
  // navigate to /board
  await userEvent.click(screen.getByRole("row", { name: /^board$/i }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "Chat" })).toBeNull());
});
```
(Use the file's existing render helper + session-seeding pattern; grep `HomePage.test.tsx` for how it seeds `qk.session`/roster and how it drives the rail. If HomePage.test lacks a router, add the dock assertion to `router.test.tsx` instead, where `renderAt` exists.)
- [ ] **Step 2: Run to verify fail** — FAIL (no dock in the shell yet; `/` still renders VoiceStage's "Voice" region).
- [ ] **Step 3: Implement.**
  1. `ControlPlaneLayout`: add `chatDock?: ReactNode` to props and render `{chatDock}` inside `Sidebar.Main`, after `{stage}`.
  2. `HomePage`: add the wiring above; build the dock element; pass it to `chatDock`. Gate: `const variant = layoutForPath(pathname); const dockVisible = variant !== "hidden" && !composerVisible;` render `dockVisible ? <ChatDock variant={variant} .../> : null`.
  3. `router.tsx`: `VoiceRoute` becomes `function VoiceRoute() { return null; }` (the dock covers `/` over the dot-grid) and drops all the now-shell-owned wiring; remove the `VoiceStage` import + the `shelf`/composer props. Keep the route registered.
  4. Delete `VoiceStage.tsx` + `VoiceStage.test.tsx`.
  5. Update `router.test.tsx`: the "renders the voice stage at /" test now asserts the **Chat** region (or move that assertion to HomePage.test). The Documents/Diagrams **kind-click** tests still pass — `onPickKind` now lives on the shell dock, but the buttons render the same; if those tests relied on VoiceStage rendering the composer, ensure the dock renders at `/` in the test's seeded state (a session seeded so the birth screen isn't forced).
- [ ] **Step 4: Run to verify pass** — `HomePage.test.tsx`, `router.test.tsx` green; whole CP suite green; `pnpm exec tsc --noEmit` clean.
- [ ] **Step 5: Commit** — `git commit -m "feat(cp): one persistent ChatDock in the shell; retire VoiceStage"`

---

### Task 5: DocRoute drops its composer; DocumentStage is document-only

**Files:**
- Modify: `control-plane/src/organisms/DocumentStage.tsx` (drop `chat` prop + Resizable split) + `DocumentStage.test.tsx`
- Modify: `control-plane/src/router.tsx` (`DocRoute` stops composing a chat dock)
- Modify: `control-plane/src/styles/documents.css` (remove `.document-stage__chat`, `__dock`, `__dock-rise`, `__split` chat rules) + `chatdock.css` (dock overlay on canvas/doc routes)

**Interfaces:** `DocumentStageProps` loses `chat: ReactNode`. The stage renders a single document column; the shell's `dock`-variant ChatDock provides chat on `/doc/$id`.

- [ ] **Step 1: Write the failing test** (edit `DocumentStage.test.tsx`) — render `DocumentStage` **without** a `chat` prop and assert it still shows the document region and sections, and that there is no second composer inside it. If the current test passes `chat={<div data-testid="dock"/>}`, change it to assert `screen.queryByTestId("dock")` is irrelevant/removed and the prop is gone from the type.
```tsx
it("renders document-only (chat is the shell's, not the stage's)", () => {
  render(<DocumentStage doc={DOC} blueprints={BPS} onSaveSection={vi.fn().mockResolvedValue({})} />);
  expect(screen.getByRole("region", { name: "Document" })).toBeInTheDocument();
});
```
- [ ] **Step 2: Run to verify fail** — FAIL (TS: `chat` is a required prop; test omits it).
- [ ] **Step 3: Implement.** Remove `chat` from `DocumentStageProps` and the destructure; delete the `Resizable`/`Resizable.Panel`/`Resizable.Handle` chat column (DocumentStage.tsx:55-161 → keep only the document panel, now full-width like `DiagramStage`). In `DocRoute` (`router.tsx`), delete the `chat={…Transcript+Composer…}` prop and the now-unused local wiring (messages/mic/sound/etc. that only fed that composer). Remove the dead CSS from `documents.css`.
- [ ] **Step 4: Run to verify pass** — `DocumentStage.test.tsx`, `router.test.tsx`, whole suite green; `tsc` clean; `pnpm lint` exit 0.
- [ ] **Step 5: Commit** — `git commit -m "feat(cp): DocumentStage is document-only; the shell dock owns chat on /doc"`

---

### Task 6: Variant CSS + import wiring

**Files:**
- Create: `control-plane/src/styles/chatdock.css`
- Modify: `control-plane/src/styles/heroui.css` (add `@import "./chatdock.css" layer(legacy);` beside `documents.css`)

- [ ] **Step 1: Implement `chatdock.css`.** Three variants, using existing tokens (`--ground-2`, `--rail-br`, `--pill-br`, `--text`, `--accent`):
  - `.chat-dock--full` — the current `.stage`/`.composer-dock` centered treatment (lift the relevant rules from `components.css`'s voice-stage block by COPYING, not moving — do not edit components.css; if a rule must be shared, re-declare it here scoped to `.chat-dock--full`).
  - `.chat-dock--dock` — `position: fixed; right: 0; top: <navbar>; bottom: 0; width: min(34vw, 420px);` a right column over the canvas; transcript scrolls, composer pinned at the bottom. The canvas/doc stages need `padding-right` to clear it (add `.stage.document-stage`, `.stage.diagram-stage`, `.stage[aria-label="Story map"]` a right inset **only when a dock is present** — simplest: a `body`/layout class toggled by variant, or a `--dock-w` custom property the stages read; keep it minimal, Plan 3b refines).
  - `.chat-dock--center` — mid-screen max-width column (Plan 4 details; here just center it so dashboards is usable).
  - `.composer__kind-select` — toolbar-height Select, no field chrome.
- [ ] **Step 2: Verify** — `pnpm build` exit 0; visually confirm in Task 7's smoke. `pnpm lint` exit 0.
- [ ] **Step 3: Commit** — `git commit -m "feat(cp): chat-dock variant styles (full/dock/center)"`

---

### Task 7: Full suite + build + smoke

- [ ] **Step 1:** `cd control-plane && pnpm test` (whole suite green — re-run once if the known MapStage/NewWorkspaceModal parallelism flake appears), `pnpm exec tsc --noEmit` clean, `pnpm lint` exit 0 (7 pre-existing warnings now — VoiceStage's went away with the file), `pnpm build` exit 0. `cd broker && pnpm test` (unchanged, still green).
- [ ] **Step 2: Manual smoke (record evidence).** With the app running: on `/` the ChatDock is the full centerpiece (hero when empty, transcript when active); type a draft, then click **Documents** → the SAME box is now docked right with the kind control as a **select**, and the draft text is still there; switch to **Diagrams** via the select → docks stay, box persists; go to **Dashboards** → box centers; go to a **board** → box hides; back to `/` → box returns full with draft intact. The mic hero shows only on `/` empty. Record what persisted across navigations (the whole point).
- [ ] **Step 3:** Commit any smoke-found fixes with their own tests.

---

## Self-review notes
- **Spec coverage (revision section):** one persistent ChatDock (Tasks 3-4) ✓; router-driven `layoutForPath` (Task 1) ✓; variants full/dock/center/hidden (Tasks 1, 6) ✓; buttons→select on dock (Task 2) ✓; VoiceStage retired + DocRoute composer removed + DocumentStage document-only (Tasks 4-5) ✓; coverage excludes board/work + session-birth (Task 4 gate) ✓. Full-screen is explicitly Plan 3b (not here).
- **The `onSend`/send contract is untouched** — the same `Composer` submit path, just mounted once. `postUtterance` wiring moves from route to shell verbatim.
- **Type consistency:** `ComposerVariant` and `kindControl: "buttons" | "select"` used identically across tasks; `ChatDock.variant` excludes `"hidden"` (the shell renders `null` instead of a hidden dock).
- **Risk:** HomePage/router tests are the largest surface. If wiring the dock at the shell breaks a kind-click test that assumed VoiceStage, the fix is to seed a session so the birth screen isn't forced and the dock renders at `/` (Task 4 Step 3.5).

## Next plan
- **3b. Full-screen focus mode** — `uiStore.fullscreen` + Esc, hide nav/rails, shrink the dock, reposition the canvas zoom panel clear of the dock (Diagrams + Maps).
- **4. Dashboards centered layout** — the `center` variant's priority-card layout above the mid-screen chat.
