# Agent Status Reporting — Design

**Date:** 2026-08-16
**Status:** Approved design, ready for planning
**Part of:** spec 1 of 7 in the decomposition drawn from the Hamster / herdr /
Orca teardown. Independent of specs 2 (session recovery), 3 (worktree
provisioning), 6 (coordination protocol), and 7 (context projection); a
prerequisite for spec 4 (agent visibility) and spec 5 (hibernation).
**Revises:** the turn-completion invariant stated twice in the codebase —
`swarm/src/agent-sessions.ts:5-7` and `swarm/src/drivers/claude.ts:8-9`. See §4.

## Goal

Swarm cannot tell a stuck agent from a slow one.

Turn completion is detected by polling the tool's persisted transcript for a
finalized assistant message (`agent-sessions.ts:210-239`). That signal can only
ever observe *success*. An agent sitting on a permission dialog, an MCP
elicitation, or a trust prompt writes no transcript line at all, so the poll
loop spins to `turnTimeoutMs` — five minutes by default — then fires `C-c` and
throws `TurnTimeoutError`. The absence of a message is ambiguous between
*thinking*, *blocked*, and *dead*, and the system resolves that ambiguity by
waiting for the worst case every time.

This is not hypothetical. The folder-trust modal that made warm sessions 100%
broken was exactly this failure: the modal satisfied both readiness signals, the
session reported ready, and the first send typed into the dialog. The fix was to
pre-accept that specific gate. Every *other* blocking prompt remains invisible.

Three consequences today:

1. **A blocked agent costs a full timeout.** Five minutes of wall clock to learn
   nothing, and the recovery path (`C-c`) discards the turn rather than
   answering the prompt.
2. **There is no attention signal.** Nothing can tell a human or a dispatcher
   which of N running agents needs a decision. With one agent that is tolerable;
   with a council it is disqualifying.
3. **`agy` cannot run warm sessions at all.** It persists no local transcript
   (`drivers/agy.ts:21`, `warmSessionsSupported = false`), so the only
   completion mechanism the system has does not exist for it. It is task-only
   by accident of that mechanism, not by intent.

Every supported CLI already knows its own state and will report it on request.
The only question is whether we asked.

## Settled decisions

- **Agents report their own state via each CLI's native hook system.** Not
  screen scraping, not transcript inference. All five drivers support hooks; the
  event vocabularies are near-identical across claude, codex, and copilot.
- **Authority is per-driver, not global.** Where a transcript exists it keeps
  owning turn completion and the existing invariant holds. Where none exists —
  `agy` — hooks own it. Detection fidelity becomes a declared capability rather
  than an assumption.
- **Hooks add attention states; they do not accelerate turn completion.** On the
  four transcript-bearing drivers, a hook `done` is corroboration and never the
  signal `send()` resolves on. This buys the new information at zero new risk of
  a hung turn.
- **The report endpoint is read fresh from disk on every invocation.** A session
  that outlives a swarm restart must not post into a dead port.
- **A session must prove hooks loaded, or it is marked degraded.** Codex gates
  project-local hooks behind trust, so silent non-loading is a real state and it
  is indistinguishable from a quiet agent unless forced to announce itself.
- **A status hook never fails the agent's turn.** Every failure path exits 0.

## 1. The driver seam

Hook installation is a new driver method, not an extension of `materialize()`.

`materialize()` writes the *persona* and returns `string[]` of written paths,
which `create()` appends to `.git/info/exclude` (`agent-sessions.ts:108-113`).
Reusing it was the obvious move and it is wrong: we need per-driver *capability*
returned alongside the files, and a `string[]` cannot carry it. Overloading the
persona writer with a second concern would also make the two impossible to test
apart.

