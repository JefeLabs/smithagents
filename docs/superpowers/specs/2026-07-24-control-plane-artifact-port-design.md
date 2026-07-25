# Control-plane artifact port — dual-target (web + Tauri) design

**Date:** 2026-07-24
**Status:** Approved by Edwin (structure: atomic design; targets: desktop + iOS init; rustup install: yes)
**Source:** claude.ai artifact `9095b184-b66d-4d6e-a653-ef06b583bc44` ("smithagents · control plane")

## Goal

Replace the partial hand-port in `control-plane/src/` with a faithful React port of
the full artifact, running three ways from one codebase:

1. **Plain web app** — Vite dev server / static `dist/` in any browser.
2. **Tauri 2 desktop app** — macOS window wrapping the same front-end.
3. **Tauri iOS** — project initialized (`tauri ios init`); full build is a
   follow-up once Xcode is installed.

## What the artifact contains (port scope)

- Fisheye **dot-grid canvas** background: pointer-follow distortion, idle drift,
  `prefers-reduced-motion` support, theme-reactive colors read from CSS custom
  properties.
- **Light/dark theming** via CSS custom properties: `:root[data-theme]` override
  plus `prefers-color-scheme` fallback.
- **Left tool rail**: logo, five tool buttons (`aria-current` active state),
  settings, operator avatar.
- **Right agent roster**: data-driven avatar list (ring color, online status dot,
  hover/focus tooltip with name + role), add button.
- **Voice-first center stage**: greeting, mic hero button with pulse ring and
  live "Listening…" toggle, composer (attach, text input, Swarm selector).
- **Tuner panel** (press `g`): range sliders for the six grid parameters
  (distortion, radius, spacing, dot size, glow, quietness) + reset.
- **Add-agent modal**: name (live avatar preview), role, channel chips
  (Discord / Web widget / Tauri), Discord identity mode (webhook identity vs
  dedicated bot with token + MESSAGE_CONTENT + guild ID), directives textarea;
  Create appends to the roster.

## Structure — five-level atomic design

```
control-plane/src/
  styles/            tokens.css (theme vars, both schemes) · base.css · components.css
  data/agents.ts     AGENTS seed (id, name, role, ring) — data-driven like PersonaRegistry
  atoms/             Avatar · ToolButton · Chip · Field · SegmentedControl · Logo
  molecules/         AgentAvatar · MicHero · Composer · TunerRow · DiscordIdentityPanel
  organisms/         ToolRail · AgentRoster · VoiceStage · AddAgentModal · DotGridTuner
  templates/         ControlPlaneLayout (rails + stage + canvas layering)
  pages/             HomePage (owns state: agents[], modal open, mic live, grid params)
  hooks/useDotGrid.ts  canvas loop (resize, fisheye math, pointer/idle, colors)
  App.tsx            renders HomePage
  main.tsx           entry (imports styles)
```

Decisions:

- **CSS ported nearly verbatim**, split across `styles/`, class names unchanged —
  maximizes fidelity to the artifact and keeps diffs reviewable.
- **Icons from `lucide-react`** (already a dependency); the artifact's inline
  SVGs are lucide glyphs.
- **State is plain React local state.** Created agents are in-memory only,
  exactly like the artifact. No persistence.
- The obsolete hand-port (`src/index.css`, old `App.tsx` markup) is replaced.

## Dual-target mechanics

- The front-end uses **zero Tauri APIs**, so the identical bundle runs in a
  plain browser. Any future Tauri API use must be guarded (e.g. `isTauri()`).
- Scaffold `control-plane/src-tauri/`: `Cargo.toml`, `src/main.rs`, `build.rs`,
  `capabilities/default.json`, icons (generated with `tauri icon` from a
  spark-glyph source image).
- **Move** the existing root `control-plane/tauri.conf.json` to
  `src-tauri/tauri.conf.json` (Tauri 2's expected location); contents carry over.
- `tauri ios init` generates the iOS project. Without Xcode it may be partial;
  the README records the finish-up steps either way.

## Toolchain prerequisites

- Install **rustup** (stable toolchain) — approved.
- Verify `clang` (Xcode Command Line Tools) for linking; surface if missing.
- Xcode proper is required only for the iOS build — out of scope today.

## Non-goals

- No gateway/WebSocket connectivity, no mTLS — later slices (PRD §5).
- No real microphone capture; the mic button toggles the visual state only.
- No test framework for control-plane (none exists); verification is build +
  live launches.

## Verification gates

1. `npm run build` (tsc + vite) green.
2. Web app spot-checked in a browser (Playwright): rails, mic toggle, tuner,
   modal open/create flows.
3. `npm run tauri dev` opens the desktop window with the same UI.
4. iOS: `src-tauri/gen/apple` project exists (build deferred until Xcode).
