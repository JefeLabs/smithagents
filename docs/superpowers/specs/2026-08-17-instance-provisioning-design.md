# Instance Provisioning — Design

**Date:** 2026-08-17
**Status:** Approved design, ready for planning
**Part of:** spec 3 of 7 in the decomposition drawn from the Hamster / herdr /
Orca teardown. Independent of specs 1 (agent status reporting) and 2 (session
recovery).
**Builds on:** `swarm/src/workspace-instances.ts`, which already creates,
inspects, and destroys instances. This spec adds only what happens between
`git worktree add` and a usable checkout.
**Honours:** §7 of `2026-08-16-workspace-instances-and-assignment-design.md`
(secrets are retrieved on demand, never held by the instance). See §3.

## Goal

A new instance is a clean checkout, so everything gitignored is missing.

`createInstance` runs `git worktree add` per member and stops there
(`workspace-instances.ts:201-219`). Tracked files arrive; `node_modules`, build
caches, and local editor config do not. An agent assigned to that instance
cannot build, cannot test, and cannot run anything until it reconstructs the
tree itself — if it thinks to.

The existing code already knows this content matters. `destroyInstance` refuses
to proceed when it finds ignored content, categorizing it separately from
uncommitted changes because it "may contain irreplaceable content like `.env`"
(`workspace-instances.ts:387`, `:421`). The system defends gitignored content at
teardown and provides none at creation. An instance is born without a `.env` and
then cannot be destroyed because it has one.

Three consequences today:

1. **Every instance pays a full cold build.** Whatever the agent reconstructs,
   it reconstructs from nothing, in every instance, every time.
2. **The failure is silent and late.** Nothing reports "this checkout is not
   workable." The agent discovers it by running a command that fails, and how
   well it recovers is a property of the agent rather than of the system.
3. **Worktree-per-work-item stays theoretical.** Isolation that makes each unit
   of work expensive to start is isolation people route around.

## Settled decisions

- **Copy, never symlink.** Every instance owns its whole tree. A shared
  `node_modules` is shared mutable state between concurrent agents, which is
  precisely what the instances design exists to prevent.
- **Secrets are not provisioned.** Rebuildable trees and non-secret local config
  only. §7 owns credentials and its argument stands: an agent told to commit
  everything cannot commit a secret that was never on disk.
- **Detect by default, override in workspace config.** A lockfile-driven
  detector handles the ordinary case with no configuration. Nothing is written
  into the user's project repos.
- **Copy is an optimization; setup is the correctness path.** A failed copy
  yields a slow instance, never a broken one.
- **Creation runs in the background.** Copying a tree and running an install is
  seconds to minutes; a blocking create makes worktree-per-task unusable.
- **Nothing is destroyed on failure.** A failed instance keeps its worktrees.

## 1. Three classes of gitignored content

| class | examples | verdict |
| --- | --- | --- |
| rebuildable trees | `node_modules`, `.cache`, `target` | copied |
| non-secret local config | `.vscode/settings.json`, `.tool-versions` | copied |
| secrets | `.env`, `.env.local`, credential files | **never copied** — §7 |

The third row is where this spec deliberately diverges from Orca, which copies
`.env` into every worktree. That is the better developer ergonomic and the worse
security posture, and §7 already chose: retrieval on demand through a
`smith-secret` shim, with rotation, revocation, and audit. Provisioning secrets
here would quietly retire an approved decision.

The practical consequence is stated plainly rather than hidden: **until the
secret registry ships, an instance needing a credential cannot get one.** That
gap belongs to §7, and a bridge built here would be the thing least likely to be
removed once it worked.

## 2. The detector

Per member, keyed on lockfiles present in the source checkout.

```ts
interface ProvisionPlan {
  /** Gitignored paths to copy from the source checkout. */
  copy: string[];
  /** Commands run in the new member after copying. */
  setup: string[];
  /** Why this plan exists — "pnpm-lock.yaml", or "config override". */
  detectedBy: string;
}
```

`detectedBy` carries the same discipline the reconciler applies to its verdicts:
every decision explains itself, so a wrong plan is diagnosable without reading
the detector. A plan that cannot say why it exists is a plan nobody can debug.

A deliberately small table, extended when a repo needs it rather than in
anticipation:

| signal | copy | setup |
| --- | --- | --- |
| `pnpm-lock.yaml` | `node_modules` | `pnpm install --frozen-lockfile` |
| `package-lock.json` | `node_modules` | `npm ci` |
| `yarn.lock` | `node_modules` | `yarn install --immutable` |
| none of the above | — | — |

A repo matching nothing gets an empty plan and is immediately ready. That is the
correct outcome for a repo with no dependencies, not a failure to detect.

