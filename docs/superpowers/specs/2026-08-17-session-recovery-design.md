# Session Recovery — Design

**Date:** 2026-08-17
**Status:** Approved design, ready for planning
**Part of:** spec 2 of 7 in the decomposition drawn from the Hamster / herdr /
Orca teardown. Independent of spec 1 (agent status reporting) except for the
`agy` carve-out in §7; a prerequisite for spec 5 (hibernation), which is the
consumer of the `resumable` verdict this spec introduces.
**Extends:** the boot policy in `swarm/src/session-reconcile.ts`. Adds no new
value to the status union that spec 1 rewrites — see §3.

## Goal

Swarm already knows every session's id. It throws that away on death.

Session ids are pinned at launch — `claude --session-id <uuid>`
(`drivers/claude.ts:53-55`) — so the orchestrator chooses the id rather than
discovering it, and `sessionFileFor(cwd, sessionId)` derives the transcript path
from it directly. That pin is currently spent on one thing: knowing where to
poll for turn completion.

Meanwhile boot reconciliation disposes of every dead session in one mechanical
line (`session-reconcile.ts:47-49`):

```ts
if (!facts.processAlive) {
  return { action: "forget", reason: "tmux session is gone; record is stale" };
}
```

A laptop reboot, an OS update, a `tmux kill-server`, or a hard power-off ends
every warm session. The transcripts survive on disk untouched. The worktrees
survive with their branches and uncommitted work. The pinned ids survive in the
records. And the system forgets all of it, because the only thing it ever asked
about a dead session was whether its process was alive.

Every supported CLI can resume a prior conversation by id. We have the ids.

Three consequences today:

1. **Accumulated context dies with the process.** The module docs for
   `AgentSessionManager` state it plainly: *"Session death loses accumulated
   context. There is no silent respawn."* The second sentence is a good
   principle — surfacing death lets a caller decide. The first is now avoidable.
2. **Reboots are expensive in a way nothing records.** There is no signal
   distinguishing "this agent finished" from "this machine restarted", so the
   cost is invisible and therefore never weighed.
3. **Worktrees outlive their records silently.** A forgotten record leaves its
   worktree on disk with no owner. Nothing lists them, so they accumulate until
   someone notices the disk.

## Settled decisions

- **Resume is lazy, never eager.** Boot marks recoverable sessions and spawns
  nothing. A machine with twelve dead sessions boots exactly as it does today.
  The CLI relaunches on first use.
- **Profile drift flags, it does not decide.** A dead session whose agent file
  changed while the server was down still resumes, keeping the profile
  materialized in its worktree. The drift is recorded and surfaced.
- **Resume is verified twice, for two different failures.** A pre-check at boot
  avoids launching a doomed process; a post-verify after resume catches the CLI
  silently opening a fresh prompt.
- **Orphan worktrees are surfaced, never deleted and never adopted.**
- **No new status value.** `dead` remains correct for a session with no process.
  Recoverability is a separate field, so this spec forces no second migration on
  the union spec 1 already rewrites.

## 1. Facts grow; the module stays pure

`session-reconcile.ts` is deliberately pure — *"no tmux, no filesystem — so
every branch is testable without a live process."* That property is worth more
than the convenience of letting it look things up, so the new inputs arrive as
facts gathered by the caller.

```ts
export interface ReconcileFacts {
  processAlive: boolean;
  recordedProfileHash: string;
  currentProfileHash: string | null;

  /** NEW — does the session's worktree still exist on disk? */
  worktreePresent: boolean;
  /** NEW — does this driver expose a resume command at all? */
  driverCanResume: boolean;
  /** NEW — is the prior conversation recoverable? `unverifiable` for tools that
   *  keep no local transcript to inspect. */
  transcript: "present" | "missing" | "unverifiable";
}
```

## 2. One new action, decided by a table

```ts
export type ReconcileAction = "adopt" | "forget" | "kill" | "resumable";
```

`resumable` means: keep the record, spawn nothing, mark it for lazy resume. The
whole `!processAlive` branch becomes a table:

