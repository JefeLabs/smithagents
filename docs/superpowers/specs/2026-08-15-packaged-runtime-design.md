# Packaged Runtime — Design

**Status:** design, awaiting review
**Date:** 2026-08-15
**Blocks:** every other spec in this set — none of them reaches a user without it
**Related:** [env-free runtime](2026-08-15-env-free-runtime-design.md), [welcome wizard](2026-08-15-welcome-wizard-design.md)

## Problem

There is no packaged product. Today the app is: clone the repo, `pnpm install`,
start two services by hand in tmux, and open a Vite dev server. Every spec in
this set — the wizard especially — assumes a person opens an application and it
works. That person cannot exist yet.

Three concrete gaps, each verified:

**1. The bundle starts nothing.** `tauri.conf.json` has `externalBin: NONE`, no
`resources`, and the Rust side contains no `Command::new` and no sidecar call. A
packaged app is a window loading `../dist`, talking to `:7777` and `:7790`, with
nothing to start either service.

**2. State is cwd-relative.** `resolve(process.cwd(), ".smith/…")` appears **87
times** in `swarm/src/server.ts` alone. A packaged app's working directory is
meaningless and its bundle is read-only, so every one of those paths is wrong.
The broker is partway better — `BROKER_DOCUMENTS_DIR`, `BROKER_SESSIONS_DIR`,
`BROKER_FEEDS_DIR`, `BROKER_BLUEPRINTS_DIR`, `BROKER_VOICE_CACHE_DIR` exist — but
they are per-directory overrides that still default to cwd-relative paths, not a
single root.

**3. The runtime is a repo.** The services are TypeScript run through `tsx` from
a pnpm workspace. There is no artifact to ship.

## Three parts, in dependency order

### 1. A single state root

One resolver, one environment variable, every path through it:

```
SMITH_STATE_DIR  →  packaged: the OS app-data dir
                    dev:      ./.smith  (unchanged)
```

- `stateDir(...segments)` replaces all 87 call sites in the swarm and the five
  ad-hoc `BROKER_*_DIR` defaults in the broker. The per-directory overrides may
  stay as escape hatches, but they resolve **under** the root rather than beside
  it.
- Default in dev is exactly today's behaviour, so no developer notices.
- `~/.smith/master.key` stays where it is: it is machine-scoped rather than
  install-scoped, and moving it would orphan every encrypted secret.

This is mechanical, large, and the prerequisite for the other two. It is also
independently shippable and testable **before** any packaging exists, which is
the argument for doing it first.

### 2. Service supervision

The app owns the lifecycle of the services it depends on.

- **Sidecars.** Ship the swarm and broker as `externalBin` entries and start them
  from Rust on launch.
- **Health before UI.** The window waits on a health check rather than racing the
  services, so first paint never shows a disconnected shell.
- **Shutdown with the window**, including on crash and on force-quit, so closing
  the app does not leave orphans — the same failure that left **70 abandoned tmux
  sessions** on the development machine.
- **Ports are negotiated, not assumed.** 7777 and 7790 are unowned defaults; a
  packaged app must detect a conflict, pick free ports, and tell the frontend
  which ones it got. Failing to start because a port is busy is not acceptable
  in a product.
- **Failure is visible in the UI**, not only in a log the user will never open.

### 3. Shipping a Node runtime

The services must become artifacts. This needs a decision rather than a default,
and the options differ enough to matter:

| Option | Cost |
|---|---|
| Node single-executable applications (SEA) | official, large binaries, some ESM friction |
| `bun build --compile` | small and fast, second runtime to validate against |
| bundle Node + a compiled JS bundle | most control, largest artifact, manual updates |

Whichever is chosen must handle: native dependencies, code signing and
notarisation on macOS, and how updates ship. **This is the least-explored part of
this spec and the most likely to surprise.**

## What a packaged install must reach

The end state this exists to serve, tying the set together:

1. User installs the `.app` and opens it. No repo, no pnpm, no tmux, **no `.env`**
   — see [env-free runtime](2026-08-15-env-free-runtime-design.md).
2. The app starts the swarm and broker itself, on ports it chose.
3. First run is detected (no user record) and the wizard runs.
4. Everything the app needs is entered in the wizard or Settings, and persists in
   the state root.
5. Closing the app stops the services.

## Error handling

- **A service that fails to start is reported in the UI with its reason**, and
  the app stays open — a user must be able to see what went wrong.
- **A crashed service restarts once**, then reports rather than looping.
- **A state root that cannot be created** (permissions, full disk) is a
  first-class error message, not a stack trace behind a blank window.

## Testing

Unit: `stateDir()` resolution in dev and packaged modes, per-directory overrides
resolving under the root, port negotiation picking a free port when the default
is taken.

**Integration on a machine without the repo** is the only test that proves this
works, and nothing short of it does. Install the built artifact on a clean
account with no `.env`, no pnpm, and no CLIs, then complete the wizard. Every
assumption in this document is invisible from a development machine — which is
exactly how a four-variable boot dependency and 87 cwd-relative paths survived
this long.

## Out of scope

Auto-update, Windows and Linux packaging (the mechanisms differ; macOS first),
and the hosted path, which sidesteps this entirely by running the services in a
cell.
