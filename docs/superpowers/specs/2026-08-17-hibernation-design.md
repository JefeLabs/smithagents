# Hibernation — Design

**Date:** 2026-08-17
**Status:** Approved design, ready for planning
**Part of:** spec 5 of 7 in the decomposition drawn from the Hamster / herdr /
Orca teardown.
**Depends on:** spec 1 (`2026-08-16-agent-status-reporting-design.md`) for the
`done` state and `statusFidelity`; spec 2
(`2026-08-17-session-recovery-design.md`) for resume, which is the entire wake
path; spec 4 (`2026-08-17-agent-visibility-design.md`) for the assignee rollup,
which is the safety rule.

## Goal

Every idle agent holds a PTY and a model session for as long as it is left
alone.

A warm session exists to keep accumulated context alive across turns, and that
is worth paying for while the work is live. It is not worth paying for on a
crew of a dozen assignees where two are working and ten finished hours ago.
Nothing currently reclaims them: `session:orphan_cleanup` fires only from the
dispatcher's task cleanup and from the reset path, both keyed to the task tmux
prefix. There is no idle machinery for warm sessions at all.

The reason this has been safe to ignore is that reclaiming was destructive.
Killing an idle session lost its conversation, so the only options were to keep
everything or lose something. Spec 2 removes that trade: a session with a pinned
id, a live worktree, and a verified transcript can be brought back. Once waking
is reliable, sleeping stops being destruction and becomes deferral.

Two consequences today:

1. **Crews do not scale past what one machine can hold awake.** The cost of an
   assignee is paid from creation until someone manually destroys it, whether or
   not it is doing anything.
2. **Nothing distinguishes finished-and-idle from finished-and-forgotten.** Both
   look identical and both cost the same.

## Settled decisions

- **The assignee is the unit.** All of its sessions sleep together or none do. A
  squad never wakes to find a member gone.
- **Sleep adds no wake path.** It produces exactly spec 2's `resumable` state, so
  waking is spec 2's lazy resume, unchanged and already tested.
- **No new status value.** `status` stays `dead`, `recovery` stays `resumable`,
  and a `sleptAt` timestamp distinguishes deliberate from accidental.
- **Never sleep what cannot be proven wakeable.**
- **Off by default, opt-in per workspace.**
- **Eligibility is re-checked immediately before the kill.**

## 1. Sleep is the only new verb

Sleeping an assignee kills the tmux session of each member and leaves everything
else untouched: the record, the pinned session id, the worktree, the branch, the
materialized profile, and the transcript on disk.

The resulting state is byte-for-byte what spec 2 already classifies. A slept
assignee and an assignee whose machine rebooted are the same thing, deliberately:

```
processAlive: false · worktreePresent: true · transcript: present
  ⇒ resumable
```

So this spec introduces no wake logic, no second recovery path, and no new
failure mode on the way back. `sleptAt` is set on sleep and cleared on
successful wake; it changes what the UI says, not what the code does.

This is the whole argument for building spec 2 first. Hibernation without it is
a feature that destroys work; hibernation after it is a scheduling decision.

## 2. Eligibility

An assignee is sleepable only when **every** condition holds.

| # | condition | source |
| --- | --- | --- |
| 1 | the assignee rollup reports `done` | spec 4 §3 |
| 2 | every member has `statusFidelity: "hooks"` | spec 1 §5 |
| 3 | no member has received input since it reported `done` | `lastTurnAt` |
| 4 | idle for at least the configured window | `doneSince` |
| 5 | every member is verifiably wakeable | spec 2 §4 |
| 6 | no active dispatch on its work item | `delegation.state` |
| 7 | hibernation is enabled for the workspace | §5 |
| 8 | it is not the foreground session | control-plane active id |

**Condition 1 does more work than it appears to.** The assignee rollup already
encodes three of Orca's separate checks: any member `blocked` means the assignee
is not `done`; `done` requires *every* member `done`; and one `unknown` member
makes `done` unprovable. Orca states these as hibernation rules —
*"provider 'done' alone is not enough while children are still attached."* Here
they are already the definition of a done assignee, so the reaper inherits them
rather than restating them. A rule stated twice is a rule that will eventually
be revised once.

**Condition 5 is Orca's inverted, and is the one worth defending.** Orca
hibernates only agents from a list of resumable tools. Spec 2 gives something
stronger than a list: `resumeCommand` presence plus a transcript pre-check that
actually looks. Never sleep what you cannot prove you can wake.

This deliberately excludes `agy`, whose `transcriptStatus` is `unverifiable`.
Spec 2 resumes it on trust, and trust is appropriate for recovering from a crash
you did not cause. It is not appropriate as a reason to cause one.

## 3. The sweep

A 60-second tick in swarm, evaluating eligibility from timestamps on the
records.

Not cron. The existing midnight sweep is a calendar-anchored daily job where
cron is the right mechanism; this is a duration timer measured in minutes, and
tying it to a wall-clock schedule would make the idle window depend on when the
tick happened to land.

