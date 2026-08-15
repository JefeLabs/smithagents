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

### 1. A single state root — `~/.smithagents`

**Ruling (Edwin, 2026-08-15): on startup the working directory is
`~/.smithagents`.**

That is far cheaper than the refactor this spec originally proposed. State paths
are cwd-relative in **116 places** (102 in swarm, 14 in broker; 91 in
`swarm/src/server.ts` alone), and `process.chdir(stateRoot)` at startup makes
every one of them resolve correctly **with no code change**. A `stateDir()`
helper threaded through 116 call sites was the expensive way to reach the same
place.

```
~/.smithagents/          ← chdir target at startup
  .smith/                ← existing layout, unchanged, now under a stable root
    users/ agents/ workspaces/ work/ documents/ …
```

The nested `.smith/` is mildly redundant but costs nothing and keeps every
existing path literal valid. Renaming it later is cosmetic.

**Three consequences to handle explicitly, because `chdir` is process-global:**

- **Dev must be gated, or every developer's state silently moves.** Running
  `pnpm serve` from `swarm/` today uses `swarm/.smith`; an unconditional `chdir`
  would relocate that to `~/.smithagents` mid-workflow. Gate on packaged mode, or
  on an explicit env var, with dev keeping today's behaviour by default.
- **Spawned children inherit the new cwd.** Dispatch already passes an explicit
  `cwd` per worktree, so it is unaffected. `CliResearch` spawns with **no** `cwd`
  (`research.ts:138`) and would move from the repo root to `~/.smithagents` —
  probably an improvement, since a research turn has no business running in the
  repo, but it is a behaviour change that must be verified rather than assumed.
- **Relative paths anywhere else** in either service shift with it. The `.env`
  load (`--env-file=../.env`) is resolved by node before any `chdir`, so it is
  safe; anything else reading a relative path at runtime needs checking.

**Move `~/.smith/master.key` into `~/.smithagents/` at the same time.** It is the
only state living outside the repo today, and consolidating gives the product one
home instead of two. Critically, **this is free right now and expensive later**:
the key encrypts secrets at rest, so moving it normally orphans every encrypted
value — but the reference install was reset on 2026-08-15 and currently holds
**no encrypted secrets at all**. That window closes the moment anyone re-enters a
credential. If the move is not made now, it should not be made casually later.

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