| worktree | canResume | transcript | action | reason |
| --- | --- | --- | --- | --- |
| absent | — | — | `forget` | worktree is gone; nothing to resume into |
| present | no | — | `forget` | driver exposes no resume command |
| present | yes | `missing` | `forget` | transcript gone; resume would open a fresh prompt |
| present | yes | `present` | `resumable` | conversation recoverable on next use |
| present | yes | `unverifiable` | `resumable` | resume attempted on trust; see §7 |

Profile drift is deliberately absent from this table. It sets a flag, never an
action — see §3. The two policy branches in `resolveChangedProfile` are
untouched; they concern live processes, which this spec does not change.

The `missing` row is the interesting one. It looks like a case for optimism —
attempt the resume, see what happens — and optimism is wrong here precisely
because failure is invisible: a resume against a deleted transcript succeeds at
the process level and returns an agent with amnesia.

## 3. Recoverability and drift are record fields

Two additions to `SessionRecord` / `AgentSessionInfo`, neither a status value:

```ts
/** Set when boot classified a dead session as recoverable. */
recovery?: "resumable";
/** Set after a resume attempt: did the conversation actually come back? */
continuity?: "resumed" | "fresh";
/** Set at boot whenever the agent file no longer matches the launch pin. */
profileDrift?: { recorded: string; current: string | null };
```

`recovery` has one value, not two. There is no `"unrecoverable"` because every
unrecoverable case in §2 returns `forget`, which drops the record — so the state
has nowhere to be written. A field whose second value is structurally
unreachable invites a reader to handle a case that cannot occur.

`status` stays `dead` for a session with no process, because it is true. Adding a
`resumable` status would be modelling *recoverability* as *liveness*, and would
force a second migration on the union spec 1 is already rewriting — two
migrations to the same field in two specs is how a field ends up with values
nobody can enumerate.

`profileDrift` is set for live-adopted sessions too, not only resumable ones.
Today that fact exists solely inside a boot log string
(`"profile changed since launch; live process kept"`), which means the UI cannot
show it and the user discovers it by being surprised. It is the same
information; it just needs somewhere to live.

## 4. The driver seam

Two optional methods on `ToolDriver`. Optional is load-bearing: absence means
"cannot resume", so a tool without support needs no special-casing anywhere.

```ts
/** Command to resume a prior session, or null when this tool cannot. */
resumeCommand?(baseCommand: string, sessionId: string, model?: string): string | null;

/** Is a prior conversation recoverable? Absent method ⇒ `unverifiable`. */
transcriptStatus?(cwd: string, sessionId: string): Promise<"present" | "missing" | "unverifiable">;
```

| driver | resume command | `transcriptStatus` mechanism |
| --- | --- | --- |
| claude | `claude --resume <id>` | stat the path from `sessionFileFor()` |
| codex | `codex resume <id>` | scan recent rollouts; sessions are not partitioned by cwd |
| copilot | `copilot --resume=<id>` | query its store behind the `db::` handle |
| opencode | `opencode --session <id>` | `session` row lookup in `opencode.db` |
| agy | `agy --conversation <id>` | method absent ⇒ `unverifiable` |

`resumeCommand` is a distinct shape from `interactiveCommand`, not a parameter on
it: the latter *pins* a new id (`--session-id`), the former *reopens* an existing
one. Both apply `modelFlag`.

`codex` is the expensive one. Its rollouts live at
`~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<uuid>.jsonl` and are not keyed
by working directory, so a lookup is a scan rather than a stat. Bound it to
recent days and treat a scan miss as `missing`, not as an error.

## 5. Lazy resume

`assertAlive()` currently throws `SessionDeadError` when the status is `dead` or
the tmux session is absent (`agent-sessions.ts:378`). That check becomes the
resume trigger: when `recovery === "resumable"`, attempt recovery before
throwing.

1. **Re-verify the worktree.** It may have been removed between boot and now.
   Gone ⇒ `forget` the record and throw, with a reason naming the missing path.
2. **Re-run `prepareWorkspace()`.** Idempotent, and the CLI's trust store may
   have been reset while the server was down. Skipping this reintroduces the
   folder-trust failure on exactly the path least likely to be tested.
