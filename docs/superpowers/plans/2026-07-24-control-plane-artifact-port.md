# Control-Plane Artifact Port (Web + Tauri) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the partial hand-port in `control-plane/src/` with a faithful atomic-design React port of claude.ai artifact 9095b184 that runs as a plain Vite web app, a Tauri 2 macOS desktop app, and an initialized Tauri iOS project.

**Architecture:** Five-level atomic design (atoms → molecules → organisms → templates → pages) with the artifact's CSS carried over nearly verbatim (identical class names) in `src/styles/`, the fisheye canvas isolated in a `useDotGrid` hook, and all state owned by `pages/HomePage`. The front-end uses zero Tauri APIs, so the identical bundle serves both targets; `src-tauri/` is scaffolded with the Tauri CLI.

**Tech Stack:** React 19, TypeScript 5.6, Vite 6, lucide-react, Biome 2, Tauri 2 (CLI + rustup-installed stable Rust).

**Porting reference (committed):** `docs/superpowers/specs/2026-07-24-artifact-9095b184-source.html` — the artifact's markup/styles/script verbatim. "Copy from reference" below always means this file.

## Global Constraints

- Working directory for all npm/tauri commands: `control-plane/`.
- CSS class names, UI copy, and typographic characters (`’`, `…`, `—`, `·`) must match the reference verbatim.
- No `@tauri-apps/api` imports in ported UI code.
- Dev server stays on fixed port 1420 (`vite.config.ts`, matches `devUrl`).
- Biome (`npm run lint`) must pass after every task; if an a11y rule flags a ported pattern (label without control, scrim click handler), keep the artifact's behavior and add a targeted `biome-ignore` comment with a reason rather than restructuring markup.
- `lucide-react` icon approximations of the reference's inline SVGs are acceptable (spec decision); the logo star keeps its custom path.
- Do not touch the Maven modules; JVM build must remain untouched.
- Commit after every task with the trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Style foundation + agent seed data

**Files:**
- Create: `control-plane/src/styles/tokens.css`
- Create: `control-plane/src/styles/base.css`
- Create: `control-plane/src/styles/components.css`
- Create: `control-plane/src/data/agents.ts`

**Interfaces:**
- Consumes: reference file `<style>` block.
- Produces: CSS classes used by all later tasks (`.rail`, `.tool`, `.avatar`, `.roster`, `.mic-hero`, `.composer`, `.tuner`, `.scrim`, `.modal`, `.field`, `.chips`, `.chip`, `.seg`, `.discord-panel`, `.note`, `.check`, `.modal-actions`, `.subhint`, `.greeting`, `.voice`, `.id-head`, `.id-avatar`, `.hidden`); `AgentSeed { id, name, role, ring: string }`, `AGENTS: AgentSeed[]`, `ringForIndex(i: number): string`.

- [ ] **Step 1: Write `styles/tokens.css`** — copy from the reference the three theme blocks verbatim: `:root { … }`, `:root[data-theme="light"] { … }`, and the `@media (prefers-color-scheme: light)` block. Nothing else.

- [ ] **Step 2: Write `styles/base.css`** — copy from the reference, verbatim: `* { box-sizing }`, `html, body`, `body`, `#bg`, `main`, `.subhint` (+ its `kbd` rule), `@keyframes rise`, `@keyframes ring`, and the `@media (prefers-reduced-motion: reduce)` block. Add one rule not in the reference:

```css
#root { height: 100%; }
```

