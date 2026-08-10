# Dashboards Stage Mock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the "agent-composed dashboards" concept as a fully client-side mock stage (ask → composing → board) in the control-plane shell, per `docs/superpowers/specs/2026-08-10-dashboards-mock-design.md`.

**Architecture:** One thin stage organism (`DashboardsStage`) owns a `{view, query, scope, step}` state machine and delegates to three stateless view organisms. All data is hardcoded in `data/dashboards.ts`; charts are hand-rolled inline SVG via two pure path helpers. One new hash route + one ToolRail item wire it into the shell.

**Tech Stack:** React 19 + TypeScript, TanStack Router (hash history), HeroUI Pro Sidebar (rail), vitest + Testing Library, lucide-react icons, plain CSS in the app's cascade-layer system. **No new dependencies.**

## Global Constraints

- Working directory for all pnpm commands: `control-plane/` — this package uses **pnpm, never npm**.
- Work on the current branch of the main checkout (`app-shell-navbar` unless Edwin redirects). This is a **shared checkout**: other agents have uncommitted edits (notably `src/styles/components.css`, `src/organisms/MapStage.tsx`, `src/organisms/map/*`). This plan **never touches components.css** — the mock's CSS lives in a NEW file `src/styles/dashboards.css` precisely to avoid sweeping foreign hunks.
- Git discipline: always `git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents`; stage **only the exact files named in the task**; before staging any pre-existing file, run `git -C … diff <file>` and confirm every hunk is yours; after each commit verify the `[branch hash]` line and the file count match the task's file list.
- `pnpm lint` exits 0 **with 2 permanent biome.json config diagnostics** — those two are not yours. A non-zero exit IS yours.
- No route loaders, ever (WS lives above the router). Organisms stay router-free: `DashboardsStage` and its subviews import nothing from `@tanstack/react-router`.
- Do not touch or shadow `--accent` — the stage defines its own `--dash-*` variables (there is a known `--accent` shadowing hazard with 86 usages).
- Copy rules from the design: all-lowercase copy ("dashboards", "new question", "save dashboard", "what do you want to know?"), mono labels UPPERCASE.
- Chart palette below is **already validated** (dataviz six-checks, both modes) — use these exact hexes, do not re-pick:
  - dark (surface #0d1119): line `#5b84e8`, reference line `var(--text-dim)` dashed, status ok `#2aa27a` / watch `#b8892a` / high `#d9536e`
  - light (surface #ffffff): line `#3f6fe0`, reference `var(--text-dim)` dashed, status ok `#17a877` / watch `#84620a` / high `#d84a70`
  - The gray dashed intake line is a deliberate de-emphasized reference series: its identity is carried by dash pattern + legend + tooltip (never color alone), so it is exempt from the categorical chroma floor.

---

### Task 1: SVG path helpers

**Files:**
- Create: `control-plane/src/lib/dashboard-paths.ts`
- Test: `control-plane/src/lib/dashboard-paths.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `seriesPath(vals: number[], opts: { w: number; h: number; max: number; pad?: number; close?: boolean }): string` and `sparkPath(vals: number[]): string` — Task 5 (`DashboardBoard`) imports both from `../../lib/dashboard-paths`.

- [ ] **Step 1: Write the failing test**

```ts
// control-plane/src/lib/dashboard-paths.test.ts
import { describe, expect, it } from "vitest";
import { seriesPath, sparkPath } from "./dashboard-paths";

describe("seriesPath", () => {
  it("maps values into the padded band", () => {
    // h=100 pad=30 → drawable band is 70px tall, centred: y ∈ [15, 85]
    expect(seriesPath([0, 50], { w: 100, h: 100, max: 50 })).toBe("M0.0 85.0 L100.0 15.0");
  });

  it("closes to the baseline for area fills", () => {
    expect(seriesPath([0, 50], { w: 100, h: 100, max: 50, close: true })).toBe(
      "M0.0 85.0 L100.0 15.0 L100 100 L0 100 Z",
    );
  });

  it("an empty series draws nothing", () => {
    expect(seriesPath([], { w: 100, h: 100, max: 50 })).toBe("");
  });
});

describe("sparkPath", () => {
  it("normalizes to its own min and max in a 100×22 box", () => {
    expect(sparkPath([0, 10])).toBe("M0.0 20.0 L100.0 3.0");
  });

  it("a flat series draws a baseline, not NaN", () => {
    expect(sparkPath([5, 5, 5])).toBe("M0.0 20.0 L50.0 20.0 L100.0 20.0");
  });

  it("an empty series draws nothing", () => {
    expect(sparkPath([])).toBe("");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd control-plane && pnpm test src/lib/dashboard-paths.test.ts`
Expected: FAIL — cannot resolve `./dashboard-paths`.

- [ ] **Step 3: Write the implementation**

```ts
// control-plane/src/lib/dashboard-paths.ts
/**
 * SVG path builders for the dashboards mock — ported from the source design
 * (claude.ai/design "Agentic dashboard left rail", Dashboards Rail.dc.html).
 * Pure string math, no DOM.
 */

export interface SeriesPathOpts {
  w: number;
  h: number;
  /** Y-scale ceiling — every series on one chart MUST share it (one axis). */
  max: number;
  /** Vertical inset so the line never kisses the panel edges. */
  pad?: number;
  /** Close the path down to the baseline for an area fill. */
  close?: boolean;
}

export function seriesPath(vals: number[], { w, h, max, pad = 30, close = false }: SeriesPathOpts): string {
  const n = vals.length;
  if (n === 0) return "";
  const pts = vals.map((v, i) => [n === 1 ? 0 : (i * w) / (n - 1), h - (v / max) * (h - pad) - pad / 2]);
  let d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  if (close) d += ` L${w} ${h} L0 ${h} Z`;
  return d;
}

/** 100×22 sparkline normalized to its own min/max; a flat series draws its baseline. */
export function sparkPath(vals: number[]): string {
  const n = vals.length;
  if (n === 0) return "";
  const max = Math.max(...vals);
  const min = Math.min(...vals);
  const range = max - min || 1;
  return vals
    .map((v, i) => {
      const x = n === 1 ? 0 : (i * 100) / (n - 1);
      const y = 20 - ((v - min) / range) * 17;
      return `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd control-plane && pnpm test src/lib/dashboard-paths.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents add control-plane/src/lib/dashboard-paths.ts control-plane/src/lib/dashboard-paths.test.ts
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents commit -m "feat: dashboard path helpers — two pure functions, the whole chart engine"
```
Verify the commit line reports 2 files changed.

---

### Task 2: Fake data module

**Files:**
- Create: `control-plane/src/data/dashboards.ts`
- Test: `control-plane/src/data/dashboards.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (imported by Tasks 3–6): types `DashRisk = "ok" | "watch" | "high"`, `SavedDashboard { id: string; title: string; meta: string }`, `DashKpi`, `DashStageBar`, `DashGroupRow`; constants `DASH_SCOPES`, `DASH_SUGGESTIONS`, `DASH_FOLLOWUPS`, `DASH_STEPS`, `DASH_SAVED`, `DASH_ANSWER`, `DASH_KPIS`, `DASH_SHIPPED`, `DASH_INTAKE`, `DASH_WEEKS`, `DASH_STAGE_BARS`, `DASH_ROWS`; functions `savedMeta(scope: string): string`, `scopeHint(scope: string): string`.

- [ ] **Step 1: Write the failing test**

```ts
// control-plane/src/data/dashboards.test.ts
import { describe, expect, it } from "vitest";
import { DASH_INTAKE, DASH_ROWS, DASH_SHIPPED, DASH_STEPS, DASH_WEEKS, savedMeta, scopeHint } from "./dashboards";

describe("dashboards fake data", () => {
  it("series and axis agree on 12 weeks", () => {
    expect(DASH_SHIPPED).toHaveLength(12);
    expect(DASH_INTAKE).toHaveLength(12);
    expect(DASH_WEEKS).toHaveLength(12);
  });

  it("every group trend is 12 points", () => {
    for (const r of DASH_ROWS) expect(r.trend).toHaveLength(12);
  });

  it("has exactly four composing steps (the stage timer counts on it)", () => {
    expect(DASH_STEPS).toHaveLength(4);
  });

  it("savedMeta folds 'all workspaces' to ALL", () => {
    expect(savedMeta("all workspaces")).toBe("ALL · JUST SAVED");
    expect(savedMeta("release")).toBe("RELEASE · JUST SAVED");
  });

  it("scopeHint uppercases the scope", () => {
    expect(scopeHint("all workspaces")).toBe("SCOPE · ALL WORKSPACES");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd control-plane && pnpm test src/data/dashboards.test.ts`
Expected: FAIL — cannot resolve `./dashboards`.

- [ ] **Step 3: Write the implementation**

```ts
// control-plane/src/data/dashboards.ts
/**
 * Client-side fake data for the dashboards mock — the stage reads from here
 * and only here. "Make it real" later = replace this module with an
 * agent-composed payload; nothing else moves (spec: Future path).
 */

export type DashRisk = "ok" | "watch" | "high";

export interface SavedDashboard {
  id: string;
  title: string;
  meta: string;
}

export interface DashKpi {
  label: string;
  value: string;
  delta: string;
  tone: DashRisk;
  /** Meter fill, 0–1 of the tile's width. */
  bar: number;
}

export interface DashStageBar {
  label: string;
  value: number;
}

export interface DashGroupRow {
  name: string;
  cards: number;
  wip: number;
  cycle: string;
  /** 12 weekly points, arbitrary units — drawn by sparkPath. */
  trend: number[];
  risk: DashRisk;
}

export const DASH_SCOPES = [
  "all workspaces",
  "ideation",
  "plan",
  "deliver",
  "release",
  "reactive",
  "maintenance",
  "personal",
] as const;

export const DASH_SUGGESTIONS = [
  "where is delivery slipping across all workspaces this quarter?",
  "which groups have the most work stuck in scoping?",
  "how much did we kill vs. ship in the last 12 weeks?",
  "who on the crew is most loaded right now?",
] as const;

export const DASH_FOLLOWUPS = [
  "break this down by crew member",
  "compare to last quarter",
  "only show groups trending worse",
] as const;

export const DASH_STEPS = [
  "reading 24 workspaces in jefelabs",
  "resolving stage history · 12 weeks",
  "selecting KPIs, trend and breakdown",
  "composing dashboard",
] as const;

export const DASH_SAVED: SavedDashboard[] = [
  { id: "seed-0", title: "weekly delivery health", meta: "ALL · UPDATED MON" },
  { id: "seed-1", title: "intake pressure by group", meta: "IDEATION · UPDATED 3D" },
  { id: "seed-2", title: "kill-rate watch", meta: "ALL · UPDATED 1W" },
];

export const DASH_ANSWER =
  "shipped volume is up 24% over 12 weeks, but intake is growing faster — the release group is absorbing the gap and is now the only group above its WIP ceiling.";

export const DASH_KPIS: DashKpi[] = [
  { label: "ACTIVE WORKSPACES", value: "24", delta: "+3", tone: "ok", bar: 0.72 },
  { label: "CARDS IN FLIGHT", value: "186", delta: "+18%", tone: "watch", bar: 0.84 },
  { label: "MEDIAN CYCLE TIME", value: "4.2d", delta: "+0.6d", tone: "high", bar: 0.61 },
  { label: "KILLED IN SCOPING", value: "12%", delta: "−4%", tone: "ok", bar: 0.34 },
];

export const DASH_SHIPPED = [18, 22, 19, 26, 24, 31, 28, 34, 29, 36, 33, 41];
export const DASH_INTAKE = [24, 26, 25, 30, 33, 32, 36, 35, 38, 37, 40, 44];
/** One label per point; the axis renders every other one. */
export const DASH_WEEKS = ["W23", "W24", "W25", "W26", "W27", "W28", "W29", "W30", "W31", "W32", "W33", "W34"];

export const DASH_STAGE_BARS: DashStageBar[] = [
  { label: "INTAKE", value: 54 },
  { label: "SCOPING", value: 71 },
  { label: "CONFIRM", value: 38 },
  { label: "KILLED", value: 23 },
];

export const DASH_ROWS: DashGroupRow[] = [
  { name: "release", cards: 42, wip: 11, cycle: "5.8d", risk: "high", trend: [12, 14, 13, 16, 15, 18, 17, 20, 19, 22, 24, 27] },
  { name: "deliver", cards: 61, wip: 14, cycle: "4.1d", risk: "watch", trend: [22, 21, 23, 22, 24, 23, 25, 26, 25, 27, 26, 28] },
  { name: "reactive", cards: 28, wip: 9, cycle: "1.3d", risk: "ok", trend: [15, 13, 16, 12, 15, 11, 14, 12, 13, 11, 12, 10] },
  { name: "plan", cards: 33, wip: 6, cycle: "3.6d", risk: "ok", trend: [18, 17, 18, 19, 18, 17, 18, 18, 19, 18, 17, 18] },
  { name: "ideation", cards: 47, wip: 4, cycle: "8.2d", risk: "watch", trend: [9, 11, 10, 13, 12, 15, 14, 17, 16, 19, 18, 21] },
  { name: "maintenance", cards: 19, wip: 3, cycle: "2.4d", risk: "ok", trend: [8, 9, 8, 9, 8, 9, 9, 8, 9, 8, 9, 8] },
];

/** The meta line a just-saved dashboard gets; "all workspaces" folds to ALL. */
export function savedMeta(scope: string): string {
  return `${(scope === "all workspaces" ? "all" : scope).toUpperCase()} · JUST SAVED`;
}

export function scopeHint(scope: string): string {
  return `SCOPE · ${scope.toUpperCase()}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd control-plane && pnpm test src/data/dashboards.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents add control-plane/src/data/dashboards.ts control-plane/src/data/dashboards.test.ts
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents commit -m "feat: dashboards fake data — the one module a real backend replaces"
```
Verify 2 files changed.

---

### Task 3: DashboardComposing view

**Files:**
- Create: `control-plane/src/organisms/dashboards/DashboardComposing.tsx`
- Test: `control-plane/src/organisms/dashboards/DashboardComposing.test.tsx`

**Interfaces:**
- Consumes: `DASH_STEPS` from `../../data/dashboards` (Task 2).
- Produces: `DashboardComposing({ query: string; scopeHint: string; step: number })` — Task 6 renders it while `view === "composing"`.

- [ ] **Step 1: Write the failing test**

```tsx
// control-plane/src/organisms/dashboards/DashboardComposing.test.tsx
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DashboardComposing } from "./DashboardComposing";

describe("DashboardComposing", () => {
  afterEach(() => cleanup());

  it("echoes the query and the scope hint", () => {
    render(<DashboardComposing query="who is most loaded?" scopeHint="SCOPE · ALL WORKSPACES" step={0} />);
    expect(screen.getByText("who is most loaded?")).toBeTruthy();
    expect(screen.getByText("SCOPE · ALL WORKSPACES")).toBeTruthy();
  });

  it("marks steps done, active and todo around the current index", () => {
    render(<DashboardComposing query="q" scopeHint="SCOPE · ALL WORKSPACES" step={1} />);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(4);
    expect(items[0].className).toContain("dash-composing__step--done");
    expect(items[1].className).toContain("dash-composing__step--active");
    expect(items[2].className).not.toContain("--done");
    expect(items[2].className).not.toContain("--active");
  });

  it("shows an indeterminate progress track", () => {
    render(<DashboardComposing query="q" scopeHint="SCOPE · ALL WORKSPACES" step={0} />);
    expect(screen.getByRole("progressbar", { name: "composing dashboard" })).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd control-plane && pnpm test src/organisms/dashboards/DashboardComposing.test.tsx`
Expected: FAIL — cannot resolve `./DashboardComposing`.

- [ ] **Step 3: Write the implementation**

```tsx
// control-plane/src/organisms/dashboards/DashboardComposing.tsx
import { DASH_STEPS } from "../../data/dashboards";

interface DashboardComposingProps {
  query: string;
  scopeHint: string;
  /** Index of the step currently running; steps below it render as done. */
  step: number;
}

/** The fake agent at work — four steps and a sweep. Stateless: the stage's interval drives `step`. */
export function DashboardComposing({ query, scopeHint, step }: DashboardComposingProps) {
  return (
    <div className="dash-composing">
      <div className="dash-composing__inner">
        <div className="dash-composing__query">{query}</div>
        <div className="dash-composing__hint">{scopeHint}</div>
        <ol className="dash-composing__steps">
          {DASH_STEPS.map((label, i) => (
            <li
              key={label}
              className={`dash-composing__step ${
                i < step ? "dash-composing__step--done" : i === step ? "dash-composing__step--active" : ""
              }`}
            >
              <span className="dash-composing__dot" aria-hidden="true" />
              {label}
            </li>
          ))}
        </ol>
        <div className="dash-composing__track" role="progressbar" aria-label="composing dashboard">
          <div className="dash-composing__sweep" />
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd control-plane && pnpm test src/organisms/dashboards/DashboardComposing.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents add control-plane/src/organisms/dashboards/DashboardComposing.tsx control-plane/src/organisms/dashboards/DashboardComposing.test.tsx
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents commit -m "feat: the composing view — four fake steps and a sweep"
```
Verify 2 files changed.

---

### Task 4: DashboardAsk view

**Files:**
- Create: `control-plane/src/organisms/dashboards/DashboardAsk.tsx`
- Test: `control-plane/src/organisms/dashboards/DashboardAsk.test.tsx`

**Interfaces:**
- Consumes: `DASH_SCOPES`, `DASH_SUGGESTIONS`, `SavedDashboard` from `../../data/dashboards` (Task 2).
- Produces: `DashboardAsk({ scope: string; saved: SavedDashboard[]; scopeHint: string; onScope: (scope: string) => void; onSubmit: (query: string) => void })` — Task 6 renders it while `view === "ask"`. `onSubmit("")` is legal; the stage falls back to the first suggestion.

- [ ] **Step 1: Write the failing test**

```tsx
// control-plane/src/organisms/dashboards/DashboardAsk.test.tsx
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DASH_SAVED, DASH_SUGGESTIONS } from "../../data/dashboards";
import { DashboardAsk } from "./DashboardAsk";

function renderAsk(over: Partial<Parameters<typeof DashboardAsk>[0]> = {}) {
  const props = {
    scope: "all workspaces",
    saved: DASH_SAVED,
    scopeHint: "SCOPE · ALL WORKSPACES",
    onScope: vi.fn(),
    onSubmit: vi.fn(),
    ...over,
  };
  render(<DashboardAsk {...props} />);
  return props;
}

describe("DashboardAsk", () => {
  afterEach(() => cleanup());

  it("scope chips reflect the selection and report a pick", () => {
    const { onScope } = renderAsk();
    expect(screen.getByRole("radio", { name: "all workspaces" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: "release" }));
    expect(onScope).toHaveBeenCalledWith("release");
  });

  it("Enter submits the trimmed draft; Shift+Enter does not", () => {
    const { onSubmit } = renderAsk();
    const box = screen.getByRole("textbox", { name: "Dashboard question" });
    fireEvent.change(box, { target: { value: "  where is delivery slipping?  " } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("where is delivery slipping?");
  });

  it("the compose button submits the draft", () => {
    const { onSubmit } = renderAsk();
    fireEvent.change(screen.getByRole("textbox", { name: "Dashboard question" }), { target: { value: "q1" } });
    fireEvent.click(screen.getByRole("button", { name: /compose/i }));
    expect(onSubmit).toHaveBeenCalledWith("q1");
  });

  it("a suggestion submits its own text", () => {
    const { onSubmit } = renderAsk();
    fireEvent.click(screen.getByText(DASH_SUGGESTIONS[2]));
    expect(onSubmit).toHaveBeenCalledWith(DASH_SUGGESTIONS[2]);
  });

  it("a saved card submits its title", () => {
    const { onSubmit } = renderAsk();
    fireEvent.click(screen.getByText("kill-rate watch"));
    expect(onSubmit).toHaveBeenCalledWith("kill-rate watch");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd control-plane && pnpm test src/organisms/dashboards/DashboardAsk.test.tsx`
Expected: FAIL — cannot resolve `./DashboardAsk`.

- [ ] **Step 3: Write the implementation**

```tsx
// control-plane/src/organisms/dashboards/DashboardAsk.tsx
import { ArrowRight } from "lucide-react";
import { useState } from "react";
import { DASH_SCOPES, DASH_SUGGESTIONS, type SavedDashboard } from "../../data/dashboards";

interface DashboardAskProps {
  scope: string;
  saved: SavedDashboard[];
  scopeHint: string;
  onScope: (scope: string) => void;
  /** Submit the typed draft; "" lets the stage fall back to the first suggestion. */
  onSubmit: (query: string) => void;
}

export function DashboardAsk({ scope, saved, scopeHint, onScope, onSubmit }: DashboardAskProps) {
  // The draft is local: the stage only cares at submit time, and a keystroke
  // re-render of the whole stage would be noise.
  const [draft, setDraft] = useState("");
  return (
    <div className="dash-ask">
      <div className="dash-ask__inner">
        <div className="dash-ask__heading">what do you want to know?</div>
        <p className="dash-ask__sub">
          ask in plain language. the agent reads your workspaces and composes a dashboard of KPIs, charts and tables
          to answer it.
        </p>

        <div className="dash-ask__scopes" role="radiogroup" aria-label="Scope">
          <span className="dash-ask__label">SCOPE</span>
          {DASH_SCOPES.map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={s === scope}
              className={`dash-chip ${s === scope ? "dash-chip--active" : ""}`}
              onClick={() => onScope(s)}
            >
              {s}
            </button>
          ))}
        </div>

        <div className="dash-ask__box">
          <textarea
            rows={2}
            value={draft}
            aria-label="Dashboard question"
            placeholder="e.g. where is delivery slipping across the release group this quarter?"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSubmit(draft.trim());
              }
            }}
          />
          <div className="dash-ask__boxrow">
            <span className="dash-ask__hint">{scopeHint}</span>
            <button type="button" className="dash-btn dash-btn--primary" onClick={() => onSubmit(draft.trim())}>
              compose <ArrowRight size={13} aria-hidden="true" />
            </button>
          </div>
        </div>

        <div className="dash-ask__label">TRY</div>
        <div className="dash-ask__suggestions">
          {DASH_SUGGESTIONS.map((q) => (
            <button key={q} type="button" className="dash-ask__suggestion" onClick={() => onSubmit(q)}>
              {q}
            </button>
          ))}
        </div>

        <div className="dash-ask__label">SAVED</div>
        <div className="dash-ask__saved">
          {saved.map((d) => (
            <button key={d.id} type="button" className="dash-saved-card" onClick={() => onSubmit(d.title)}>
              <span className="dash-saved-card__title">{d.title}</span>
              <span className="dash-saved-card__meta">{d.meta}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd control-plane && pnpm test src/organisms/dashboards/DashboardAsk.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents add control-plane/src/organisms/dashboards/DashboardAsk.tsx control-plane/src/organisms/dashboards/DashboardAsk.test.tsx
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents commit -m "feat: the ask view — scope chips, a question box, and the saved grid"
```
Verify 2 files changed.

---

### Task 5: DashboardBoard view

**Files:**
- Create: `control-plane/src/organisms/dashboards/DashboardBoard.tsx`
- Test: `control-plane/src/organisms/dashboards/DashboardBoard.test.tsx`

**Interfaces:**
- Consumes: data constants (Task 2) and `seriesPath`/`sparkPath` (Task 1).
- Produces: `DashboardBoard({ query: string; scopeHint: string; onFollowup: (query: string) => void })` — Task 6 renders it while `view === "board"` and passes its `submit` as `onFollowup`.

- [ ] **Step 1: Write the failing test**

```tsx
// control-plane/src/organisms/dashboards/DashboardBoard.test.tsx
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DASH_FOLLOWUPS } from "../../data/dashboards";
import { DashboardBoard } from "./DashboardBoard";

function renderBoard(onFollowup = vi.fn()) {
  const r = render(
    <DashboardBoard query="where is delivery slipping?" scopeHint="SCOPE · ALL WORKSPACES" onFollowup={onFollowup} />,
  );
  return { ...r, onFollowup };
}

describe("DashboardBoard", () => {
  afterEach(() => cleanup());

  it("banner echoes the question, the answer and the scope hint", () => {
    renderBoard();
    expect(screen.getByText("where is delivery slipping?")).toBeTruthy();
    expect(screen.getByText(/shipped volume is up 24%/)).toBeTruthy();
    expect(screen.getByText("SCOPE · ALL WORKSPACES")).toBeTruthy();
  });

  it("renders four KPI tiles and six group rows", () => {
    const { container } = renderBoard();
    expect(container.querySelectorAll(".dash-kpi")).toHaveLength(4);
    // 6 data rows + 1 header row
    expect(screen.getAllByRole("row")).toHaveLength(7);
    expect(screen.getByText("release")).toBeTruthy();
  });

  it("hovering a week band shows the crosshair tooltip with both values", () => {
    const { container } = renderBoard();
    const hits = container.querySelectorAll(".dash-chart__hit");
    expect(hits).toHaveLength(12);
    fireEvent.mouseEnter(hits[2]);
    // DASH_WEEKS[2]=W25, DASH_SHIPPED[2]=19, DASH_INTAKE[2]=25
    expect(screen.getByText(/shipped 19 · intake 25/)).toBeTruthy();
    expect(screen.getByText("W25")).toBeTruthy();
  });

  it("a follow-up chip reports its own text", () => {
    const { onFollowup } = renderBoard();
    fireEvent.click(screen.getByText(DASH_FOLLOWUPS[1]));
    expect(onFollowup).toHaveBeenCalledWith(DASH_FOLLOWUPS[1]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd control-plane && pnpm test src/organisms/dashboards/DashboardBoard.test.tsx`
Expected: FAIL — cannot resolve `./DashboardBoard`.

- [ ] **Step 3: Write the implementation**

```tsx
// control-plane/src/organisms/dashboards/DashboardBoard.tsx
import { Sparkles } from "lucide-react";
import { useState } from "react";
import {
  DASH_ANSWER,
  DASH_FOLLOWUPS,
  DASH_INTAKE,
  DASH_KPIS,
  DASH_ROWS,
  DASH_SHIPPED,
  DASH_STAGE_BARS,
  DASH_WEEKS,
} from "../../data/dashboards";
import { seriesPath, sparkPath } from "../../lib/dashboard-paths";

const CHART_W = 640;
const CHART_H = 190;
/** One shared ceiling for both series — one axis, never two. */
const CHART_MAX = 50;
const N = DASH_WEEKS.length - 1; // 11 gaps between 12 points

interface DashboardBoardProps {
  query: string;
  scopeHint: string;
  onFollowup: (query: string) => void;
}

export function DashboardBoard({ query, scopeHint, onFollowup }: DashboardBoardProps) {
  const [hover, setHover] = useState<number | null>(null);
  const maxStage = Math.max(...DASH_STAGE_BARS.map((s) => s.value));
  return (
    <div className="dash-board">
      <div className="dash-board__banner">
        <Sparkles size={16} aria-hidden="true" />
        <div>
          <div className="dash-board__question">{query}</div>
          <div className="dash-board__answer">{DASH_ANSWER}</div>
          <div className="dash-board__meta">
            <span>{scopeHint}</span>
            <span>12 WEEKS</span>
            <span>UPDATED 2 MIN AGO</span>
          </div>
        </div>
      </div>

      <div className="dash-board__kpis">
        {DASH_KPIS.map((k) => (
          <div key={k.label} className="dash-kpi">
            <div className="dash-kpi__label">{k.label}</div>
            <div className="dash-kpi__row">
              <span className="dash-kpi__value">{k.value}</span>
              <span className={`dash-kpi__delta dash-tone--${k.tone}`}>{k.delta}</span>
            </div>
            <div className="dash-kpi__meter">
              <div className={`dash-kpi__fill dash-fill--${k.tone}`} style={{ width: `${k.bar * 100}%` }} />
            </div>
          </div>
        ))}
      </div>

      <div className="dash-board__charts">
        <section className="dash-panel" aria-label="Throughput vs intake">
          <div className="dash-panel__head">
            <span>throughput vs. intake</span>
            <span className="dash-panel__legend">
              <i className="dash-legend__swatch dash-legend__swatch--line" /> shipped
              <i className="dash-legend__swatch dash-legend__swatch--ref" /> intake
            </span>
          </div>
          <div className="dash-chart" onMouseLeave={() => setHover(null)}>
            <svg
              viewBox={`0 0 ${CHART_W} ${CHART_H}`}
              preserveAspectRatio="none"
              role="img"
              aria-label="Shipped and intake per week over 12 weeks"
            >
              <defs>
                <linearGradient id="dash-fill-a" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--dash-line)" stopOpacity="0.28" />
                  <stop offset="100%" stopColor="var(--dash-line)" stopOpacity="0" />
                </linearGradient>
              </defs>
              <path d="M0 40H640M0 90H640M0 140H640M0 175H640" className="dash-chart__grid" />
              <path
                d={seriesPath(DASH_SHIPPED, { w: CHART_W, h: CHART_H, max: CHART_MAX, close: true })}
                fill="url(#dash-fill-a)"
              />
              <path d={seriesPath(DASH_SHIPPED, { w: CHART_W, h: CHART_H, max: CHART_MAX })} className="dash-chart__line" />
              <path d={seriesPath(DASH_INTAKE, { w: CHART_W, h: CHART_H, max: CHART_MAX })} className="dash-chart__ref" />
              {hover !== null && (
                <line
                  className="dash-chart__cross"
                  x1={(hover * CHART_W) / N}
                  x2={(hover * CHART_W) / N}
                  y1="0"
                  y2={CHART_H}
                />
              )}
              {DASH_WEEKS.map((w, i) => (
                <rect
                  key={w}
                  className="dash-chart__hit"
                  x={((i - 0.5) * CHART_W) / N}
                  y="0"
                  width={CHART_W / N}
                  height={CHART_H}
                  onMouseEnter={() => setHover(i)}
                />
              ))}
            </svg>
            {hover !== null && (
              <div className="dash-chart__tip" style={{ left: `${(hover / N) * 100}%` }}>
                <strong>{DASH_WEEKS[hover]}</strong> shipped {DASH_SHIPPED[hover]} · intake {DASH_INTAKE[hover]}
              </div>
            )}
          </div>
          <div className="dash-chart__weeks">
            {DASH_WEEKS.filter((_, i) => i % 2 === 0).map((w) => (
              <span key={w}>{w}</span>
            ))}
          </div>
        </section>

        <section className="dash-panel" aria-label="Cards by stage">
          <div className="dash-panel__head">
            <span>where work is sitting</span>
          </div>
          <div className="dash-panel__sub">CARDS BY STAGE</div>
          <div className="dash-stagebars">
            {DASH_STAGE_BARS.map((s) => (
              <div key={s.label} className="dash-stagebars__col">
                <span className="dash-stagebars__num">{s.value}</span>
                <div
                  className={`dash-stagebars__bar ${s.label === "KILLED" ? "dash-stagebars__bar--dim" : ""}`}
                  style={{ height: `${(s.value / maxStage) * 150}px` }}
                />
                <span className="dash-stagebars__lab">{s.label}</span>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="dash-table" aria-label="Workspace groups">
        <div className="dash-table__toprow">
          <span>workspace groups</span>
          <span className="dash-table__sort">SORTED BY RISK</span>
        </div>
        <table>
          <thead>
            <tr>
              <th>GROUP</th>
              <th>CARDS</th>
              <th>WIP</th>
              <th>CYCLE</th>
              <th>12-WEEK TREND</th>
              <th>RISK</th>
            </tr>
          </thead>
          <tbody>
            {DASH_ROWS.map((r) => (
              <tr key={r.name}>
                <td className="dash-table__group">
                  <i className={`dash-table__dot dash-fill--${r.risk}`} />
                  {r.name}
                </td>
                <td className="dash-table__num">{r.cards}</td>
                <td className="dash-table__num">{r.wip}</td>
                <td className="dash-table__num">{r.cycle}</td>
                <td>
                  <svg viewBox="0 0 100 22" className="dash-table__spark" aria-hidden="true">
                    <path d={sparkPath(r.trend)} className={`dash-spark--${r.risk}`} />
                  </svg>
                </td>
                <td>
                  <span className={`dash-pill dash-pill--${r.risk}`}>{r.risk}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <div className="dash-board__followups">
        {DASH_FOLLOWUPS.map((f) => (
          <button key={f} type="button" className="dash-followup" onClick={() => onFollowup(f)}>
            {f}
          </button>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd control-plane && pnpm test src/organisms/dashboards/DashboardBoard.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents add control-plane/src/organisms/dashboards/DashboardBoard.tsx control-plane/src/organisms/dashboards/DashboardBoard.test.tsx
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents commit -m "feat: the composed board — KPIs, two charts, a risk table, follow-ups"
```
Verify 2 files changed.

---

### Task 6: DashboardsStage state machine

**Files:**
- Create: `control-plane/src/organisms/DashboardsStage.tsx`
- Test: `control-plane/src/organisms/DashboardsStage.test.tsx`

**Interfaces:**
- Consumes: all three views (Tasks 3–5), data module (Task 2).
- Produces: `DashboardsStage()` — no props; Task 8's route renders `<DashboardsStage />`. Root element is `<section className="stage dashboards-stage" aria-label="Dashboards">` (role `region`, name "Dashboards" — Task 8's route test finds it by that name).

- [ ] **Step 1: Write the failing test**

```tsx
// control-plane/src/organisms/DashboardsStage.test.tsx
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DASH_SUGGESTIONS } from "../data/dashboards";
import { DashboardsStage } from "./DashboardsStage";

const STEP_MS = 620;

describe("DashboardsStage", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("a suggestion walks the steps and lands on the board", () => {
    vi.useFakeTimers();
    render(<DashboardsStage />);
    fireEvent.click(screen.getByText(DASH_SUGGESTIONS[1]));
    expect(screen.getByText("reading 24 workspaces in jefelabs")).toBeTruthy();
    act(() => vi.advanceTimersByTime(STEP_MS * 4));
    expect(screen.getByText("save dashboard")).toBeTruthy();
    // The banner echoes the submitted query.
    expect(screen.getByText(DASH_SUGGESTIONS[1])).toBeTruthy();
  });

  it("an empty manual submit falls back to the first suggestion", () => {
    vi.useFakeTimers();
    render(<DashboardsStage />);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Dashboard question" }), { key: "Enter" });
    act(() => vi.advanceTimersByTime(STEP_MS * 4));
    expect(screen.getByText(DASH_SUGGESTIONS[0])).toBeTruthy();
  });

  it("new question returns to ask; save appends a JUST SAVED card first", () => {
    vi.useFakeTimers();
    render(<DashboardsStage />);
    const box = screen.getByRole("textbox", { name: "Dashboard question" });
    fireEvent.change(box, { target: { value: "my question" } });
    fireEvent.keyDown(box, { key: "Enter" });
    act(() => vi.advanceTimersByTime(STEP_MS * 4));
    fireEvent.click(screen.getByText("save dashboard"));
    fireEvent.click(screen.getByText("new question"));
    // Back on ask, with the saved card appended (scope was untouched → ALL).
    expect(screen.getByText("what do you want to know?")).toBeTruthy();
    expect(screen.getByText("my question")).toBeTruthy();
    expect(screen.getByText("ALL · JUST SAVED")).toBeTruthy();
  });

  it("a follow-up from the board re-runs the compose walk", () => {
    vi.useFakeTimers();
    render(<DashboardsStage />);
    fireEvent.click(screen.getByText(DASH_SUGGESTIONS[0]));
    act(() => vi.advanceTimersByTime(STEP_MS * 4));
    fireEvent.click(screen.getByText("compare to last quarter"));
    expect(screen.getByText("reading 24 workspaces in jefelabs")).toBeTruthy();
    // Two ticks in, it is still composing — the restart began from step 0.
    act(() => vi.advanceTimersByTime(STEP_MS * 2));
    expect(screen.queryByText("save dashboard")).toBeNull();
    act(() => vi.advanceTimersByTime(STEP_MS * 2));
    expect(screen.getByText("compare to last quarter")).toBeTruthy();
    expect(screen.getByText("save dashboard")).toBeTruthy();
  });

  it("unmounting mid-compose leaks no timer", () => {
    vi.useFakeTimers();
    const { unmount } = render(<DashboardsStage />);
    fireEvent.click(screen.getByText(DASH_SUGGESTIONS[0]));
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd control-plane && pnpm test src/organisms/DashboardsStage.test.tsx`
Expected: FAIL — cannot resolve `./DashboardsStage`.

- [ ] **Step 3: Write the implementation**

```tsx
// control-plane/src/organisms/DashboardsStage.tsx
import { useCallback, useEffect, useRef, useState } from "react";
import {
  DASH_SAVED,
  DASH_STEPS,
  DASH_SUGGESTIONS,
  type SavedDashboard,
  savedMeta,
  scopeHint,
} from "../data/dashboards";
import { DashboardAsk } from "./dashboards/DashboardAsk";
import { DashboardBoard } from "./dashboards/DashboardBoard";
import { DashboardComposing } from "./dashboards/DashboardComposing";

type DashView = "ask" | "composing" | "board";
const STEP_MS = 620;

/**
 * The dashboards mock — spec 2026-08-10-dashboards-mock-design.md. Entirely
 * client-side: the state machine below is the whole "backend", and
 * data/dashboards.ts is the whole "payload". Router-free like every organism.
 */
export function DashboardsStage() {
  const [view, setView] = useState<DashView>("ask");
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("all workspaces");
  const [step, setStep] = useState(0);
  const [saved, setSaved] = useState<SavedDashboard[]>(DASH_SAVED);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const savedSeq = useRef(0);

  const stop = useCallback(() => {
    if (timer.current !== null) {
      clearInterval(timer.current);
      timer.current = null;
    }
  }, []);
  useEffect(() => stop, [stop]);

  const submit = useCallback(
    (q: string) => {
      stop(); // a re-submit restarts the walk cleanly, never double-fires
      setQuery(q || DASH_SUGGESTIONS[0]);
      setStep(0);
      setView("composing");
      timer.current = setInterval(() => setStep((s) => s + 1), STEP_MS);
    },
    [stop],
  );

  // The interval only counts; the view flip lives here so the tick stays pure.
  useEffect(() => {
    if (view === "composing" && step >= DASH_STEPS.length) {
      stop();
      setView("board");
    }
  }, [view, step, stop]);

  return (
    <section className="stage dashboards-stage" aria-label="Dashboards">
      <header className="dashboards-stage__bar">
        <div className="dashboards-stage__title">dashboards</div>
        <span className="dashboards-stage__badge">AGENT COMPOSED</span>
        <div className="spacer" />
        {view === "board" && (
          <div className="dashboards-stage__actions">
            <button
              type="button"
              className="dash-btn"
              onClick={() => {
                stop();
                setQuery("");
                setStep(0);
                setView("ask");
              }}
            >
              new question
            </button>
            <button
              type="button"
              className="dash-btn dash-btn--primary"
              onClick={() =>
                setSaved((s) => [...s, { id: `saved-${savedSeq.current++}`, title: query, meta: savedMeta(scope) }])
              }
            >
              save dashboard
            </button>
          </div>
        )}
      </header>
      {view === "ask" && (
        <DashboardAsk scope={scope} saved={saved} scopeHint={scopeHint(scope)} onScope={setScope} onSubmit={submit} />
      )}
      {view === "composing" && <DashboardComposing query={query} scopeHint={scopeHint(scope)} step={step} />}
      {view === "board" && <DashboardBoard query={query} scopeHint={scopeHint(scope)} onFollowup={submit} />}
    </section>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd control-plane && pnpm test src/organisms/DashboardsStage.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents add control-plane/src/organisms/DashboardsStage.tsx control-plane/src/organisms/DashboardsStage.test.tsx
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents commit -m "feat: the dashboards stage — a 620ms interval is the whole backend"
```
Verify 2 files changed.

---

### Task 7: Stylesheet

**Files:**
- Create: `control-plane/src/styles/dashboards.css`
- Modify: `control-plane/src/styles/heroui.css` (one `@import` line, next to the existing components.css import)
- Modify: `control-plane/src/styles/base.css` (add `.stage.dashboards-stage` to the existing two-selector stage-override rule at ~line 122)

**Interfaces:**
- Consumes: class names from Tasks 3–6 (they render unstyled until now — fine, tests never look at CSS).
- Produces: the `--dash-*` palette and every `dash-*` class. No later task depends on this file's internals.

**NOTE:** `heroui.css` and `base.css` are pre-existing shared files. Before staging each, run `git -C … diff control-plane/src/styles/heroui.css` (and base.css) and confirm the only hunks are yours: one `@import` line, one selector addition. If foreign hunks appear, stop and surface it.

- [ ] **Step 1: Create the stylesheet**

```css
/* control-plane/src/styles/dashboards.css
   The dashboards mock stage. Imported from heroui.css as layer(legacy), same
   as components.css — kept as its own file so this feature never has to stage
   the shared components.css (parallel agents live there).

   Palette: validated against the dataviz six-checks for BOTH modes
   (dark surface #0d1119, light #ffffff) — see the plan doc. The dashed gray
   intake line is a deliberate reference series: identity via dash + legend. */

.dashboards-stage {
  --dash-line: #5b84e8;
  --dash-ok: #2aa27a;
  --dash-watch: #b8892a;
  --dash-high: #d9536e;
  --dash-mono: ui-monospace, monospace;
  overflow: hidden;
}
:root[data-theme="light"] .dashboards-stage {
  --dash-line: #3f6fe0;
  --dash-ok: #17a877;
  --dash-watch: #84620a;
  --dash-high: #d84a70;
}
@media (prefers-color-scheme: light) {
  :root:not([data-theme]) .dashboards-stage {
    --dash-line: #3f6fe0;
    --dash-ok: #17a877;
    --dash-watch: #84620a;
    --dash-high: #d84a70;
  }
}

/* ---- stage header ---- */
.dashboards-stage__bar {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 6px 12px 0 12px;
}
.dashboards-stage__bar .spacer {
  flex: 1;
}
.dashboards-stage__title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
}
.dashboards-stage__badge {
  font-family: var(--dash-mono);
  font-size: 10px;
  letter-spacing: 0.12em;
  color: var(--dash-line);
  border: 1px solid color-mix(in srgb, var(--dash-line) 30%, transparent);
  background: color-mix(in srgb, var(--dash-line) 9%, transparent);
  padding: 3px 7px;
  border-radius: 5px;
}
.dashboards-stage__actions {
  display: flex;
  gap: 8px;
}

/* ---- shared buttons/chips ---- */
.dash-btn {
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  color: var(--text-2);
  padding: 7px 12px;
  border-radius: 7px;
  border: 1px solid var(--pill-br);
  background: transparent;
  transition: background 0.18s ease, color 0.18s ease, border-color 0.18s ease;
}
.dash-btn:hover {
  color: var(--text);
  background: color-mix(in srgb, var(--text) 5%, transparent);
}
.dash-btn--primary {
  color: var(--text);
  border-color: color-mix(in srgb, var(--dash-line) 35%, transparent);
  background: color-mix(in srgb, var(--dash-line) 14%, transparent);
}
.dash-btn--primary:hover {
  background: color-mix(in srgb, var(--dash-line) 24%, transparent);
}
.dash-chip {
  cursor: pointer;
  font-size: 12px;
  padding: 5px 11px;
  border-radius: 999px;
  border: 1px solid var(--pill-br);
  background: color-mix(in srgb, var(--text) 2%, transparent);
  color: var(--text-2);
}
.dash-chip--active {
  border-color: color-mix(in srgb, var(--dash-line) 40%, transparent);
  background: color-mix(in srgb, var(--dash-line) 13%, transparent);
  color: var(--text);
}

/* ---- ask view ---- */
.dash-ask {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  justify-content: center;
  padding: 56px 26px 40px 26px;
}
.dash-ask__inner {
  width: 100%;
  max-width: 760px;
}
.dash-ask__heading {
  font-size: 30px;
  font-weight: 500;
  color: var(--text);
  letter-spacing: -0.01em;
  margin-bottom: 8px;
}
.dash-ask__sub {
  font-size: 14px;
  color: var(--text-2);
  margin: 0 0 26px 0;
  text-wrap: pretty;
}
.dash-ask__label {
  font-family: var(--dash-mono);
  font-size: 10px;
  letter-spacing: 0.12em;
  color: var(--text-dim);
  margin: 28px 0 10px 0;
}
.dash-ask__scopes {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}
.dash-ask__scopes .dash-ask__label {
  margin: 0 2px 0 0;
}
.dash-ask__box {
  border: 1px solid color-mix(in srgb, var(--dash-line) 25%, transparent);
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--dash-line) 7%, transparent),
    color-mix(in srgb, var(--text) 2%, transparent)
  );
  border-radius: 12px;
  padding: 16px 16px 12px 16px;
}
.dash-ask__box textarea {
  width: 100%;
  resize: none;
  border: none;
  outline: none;
  background: transparent;
  color: var(--text);
  font-size: 15px;
  line-height: 1.5;
  font-family: inherit;
}
.dash-ask__boxrow {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 6px;
}
.dash-ask__boxrow .dash-btn--primary {
  margin-left: auto;
}
.dash-ask__hint {
  font-family: var(--dash-mono);
  font-size: 10px;
  color: var(--text-dim);
}
.dash-ask__suggestions {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.dash-ask__suggestion {
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border-radius: 9px;
  border: 1px solid var(--rail-br);
  background: color-mix(in srgb, var(--text) 1.5%, transparent);
  font-size: 13.5px;
  color: var(--text-2);
  text-align: left;
}
.dash-ask__suggestion:hover {
  border-color: color-mix(in srgb, var(--dash-line) 30%, transparent);
  color: var(--text);
  background: color-mix(in srgb, var(--dash-line) 7%, transparent);
}
.dash-ask__saved {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}
.dash-saved-card {
  cursor: pointer;
  padding: 13px 14px;
  border-radius: 9px;
  border: 1px solid var(--rail-br);
  background: color-mix(in srgb, var(--text) 1.5%, transparent);
  display: flex;
  flex-direction: column;
  gap: 6px;
  text-align: left;
}
.dash-saved-card:hover {
  border-color: color-mix(in srgb, var(--dash-line) 28%, transparent);
  background: color-mix(in srgb, var(--dash-line) 6%, transparent);
}
.dash-saved-card__title {
  font-size: 13px;
  color: var(--text);
  line-height: 1.35;
}
.dash-saved-card__meta {
  font-family: var(--dash-mono);
  font-size: 10px;
  color: var(--text-dim);
}

/* ---- composing view ---- */
.dash-composing {
  flex: 1;
  min-height: 0;
  display: flex;
  justify-content: center;
  padding: 90px 26px;
}
.dash-composing__inner {
  width: 100%;
  max-width: 620px;
}
.dash-composing__query {
  font-size: 20px;
  color: var(--text);
  margin-bottom: 6px;
  line-height: 1.4;
}
.dash-composing__hint {
  font-family: var(--dash-mono);
  font-size: 10px;
  letter-spacing: 0.12em;
  color: var(--text-dim);
  margin-bottom: 26px;
}
.dash-composing__steps {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.dash-composing__step {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 13.5px;
  color: var(--text-dim);
}
.dash-composing__step--done {
  color: var(--text-2);
}
.dash-composing__step--active {
  color: var(--text);
}
.dash-composing__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--text-dim) 50%, transparent);
}
.dash-composing__step--done .dash-composing__dot {
  background: var(--dash-ok);
}
.dash-composing__step--active .dash-composing__dot {
  background: var(--dash-line);
  animation: dash-pulse 1s ease-in-out infinite;
}
.dash-composing__track {
  margin-top: 32px;
  height: 2px;
  border-radius: 2px;
  background: color-mix(in srgb, var(--text) 6%, transparent);
  overflow: hidden;
}
.dash-composing__sweep {
  width: 40%;
  height: 100%;
  background: var(--dash-line);
  animation: dash-sweep 1.3s ease-in-out infinite;
}
@keyframes dash-pulse {
  0%,
  100% {
    opacity: 0.25;
  }
  50% {
    opacity: 1;
  }
}
@keyframes dash-sweep {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(220%);
  }
}

/* ---- board view ---- */
.dash-board {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px 12px 34px 12px;
}
.dash-board__banner {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  padding: 14px 16px;
  border-radius: 10px;
  border: 1px solid color-mix(in srgb, var(--dash-line) 22%, transparent);
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--dash-line) 8%, transparent),
    color-mix(in srgb, var(--text) 1.5%, transparent)
  );
  margin-bottom: 12px;
}
.dash-board__banner > svg {
  flex-shrink: 0;
  margin-top: 2px;
  color: var(--dash-line);
}
.dash-board__question {
  font-size: 16px;
  color: var(--text);
  margin-bottom: 5px;
  line-height: 1.4;
}
.dash-board__answer {
  font-size: 13px;
  color: var(--text-2);
  line-height: 1.55;
  text-wrap: pretty;
}
.dash-board__meta {
  margin-top: 9px;
  display: flex;
  gap: 14px;
  font-family: var(--dash-mono);
  font-size: 10px;
  color: var(--text-dim);
}
.dash-board__kpis {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
  margin-bottom: 12px;
}
.dash-kpi {
  padding: 16px 16px 14px 16px;
  border-radius: 10px;
  border: 1px solid var(--rail-br);
  background: color-mix(in srgb, var(--text) 2%, transparent);
  animation: rise 0.4s ease both;
}
.dash-kpi__label {
  font-family: var(--dash-mono);
  font-size: 10px;
  letter-spacing: 0.12em;
  color: var(--text-dim);
  margin-bottom: 12px;
}
.dash-kpi__row {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.dash-kpi__value {
  font-size: 30px;
  font-weight: 500;
  color: var(--text);
  letter-spacing: -0.02em;
}
.dash-kpi__delta {
  font-size: 12px;
}
.dash-kpi__meter {
  margin-top: 10px;
  height: 3px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--text) 5%, transparent);
  overflow: hidden;
}
.dash-kpi__fill {
  height: 100%;
  opacity: 0.7;
}
.dash-tone--ok {
  color: var(--dash-ok);
}
.dash-tone--watch {
  color: var(--dash-watch);
}
.dash-tone--high {
  color: var(--dash-high);
}
.dash-fill--ok {
  background: var(--dash-ok);
}
.dash-fill--watch {
  background: var(--dash-watch);
}
.dash-fill--high {
  background: var(--dash-high);
}

.dash-board__charts {
  display: grid;
  grid-template-columns: 1.6fr 1fr;
  gap: 12px;
  margin-bottom: 12px;
}
.dash-panel {
  padding: 16px 18px;
  border-radius: 10px;
  border: 1px solid var(--rail-br);
  background: color-mix(in srgb, var(--text) 2%, transparent);
  display: flex;
  flex-direction: column;
}
.dash-panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  font-size: 13px;
  color: var(--text);
  margin-bottom: 4px;
}
.dash-panel__legend {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-family: var(--dash-mono);
  font-size: 10px;
  color: var(--text-2);
}
.dash-legend__swatch {
  display: inline-block;
  width: 10px;
  height: 3px;
  border-radius: 2px;
  margin-left: 10px;
}
.dash-legend__swatch--line {
  background: var(--dash-line);
}
.dash-legend__swatch--ref {
  background: var(--text-dim);
}
.dash-panel__sub {
  font-family: var(--dash-mono);
  font-size: 10px;
  color: var(--text-dim);
  margin-bottom: 18px;
}
.dash-chart {
  position: relative;
  margin-top: 12px;
}
.dash-chart svg {
  width: 100%;
  height: 200px;
  display: block;
}
.dash-chart__grid {
  stroke: color-mix(in srgb, var(--text) 6%, transparent);
  stroke-width: 1;
  fill: none;
}
.dash-chart__line {
  stroke: var(--dash-line);
  stroke-width: 2;
  fill: none;
  stroke-linejoin: round;
  stroke-linecap: round;
}
.dash-chart__ref {
  stroke: var(--text-dim);
  stroke-width: 1.6;
  stroke-dasharray: 4 4;
  fill: none;
  stroke-linejoin: round;
}
.dash-chart__cross {
  stroke: var(--pill-br);
  stroke-width: 1;
}
.dash-chart__hit {
  fill: transparent;
  pointer-events: all;
}
.dash-chart__tip {
  position: absolute;
  top: 0;
  transform: translateX(-50%);
  pointer-events: none;
  white-space: nowrap;
  font-family: var(--dash-mono);
  font-size: 11px;
  color: var(--text);
  background: var(--pill);
  border: 1px solid var(--pill-br);
  border-radius: 6px;
  padding: 4px 8px;
  backdrop-filter: blur(8px);
}
.dash-chart__weeks {
  display: flex;
  justify-content: space-between;
  margin-top: 8px;
  font-family: var(--dash-mono);
  font-size: 9.5px;
  color: var(--text-dim);
}
.dash-stagebars {
  flex: 1;
  min-height: 190px;
  display: flex;
  align-items: stretch;
  gap: 14px;
  padding-bottom: 10px;
}
.dash-stagebars__col {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
}
.dash-stagebars__num {
  font-family: var(--dash-mono);
  font-size: 11px;
  color: var(--text);
}
.dash-stagebars__bar {
  width: 100%;
  flex-shrink: 0;
  border-radius: 5px 5px 2px 2px;
  background: var(--dash-line);
}
.dash-stagebars__bar--dim {
  opacity: 0.35;
}
.dash-stagebars__lab {
  font-family: var(--dash-mono);
  font-size: 9.5px;
  letter-spacing: 0.08em;
  color: var(--text-dim);
}

.dash-table {
  border-radius: 10px;
  border: 1px solid var(--rail-br);
  background: color-mix(in srgb, var(--text) 2%, transparent);
  overflow: hidden;
}
.dash-table__toprow {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 15px 18px 13px 18px;
  font-size: 13px;
  color: var(--text);
}
.dash-table__sort {
  font-family: var(--dash-mono);
  font-size: 10px;
  color: var(--text-dim);
}
.dash-table table {
  width: 100%;
  border-collapse: collapse;
}
.dash-table th {
  text-align: left;
  padding: 8px 18px;
  border-top: 1px solid var(--rail-br);
  border-bottom: 1px solid var(--rail-br);
  font-family: var(--dash-mono);
  font-size: 9.5px;
  letter-spacing: 0.1em;
  color: var(--text-dim);
  font-weight: 400;
}
.dash-table td {
  padding: 13px 18px;
  border-bottom: 1px solid color-mix(in srgb, var(--text) 4%, transparent);
  font-size: 13px;
  color: var(--text-2);
}
.dash-table tbody tr:hover {
  background: color-mix(in srgb, var(--text) 2%, transparent);
}
.dash-table tbody tr:last-child td {
  border-bottom: none;
}
.dash-table__group {
  color: var(--text);
}
.dash-table__dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 2px;
  margin-right: 9px;
}
.dash-table__num {
  font-family: var(--dash-mono);
}
.dash-table__spark {
  width: 100%;
  max-width: 120px;
  height: 22px;
  display: block;
}
.dash-table__spark path {
  fill: none;
  stroke-width: 1.6;
  stroke-linejoin: round;
}
.dash-spark--ok {
  stroke: var(--dash-ok);
}
.dash-spark--watch {
  stroke: var(--dash-watch);
}
.dash-spark--high {
  stroke: var(--dash-high);
}
.dash-pill {
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 999px;
}
.dash-pill--ok {
  color: var(--dash-ok);
  border: 1px solid color-mix(in srgb, var(--dash-ok) 30%, transparent);
  background: color-mix(in srgb, var(--dash-ok) 8%, transparent);
}
.dash-pill--watch {
  color: var(--dash-watch);
  border: 1px solid color-mix(in srgb, var(--dash-watch) 30%, transparent);
  background: color-mix(in srgb, var(--dash-watch) 8%, transparent);
}
.dash-pill--high {
  color: var(--dash-high);
  border: 1px solid color-mix(in srgb, var(--dash-high) 35%, transparent);
  background: color-mix(in srgb, var(--dash-high) 9%, transparent);
}
.dash-board__followups {
  margin-top: 14px;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.dash-followup {
  cursor: pointer;
  font-size: 12.5px;
  color: var(--text-2);
  padding: 8px 13px;
  border-radius: 999px;
  border: 1px dashed color-mix(in srgb, var(--text) 14%, transparent);
  background: transparent;
}
.dash-followup:hover {
  color: var(--text);
  border-color: color-mix(in srgb, var(--dash-line) 40%, transparent);
  background: color-mix(in srgb, var(--dash-line) 7%, transparent);
}
```

- [ ] **Step 2: Import it as layer(legacy)**

In `control-plane/src/styles/heroui.css`, find the existing `@import` that pulls in `components.css` with `layer(legacy)` (the file's comment block explains this is where layer assignment happens). Add directly below it:

```css
@import url("./dashboards.css") layer(legacy);
```

- [ ] **Step 3: Give the stage the edge-to-edge layout**

In `control-plane/src/styles/base.css` (~line 122), extend the existing rule:

```css
.stage.board-stage,
.stage.map-stage {
```
becomes
```css
.stage.board-stage,
.stage.map-stage,
.stage.dashboards-stage {
```
Do not change the rule body.

- [ ] **Step 4: Verify nothing broke**

Run: `cd control-plane && pnpm lint && pnpm test src/styles/tokens.test.ts`
Expected: lint exits 0 (the 2 permanent biome.json diagnostics are pre-existing); tokens test PASSES.

- [ ] **Step 5: Diff-check the shared files, then commit**

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents diff control-plane/src/styles/heroui.css control-plane/src/styles/base.css
```
Confirm: exactly one added `@import` line in heroui.css, exactly one added selector line in base.css, nothing else. Then:

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents add control-plane/src/styles/dashboards.css control-plane/src/styles/heroui.css control-plane/src/styles/base.css
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents commit -m "feat: dashboards stage styles — own file, so components.css stays other agents' land"
```
Verify 3 files changed.

---

### Task 8: Route + rail wiring

**Files:**
- Modify: `control-plane/src/router.tsx` (import, route component, route const at ~line 108, `addChildren` at ~line 110)
- Modify: `control-plane/src/organisms/ToolRail.tsx` (icon import, one `Sidebar.MenuItem` after Map)
- Test: `control-plane/src/router.test.tsx` (one new `it`), `control-plane/src/organisms/ToolRail.test.tsx` (two new `it`s)

**Interfaces:**
- Consumes: `DashboardsStage` (Task 6).
- Produces: route `/dashboards`; rail row named "Dashboards". Nothing later depends on this.

**NOTE:** All four files are pre-existing. Diff-check each before staging (Global Constraints).

- [ ] **Step 1: Write the failing tests**

Append inside `describe("stage routing", …)` in `control-plane/src/router.test.tsx`, right after the "board tool navigates" test (~line 108). This mirrors that test exactly — `Sidebar.MenuItem` is RAC TreeItem (`role="row"`), and the current item is marked with `data-current`, not `aria-current`:

```tsx
  it("dashboards tool navigates to /dashboards and highlights itself", async () => {
    const router = await renderAt("/");
    await userEvent.click(screen.getByRole("row", { name: /^dashboards$/i }));
    expect(await screen.findByRole("region", { name: "Dashboards" })).toBeTruthy();
    expect(router.state.location.pathname).toBe("/dashboards");
    expect(screen.getByRole("row", { name: /^dashboards$/i }).getAttribute("data-current")).toBe("true");
  });
```

Append inside `describe("ToolRail", …)` in `control-plane/src/organisms/ToolRail.test.tsx`, after the "map tool navigates" test:

```tsx
  it("dashboards tool navigates via the Provider", async () => {
    const { navigate } = renderRail();
    await userEvent.click(screen.getByRole("row", { name: "Dashboards" }));
    expect(navigate).toHaveBeenCalledWith("/dashboards");
  });

  it("dashboards tool is highlighted only when activeRoute is /dashboards", () => {
    renderRail({ activeRoute: "/dashboards" });
    expect(screen.getByRole("row", { name: "Dashboards" }).getAttribute("data-current")).toBe("true");
    expect(screen.getByRole("row", { name: "Board" }).getAttribute("data-current")).toBeNull();
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd control-plane && pnpm test src/router.test.tsx src/organisms/ToolRail.test.tsx`
Expected: the 3 new tests FAIL (no row named "Dashboards"); every pre-existing test still PASSES.

- [ ] **Step 3: Wire the route**

In `control-plane/src/router.tsx`:

Add to the organism imports (after the `MapStage` import):
```tsx
import { DashboardsStage } from "./organisms/DashboardsStage";
```

Add next to `MapRoute` (~line 77):
```tsx
function DashboardsRoute() {
  return <DashboardsStage />;
}
```

Add with the route consts (~line 108):
```tsx
const dashboardsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/dashboards",
  component: DashboardsRoute,
});
```

And register it (~line 110):
```tsx
const routeTree = rootRoute.addChildren([indexRoute, boardRoute, mapRoute, dashboardsRoute, workRoute]);
```

- [ ] **Step 4: Wire the rail**

In `control-plane/src/organisms/ToolRail.tsx`, extend the lucide import:
```tsx
import { History, Map as MapIcon, Plus, Settings, SquareKanban, TrendingUp } from "lucide-react";
```
(`TrendingUp` is the same trending-line glyph the source design uses for its dashboards icon.)

Add after the Map `Sidebar.MenuItem` (before `</Sidebar.Menu>`):
```tsx
          <Sidebar.MenuItem href="/dashboards" isCurrent={activeRoute === "/dashboards"}>
            <Sidebar.MenuIcon>
              <TrendingUp />
            </Sidebar.MenuIcon>
            <Sidebar.MenuItemContent>
              <Sidebar.MenuLabel>Dashboards</Sidebar.MenuLabel>
            </Sidebar.MenuItemContent>
          </Sidebar.MenuItem>
```

Also update the `activeRoute` doc comment on `ToolRailProps` to include `"/dashboards"`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd control-plane && pnpm test src/router.test.tsx src/organisms/ToolRail.test.tsx`
Expected: PASS, including all pre-existing tests.

- [ ] **Step 6: Diff-check the shared files, then commit**

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents diff control-plane/src/router.tsx control-plane/src/organisms/ToolRail.tsx control-plane/src/router.test.tsx control-plane/src/organisms/ToolRail.test.tsx
```
Confirm every hunk is the wiring above. Then:

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents add control-plane/src/router.tsx control-plane/src/organisms/ToolRail.tsx control-plane/src/router.test.tsx control-plane/src/organisms/ToolRail.test.tsx
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents commit -m "feat: dashboards is a stage — one route, one rail row"
```
Verify 4 files changed.

---

### Task 9: Full verification

**Files:** none created — this task gates the branch.

- [ ] **Step 1: Typecheck**

Run: `cd control-plane && pnpm typecheck`
Expected: exit 0, no output.

- [ ] **Step 2: Lint**

Run: `cd control-plane && pnpm lint; echo "exit=$?"` — read the exit code from the echo, not from a pipe.
Expected: `exit=0`. The 2 permanent biome.json config diagnostics are pre-existing; any OTHER diagnostic is yours — fix it.

- [ ] **Step 3: Full test suite**

Run: `cd control-plane && pnpm test`
Expected: everything green — the new ~28 tests plus every pre-existing test. If a pre-existing test fails, check whether it fails on a clean checkout of the branch tip before touching it (other agents' uncommitted work is in this tree — do not "fix" their tests).

- [ ] **Step 4: Visual smoke (report, don't gate)**

If a dev server is practical (`cd control-plane && pnpm dev`), open `#/dashboards`, click a suggestion, watch the compose walk, hover the chart, save, and return via "new question" — in dark AND light theme. If not practical in this session, state plainly in the final report that the visual smoke was NOT run.

- [ ] **Step 5: Report**

Report the suite count, lint/typecheck status, and visual-smoke status honestly. No commit here unless fixes were needed (commit any fix with its own message).

---

## Self-Review (done at plan time)

- **Spec coverage:** three views ✔ (Tasks 3–5), state machine + timer hygiene + save/reset/fallback ✔ (Task 6), route + rail ✔ (Task 8), styling with theme tokens + both themes ✔ (Task 7), data module ✔ (Task 2), path helpers + flat-series NaN guard ✔ (Task 1), all spec test cases mapped ✔ (Tasks 1–6, 8).
- **Type consistency:** `SavedDashboard {id,title,meta}` produced in Task 2, consumed in Tasks 4/6; `seriesPath`/`sparkPath` signatures identical in Tasks 1/5; `DashRisk` drives `dash-tone--*`/`dash-fill--*`/`dash-pill--*`/`dash-spark--*` class families defined in Task 7.
- **Placeholder scan:** none — every step carries its code.