```ts
interface StatusReporting {
  /** Files written into the worktree; git-excluded exactly like materialize()'s. */
  files: string[];
  /** Which states this driver can actually report. */
  reports: { working: boolean; blocked: boolean; done: boolean };
  /** True only when hooks are the sole completion signal for this tool. */
  authoritativeForTurns: boolean;
}

/** On ToolDriver. `reportDir` is where the endpoint file, token, and script live. */
installStatusReporting(worktreePath: string, reportDir: string): Promise<StatusReporting>;
```

`reportDir` is `<worktree>/.smith/status/`, holding exactly three files —
`endpoint`, `token`, and `smith-report`. It sits inside the worktree so a
container or SSH host that can see the checkout can see the reporter, with no
second mount to arrange. Like everything `materialize()` writes, the directory
is appended to `.git/info/exclude` and never reaches a commit.

Codex's trust gate folds into the **existing** `prepareWorkspace(cwd)` rather
than a new method. That hook already exists for precisely this purpose — it
pre-accepts Claude's folder-trust gate — and its write-and-rename discipline
(`drivers/claude.ts:94-97`) is what a second trust store needs anyway.

Per-driver mechanisms, all verified against current vendor documentation:

| driver | writes | events consumed | `prepareWorkspace` |
| --- | --- | --- | --- |
| claude | `.claude/settings.json` hooks block | `SessionStart`, `UserPromptSubmit`, `PermissionRequest`, `Elicitation`, `Stop` | existing trust accept |
| copilot | reuses `.claude/settings.json` | `sessionStart`, `userPromptSubmitted`, `permissionRequest`, `agentStop` | — |
| codex | `.codex/hooks.json` | `SessionStart`, `UserPromptSubmit`, `PermissionRequest`, `Stop` | **new:** trust the `.codex/` layer |
| agy | `.agents/hooks.json` | `PreInvocation`, `PreToolUse`, + turn-end (see risks) | — |
| opencode | `.opencode/plugin/smith-status.ts` | `session.idle` and peers | — |

Copilot documents `.claude/settings.json` as a supported cross-tool location, so
those two drivers share one file shape. That is a convenience, not a coupling:
each driver still returns its own `StatusReporting`, and a future divergence
costs one method body.

## 2. The report script

One POSIX shell script per session, written into `reportDir` alongside the
endpoint and token files. Each CLI's hook config invokes it with a literal state
argument, so the per-CLI configuration carries no logic.

```sh
#!/bin/sh
# smith-report <state>   — never fails the agent's turn.
DIR="$(dirname "$0")"
ENDPOINT="$(cat "$DIR/endpoint" 2>/dev/null)" || exit 0
[ -n "$ENDPOINT" ] || exit 0
curl -sS -m 2 -X POST "$ENDPOINT" \
  -H "Authorization: Bearer $(cat "$DIR/token" 2>/dev/null)" \
  -H 'Content-Type: application/json' \
  -d "{\"sessionId\":\"$SMITH_SESSION_ID\",\"state\":\"$1\"}" >/dev/null 2>&1
exit 0
```

Four properties are load-bearing:

- **The endpoint is read from disk every invocation, never baked in.** A session
  outliving a swarm restart re-reads the new address and keeps reporting. Baking
  the port into the hook config at install time is the obvious implementation
  and it produces sessions that go silent after any restart, invisibly.
- **A 2-second timeout.** The hook runs inside the agent's loop; a hanging POST
  would stall the agent itself.
- **`exit 0` unconditionally.** Several of these events can block or alter agent
  behaviour when a hook returns non-zero. Status reporting must never acquire
  that power by accident.
- **`SMITH_SESSION_ID` is exported into the session's environment at launch**,
  so the script needs no per-session templating and the same bytes work in every
  worktree.

`curl` availability inside the container images is an implementation risk, not
an assumption — see §9.

## 3. Status model and migration

The union becomes:

```
starting | working | blocked | done | idle | dead | unknown
```

Adopted from the herdr/Orca vocabulary, which is what the hooks natively
express. `ready` → `idle` and `busy` → `working` are renames. `starting` and
`dead` survive because no hook can express them: one precedes the agent process,
the other is the absence of it. `unknown` is new and load-bearing — it is what a
degraded session reports instead of a confident lie.