- [ ] **Step 3: Write `styles/components.css`** — copy from the reference, verbatim, every remaining rule: the `/* ---- shared rails ---- */` section through `.add:hover`, `.greeting`/`.voice`/`.mic-hero`/`.mic-caption`/`.composer`/`.selector` rules, the `/* tiny hidden tuner */` section, and the `/* ---- add-agent modal ---- */` section through `.hidden`. Add one rule (replaces the reference's inline `#roster` style):

```css
.roster { display: flex; flex-direction: column; gap: 12px; align-items: center; }
```

- [ ] **Step 4: Write `src/data/agents.ts`**

```ts
export interface AgentSeed {
  id: string;
  name: string;
  role: string;
  ring: string;
}

// Mirrors the personas module: agents are data, never a hardcoded enum.
export const AGENTS: AgentSeed[] = [
  { id: "manuel", name: "Manuel", role: "Architect", ring: "#6f8dff" },
  { id: "octavio", name: "Octavio", role: "Security / Integration", ring: "#e0a15a" },
  { id: "aurelio", name: "Aurelio", role: "UI Purist", ring: "#d977c8" },
];

export const RING_PALETTE = ["#6f8dff", "#e0a15a", "#d977c8", "#5fd0b0", "#f2778f", "#9b8cff"];

export function ringForIndex(i: number): string {
  return RING_PALETTE[i % RING_PALETTE.length] ?? "#6f8dff";
}
```

- [ ] **Step 5: Verify build still green** — Run in `control-plane/`: `npm install && npm run build`. Expected: tsc silent, `vite build` reports `✓ built`. (New files are not imported yet; this guards against syntax errors.)

- [ ] **Step 6: Commit**

```bash
git add control-plane/src/styles control-plane/src/data docs/superpowers/specs/2026-07-24-artifact-9095b184-source.html
git commit -m "feat(control-plane): port artifact styles + agent seed data"
```

---

### Task 2: useDotGrid hook + atoms

**Files:**
- Create: `control-plane/src/hooks/useDotGrid.ts`
- Create: `control-plane/src/atoms/Logo.tsx`
- Create: `control-plane/src/atoms/ToolButton.tsx`
- Create: `control-plane/src/atoms/Avatar.tsx`
- Create: `control-plane/src/atoms/Chip.tsx`
- Create: `control-plane/src/atoms/Field.tsx`
- Create: `control-plane/src/atoms/SegmentedControl.tsx`

**Interfaces:**
- Consumes: CSS classes from Task 1.
- Produces:
  - `GridParams { distortion, radius, spacing, dotSize, glow, base: number }`, `GridParamMeta { min, max, step: number, label: string }`, `GRID_DEFAULTS: GridParams`, `GRID_META: Record<keyof GridParams, GridParamMeta>`, `useDotGrid(canvasRef: RefObject<HTMLCanvasElement | null>, params: GridParams): void`
  - `Logo()`; `ToolButton({ icon: LucideIcon, label: string, active?: boolean, onClick?: () => void })`; `Avatar({ initial: string, label: string, ring?: string, style?: CSSProperties, onClick?: () => void, children?: ReactNode })`; `Chip({ label: string, pressed: boolean, onToggle: () => void })`; `Field({ label: ReactNode, htmlFor?: string, style?: CSSProperties, children: ReactNode })`; `SegmentedControl({ options: {id, label: string}[], selected: string, onSelect: (id: string) => void, ariaLabel: string })`

- [ ] **Step 1: Write `hooks/useDotGrid.ts`** — a line-faithful port of the reference's `/* ---- fisheye dot grid ---- */` script section into one mount effect. The RAF loop reads live params through a ref (sliders update without re-subscribing) and rebuilds the grid when `spacing` changes:

```ts
import { type RefObject, useEffect, useRef } from "react";

export interface GridParams {
  distortion: number;
  radius: number;
  spacing: number;
  dotSize: number;
  glow: number;
  base: number;
}

export interface GridParamMeta {
  min: number;
  max: number;
  step: number;
  label: string;
}

export const GRID_DEFAULTS: GridParams = {
  distortion: 1.6,
  radius: 170,
  spacing: 36,
  dotSize: 1.2,
  glow: 0.85,
  base: 0.26,
};

export const GRID_META: Record<keyof GridParams, GridParamMeta> = {
  distortion: { min: 0.4, max: 4, step: 0.1, label: "distortion" },
  radius: { min: 90, max: 420, step: 10, label: "radius" },
  spacing: { min: 22, max: 64, step: 2, label: "spacing" },
  dotSize: { min: 0.6, max: 2.6, step: 0.1, label: "dot size" },
  glow: { min: 0, max: 1, step: 0.05, label: "glow" },
  base: { min: 0.08, max: 0.6, step: 0.02, label: "quietness" },
};

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function hexToRgb(hex: string): Rgb {
  let h = (hex || "").trim().replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = Number.parseInt(h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** Fisheye dot-grid background — the artifact's canvas loop, theme-reactive. */
export function useDotGrid(canvasRef: RefObject<HTMLCanvasElement | null>, params: GridParams): void {
  const paramsRef = useRef(params);
  paramsRef.current = params;

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const TAU = Math.PI * 2;
    const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let colDot: Rgb = { r: 34, g: 42, b: 56 };
    let colHi: Rgb = { r: 122, g: 162, b: 255 };
    const readColors = () => {
      const cs = getComputedStyle(document.documentElement);
      colDot = hexToRgb(cs.getPropertyValue("--dot"));
      colHi = hexToRgb(cs.getPropertyValue("--dot-hi"));
    };

    let W = 0;
    let H = 0;
    let dots: { x: number; y: number }[] = [];
    let builtSpacing = paramsRef.current.spacing;
    const buildGrid = () => {
      const s = paramsRef.current.spacing;
      builtSpacing = s;
      dots = [];
      const cols = Math.floor(W / s);
      const rows = Math.floor(H / s);
      const ox = (W - (cols - 1) * s) / 2;
      const oy = (H - (rows - 1) * s) / 2;
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) dots.push({ x: ox + c * s, y: oy + r * s });
    };
    const resize = () => {
      const dpr = Math.min(devicePixelRatio || 1, 2);
      W = innerWidth;
      H = innerHeight;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      canvas.style.width = `${W}px`;
      canvas.style.height = `${H}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      buildGrid();
    };

    let fx = 0;
    let fy = 0;
    let tx = 0;
    let ty = 0;
    let hasMouse = false;
    let lastMove = -1e9;
    let hidden = false;
    const onMove = (e: PointerEvent) => {
      tx = e.clientX;
      ty = e.clientY;
      hasMouse = true;
      lastMove = performance.now();
    };
    const onLeave = () => {
      hasMouse = false;
    };
    const onVisibility = () => {
      hidden = document.hidden;
    };

    let raf = 0;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (hidden) return;
      const p = paramsRef.current;
      if (p.spacing !== builtSpacing) buildGrid();
      const idle = !hasMouse || now - lastMove > 2600;
      if (idle && !reduceMotion) {
        const t = now * 0.00015;
        tx = W / 2 + Math.cos(t) * Math.min(W, H) * 0.2;
        ty = H * 0.6 + Math.sin(t * 0.9) * Math.min(W, H) * 0.12;
      } else if (idle && reduceMotion) {
        tx = -1e5;
        ty = -1e5;
      }
      const ease = reduceMotion ? 1 : 0.15;
      fx += (tx - fx) * ease;
      fy += (ty - fy) * ease;
      const R = p.radius;
      const D = p.distortion;
      const R2 = R * R;
      let k0 = Math.exp(D);
      k0 = (k0 / (k0 - 1)) * R;
      const k1 = D / R;
      ctx.clearRect(0, 0, W, H);
      for (const dot of dots) {
        const dx = dot.x - fx;
        const dy = dot.y - fy;
        const d2 = dx * dx + dy * dy;
        let px = dot.x;
        let py = dot.y;
        let t = 0;
        if (d2 < R2) {
          const dd = Math.sqrt(d2);
          if (dd > 0.5) {
            const k = ((k0 * (1 - Math.exp(-dd * k1))) / dd) * 0.75 + 0.25;
            px = fx + dx * k;
            py = fy + dy * k;
            t = Math.max(0, Math.min(1, (k - 1) / 1.4));
          }
        }
        const rad = p.dotSize * (1 + t * 1.7);
        const cT = t * p.glow;
        const r = (colDot.r + (colHi.r - colDot.r) * cT) | 0;
        const g = (colDot.g + (colHi.g - colDot.g) * cT) | 0;
        const b = (colDot.b + (colHi.b - colDot.b) * cT) | 0;
        const a = p.base + (0.9 - p.base) * cT;
        ctx.beginPath();
        ctx.arc(px, py, rad, 0, TAU);
        ctx.fillStyle = `rgba(${r},${g},${b},${a.toFixed(3)})`;
        ctx.fill();
      }
    };

    const scheme = matchMedia("(prefers-color-scheme: dark)");
    const observer = new MutationObserver(readColors);

    readColors();
    scheme.addEventListener("change", readColors);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    addEventListener("pointermove", onMove, { passive: true });
    addEventListener("pointerleave", onLeave);
    document.addEventListener("visibilitychange", onVisibility);
    addEventListener("resize", resize);
    resize();
    fx = tx = W / 2;
    fy = ty = H * 0.6;
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      removeEventListener("resize", resize);
      removeEventListener("pointermove", onMove);
      removeEventListener("pointerleave", onLeave);
      document.removeEventListener("visibilitychange", onVisibility);
      scheme.removeEventListener("change", readColors);
      observer.disconnect();
    };
  }, [canvasRef]);
}
```

- [ ] **Step 2: Write `atoms/Logo.tsx`**

```tsx
/** Four-point spark — the smithagents mark (the artifact's custom path, not a lucide glyph). */
export function Logo() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} role="img" aria-label="smithagents">
      <path d="M12 2l2.4 5.6L20 10l-5.6 2.4L12 18l-2.4-5.6L4 10l5.6-2.4z" />
    </svg>
  );
}
```

- [ ] **Step 3: Write `atoms/ToolButton.tsx`** (if `lucide-react` does not export the `LucideIcon` type in the installed version, substitute `ComponentType<{ strokeWidth?: number | string }>` from react):

```tsx
import type { LucideIcon } from "lucide-react";