Recomputing from `doneSince` each tick rather than arming per-assignee timers
makes the sweep restart-safe by construction: there is no in-memory schedule to
lose, and a server that was down for an hour reaches the same conclusion on its
first tick that it would have reached gradually.

**Eligibility is re-checked immediately before the kill**, not only at selection
time. The gap between deciding to sleep and sleeping is where an agent receives
input, a dispatch starts, or a member goes from `done` to `working`. A check
whose result is acted on later is a check against a state that no longer exists,
and the cost here is killing a working agent.

## 4. Waking, and a report we hold to a higher standard

Waking is spec 2 §5 in full: re-verify the worktree, re-run `prepareWorkspace`,
relaunch with the resume command, wait on the readiness probe, post-verify the
transcript.

One difference, and it is in reporting rather than mechanism. Spec 2 records
`continuity: "fresh"` when a resume silently loses the conversation and treats it
as a usable session with no history. After an unplanned death that is accurate
and proportionate — the transcript was lost by something outside the system.

**After a deliberate sleep it is this system's fault.** We chose to kill a
working process on the strength of a checklist, and failed to bring it back. The
same code path, `sleptAt` present, is reported at higher severity: logged as an
error rather than a warning, surfaced on the assignee, and counted. If that
counter is ever non-trivial, hibernation is losing work and should be disabled
rather than tuned.

## 5. Configuration

Per workspace:

```json
{ "hibernation": { "enabled": false, "idleMinutes": 30 } }
```

`idleMinutes` accepts 1 to 1440, defaulting to 30, matching Orca's range and
default. A workspace with no hibernation key never sleeps anything.

**Off by default is a deliberate choice, not caution theatre.** The checklist is
only as good as the states feeding it, and those come from spec 1's hooks —
which will themselves be new, with a fidelity fallback whose probe window is an
untuned guess (spec 1 §9). Opt-in means the first wrong sleep lands on someone
who chose the feature, and gives the checklist a chance to earn trust on real
crews before it runs everywhere. Orca reached the same conclusion from the other
side, having built it: *off by default while we keep tuning the safety model.*

## 6. Errors

| condition | outcome |
| --- | --- |
| kill fails for one member | abort the whole assignee; no member is left slept |
| assignee becomes ineligible between check and kill | abort, no state change, re-evaluate next tick |
| wake fails to launch | spec 2 §5 — record stays resumable, `lastResumeError` set |
| wake yields an empty conversation | `continuity: "fresh"`, reported as error because `sleptAt` was set |
| workspace config is malformed | treat as disabled; never sleep on an unreadable policy |

The first row is B5 as an error rule: partial sleep is worse than no sleep,
because it produces exactly the half-paused assignee the unit decision exists to
prevent.

## 7. Rendering

A slept assignee is `status: dead`, `recovery: "resumable"`, `sleptAt` set. Spec
4's board renders it as sleeping — quieter than idle, since it is deliberate
quiet — and never in Needs You or Working.

Sleeping must not read as failure. An assignee that slept correctly and can be
woken is the system working; showing it beside genuinely dead sessions would
teach people to distrust a mechanism that is behaving.

## 8. Testing

- **Eligibility table, one condition at a time.** Each of the eight must
  independently block sleep, asserted separately. A checklist tested only in
  aggregate still passes when a condition is deleted, which is the specific way
  safety checklists rot.
- **Unwakeable never sleeps:** an assignee with an `unverifiable` member is not
  selected, even when every other condition holds.
- **The re-check window:** a state change injected between selection and kill
  aborts the sleep.
- **Partial-kill abort:** a member whose kill fails leaves no member slept.
- **Severity asymmetry:** a `fresh` wake with `sleptAt` set reports at error
  level; without it, at warn.
- **Default off:** a workspace with no hibernation config never sleeps anything,
  regardless of idle time.

## 9. Open items

- **Ad-hoc sessions have no assignee.** A session created through
  `POST /agent-sessions` with no delegation has no rollup and therefore no unit
  to sleep — spec 4 gives them their own Unassigned column precisely because
  nothing else accounts for them. They are arguably the best hibernation
  candidates, since nobody is watching them. Left out of v1 deliberately rather
  than by omission; revisit once the assignee rollup has proven itself.
- **`idleMinutes` default of 30 is inherited, not measured.** It is Orca's
  default for a human driving worktrees by hand. A crew of autonomous agents may
  want longer or shorter, and the counter in §4 is the signal to look at.

## Out of scope

- **Eager wake.** Spec 2 settled resume as lazy; nothing here changes that.
- **Sleeping across machines.** A record's worktree path is local, and spec 2
  already scopes resumability to one host.
- **Reclaiming worktrees or disk.** Sleep releases a process, not storage.
  Instance teardown is the workspace-instances line.
- **Sleeping the foreground session.** Condition 8 excludes it; a policy that
  can sleep what the user is looking at is a bug with a configuration knob.