| state | meaning | authored by |
| --- | --- | --- |
| `starting` | launching, before the readiness probe passes | session manager |
| `working` | actively running a turn | hook, or `send()` |
| `blocked` | needs a permission, approval, or elicitation answered | hook only |
| `done` | finished a turn, not yet seen | transcript, or hook on `agy` |
| `idle` | ready for input, quiet | session manager |
| `dead` | tmux session gone | liveness check |
| `unknown` | present but unclassifiable | fidelity fallback |

`done` and `idle` are distinguished by seen-ness rather than by liveness. Spec 4
owns the mark-seen route; until it exists, `done` decays to `idle` on the next
successful `send()`. No `seenAt` field is added here.

**Migration.** Persisted `SessionRecord.status` is rewritten on load:
`ready`→`idle`, `busy`→`working`, anything unrecognized→`unknown`. The migration
and every reader change in one commit, with a test that loads a v1-shaped record
and asserts the new union. The workspace-registry incident was exactly this pair
drifting apart — the migration was updated and the readers were not — so they
are treated here as a single change with a single test, not as two tasks.

## 4. Authority

A `SessionStatus` module owns every transition. `agent-sessions.ts` calls it and
never assigns `state.status` directly. This is the whole of decision A4: the
moment two signals can both write status, there are two sources of truth and a
race that only shows up under load.

Precedence, highest first:

1. **`dead` beats everything.** Liveness is observed, not reported. A hook
   claiming `working` from a session whose tmux is gone is stale mail.
2. **Transcript owns turn completion** on `claude`, `codex`, `copilot`, and
   `opencode`. `send()` resolves on `isTurnComplete()` exactly as it does today.
   A hook `done` updates the reported status but is never what unblocks the
   caller.
3. **Hooks own `blocked` and `working`** on all drivers. Neither is expressible
   from a transcript, so there is no competing claim.
4. **On `agy`, hooks own everything**, including turn completion, because there
   is no transcript to defer to.

This is the revision to the stated invariant. The current text — *"never from
process exit, never from screen state"* — remains true and is worth keeping;
hooks are neither. What changes is *"ONLY from the tool's persisted session
files"*, which becomes: only from persisted session files **where they exist**,
and from the tool's own lifecycle reports where they do not. Both file headers
are rewritten to say this, because a rule stated in two places and revised in
one is worse than a rule stated nowhere.

A `blocked` report arriving mid-`send()` does **not** abort the turn. The agent
may resolve its own prompt, and a caller that gave up on every permission
request would be less useful than today's timeout. It updates status so a human
or a dispatcher can act, and the wait continues.

## 5. Fidelity and the positive control

Hooks that fail to load are indistinguishable from an agent that has nothing to
say. Codex makes this concrete: project-local hooks load *only when the
`.codex/` layer is trusted*, and every warm session runs in a freshly created
worktree the CLI has never seen. An untrusted worktree yields a session that
never reports, and nothing about that looks wrong.

So loading is measured, not assumed:

- Every driver's `installStatusReporting()` registers a `SessionStart` report.
- If no report arrives within `hookProbeMs` (default 10 000), the session is
  marked `statusFidelity: "degraded"`, logged at warn with the driver id and
  worktree path, and falls back to transcript-only.
- `AgentSessionInfo` gains `statusFidelity: "hooks" | "degraded"` so spec 4 can
  render honestly — a degraded session shows `unknown`, never a confident state
  it cannot support.
- On `agy`, degraded is fatal: `create()` fails with a reason naming the missing
  hook, because there is no transcript to fall back to and a silently
  non-reporting agy session would hang every turn.

The test suite includes a driver that deliberately installs nothing and asserts
it produces `degraded`. Without that, a broken probe and a healthy install look
identical, and the control that is supposed to catch silent failure becomes the
silent failure.

## 6. Transport and security

