# control-plane

The smithagents operator UI (PRD §5): a faithful React port of the
"smithagents · control plane" claude.ai artifact, structured as five-level
atomic design (`atoms → molecules → organisms → templates → pages`), running
from one codebase as a web app, a Tauri 2 macOS desktop app, and a Tauri iOS
project.

Design spec: `../docs/superpowers/specs/2026-07-24-control-plane-artifact-port-design.md`
Porting reference: `../docs/superpowers/specs/2026-07-24-artifact-9095b184-source.html`

## Run it

```bash
npm install

npm run dev          # 1) web app on http://localhost:1420 (any browser)
npm run tauri dev    # 2) native macOS window (Rust via rustup; Xcode CLT for linking)
npm run tauri -- ios dev   # 3) iOS — requires full Xcode.app (see below)
```

`npm run build` type-checks and emits `dist/`; `npm run lint` runs Biome
(config in `biome.json` — two style rules are relaxed for the verbatim-ported
artifact CSS in `src/styles/`).

## Layout

```
src/
  styles/     tokens.css (dark default + light via prefers-color-scheme or
              data-theme="light") · base.css · components.css (artifact-verbatim)
  data/       agents.ts — seed roster, data-driven like the personas module
  hooks/      useDotGrid.ts — fisheye canvas loop (theme-reactive, reduced-motion aware)
  atoms/ molecules/ organisms/ templates/ pages/
src-tauri/    Tauri 2 crate (mobile-ready lib.rs template)
  gen/apple/  generated iOS Xcode project (tauri ios init)
scripts/      gen-icon.mjs — dependency-free 1024² PNG icon renderer
```

The front-end uses zero Tauri APIs, so the same bundle serves browser and
native shells; guard any future `@tauri-apps/api` usage behind a runtime check.

## iOS status

`tauri ios init` has been run (cocoapods installed via Homebrew); the project
lives at `src-tauri/gen/apple/smithagents-control-plane.xcodeproj`. Building or
simulating requires full **Xcode.app** (only the Command Line Tools are
installed on this machine): install Xcode from the App Store, then
`sudo xcode-select -s /Applications/Xcode.app/Contents/Developer` and run
`npm run tauri -- ios dev`.
