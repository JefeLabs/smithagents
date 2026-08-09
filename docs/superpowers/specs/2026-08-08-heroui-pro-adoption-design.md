# HeroUI Pro Adoption — Design

**Status:** Phase 0 in progress on branch `heroui-phase-0` (2026-08-09).
**Phases 1–3 are NOT approved to start.** Edwin deferred them pending (a) confirmation
of what a Pro seat entitles past beta, and (b) evidence the library is still shipping:
`@heroui-pro/react@1.0.0-beta.8` is the `latest` dist-tag and was published
2026-03-30 — over four months before this line was written, with no beta.9 and no
1.0.0. Risk 1 below was written assuming beta *churn*; the observed risk is closer to
*stagnation*, which makes Risk 4 the load-bearing question rather than a footnote.
**Claimed by:** unclaimed — claim this header before executing
**Date:** 2026-08-08
**Surface:** `control-plane/` — full view-layer migration

Migrate `control-plane` from hand-written global CSS to `@heroui-pro/react` +
`@heroui/react` on Tailwind v4, in four independently-shippable phases, ending with
`components.css` deleted.

---

## Starting state (verified 2026-08-08)

- `control-plane/package.json`: **zero** heroui/tailwind entries.
- `control-plane/src/`: **zero** heroui imports. 86 `.tsx`, ~16.5k LOC.
- `src/styles/components.css`: 2,896 lines, **235 root classes**, of which only 26 are
  single-word.
- `src/styles/tokens.css`: 65 tokens, **four** themes — default dark (`:root`),
  `[data-theme="light"]` (+ `prefers-color-scheme` fallback), `[data-theme="midnight"]`,
  `[data-theme="sand"]`.
- The untracked `package.json` + `package-lock.json` at **repo root** carrying
  `@heroui-pro/react@1.0.0-beta.8` is a **scratch install, not wired to anything**.
  It is not the target and must not be used.

---

## Decisions

Two decisions were taken against the recommendation in this document's brainstorm.
Recorded factually so a future reader knows they were deliberate, not overlooked:

1. **Full migration, not a beachhead.** Recommendation was to let HeroUI own three
   dense surfaces and leave the ambient shell hand-written permanently. Edwin chose
   full migration ending in `components.css` deleted.
2. **Phase 3 rebuilds identity surfaces on HeroUI primitives.** Recommendation was to
   restyle them to Tailwind with logic and appearance untouched. Edwin chose rebuilding
   `MicHero` / `VoiceStage` on `Surface` / `Card` / `Chip` / `Button`.

The risk carried by (2) is stated in *Risks* below and should be re-evaluated when
Phase 3 begins rather than treated as settled.

## Goals

1. One styling idiom across `control-plane`.
2. Accessibility from react-aria: focus traps, keyboard nav, and keyboard drag —
   `KeyboardSensor` count in the repo is currently **0**, so every drag surface is
   mouse-only today.
3. Capability the codebase lacks: markdown rendering, chain-of-thought, tool-call
   display in agent transcripts.

## Non-goals

- No change to `queries/`, `stores/`, `api/`, or any react-hook-form usage. This is a
  view-layer migration; the state stack landed in `aa0118a` / `bedf405` and stays.
- No redesign. Phases 0–2 preserve current appearance. Phase 3 is the only phase
  permitted to change how anything looks.
- No change to the atoms/molecules/organisms/templates/pages structure.

---

## Architecture: the token bridge

HeroUI derives aggressively — `--accent-hover`, `--accent-soft`, `--chart-1…5` are all
`color-mix()` / `oklch(from …)` off `--accent`. Setting one variable yields the family.

Therefore this is **not two token systems**. `tokens.css` becomes the definition of
HeroUI's variables, speaking two vocabularies from the same selectors:

| `tokens.css` today | → HeroUI variable | Note |
|--------------------|-------------------|------|
| `--ground`         | `--background`    | direct |
| `--ground-2`       | `--surface`, `--overlay` | direct |
| `--text`           | `--foreground`    | direct |
| `--text-2`         | `--muted`         | direct |
| `--accent`         | `--accent`        | derives hover / soft / chart series free |
| `--pill`           | `--default`       | |
| `--pill-br`        | `--border`        | |
| `--rail-br`        | `--separator`     | |
| `--online`         | `--success`       | |
| `--text-dim`       | *(none)*          | no HeroUI equivalent; stays custom |
| `--bloom`          | *(none)*          | identity token, stays custom permanently |
| `--dot`, `--dot-hi`| *(none)*          | identity tokens, stay custom permanently |

