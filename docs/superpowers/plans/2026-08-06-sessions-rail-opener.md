# Sessions Rail Opener Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore a UI opener for the SessionsPanel: a Sessions tool (lucide `History`) on the left rail, toggling the panel.

**Architecture:** Purely additive UI wiring — a second entry in ToolRail's `TOOLS` array with a new optional `onSessions` prop, and a one-line HomePage pass-through to the existing `setSessionsOpen` state. No panel, CSS, or atom changes.

**Tech Stack:** React 19, lucide-react, vitest + RTL + userEvent (control-plane = **pnpm**, never npm).

**Spec:** `docs/superpowers/specs/2026-08-06-sessions-rail-opener-design.md`

## Global Constraints

- All commands from `control-plane/`: `pnpm exec vitest run <file>`, `pnpm typecheck`, `pnpm exec biome check src` (5 pre-existing warnings in IntegrationsGroup.test.tsx are known; no new ones).
- Tests use plain vitest matchers — no jest-dom.
- Exact strings: tool label `Sessions`; icon lucide `History`; toggle semantics (`setSessionsOpen((open) => !open)`).
- Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Sessions tool on the rail

**Files:**
- Modify: `control-plane/src/organisms/ToolRail.tsx`
- Modify: `control-plane/src/pages/HomePage.tsx:148`
- Test: `control-plane/src/organisms/ToolRail.test.tsx`

**Interfaces:**
- Produces: `ToolRailProps` gains `onSessions?: () => void`. HomePage is the only consumer.

- [ ] **Step 1: Write the failing test**

Add to `control-plane/src/organisms/ToolRail.test.tsx` inside the existing `describe`:

```tsx
  it("sessions tool fires onSessions", async () => {
    const onSessions = vi.fn();
    render(<ToolRail onSessions={onSessions} />);
    await userEvent.click(screen.getByRole("button", { name: /sessions/i }));
    expect(onSessions).toHaveBeenCalledTimes(1);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd control-plane && pnpm exec vitest run src/organisms/ToolRail.test.tsx`
Expected: new test FAILS ("Unable to find an accessible element … name /sessions/i"); existing 2 pass.

- [ ] **Step 3: Implement**

In `control-plane/src/organisms/ToolRail.tsx`:

1. Import: `import { History, Plus, Settings } from "lucide-react";`
2. `const TOOLS = [
  { icon: Plus, label: "New workspace" },
  { icon: History, label: "Sessions" },
];`
3. Props:

```tsx
interface ToolRailProps {
  /** "New workspace" tool — opens the create-workspace flow directly (design §5). */
  onNewWorkspace?: () => void;
  /** "Sessions" tool — toggles the sessions panel. */
  onSessions?: () => void;
  /** Settings — the reset surface. */
  onSettings?: () => void;
}
```

4. Component signature gains `onSessions`; the click dispatch becomes:

```tsx
          onClick={() => {
            setActive(i);
            if (tool.label === "New workspace") onNewWorkspace?.();
            if (tool.label === "Sessions") onSessions?.();
          }}
```

In `control-plane/src/pages/HomePage.tsx` line ~148, the rail becomes:

```tsx
      leftRail={
        <ToolRail
          onNewWorkspace={() => setNewWorkspaceOpen(true)}
          onSessions={() => setSessionsOpen((open) => !open)}
          onSettings={() => setSettingsOpen(true)}
        />
      }
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd control-plane && pnpm exec vitest run src/organisms/ToolRail.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Full suite + typecheck + lint**

Run: `cd control-plane && pnpm exec vitest run && pnpm typecheck && pnpm exec biome check src`
Expected: all green, no new lint warnings.

- [ ] **Step 6: Commit**

```bash
git add control-plane/src/organisms/ToolRail.tsx control-plane/src/organisms/ToolRail.test.tsx control-plane/src/pages/HomePage.tsx
git commit -m "feat(control-plane): Sessions tool on the rail reopens the sessions panel

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

## Self-Review Notes

- Spec coverage complete (tool, icon, placement, prop, toggle wiring, tests). No placeholders. Names consistent (`onSessions` everywhere).
