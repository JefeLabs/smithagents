# Docker Git Isolation — Design

**Date:** 2026-10-23 · **Status:** approved to plan (Edwin, 2026-10-23: "plan the git fix first, then subagent-driven") · **Plan:** `docs/superpowers/plans/2026-10-23-docker-git-isolation.md` · **Lands before:** `docs/superpowers/plans/2026-10-23-local-api-auth.md`, whose protection depends on this.

## Why

A docker task's container gets the user's **real** repository `.git` mounted read-write
(`swarm/src/runtime.ts` `gitdirMount`). This holds on both the legacy and the workspace-instance
path, because both hand the container a `git worktree`. After the container exits, the dispatcher
runs `git status`, `git add -A`, and `git commit` **on the host**, in that worktree, with hooks
enabled (`dispatcher.ts` `ensureWorkCommitted`). It then runs `git push` and `gh pr create` there
too (`openPullRequest`).

Anything the container writes into git metadata therefore runs on Edwin's Mac as Edwin:

- **Hooks:** `.git/hooks/*`.
- **Config:** `core.fsmonitor` or `include.path` in `.git/config`.
- **Redirection:** a rewritten worktree `.git` file, or a rewritten `.git/worktrees/<id>/commondir`,
  that points git at metadata the container controls.

The container can also overwrite object files or move `refs/heads/main`.

**Measured on 2026-10-23** with the real `smith-agent:latest` image. Running plain host git in a
container-written repo fired four planted traps: `fsmonitor`, `pre-commit`, `post-index-change`,
and `reference-transaction`. The same container's work, imported by the design below, fired none.

Git's own manual (`git help git`, SECURITY) says it is not safe to run git in a `.git` that comes
from an untrusted source. It says fetching from one through `upload-pack` "carries some risk", and
that the safest way is to serve the repository as an unprivileged user.

## Goals

1. A container can write nothing that the host later executes or trusts as git metadata.
2. A container can't modify the user's repository: no objects, no refs, no config, no hooks.
3. Agents keep full git inside their sandbox: commit, branch, stash, rebase.
4. The task's work still lands as `smith/<taskId>` in the user's repo, and the PR still opens.

## Non-goals

- **Host (tmux) tasks:** they keep worktrees. The host is not a sandbox (see the auth spec).
- **Squads:** they never launch. Their shared-object-store design doesn't fit per-container clones;
  revisit if squads ever run in docker.
- **Remote-docker workers:** that path can't run a task today (the repo never ships to the worker).
  After this change it fails closed.
- **Cleaning up old task directories.** Today nothing removes worktrees either.
- **Linux hosts with uid ≠ 501** (`safe.directory`). Today's image is already Mac-shaped.

## Anti-goals

- Any host git or `gh` command that reads a container-written `.git`, including retries and
  re-dispatch of the same task.
- Any mount list derived from container-written files after the container has run.

## Design

**A docker task gets a disposable clone, not a worktree.** The clone is made with
`git clone --shared` from the user's repo, at `<stateRoot>/clones/<taskId>`, on branch
`smith/<taskId>`, cut from the base **commit**. The base is resolved on the host first, because a
fresh clone has local branches only.

- **What the container sees:** the clone read-write, and the user's object store read-only at the
  same absolute path the clone's `alternates` names, including any chained alternates. It gets
  nothing else of the user's repo.
- **Mounts are computed once,** when the clone is created and still trusted. They are stored in the
  `TaskClone` record and reused for every later container. They are never re-read from the clone.
- **The clone's `origin`** is the user repo's origin URL, so `git fetch origin` inside behaves as it
  does today. With no origin, the clone has none.
- **Freshness:** a clone path that already exists is refused, never reused.

**Every git command against the clone after launch runs in a container:**

1. **Finalize.** This replaces `ensureWorkCommitted` for docker tasks. One `docker run --rm
   --network none` commits any leftover changes, with the same commit message as today. Hooks the
   agent planted can run only inside that sandbox, and it has no network.
2. **Import.** The host runs `git fetch` **in the user's repo**, which is the client side and
   handles untrusted data by design, with `--upload-pack="docker run --rm -i --network none
   --entrypoint git-upload-pack -v <clone>:<clone>:ro <object mounts>:ro <image>"`. It refreshes
   `+refs/heads/smith/<taskId>`. Hardening: `core.hooksPath=/dev/null`, `core.fsmonitor=false`,
   `fetch.fsckObjects`/`transfer.fsckObjects`, `--no-tags`, `--no-recurse-submodules`,
   `--no-write-fetch-head`. Git honours `--upload-pack` for a local path; this was verified with a
   failing command and with a logging wrapper.
3. **PR.** The PR is opened from the **user's repo**, never the clone.
   - Commits are counted and the title taken from `<baseSha>..smith/<taskId>`, not `HEAD`.
   - The push is `git -c core.hooksPath=/dev/null push --no-verify origin smith/<taskId>`, without
     `-u`.
   - `gh pr create --head smith/<taskId>` runs with the user's repo as cwd.

**`DockerRuntime` refuses a worktree.** If `<cwd>/.git` is a file, the launch throws. This turns
every path that still hands docker a worktree into a loud failure: warm sessions on a docker
default runtime, and remote-docker. `gitdirMount` is deleted. Read-only mounts arrive through a new
optional `LaunchOptions.readOnlyMounts`.

## Calls made without asking (check these)

1. Clones live at `<stateRoot>/clones/<taskId>`, not inside the workspace's `.runtime/instances`.
   Docker tasks skip the instance's sparse org-config member, which was never visible in the
   container anyway.
2. A docker task without a repository is refused, rather than given an empty directory.
3. Import failure doesn't fail the task. It is logged, the clone is kept, and no PR opens.
4. Docker PR pushes skip pre-push hooks (`--no-verify`).
5. Clones are kept after import, matching today's worktrees. Cleanup is a separate feature.