interface ToolButtonProps {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  onClick?: () => void;
}

export function ToolButton({ icon: Icon, label, active = false, onClick }: ToolButtonProps) {
  return (
    <button
      type="button"
      className="tool"
      aria-current={active ? "true" : undefined}
      title={label}
      aria-label={label}
      onClick={onClick}
    >
      <Icon strokeWidth={1.7} />
    </button>
  );
}
```

- [ ] **Step 4: Write `atoms/Avatar.tsx`**

```tsx
import type { CSSProperties, ReactNode } from "react";

interface AvatarProps {
  initial: string;
  label: string;
  ring?: string;
  style?: CSSProperties;
  onClick?: () => void;
  children?: ReactNode;
}

/** Circular identity button; ring color arrives via the --ring custom property. */
export function Avatar({ initial, label, ring, style, onClick, children }: AvatarProps) {
  const ringStyle = { ...(ring ? { "--ring": ring } : {}), ...style } as CSSProperties;
  return (
    <button type="button" className="avatar" style={ringStyle} title={label} aria-label={label} onClick={onClick}>
      {initial}
      {children}
    </button>
  );
}
```

- [ ] **Step 5: Write `atoms/Chip.tsx`**

```tsx
interface ChipProps {
  label: string;
  pressed: boolean;
  onToggle: () => void;
}

export function Chip({ label, pressed, onToggle }: ChipProps) {
  return (
    <button type="button" className="chip" aria-pressed={pressed} onClick={onToggle}>
      {label}
    </button>
  );
}
```

- [ ] **Step 6: Write `atoms/Field.tsx`**

```tsx
import type { CSSProperties, ReactNode } from "react";

interface FieldProps {
  label: ReactNode;
  htmlFor?: string;
  style?: CSSProperties;
  children: ReactNode;
}

export function Field({ label, htmlFor, style, children }: FieldProps) {
  return (
    <div className="field" style={style}>
      <label htmlFor={htmlFor}>{label}</label>
      {children}
    </div>
  );
}
```

- [ ] **Step 7: Write `atoms/SegmentedControl.tsx`**

```tsx
interface SegmentedOption {
  id: string;
  label: string;
}

interface SegmentedControlProps {
  options: SegmentedOption[];
  selected: string;
  onSelect: (id: string) => void;
  ariaLabel: string;
}