**The detector must never emit a `copy` entry that its `setup` cannot
reproduce.** This is the invariant behind the copy-is-an-optimization property
in §5; violating it turns a recoverable slow path into an unrecoverable broken
one.

## 3. Copy safety, as a guard rather than a convention

Overrides are user-authored, so a `.env` will eventually appear in a copy list.
§7's decision is therefore enforced in code, not documented and hoped for. The
copy step rejects any path that:

- matches the secret denylist (`.env`, `.env.*`, `*.pem`, `id_rsa*`, and the
  registry's own key material),
- is tracked by git — it is already in the worktree, and copying over it would
  shadow the checkout with a stale copy,
- is absolute, or escapes the member root via `..`,
- does not exist in the source checkout.

A rejected path is a hard error on an override and a skipped entry with a
warning on a detected plan. The asymmetry is deliberate: a user who wrote the
path meant it and needs to be told they cannot have it; a detector that guessed
wrong should not fail the instance.

## 4. Overrides

`config/settings.json`, keyed by repo name:

```json
{
  "repos": {
    "web": {
      "provision": {
        "copy": ["node_modules", ".vscode/settings.json"],
        "setup": ["pnpm install --frozen-lockfile", "pnpm build:deps"]
      }
    }
  }
}
```

An override **replaces** the detected plan for that repo; it does not merge with
it. Merging produces a union nobody wrote in full, and the first surprising copy
sends someone reading detector source to find out where a path came from.
`detectedBy` becomes `"config override"`.

Nothing is written into project repos. The workspace's `config/` is already a
versioned git repo the user owns, which makes it the natural home; a repo-local
manifest would travel between users, and that matters only once workspaces are
shared, which they are not.

## 5. Copy mechanics

Copy-on-write where the filesystem provides it — `cp -c` on APFS — falling back
to a plain recursive copy. Both produce an independent tree; the clone is an
optimization on the same semantics, not a different sharing model. No symlinks
are created under any condition.

**Copy failure is not instance failure.** The copy is skipped with a warning and
setup proceeds, rebuilding what the copy would have provided. This is what makes
provisioning safe to run unattended: the worst outcome of a failed copy is a
cold build, which is exactly the status quo.

## 6. Background creation

`createInstance` currently blocks its caller (`server.ts:3811`) and would now
block it for the length of an install. Creation becomes a job.

```
provisioning → ready
             → failed
```

The route returns immediately with the instance in `provisioning`. The instance
directory and every member worktree already exist at that point; only copy and
setup are outstanding. Progress and the current setup command are readable, and
the job can be cancelled or retried.

**Session launch is gated on `ready`.** `AgentSessionManager.create()` refuses an
instance still provisioning, with a reason naming the state. An agent starting
in a half-populated tree would produce failures indistinguishable from real ones
— a dependency that is missing because it has not been copied *yet* looks exactly
like a dependency that is genuinely absent.

## 7. Errors

| condition | outcome |
| --- | --- |
| detector matches nothing | empty plan, instance `ready` |
| copy rejected by a guard (detected) | warn, skip that path, continue |
| copy rejected by a guard (override) | instance `failed`, naming the path and the rule |
| copy fails at the filesystem | warn, continue to setup |
| setup command fails | instance `failed`, command output retained |
| setup exceeds its timeout | instance `failed`, treated as above |
| session create against `provisioning` | refused, with the state in the reason |

A `failed` instance keeps its worktrees and its branches. The existing code
already refuses to destroy an instance holding ignored content; a provisioning
failure is a weaker signal than that and must not be a licence to clean up.

## 8. Testing

- **Detector table:** each lockfile fixture produces the expected plan, and a
  repo with no lockfile produces an empty plan that is `ready` rather than
  `failed`.
- **Denylist enforcement:** an override naming `.env` is rejected. This test is
  the enforcement of §7 — if it passes with the guard removed, §7 is a comment.
- **Copy-optimization property:** a member whose copy step is forced to fail
  still reaches `ready` through setup.
- **Guard coverage:** tracked path, absolute path, `..` escape, and absent path
  each rejected, with the detected-versus-override asymmetry asserted.
- **Launch gate:** `create()` against a `provisioning` instance is refused.
- **`detectedBy` is always populated**, including on the empty plan.

## Out of scope

- **Preserved branches (register F3).** Moot: `destroyInstance` never deletes
  branches. If branch cleanup is ever added, Orca's rule — keep what git refuses
  to drop, and list it — should come with it.
- **Cascade to nested members (register F5).** Already handled;
  `listMemberWorktrees` finds member worktrees on disk precisely because they
  were added after the instance was built.
- **Symlink sharing.** Considered and declined; it reintroduces shared mutable
  state between concurrent agents.
- **Secrets.** §7, in full.
- **Detecting non-Node ecosystems.** The table extends when a repo needs it.