HeroUI variables with no current equivalent (`--radius`, `--border-width`,
`--disabled-opacity`, `--ring-offset-width`, `--field-*`, `--warning`, `--danger`,
`--backdrop`, `--scrollbar`, `--segment`) are added to each theme block with values
chosen to match today's rendered appearance.

**All four themes survive unchanged, including `midnight` and `sand`.** HeroUI's
variables are plain custom properties with no switching mechanism of their own, so
`:root[data-theme="midnight"]` simply sets more of them. Extra themes are not a HeroUI
feature to find — they are selectors already written.

Every theme block must define the **full** HeroUI variable set. A theme that defines
only some inherits the rest from `:root` (dark), which silently produces unreadable
light-on-light or dark-on-dark components. Task 3 of the Phase 0 plan enforces this
with a test rather than review discipline.

---

## Verified collision set

HeroUI namespaces almost everything as `block__element`, so only bare single-word
**block** names are exposed. Of 235 root classes in `components.css`, 26 are
single-word and exactly three collide:

| Class     | CSS rules | `.tsx` files | Collides with |
|-----------|-----------|--------------|---------------|
| `.chip`   | 3         | 6            | HeroUI OSS bare `.chip` — confirmed |
| `.avatar` | 18        | 8            | HeroUI OSS bare `.avatar` — confirmed |
| `.hidden` | 1         | 4            | Tailwind v4 core utility |

**Non-collisions, verified:** `.modal` (HeroUI defines only `.modal__trigger`,
`.modal__backdrop`, `.modal__dialog`, … — never a bare `.modal`) and `.field`
(no bare `field` component exists; it is `input` + `label` + `description` composed).

Fix: rename to `.sm-chip`, `.sm-avatar`, `.sm-hidden`. ~18 file touches.

---

## Phases

Phase 0 gates everything. Phases 1–3 are independently shippable, and **the migration
is abandonable after any phase** — this is the hedge against a `1.0.0-beta.8`
dependency, and it must not be traded away for convenience.

**Implementation plans are written per phase, not for the whole migration.** A single
plan spanning four phases would be stale before Phase 1 finished, and Phase 2/3 task
breakdowns depend on what Phases 0/1 teach about how the library behaves in this
codebase. Write the Phase 0 plan now; write each later phase's plan when its
predecessor merges.

### Phase 0 — Foundation

1. Add `@heroui-pro/react`, `@heroui/react`, `@heroui/styles`, `tailwindcss@4`,
   `react-aria-components` to **`control-plane/package.json` via pnpm**. Never the
   root npm island.
2. Tailwind v4 setup + HeroUI stylesheet import.
3. Declare cascade layers so ordering is deterministic regardless of import order:
   `@layer legacy, heroui, overrides;` with `components.css` in `legacy`.
4. Token bridge: extend all three theme blocks in `tokens.css` with HeroUI variables.
5. Rename the three colliding classes.
6. A throwaway canary component importing one HeroUI `Button`. Steps 1–5 all pass with
   a completely broken install, because nothing imports HeroUI — the canary makes that
   fail here rather than midway through Phase 1, where a pipeline bug and a migration
   bug are indistinguishable. Deleted at the start of Phase 1.
7. Verify: `pnpm typecheck`, `pnpm lint`, `pnpm test` all green, app renders
   pixel-identical. No production component uses HeroUI yet.

### Phase 1 — Dense surfaces

| Surface | Files | LOC | HeroUI components |
|---|---|---|---|
| Workspace creation | `NewWorkspaceModal`, `WorkspaceManagerModal` | 776 | `stepper`, `form`, `input`, `label`, `radio-button-group` (replaces `SegmentedControl`), `color-swatch-picker` (replaces `WORKSPACE_PALETTE`), `drop-zone`, `modal`/`sheet` |
| Chat sessions | `SessionsPanel`, `Transcript`, `Composer`, `NewSessionScreen` | 527 | `ChatConversation`, `ChatMessage`, `Markdown`, `ChainOfThought`, `chat-tool`, `chat-message-actions`, `code-block`, `PromptInput` |
| Kanban | `BoardStage`, `BoardColumn`, `BoardCard`, `BoardTabs`, `CardSheet` | 985 | `kanban` (RAC `GridList` + `dragAndDropHooks`, `useKanban`, `useKanbanColumn`, `Kanban.DragHandle`, `dragType`) |