**Receiver.** `POST /agent-sessions/:id/status` on the existing Fastify server
(`swarm/src/server.ts`), beside the existing `/agent-sessions` routes.

**Authentication.** A per-session token generated at `create()`, written to
`reportDir/token` inside the worktree and git-excluded with the rest. Required
as a bearer. The endpoint mutates session state, so an unauthenticated one would
let any process on the machine drive another agent's status.

**Addressing per substrate**, written to `reportDir/endpoint`:

| substrate | endpoint |
| --- | --- |
| local, in-process | `http://127.0.0.1:<swarmPort>/agent-sessions/<id>/status` |
| local, docker | `http://host.docker.internal:<swarmPort>/…` |
| remote, either | that host's own worker daemon, which already proxies to swarm |

No session reaches across a network boundary it is not already crossing. The
remote case deliberately does not point at swarm directly; the worker daemon on
that machine is the existing channel and reusing it keeps this spec out of the
remote transport question entirely.

**Rewritten on server start**, so every live session picks up the new address
after a restart.

## 7. Errors

| condition | response | state change |
| --- | --- | --- |
| unknown session id | 404 | none |
| bad or missing token | 401 | none |
| state not in the union | 400 | none |
| well-formed report for a `dead` session | 200 | none — `dead` wins |
| hook script cannot reach the endpoint | — | none; script exits 0 silently |

Nothing in this path is permitted to surface to the agent. A status system that
can break the work it is observing is worse than no status system.

## 8. Testing

- **Per-driver install:** each `installStatusReporting()` writes the expected
  config shape, compared against a fixture. Five drivers, five fixtures.
- **Receiver:** token rejection, unknown id, unrecognized state, happy path.
- **Authority table:** driver capability × incoming signal → expected status, as
  a single case table. This is where the per-driver rule either holds or does
  not, and a table makes a missing combination visible.
- **Migration:** a v1-shaped `SessionRecord` loads to the new union; an
  unrecognized legacy value becomes `unknown` rather than throwing.
- **Positive control:** a driver that installs nothing must produce `degraded`.
- **Invariant preservation:** on a transcript-bearing driver, a hook `done`
  arriving before the transcript finalizes must **not** resolve `send()`.

## 9. Risks and open items

- **`agy`'s turn-end event is unconfirmed.** Antigravity documents `PreToolUse`,
  `PostToolUse`, and `PreInvocation` in `.agents/hooks.json`, but no turn-end
  event was verified against primary documentation. `agy` is the one driver
  where hooks are authoritative for completion, so this must be confirmed before
  implementation begins. If no turn-end event exists, `agy` stays task-only and
  §4's fourth rule has no subject — which does not affect the other four
  drivers.
- **`curl` inside container images.** The report script assumes it. Verify
  against the tracked Dockerfile; if absent, either add it or fall back to a
  driver-supplied reporter. Do not discover this at runtime as a silently
  degraded session.
- **Copilot's shared `.claude/settings.json`.** Two drivers writing one file is
  fine today because only one runs per worktree. If that ever changes, the file
  becomes shared mutable state between drivers.
- **`hookProbeMs` default of 10s is a guess.** Cold starts on a loaded machine
  may exceed it and produce spurious degradation. Tune against measured launch
  times before shipping, and prefer a false *healthy* to a false *degraded* —
  the fallback is correct either way, but a degraded label that is wrong will
  teach people to ignore it.

## Out of scope

Named explicitly so the plan does not drift into them:

- The **Needs You board** and state rollup — spec 4.
- **Hibernation** and its safety checklist — spec 5.
- **Resume-instead-of-tombstone** — spec 2. This spec adds no recovery
  behaviour; a dead session is still forgotten.
- **The `ask` protocol** — spec 6. Giving workers a structured way to ask the
  coordinator would reduce how often `blocked` is ever reached; it does not
  replace detecting it, since an agent can always ignore the protocol.
- **Screen-based detection** as a second-tier fallback. Deferred until there is
  evidence a supported CLI needs it; all five have hooks today.
