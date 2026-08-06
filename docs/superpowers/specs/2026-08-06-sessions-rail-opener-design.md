# Sessions panel opener on the tool rail

**Date:** 2026-08-06
**Status:** Approved by Edwin (icon: lucide `History`).

## Problem

Removing the bottom hint bar (commit 3ae1be8) removed the SessionsPanel's only
opener — `sessionsOpen` in `HomePage.tsx` can never become true. The panel,
its state, and its wiring are intact; only the trigger is missing.

## Design

- `control-plane/src/organisms/ToolRail.tsx`: add a **Sessions** entry to the
  `TOOLS` array — `{ icon: History, label: "Sessions" }` (lucide `History`),
  listed after "New workspace" so it sits under the `+` button. New optional
  prop `onSessions?: () => void`, dispatched by label like the existing
  New-workspace tool.
- `control-plane/src/pages/HomePage.tsx:148`: pass
  `onSessions={() => setSessionsOpen((open) => !open)}` — toggle semantics,
  matching the removed footer button's behavior.
- No SessionsPanel, CSS, or atom changes — `ToolButton` already styles rail
  tools.

## Testing

Extend `control-plane/src/organisms/ToolRail.test.tsx` (existing idiom:
plain vitest + RTL + userEvent, no jest-dom):

- Clicking the button named "Sessions" fires `onSessions` once.
- Existing tests unchanged and passing.

## Out of scope

- SessionsPanel content/redesign.
- Keyboard shortcut for the panel.