export function SegmentedControl({ options, selected, onSelect, ariaLabel }: SegmentedControlProps) {
  return (
    <div className="seg" role="tablist" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="tab"
          aria-selected={option.id === selected}
          onClick={() => onSelect(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 8: Verify** — `npm run build` green, `npm run lint` clean (fix per Global Constraints if not).

- [ ] **Step 9: Commit** — `git add control-plane/src && git commit -m "feat(control-plane): dot-grid hook + atoms"`

---

### Task 3: Molecules

**Files:**
- Create: `control-plane/src/molecules/AgentAvatar.tsx`
- Create: `control-plane/src/molecules/MicHero.tsx`
- Create: `control-plane/src/molecules/Composer.tsx`
- Create: `control-plane/src/molecules/TunerRow.tsx`
- Create: `control-plane/src/molecules/DiscordIdentityPanel.tsx`

**Interfaces:**
- Consumes: `Avatar`, `Field`, `SegmentedControl` from Task 2; `GridParamMeta` from `useDotGrid`.
- Produces: `AgentAvatar({ name, role, ring: string })`; `MicHero({ live: boolean, onToggle: () => void })`; `Composer()`; `TunerRow({ meta: GridParamMeta, value: number, onChange: (value: number) => void })`; `DiscordMode = "webhook" | "bot"`; `DiscordIdentityPanel({ mode: DiscordMode, onModeChange: (mode: DiscordMode) => void, hidden?: boolean })`.

- [ ] **Step 1: Write `molecules/AgentAvatar.tsx`**

```tsx
import { Avatar } from "../atoms/Avatar";

interface AgentAvatarProps {
  name: string;
  role: string;
  ring: string;
}

export function AgentAvatar({ name, role, ring }: AgentAvatarProps) {
  return (
    <Avatar initial={name[0]?.toUpperCase() ?? "?"} ring={ring} label={`${name}, ${role}`}>
      <span className="status" />
      <span className="tip">
        <b>{name}</b>
        <span>{role}</span>
      </span>
    </Avatar>
  );
}
```

- [ ] **Step 2: Write `molecules/MicHero.tsx`**

```tsx
import { Mic } from "lucide-react";

interface MicHeroProps {
  live: boolean;
  onToggle: () => void;
}

export function MicHero({ live, onToggle }: MicHeroProps) {
  return (
    <div className="voice">
      <button
        type="button"
        className={live ? "mic-hero live" : "mic-hero"}
        title="Push to talk"
        aria-label="Push to talk"
        aria-pressed={live}
        onClick={onToggle}
      >
        <Mic strokeWidth={1.7} />
      </button>
      <div className="mic-caption">
        {live ? (
          <>
            <b style={{ color: "var(--accent)" }}>Listening…</b> tap to stop
          </>
        ) : (
          <>
            <b>Push to talk</b> — or type below
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Write `molecules/Composer.tsx`**

```tsx
import { ChevronDown, Plus } from "lucide-react";

export function Composer() {
  return (
    <form className="composer" onSubmit={(e) => e.preventDefault()}>
      <button type="button" className="plus" title="Attach screenshot or file" aria-label="Attach">
        <Plus strokeWidth={1.7} />
      </button>
      <input type="text" placeholder="Type a request…" aria-label="Type a request" />
      <div className="selector" role="button" tabIndex={0} title="Route to a specific agent, or let the swarm decide">
        Swarm
        <ChevronDown strokeWidth={2} />
      </div>
    </form>
  );
}
```

- [ ] **Step 4: Write `molecules/TunerRow.tsx`**

```tsx
import type { GridParamMeta } from "../hooks/useDotGrid";

interface TunerRowProps {
  meta: GridParamMeta;
  value: number;
  onChange: (value: number) => void;
}

export function TunerRow({ meta, value, onChange }: TunerRowProps) {
  return (
    <div className="r">
      <div className="t">
        <span>{meta.label}</span>
        <output>{meta.step < 1 ? value.toFixed(2) : String(value)}</output>
      </div>
      <input
        type="range"
        min={meta.min}
        max={meta.max}
        step={meta.step}
        value={value}
        aria-label={meta.label}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}
```

- [ ] **Step 5: Write `molecules/DiscordIdentityPanel.tsx`** — both mode panels stay mounted (`.hidden` class), matching the reference and preserving typed-but-hidden token/guild values:

```tsx
import { Field } from "../atoms/Field";
import { SegmentedControl } from "../atoms/SegmentedControl";

export type DiscordMode = "webhook" | "bot";

interface DiscordIdentityPanelProps {
  mode: DiscordMode;
  onModeChange: (mode: DiscordMode) => void;
  hidden?: boolean;
}

export function DiscordIdentityPanel({ mode, onModeChange, hidden = false }: DiscordIdentityPanelProps) {
  return (
    <div className={hidden ? "field hidden" : "field"}>
      <label>Discord identity — how it appears on the server</label>
      <SegmentedControl
        ariaLabel="Discord identity mode"
        options={[
          { id: "webhook", label: "Webhook identity" },
          { id: "bot", label: "Dedicated bot" },
        ]}
        selected={mode}
        onSelect={(id) => onModeChange(id as DiscordMode)}
      />
      <div className="discord-panel">
        <div className={mode === "webhook" ? "" : "hidden"}>
          <p className="note">
            <b>Distinct sender — no token.</b> Posts as this agent’s name &amp; avatar in every channel, seen by
            everyone. Rides the shared bot’s <em>Manage&nbsp;Webhooks</em> permission. No presence in the member list.
          </p>
        </div>
        <div className={mode === "bot" ? "" : "hidden"}>
          <p className="note">
            <b>A real member.</b> Appears in the member list with presence and can join voice — needs its own bot
            token.
          </p>
          <Field label="Bot token" htmlFor="agToken" style={{ marginTop: 12 }}>
            <input id="agToken" type="password" placeholder="paste the agent’s bot token" autoComplete="off" />
          </Field>
          <label className="check">
            <input type="checkbox" defaultChecked /> Enable the <b>MESSAGE_CONTENT</b> intent
          </label>
          <Field label="Guild ID" htmlFor="agGuild" style={{ marginTop: 12 }}>
            <input id="agGuild" type="text" placeholder="defaults to GUILD_ID from .env" />
          </Field>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Verify** — `npm run build` green, `npm run lint` clean.

- [ ] **Step 7: Commit** — `git add control-plane/src && git commit -m "feat(control-plane): molecules (mic, composer, tuner row, discord identity)"`

---

### Task 4: Organisms

**Files:**
- Create: `control-plane/src/organisms/ToolRail.tsx`
- Create: `control-plane/src/organisms/AgentRoster.tsx`
- Create: `control-plane/src/organisms/VoiceStage.tsx`
- Create: `control-plane/src/organisms/DotGridCanvas.tsx`
- Create: `control-plane/src/organisms/DotGridTuner.tsx`
- Create: `control-plane/src/organisms/AddAgentModal.tsx`

**Interfaces:**
- Consumes: everything from Tasks 1–3.
- Produces: `ToolRail()`; `AgentRoster({ agents: AgentSeed[], onAdd: () => void })`; `VoiceStage({ micLive: boolean, onMicToggle: () => void })`; `DotGridCanvas({ params: GridParams })`; `DotGridTuner({ open: boolean, params: GridParams, onChange: (key: keyof GridParams, value: number) => void, onReset: () => void })`; `AddAgentModal({ open: boolean, onClose: () => void, onCreate: (name: string, role: string) => void })`.

- [ ] **Step 1: Write `organisms/ToolRail.tsx`**

```tsx
import { GitBranch, LayoutGrid, PenLine, Search, Settings, SquareCheck } from "lucide-react";
import type { CSSProperties } from "react";
import { useState } from "react";
import { Avatar } from "../atoms/Avatar";
import { Logo } from "../atoms/Logo";
import { ToolButton } from "../atoms/ToolButton";

const TOOLS = [
  { icon: PenLine, label: "New session" },
  { icon: Search, label: "Search" },
  { icon: SquareCheck, label: "Tasks and activity" },
  { icon: GitBranch, label: "Branches and pull requests" },
  { icon: LayoutGrid, label: "Apps" },
];

const OPERATOR_STYLE = {
  "--ring": "var(--rail-br)",
  background: "linear-gradient(135deg,#3a4358,#232a38)",
  fontSize: 14,
} as CSSProperties;

export function ToolRail() {
  const [active, setActive] = useState(0);
  return (
    <nav className="rail rail--left" aria-label="Tools and activity">
      <div className="logo" title="smithagents">
        <Logo />
      </div>
      {TOOLS.map((tool, i) => (
        <ToolButton
          key={tool.label}
          icon={tool.icon}
          label={tool.label}
          active={i === active}
          onClick={() => setActive(i)}
        />
      ))}
      <div className="spacer" />
      <ToolButton icon={Settings} label="Settings" />
      <Avatar initial="E" label="Edwin · operator" style={OPERATOR_STYLE} />
    </nav>
  );
}
```

- [ ] **Step 2: Write `organisms/AgentRoster.tsx`**

```tsx
import type { AgentSeed } from "../data/agents";
import { AgentAvatar } from "../molecules/AgentAvatar";

interface AgentRosterProps {
  agents: AgentSeed[];
  onAdd: () => void;
}

export function AgentRoster({ agents, onAdd }: AgentRosterProps) {
  return (
    <aside className="rail rail--right" aria-label="Agents">
      <div className="rail__label">agents</div>
      <div className="roster">
        {agents.map((agent) => (
          <AgentAvatar key={agent.id} name={agent.name} role={agent.role} ring={agent.ring} />
        ))}
      </div>
      <button type="button" className="add" onClick={onAdd} title="Configure a new agent" aria-label="Add agent">
        +
      </button>
      <div className="spacer" />
    </aside>
  );
}
```

- [ ] **Step 3: Write `organisms/VoiceStage.tsx`**

```tsx
import { Composer } from "../molecules/Composer";
import { MicHero } from "../molecules/MicHero";

interface VoiceStageProps {
  micLive: boolean;
  onMicToggle: () => void;
}

export function VoiceStage({ micLive, onMicToggle }: VoiceStageProps) {
  return (
    <main>
      <h1 className="greeting">
        The mic is yours, <em>Edwin</em>
      </h1>
      <MicHero live={micLive} onToggle={onMicToggle} />
      <Composer />
    </main>
  );
}
```

- [ ] **Step 4: Write `organisms/DotGridCanvas.tsx`**

```tsx
import { useRef } from "react";
import { type GridParams, useDotGrid } from "../hooks/useDotGrid";

interface DotGridCanvasProps {
  params: GridParams;
}

export function DotGridCanvas({ params }: DotGridCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useDotGrid(canvasRef, params);
  return <canvas id="bg" ref={canvasRef} />;
}
```

- [ ] **Step 5: Write `organisms/DotGridTuner.tsx`**

```tsx
import { GRID_META, type GridParams } from "../hooks/useDotGrid";
import { TunerRow } from "../molecules/TunerRow";

interface DotGridTunerProps {
  open: boolean;
  params: GridParams;
  onChange: (key: keyof GridParams, value: number) => void;
  onReset: () => void;
}

const PARAM_KEYS = Object.keys(GRID_META) as (keyof GridParams)[];

export function DotGridTuner({ open, params, onChange, onReset }: DotGridTunerProps) {
  return (
    <aside className="tuner" data-open={open ? "true" : "false"} aria-label="Background tuning">
      <h4>fisheye grid</h4>
      <div>
        {PARAM_KEYS.map((key) => (
          <TunerRow key={key} meta={GRID_META[key]} value={params[key]} onChange={(value) => onChange(key, value)} />
        ))}
      </div>
      <button type="button" onClick={onReset}>
        reset
      </button>
    </aside>
  );
}
```

- [ ] **Step 6: Write `organisms/AddAgentModal.tsx`**

```tsx
import type { CSSProperties, MouseEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { Chip } from "../atoms/Chip";
import { Field } from "../atoms/Field";
import { DiscordIdentityPanel, type DiscordMode } from "../molecules/DiscordIdentityPanel";

interface AddAgentModalProps {
  open: boolean;
  onClose: () => void;
  onCreate: (name: string, role: string) => void;
}

const CHANNELS = [
  { id: "discord", label: "Discord" },
  { id: "web", label: "Web widget" },
  { id: "tauri", label: "Tauri" },
];

export function AddAgentModal({ open, onClose, onCreate }: AddAgentModalProps) {
  const [name, setName] = useState("Vera");
  const [role, setRole] = useState("Release Marshal");
  const [channels, setChannels] = useState<Record<string, boolean>>({ discord: true, web: false, tauri: false });
  const [mode, setMode] = useState<DiscordMode>("webhook");
  const [directives, setDirectives] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    nameRef.current?.focus();
    nameRef.current?.select();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const onScrimClick = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose();
  };

  const initial = name.trim()[0]?.toUpperCase() ?? "?";

  return (
    <div
      className="scrim"
      data-open={open ? "true" : "false"}
      role="dialog"
      aria-modal="true"
      aria-labelledby="modalTitle"
      onClick={onScrimClick}
    >
      <div className="modal">
        <h2 id="modalTitle">New agent</h2>
        <p className="sub">Give the agent an identity and pick where it shows up.</p>

        <div className="id-head">
          <div className="id-avatar" style={{ "--ring": "var(--accent)" } as CSSProperties}>
            {initial}
          </div>
          <Field label="Name" htmlFor="agName" style={{ flex: 1, margin: 0 }}>
            <input
              id="agName"
              ref={nameRef}
              type="text"
              placeholder="e.g. Manuel"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
        </div>

        <Field label="Role" htmlFor="agRole">
          <input
            id="agRole"
            type="text"
            placeholder="e.g. Architect"
            value={role}
            onChange={(e) => setRole(e.target.value)}
          />
        </Field>

        <Field label="Channels">
          <div className="chips">
            {CHANNELS.map((channel) => (
              <Chip
                key={channel.id}
                label={channel.label}
                pressed={channels[channel.id] ?? false}
                onToggle={() => setChannels((c) => ({ ...c, [channel.id]: !c[channel.id] }))}
              />
            ))}
          </div>
        </Field>

        <DiscordIdentityPanel mode={mode} onModeChange={setMode} hidden={!channels.discord} />

        <Field
          label={
            <>
              Directives{" "}
              <span style={{ textTransform: "none", letterSpacing: 0, color: "var(--text-dim)" }}>
                — system prompt, optional
              </span>
            </>
          }
          htmlFor="agDir"
        >
          <textarea
            id="agDir"
            placeholder="How this agent behaves — its domain, tone, and hard constraints…"
            value={directives}
            onChange={(e) => setDirectives(e.target.value)}
          />
        </Field>

        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="primary" onClick={() => onCreate(name.trim() || "Agent", role.trim() || "Agent")}>
            Create agent
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 7: Verify** — `npm run build` green, `npm run lint` clean.

- [ ] **Step 8: Commit** — `git add control-plane/src && git commit -m "feat(control-plane): organisms (rails, stage, tuner, add-agent modal)"`

---

### Task 5: Template + page + entry rewire, web verification

**Files:**
- Create: `control-plane/src/templates/ControlPlaneLayout.tsx`
- Create: `control-plane/src/pages/HomePage.tsx`
- Modify: `control-plane/src/App.tsx` (full replace)
- Modify: `control-plane/src/main.tsx` (full replace)
- Delete: `control-plane/src/index.css` (superseded by `styles/`)

**Interfaces:**
- Consumes: all organisms, `AGENTS`/`ringForIndex`, `GRID_DEFAULTS`.
- Produces: `ControlPlaneLayout({ background, leftRail, rightRail, stage, hint, overlays?: ReactNode })`; `HomePage()`; `App()` renders `HomePage`.

- [ ] **Step 1: Write `templates/ControlPlaneLayout.tsx`**

```tsx
import type { ReactNode } from "react";

interface ControlPlaneLayoutProps {
  background: ReactNode;
  leftRail: ReactNode;
  rightRail: ReactNode;
  stage: ReactNode;
  hint: ReactNode;
  overlays?: ReactNode;
}

/** Fixed-position composition: canvas underlay, side rails, center stage, bottom hint, floating overlays. */
export function ControlPlaneLayout({ background, leftRail, rightRail, stage, hint, overlays }: ControlPlaneLayoutProps) {
  return (
    <>
      {background}
      {leftRail}
      {rightRail}
      {stage}
      <div className="subhint">{hint}</div>
      {overlays}
    </>
  );
}
```

- [ ] **Step 2: Write `pages/HomePage.tsx`**

```tsx
import { useEffect, useState } from "react";
import { AGENTS, type AgentSeed, ringForIndex } from "../data/agents";
import { GRID_DEFAULTS, type GridParams } from "../hooks/useDotGrid";
import { AddAgentModal } from "../organisms/AddAgentModal";
import { AgentRoster } from "../organisms/AgentRoster";
import { DotGridCanvas } from "../organisms/DotGridCanvas";
import { DotGridTuner } from "../organisms/DotGridTuner";
import { ToolRail } from "../organisms/ToolRail";
import { VoiceStage } from "../organisms/VoiceStage";
import { ControlPlaneLayout } from "../templates/ControlPlaneLayout";

export function HomePage() {
  const [agents, setAgents] = useState<AgentSeed[]>(AGENTS);
  const [micLive, setMicLive] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [tunerOpen, setTunerOpen] = useState(false);
  const [gridParams, setGridParams] = useState<GridParams>(GRID_DEFAULTS);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "g" && !/input|textarea/i.test((e.target as HTMLElement).tagName)) {
        setTunerOpen((open) => !open);
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  const createAgent = (name: string, role: string) => {
    setAgents((list) => [
      ...list,
      {
        id: `${name.toLowerCase().replace(/\s+/g, "-")}-${list.length}`,
        name,
        role,
        ring: ringForIndex(list.length),
      },
    ]);
    setModalOpen(false);
  };

  return (
    <ControlPlaneLayout
      background={<DotGridCanvas params={gridParams} />}
      leftRail={<ToolRail />}
      rightRail={<AgentRoster agents={agents} onAdd={() => setModalOpen(true)} />}
      stage={<VoiceStage micLive={micLive} onMicToggle={() => setMicLive((live) => !live)} />}
      hint={
        <>
          endless canvas · press <kbd>g</kbd> to tune the grid
        </>
      }
      overlays={
        <>
          <DotGridTuner
            open={tunerOpen}
            params={gridParams}
            onChange={(key, value) => setGridParams((p) => ({ ...p, [key]: value }))}
            onReset={() => setGridParams(GRID_DEFAULTS)}
          />
          <AddAgentModal open={modalOpen} onClose={() => setModalOpen(false)} onCreate={createAgent} />
        </>
      }
    />
  );
}
```

- [ ] **Step 3: Replace `src/App.tsx`**

```tsx
import { HomePage } from "./pages/HomePage";

export function App() {
  return <HomePage />;
}
```

- [ ] **Step 4: Replace `src/main.tsx`**

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

- [ ] **Step 5: Delete `src/index.css`** — `git rm control-plane/src/index.css`

- [ ] **Step 6: Build + lint** — `npm run build && npm run lint`. Expected: both green.

- [ ] **Step 7: Live web verification (Playwright)** — start `npm run dev` (background), then with the Playwright browser tools against `http://localhost:1420`: (a) snapshot shows both rails, greeting, mic, composer, three agent avatars M/O/A; (b) click the mic → caption flips to "Listening… tap to stop"; (c) press `g` → tuner panel appears with six sliders; (d) click `+` in the right rail → modal opens, type a name → preview initial updates, click "Create agent" → fourth avatar appears. Take a screenshot for the record. Stop the dev server.

- [ ] **Step 8: Commit** — `git add -A control-plane/src && git commit -m "feat(control-plane): assemble artifact UI (template, page, entry)"`

---

### Task 6: Rust toolchain + Tauri desktop scaffold

**Files:**
- Create: `control-plane/src-tauri/` (via `tauri init`: `Cargo.toml`, `build.rs`, `src/main.rs`, `src/lib.rs`, `capabilities/`, `.gitignore`)
- Modify: `control-plane/src-tauri/tauri.conf.json` (replace generated content, below)
- Create: `control-plane/scripts/gen-icon.mjs`
- Create: `control-plane/src-tauri/icons/*` (via `tauri icon`)
- Delete: `control-plane/tauri.conf.json` (moves into `src-tauri/`)
- Modify: root `.gitignore` (add `control-plane/src-tauri/target/` if the generated `.gitignore` doesn't cover it)

**Interfaces:**
- Consumes: `dist/` produced by `npm run build`; dev server on 1420.
- Produces: working `npm run tauri dev` desktop target.

- [ ] **Step 1: Install rustup (approved)**

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
source "$HOME/.cargo/env" && cargo --version
```

Expected: `cargo 1.x`. Also verify a C linker exists: `xcode-select -p` (or `clang --version`). If missing, STOP and surface to Edwin: run `xcode-select --install` (GUI prompt) — Tauri cannot link without it.

- [ ] **Step 2: Scaffold src-tauri**

```bash
cd control-plane && npx tauri init --ci \
  --app-name smithagents-control-plane \
  --window-title "smithagents · control plane" \
  --frontend-dist ../dist \
  --dev-url http://localhost:1420 \
  --before-dev-command "npm run dev" \
  --before-build-command "npm run build"
```

Keep the generated Rust sources (`main.rs`/`lib.rs`, current mobile-ready template) untouched.

- [ ] **Step 3: Replace `src-tauri/tauri.conf.json`** with the project's config (carries over the old root file; note `frontendDist` is now `../dist`):

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "smithagents-control-plane",
  "version": "0.1.0",
  "identifier": "com.jefelabs.smithagents",
  "build": {
    "frontendDist": "../dist",
    "devUrl": "http://localhost:1420",
    "beforeDevCommand": "npm run dev",
    "beforeBuildCommand": "npm run build"
  },
  "app": {
    "windows": [
      {
        "title": "smithagents · control plane",
        "width": 1280,
        "height": 800,
        "minWidth": 800,
        "minHeight": 600,
        "resizable": true
      }
    ],
    "security": { "csp": null }
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ]
  }
}
```

Then `git rm control-plane/tauri.conf.json`.

- [ ] **Step 4: Write `scripts/gen-icon.mjs`** — dependency-free 1024×1024 PNG (dark rounded square, accent spark; transparent corners as `tauri icon` requires):

```js
// Renders the smithagents spark glyph to a 1024x1024 RGBA PNG. No dependencies:
// pixels are composed in a Buffer and PNG chunks are emitted with node:zlib.
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const S = 1024;
const CORNER = 180;
const BG = [0x0d, 0x11, 0x19];
const FG = [0x7a, 0xa2, 0xff];

function inRoundedRect(x, y) {
  const cx = Math.min(Math.max(x, CORNER), S - CORNER);
  const cy = Math.min(Math.max(y, CORNER), S - CORNER);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= CORNER * CORNER;
}

const SCALE = 44;
const BASE = [[12, 2], [14.4, 7.6], [20, 10], [14.4, 12.4], [12, 18], [9.6, 12.4], [4, 10], [9.6, 7.6]];
const STAR = BASE.map(([x, y]) => [512 + (x - 12) * SCALE, 512 + (y - 10) * SCALE]);

function inStar(x, y) {
  let inside = false;
  for (let i = 0, j = STAR.length - 1; i < STAR.length; j = i++) {
    const [xi, yi] = STAR[i];
    const [xj, yj] = STAR[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const SAMPLES = [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]];
const px = Buffer.alloc(S * S * 4);
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    let bgCov = 0;
    let fgCov = 0;
    for (const [ox, oy] of SAMPLES) {
      if (inRoundedRect(x + ox, y + oy)) {
        bgCov++;
        if (inStar(x + ox, y + oy)) fgCov++;
      }
    }
    const i = (y * S + x) * 4;
    const t = fgCov / 4;
    px[i] = Math.round(BG[0] * (1 - t) + FG[0] * t);
    px[i + 1] = Math.round(BG[1] * (1 - t) + FG[1] * t);
    px[i + 2] = Math.round(BG[2] * (1 - t) + FG[2] * t);
    px[i + 3] = Math.round((bgCov / 4) * 255);
  }
}

function crc32(buf) {
  let crc = ~0;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA

const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw)),
  chunk("IEND", Buffer.alloc(0)),
]);
writeFileSync(process.argv[2] ?? "app-icon.png", png);
console.log(`wrote ${process.argv[2] ?? "app-icon.png"} (${png.length} bytes)`);
```

Run: `node scripts/gen-icon.mjs src-tauri/app-icon.png && npx tauri icon src-tauri/app-icon.png`
Expected: `src-tauri/icons/` populated (32x32.png, 128x128.png, icon.icns, icon.ico, iOS/Android sets).

- [ ] **Step 5: Compile check** — `source "$HOME/.cargo/env" && cargo check --manifest-path src-tauri/Cargo.toml`. Expected: `Finished` (first run downloads crates; minutes).

- [ ] **Step 6: Launch check** — `npm run tauri dev` (background). Expected: Vite starts on 1420, Rust compiles, a native window titled "smithagents · control plane" opens with the artifact UI. Then stop it.

- [ ] **Step 7: gitignore** — the init-generated `src-tauri/.gitignore` must cover `target/` and `gen/`; if not, add `control-plane/src-tauri/target/` to the root `.gitignore`.

- [ ] **Step 8: Commit**

```bash
git add -A control-plane && git rm --cached -r control-plane/src-tauri/target 2>/dev/null; git commit -m "feat(control-plane): Tauri 2 desktop scaffold (src-tauri, icons, rustup)"
```

---

### Task 7: iOS init + README updates

**Files:**
- Create: `control-plane/src-tauri/gen/apple/` (via `tauri ios init`, best-effort without Xcode)
- Modify: root `README.md` (Build & run section)

**Interfaces:**
- Consumes: Task 6's `src-tauri/`.
- Produces: iOS project scaffold (or documented prerequisites), updated docs.

- [ ] **Step 1: Add iOS rust targets** — `rustup target add aarch64-apple-ios aarch64-apple-ios-sim`. Expected: installed.

- [ ] **Step 2: Attempt iOS init** — `npm run tauri -- ios init`. Expected without Xcode: failure mentioning Xcode/simctl. Either outcome is acceptable; capture the exact error.

- [ ] **Step 3: Update root `README.md`** — in the Build & run section: replace the note "The Tauri Rust crate (`control-plane/src-tauri/`) is not scaffolded yet." with current reality, and extend the control-plane run block to:

```bash
# control plane — three ways to run
cd control-plane && npm install
npm run dev          # 1) web app on :1420 (any browser)
npm run tauri dev    # 2) native macOS window (requires rustup + Xcode CLT)
npm run tauri -- ios init && npm run tauri -- ios dev   # 3) iOS (requires full Xcode; see src-tauri/gen/apple)
```

If Step 2 failed, note the Xcode prerequisite line under it verbatim with the captured error's remedy.

- [ ] **Step 4: Commit** — `git add -A control-plane README.md && git commit -m "feat(control-plane): iOS init + run docs"`

---

## Self-Review

1. **Spec coverage:** artifact features → Tasks 1–5 (canvas, theming, rails, stage, tuner, modal all present); dual web target → Task 5 Step 7; Tauri desktop → Task 6; iOS init → Task 7; rustup approval → Task 6 Step 1; README follow-ups → Task 7. No gaps found.
2. **Placeholder scan:** all code steps carry complete code; CSS steps name exact reference sections and the two deliberate additions (`#root`, `.roster`). Clean.
3. **Type consistency:** `GridParams`/`GRID_META`/`GridParamMeta` names match across Tasks 2/4/5; `AgentSeed`/`ringForIndex` match across 1/4/5; `DiscordMode` matches across 3/4. Clean.