3. **Relaunch** tmux with `resumeCommand(...)`.
4. **Wait on the existing readiness probe.** No new readiness concept.
5. **Post-verify.** Parse the transcript. A non-empty conversation ⇒
   `continuity: "resumed"`, status `idle`. Zero messages ⇒ `continuity: "fresh"`,
   logged at warn, and the caller is told. Skipped when `transcriptStatus`
   reports `unverifiable`.

A resume that yields a fresh session is **not** an error and does not throw. The
session is usable; it simply has no history. Throwing would discard a working
process to punish a lost transcript. Reporting it accurately is the requirement.

**Failed launch.** If the relaunch itself fails, the record keeps
`recovery: "resumable"` and gains `lastResumeError` plus `lastResumeAt`. There is
no automatic retry — a caller trying again is a deliberate act, and a loop that
retries a broken CLI on every `send()` would turn one failure into a rate-limit
incident.

**Interaction with spec 1.** Nothing to redo on resume. Hook configuration was
written into the worktree at create and is still there; the endpoint file is
rewritten on every server start, so a resumed session reads the current address
on its first report.

## 6. Orphan worktrees

Boot scans the sessions worktree directory. Any directory with no matching
record is recorded as an orphan and exposed — a route and a CLI listing —
carrying its path, branch, whether the tree is dirty, and ahead/behind counts
against its base.

Nothing is deleted. Nothing is adopted. Deleting risks unpushed commits on a
branch that looks clean, and in a shared checkout the directory may belong to
another swarm instance or to a person. Adopting would fabricate a record with no
profile hash and no agent identity, which is precisely what the pinning model
uses to decide whether a session still matches its definition.

Reporting is the whole feature. A human deciding what to reclaim needs a list,
not a policy.

## 7. The `agy` carve-out

`agy` keeps conversations server-side and persists no local transcript
(`drivers/agy.ts:21`, `warmSessionsSupported = false`), so neither verification
applies: nothing to pre-check, nothing to post-verify. Its resume is attempted on
trust and its `continuity` stays unset rather than claiming either value.

This path is **dormant on delivery.** Because `create()` refuses `agy` today,
there are no `agy` warm sessions in existence to resume. The carve-out becomes
live only if spec 1 lands and makes `agy` warm-session-capable via hooks. It is
specified here so that spec 1 does not have to reopen this file, and it needs a
test asserting the unverifiable path is taken — not a test asserting resume
works, which cannot be written yet.

## 8. Errors

| condition | outcome |
| --- | --- |
| worktree vanished between boot and resume | record forgotten, throw naming the path |
| relaunch fails | record stays resumable, `lastResumeError` set, no retry |
| resume yields empty conversation | usable session, `continuity: "fresh"`, warn |
| `transcriptStatus` throws | treat as `missing`; a lookup we cannot complete is not a conversation we can promise |
| orphan scan fails | log and continue; boot must not depend on it |

## 9. Testing

- **Decision table** as a case table over the five rows in §2, matching how the
  existing pure module is already tested.
- **Per-driver `resumeCommand`** fixtures, five drivers, including `modelFlag`
  composition.
- **`transcriptStatus`** per driver: present, missing, and — for codex — a scan
  that misses.
- **Post-verify control:** a fake driver whose parse returns zero messages must
  produce `continuity: "fresh"`. If this test still passes with post-verification
  deleted, it is testing nothing; the plan should verify that it fails.
- **No-new-status assertion:** a resumable session reports `status: "dead"`. This
  guards the §3 decision against a future edit that "simplifies" it into the
  union.
- **Orphan scan:** a worktree directory with no record is listed, and still
  exists on disk afterwards.

## Out of scope

- **Eager resume** and a bulk resume-all command — considered and declined.
- **Deleting or adopting orphans** — surfacing only.
- **Hibernation** (spec 5). It is the consumer of `resumable`: hibernation
  deliberately kills a live process knowing this spec can bring it back. Nothing
  here assumes it exists.
- **Status reporting** (spec 1). The two specs touch adjacent fields on the same
  record and are otherwise independent.
- **Resuming across machines.** A record's worktree path is local; a session
  resumable on one host is not resumable on another. Out of scope until the
  remote substrate work needs it.