Order within the phase: **workspace creation first** — it is form-heavy and
identity-free, so it proves the RHF ↔ react-aria `Controller` seam before anything
user-visible depends on it. Then chat, then kanban.

Chat is the only surface gaining capability rather than swapping implementations:
`Transcript.tsx` is 53 lines and there is no markdown renderer anywhere in `src/`.

Kanban carries two specific hazards:
- Business rules live in `onDragEnd` — personal-first drag, and capability refs
  resolved by `cardId` never `boardId`. HeroUI's model is `dragType` + key transfer,
  so these need deliberate re-homing, not a copy-paste.
- dnd-kit stays in the repo for `AgentRoster`. Two drag systems coexist until Phase 2.

### Phase 2 — Remaining application surfaces

`SettingsPanel` + `organisms/settings/*`, `WorkStage`, `AgentRoster` (retires the last
dnd-kit usage), `SessionsPanel` rail, `ToolRail`, `AddAgentModal`, `AddAgentChooser`,
`ConfirmSheet`, `SurfacePolicyPopover`, and the remaining atoms/molecules.

**Coordination with the story map:** `MapStage` migrates to xyflow under
`docs/superpowers/specs/2026-08-08-story-map-canvas-design.md`. If that work starts
**after** Phase 0, write the new `organisms/map/*` components in Tailwind directly —
otherwise they are written in `components.css` idiom and immediately rewritten here.
The `.map-*` classes are Phase 2 work only if the xyflow migration has not already
retired them.

### Phase 3 — Identity surfaces

`MicHero` → `Surface` + `Button` + custom. `VoiceStage` → `Card` + `Chip` + custom.
`DotGridCanvas` stays custom (it is canvas drawing; no library replaces it).
`--bloom`, `--dot`, `--dot-hi` remain custom tokens permanently.

Ends with `components.css` deleted and the `legacy` cascade layer removed.

This phase is the one permitted to change appearance, and the one most likely to
regret it. See *Risks*.

---

## Testing

**13 of 36 test files query by class name** — `main.work-stage`,
`.board-column__cluster-name`, `.transcript__notice`, `.roster-host`. Deleting
`components.css` breaks every one.

De-coupling is migration work, not cleanup. In each phase, before touching a
component's markup, convert its tests to role/label/text queries
(`getByRole`, `getByLabelText`). This is the testing-library idiom regardless, and it
makes the tests survive the restyle that follows.

Per phase:
- `pnpm typecheck`, `pnpm lint`, `pnpm test` green before the phase is called done.
- Phases 0–2 additionally require **visual parity**, verified by manual smoke against
  a before-screenshot of each migrated surface in all four themes (dark, light,
  midnight, sand). Screenshots go in `.screenshots/`, which already exists. Phase 3
  does not require parity.
- Kanban requires a keyboard-drag check: select a card, move it with the keyboard,
  confirm the mutation fires. This is new capability, so it needs a new test.

## Rollback

Each phase is a separate branch merged independently. Abandoning after any phase
leaves a working app in a documented hybrid state — `components.css` still present,
cascade layers still ordering correctly. Nothing in Phases 0–2 requires Phase 3 to
happen.

---

## Risks

1. **`@heroui-pro/react` is `1.0.0-beta.8`.** A full migration ends with a pre-1.0 paid
   library owning 100% of the view layer. The phase structure is the mitigation and
   must be preserved — do not collapse phases for speed.
2. **Phase 3 identity loss.** Rebuilding `MicHero` and `VoiceStage` on HeroUI
   primitives means HeroUI's radius, shadow, and spacing scales govern the ambient
   surfaces that give the product its look. The likeliest bad outcome of this whole
   migration is a Phase 3 that ships and feels generic. Re-evaluate this decision when
   Phase 3 starts, with Phases 0–2 as evidence for how well the token bridge held the
   aesthetic.
3. **Two drag systems between Phase 1 and Phase 2.** HeroUI kanban and dnd-kit
   (`AgentRoster`) coexist. Acceptable but must be deliberate; do not let a third
   pattern appear.
4. **License terms unverified.** Whether updates past beta are included in the Pro
   seat is unconfirmed and should be checked before Phase 1 begins, since Phases 1–3
   assume continued releases.
