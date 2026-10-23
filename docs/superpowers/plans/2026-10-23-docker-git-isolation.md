# Docker Git Isolation Implementation Plan

> **Executing:** branch `feat/docker-git-isolation` (Claude Code session 7177457c, subagent-driven) since 2026-10-23T09:01Z

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A docker task's container can no longer write into the user's repository, and no host git or `gh` command ever reads a `.git` that a container wrote.

**Architecture:**
- **Clone instead of worktree.** A docker task runs in a disposable `git clone --shared` at
  `<stateRoot>/clones/<taskId>`. The user's object store is mounted read-only, at the paths recorded
  when the clone was created.
- **Git against the clone after launch runs in a container.** That covers the leftover-changes
  commit and the server side of the import fetch (`--upload-pack="docker run … git-upload-pack"`).
- **The host only acts as a fetch client,** in the user's own repo. The PR is opened from the user's
  repo with hooks off.
- **`DockerRuntime` refuses any worktree cwd,** so the paths this plan doesn't convert (warm
  sessions on a docker default, remote-docker) fail closed.

**Tech Stack:** Node ≥ 24, TypeScript ~7.0.2 (`tsx` strips types, so `tsc --noEmit` is the only type gate), `node:test`, git ≥ 2.47 (host 2.56, image 2.47.3), Docker Desktop + `smith-agent:latest` (`make agent-image`), biome 2.6.2, pnpm 12.15.0.

**Spec:** `docs/superpowers/specs/2026-10-23-docker-git-isolation-design.md`. Read its "Calls made without asking" list first. This plan lands **before** `docs/superpowers/plans/2026-10-23-local-api-auth.md`.

**Base branch:** `origin/main` (at the time of writing: `e4fd022`, plus this plan's own commit).

## Global Constraints

- **Worktree:** `git worktree add -b feat/docker-git-isolation .claude/worktrees/docker-git-isolation origin/main`.
  With symlinked `node_modules`, run scripts as `pnpm --config.verify-deps-before-run=false -C swarm <script>`.
  Never `git add -A`.
- **Tests:**
  - Unit: `cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 src/<file>.test.ts`.
  - Image-backed (opt-in): prefix with `SMITH_AGENT_IMAGE=smith-agent:latest`. An opt-in suite that
    reports skips proved nothing; it must show **zero skipped**.
  - A run counts only with `ℹ fail 0` **and** a non-zero `ℹ pass`. Read exit codes by redirect,
    never through a pipe.
- **Gates at every commit:** `tsc --noEmit` passes in swarm. biome shows no findings beyond main's
  baseline: 2 warnings and 1 info. Measure it.
- **THE RULE:** after a container has started on a clone, **no host process runs git (or `gh`)
  with that clone as cwd, `--git-dir`, or `-C`.** The only exceptions are a test's deliberate
  positive control and `rm`. Every host git call this plan adds goes through `hardenedGit`
  (Task 1), which prefixes `-c core.hooksPath=/dev/null -c core.fsmonitor=false`.
- **Mount lists for every container** come from the `TaskClone` record, computed at clone time.
  They are never re-read from the clone afterwards.
- **Image containers this plan adds** (finalize, upload-pack) run with `--rm --network none` and an
  explicit `--entrypoint`. The image's tini+tmux entrypoint would corrupt the upload-pack stream.
  They get no credential mount and no `-e`.
- **Exact strings:**
  - Clone path: `join(smithRoot, "clones", taskId)`. Branch: `smith/<taskId>`.
  - The auto-commit message is today's `ensureWorkCommitted` text, unchanged, produced by
    `autoCommitMessage` (Task 2).
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Once a SHA has
  been reported, fix forward; never amend.
- Do not touch `~/.smithagents`. Tests use `mkdtemp` roots and realpath them; on macOS `/var` is a
  symlink to `/private/var`.
- Before any test that runs the real Dispatcher on docker, check that
  `docker ps -a --filter name=^sub-` is empty. Teardown removes containers whose names start with
  `sub-`.

## Review Focus

1. **The repo path contains a symlink** (macOS `/var` → `/private/var`, or a symlinked `~/code`).
   The object-store path the clone's `alternates` names must be exactly the path mounted in the
   container, or every in-container git command fails with "unable to read". Task 1 has a
   symlinked-repo test.
2. **The base branch exists only as `origin/<base>`,** because a local `main` was deleted. The clone
   must start at origin's commit, not fail, and not silently use the default branch. Task 1 test.
3. **The same taskId is re-dispatched after a run whose import failed.** The old clone, which a
   container touched, must be refused loudly, and never reused or deleted. Task 1 test.
4. **Docker Desktop quits mid-task,** so the finalize container and the import fetch both fail. The
   task result must still be written, the error must name the kept clone path, and no PR attempt
   may run. Task 4 test (`finalizeAndImport` with a dead runner).
5. **The agent deletes or renames its own `smith/<taskId>` branch.** Import fails cleanly: the error
   is logged, nothing appears in the user's repo, and the task does not crash. Task 2 test (missing
   branch) plus Task 4's never-throws test.

---

## File Structure

| File | Responsibility after this plan |
|---|---|
| `swarm/src/task-clone.ts` | NEW. `hardenedGit`, `shellQuote`, `objectStoreMounts`, `createTaskClone`, `sandboxedUploadPack`, `importTaskBranch`, `autoCommitMessage`, `finalizeCommand` |
| `swarm/src/runtime.ts` | `LaunchOptions.readOnlyMounts`. DockerRuntime refuses worktrees and gains `runOnce`. `gitdirMount` deleted |
| `swarm/src/dispatcher.ts` | Docker tasks go through `prepareTaskClone` → launch → `finalizeAndImport` → `openPullRequest` from the user's repo. Tmux tasks are unchanged |
| `swarm/src/runtime.docker.test.ts` | Contract: commit inside the clone with objects read-only; planted traps never fire on the host |
| `swarm/src/dispatcher.docker.test.ts` | NEW. The real Dispatcher, end to end, in docker (opt-in) |

---

### Task 1: Task clones

**Files:**
- Create: `swarm/src/task-clone.ts`
- Test: `swarm/src/task-clone.test.ts`

**Interfaces:**
- Consumes: `resolveStartPoint(source: string, base: string): Promise<string>` (`swarm/src/workspace-instances.ts:112`).
- Produces:

```ts
export interface TaskClone {
  repoPath: string;         // realpath of the user's repo
  path: string;             // the clone directory
  branch: string;           // `smith/${taskId}`
  baseSha: string;          // the commit the branch was cut from
  readOnlyMounts: string[]; // [0] = the user's objects dir (realpath); then chained alternates exactly as their files name them
}
export async function hardenedGit(args: string[], cwd: string): Promise<string>;
export function shellQuote(word: string): string;
export async function objectStoreMounts(repoPath: string): Promise<string[]>;
export async function createTaskClone(repoPath: string, clonePath: string, taskId: string, base: string): Promise<TaskClone>;
```

- [ ] **Step 1: Write the failing tests** in `swarm/src/task-clone.test.ts`. Each one uses a realpath'd `mkdtemp` dir containing a `repo` made with `git init -q -b main` and one empty commit. Reuse `makeGitRepo`/`gitCommitAll` from `swarm/src/org-repo.fixture.ts` if they fit.

```ts
test("createTaskClone: a fresh clone on smith/<taskId> at the base commit, borrowing the user's objects", async () => {
  const clone = await createTaskClone(repo, join(dir, "clones", "t1"), "t1", "main");
  assert.equal(clone.branch, "smith/t1");
  assert.equal(clone.baseSha, await sh("git", ["rev-parse", "main"], repo));
  assert.ok((await lstat(join(clone.path, ".git"))).isDirectory(), "a clone, not a worktree");
  assert.equal((await readFile(join(clone.path, ".git/objects/info/alternates"), "utf8")).trim(), clone.readOnlyMounts[0]);
  assert.equal(clone.readOnlyMounts[0], join(await realpath(repo), ".git", "objects"));
  await assert.rejects(sh("git", ["rev-parse", "--verify", "refs/heads/smith/t1"], repo), "the user's repo gains no branch at launch");
});
test("createTaskClone: a base that exists only as origin/<base> starts at origin's commit", async () => {
  // clone `repo` to `work`, then `git -C work branch -D main` after detaching → createTaskClone(work, …, "main")
  // → baseSha === rev-parse origin/main in work
});
test("createTaskClone: the clone's origin is the user's origin URL — never the host path", async () => {
  // repo with `remote add origin https://github.com/acme/web.git` → clone's `remote get-url origin` === that URL
  // repo without origin → the clone's `git remote` output is ""
});
test("createTaskClone: refuses a path that already exists — a container may have written to it", async () => {
  await mkdir(join(dir, "clones", "t1"), { recursive: true });
  await assert.rejects(createTaskClone(repo, join(dir, "clones", "t1"), "t1", "main"), /already exists/);
});
test("createTaskClone: a repo reached through a symlink still names a mountable objects path", async () => {
  // symlink `link` → repo; createTaskClone(join(dir, "link"), …) → alternates === readOnlyMounts[0] === realpath objects
});
test("objectStoreMounts: follows chained alternates, relative and absolute", async () => {
  // repo A's objects/info/alternates names B's objects relatively ("../../B/.git/objects") and C's absolutely
  // → [A objects, resolve(A objects, "../../B/.git/objects"), C objects]
});
test("shellQuote: survives a shell round-trip, spaces and quotes included", async () => {
  const words = ["plain", "a b", "it's", "--upload-pack=x"];
  const out = await sh("sh", ["-c", `printf '%s\\n' ${words.map(shellQuote).join(" ")}`], dir);
  assert.deepEqual(out.split("\n"), words);
});
```

`sh(cmd, args, cwd)` is a small `execFile` helper in the test file that returns trimmed stdout.

- [ ] **Step 2: Run the tests and confirm they fail** (module not found).

- [ ] **Step 3: Implement.**
  - **`hardenedGit`:** `execFile("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })`.
    It resolves with trimmed stdout, and rejects with `git ${args.find(a => !a.startsWith("-"))} failed: ${stderr}`.
  - **`shellQuote`:** single-quote the word, and write each `'` as `'\''`.
  - **`objectStoreMounts`:**
    - `common = await realpath(resolve(repoPath, await hardenedGit(["rev-parse", "--git-common-dir"], repoPath)))`.
    - Start with `join(common, "objects")`. For each dir, read `<dir>/info/alternates`; ENOENT means
      none.
    - Each line that is not blank and doesn't start with `#` becomes
      `isAbsolute(l) ? l : resolve(dir, l)`.
    - Dedupe, recurse at most 5 levels as git does, and return in discovery order.
  - **`createTaskClone`, in this order:**
    1. If `clonePath` exists, throw
       `task clone ${clonePath} already exists — a container may have written to it, so it is never reused`.
    2. `repoReal = realpath(repoPath)`. Then
       `baseSha = hardenedGit(["rev-parse", "--verify", \`${await resolveStartPoint(repoReal, base)}^{commit}\`], repoReal)`.
    3. `readOnlyMounts = objectStoreMounts(repoReal)`.
    4. `mkdir(dirname(clonePath), { recursive: true })`, then
       `hardenedGit(["clone", "--quiet", "--shared", "--no-checkout", repoReal, clonePath], dirname(clonePath))`.
    5. Overwrite `<clonePath>/.git/objects/info/alternates` with `readOnlyMounts[0] + "\n"`. The
       clone is still trusted at this point, and this pins the exact path the container will see.
    6. `hardenedGit(["checkout", "--quiet", "-b", branch, baseSha], clonePath)`.
    7. Copy `remote get-url origin` from `repoReal` to the clone with `remote set-url origin <url>`.
       If the user's repo has no origin, run `remote remove origin` in the clone.

- [ ] **Step 4: Run the tests and confirm they pass:** `ℹ pass 7`, `ℹ fail 0`.

- [ ] **Step 5: Commit** with message `feat(swarm): disposable task clones that borrow the user's objects read-only`.

---

### Task 2: Sandboxed import and the finalize command

**Files:**
- Modify: `swarm/src/task-clone.ts`
- Modify: `swarm/src/dispatcher.ts`: `ensureWorkCommitted` (:617-640) builds its message with `autoCommitMessage`. Its behaviour is otherwise unchanged.
- Test: `swarm/src/task-clone.test.ts`

**Interfaces:**
- Consumes: `TaskClone`, `hardenedGit`, `shellQuote`, `createTaskClone` (Task 1).
- Produces:

```ts
export function sandboxedUploadPack(image: string, clone: TaskClone): string;
export async function importTaskBranch(clone: TaskClone, uploadPack: string): Promise<string>; // the imported tip SHA in the user's repo
export function autoCommitMessage(agent: string, taskId: string, completed: boolean): string;
export function finalizeCommand(agent: string, taskId: string, completed: boolean): string;
```

- [ ] **Step 1: Write the failing tests.** None of them needs docker. They use plain `git-upload-pack` as the `uploadPack` argument, which is safe only because the test controls the clone.

```ts
test("sandboxedUploadPack: clone and object stores read-only, no network, the image's entrypoint bypassed", async () => {
  const clone = { path: "/c lone", readOnlyMounts: ["/o"], /* … */ } as TaskClone;
  const words = (await sh("sh", ["-c", `printf '%s\\n' ${sandboxedUploadPack("smith-agent:latest", clone)}`], dir)).split("\n");
  assert.deepEqual(words, ["docker", "run", "--rm", "-i", "--network", "none", "--entrypoint", "git-upload-pack",
    "-v", "/c lone:/c lone:ro", "-v", "/o:/o:ro", "smith-agent:latest"]);
});
test("importTaskBranch: the clone's task branch lands in the user's repo; the user repo's hooks stay off", async () => {
  // createTaskClone → commit "agent work" in the clone (test-only host git; nothing planted)
  // plant a reference-transaction hook in the USER repo that writes a marker
  // const tip = await importTaskBranch(clone, "git-upload-pack")
  // tip === clone's smith/t1 tip; `git -C repo log -1 --format=%s smith/t1` === "agent work"; marker absent
});
test("importTaskBranch: an object fsck rejects is refused", async () => {
  // in the clone: blob = hash-object -w of "x"; a tree whose ONE entry is named ".git":
  //   Buffer.concat([Buffer.from("100644 .git\0"), Buffer.from(blobSha, "hex")]) → `git hash-object -w --literally -t tree --stdin`
  //   commit-tree that tree -p <base> → update-ref refs/heads/smith/t1
  // await assert.rejects(importTaskBranch(clone, "git-upload-pack")); smith/t1 absent from the user's repo
});
test("importTaskBranch: a clone with no task branch fails cleanly", async () => {
  // delete smith/t1 in the clone (checkout --detach first) → rejects; the user's repo unchanged
});
test("finalizeCommand: commits leftovers as the agent with today's message; does nothing when clean", async () => {
  // in a scratch git repo: write a file, run `sh -c <finalizeCommand("O'Brien", "t-1", false)>`
  // → `log -1 --format=%an|%ae|%B` === "O'Brien (smith)|crew@smithagents.local|" + autoCommitMessage("O'Brien", "t-1", false)
  // running it again on a clean tree: exit 0, no new commit
});
```

- [ ] **Step 2: Run the tests and confirm they fail.**

- [ ] **Step 3: Implement.**
  - **`sandboxedUploadPack`** joins `shellQuote`d words, in the exact order the first test pins.
  - **`importTaskBranch`** runs
    `hardenedGit(["-c", "fetch.fsckObjects=true", "-c", "transfer.fsckObjects=true", "fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", \`--upload-pack=${uploadPack}\`, clone.path, \`+refs/heads/${clone.branch}:refs/heads/${clone.branch}\`], clone.repoPath)`,
    then returns `hardenedGit(["rev-parse", \`refs/heads/${clone.branch}\`], clone.repoPath)`.
  - **`autoCommitMessage`** returns the string `ensureWorkCommitted` builds today, byte for byte.
  - **`finalizeCommand`** returns
    `git add -A && { git diff --cached --quiet || git -c user.name=<q(agent + " (smith)")> -c user.email=crew@smithagents.local commit -q -m <q(message)>; }`.

- [ ] **Step 4: Run the tests and confirm they pass.** Then run `dispatcher.test.ts` and confirm `ℹ fail 0`.

- [ ] **Step 5: Commit** with message `feat(swarm): import a task branch through a sandboxed upload-pack; finalize command for in-container commits`.

---

### Task 3: DockerRuntime refuses worktrees, takes read-only mounts, and runs one-shot containers

**Files:**
- Modify: `swarm/src/runtime.ts`:
  - `RuntimeAdapter.launch` (:46) gains an optional 5th parameter `opts?: LaunchOptions`.
    `TmuxRuntime.launch` (:122) and `RemoteRuntime.launch` (`remote-runtime.ts:379`) accept and
    ignore it.
  - `DockerRuntime.launch` (:363-456): delete `gitdirMount` (:289-300) and its call.
  - New `DockerRuntime.runOnce`.
- Modify: `swarm/src/runtime.test.ts`:
  - :97 "mounts the parent .git…" is **replaced**.
  - :186 "a plain clone (no gitdir file) adds no extra mount" is **rewritten**.
- Modify: `swarm/src/runtime.docker.test.ts`:
  - :145 "an agent commits on its task branch from inside a worktree" is **replaced**.
  - One new contract test.

**Interfaces:**
- Consumes: `createTaskClone`, `importTaskBranch`, `sandboxedUploadPack`, `finalizeCommand` (Tasks 1-2).
- Produces:
  - `export interface LaunchOptions { readOnlyMounts?: string[] }`
  - `DockerRuntime.runOnce(cwd: string, command: string, readOnlyMounts: string[], timeoutMs?: number): Promise<{ exitCode: number; output: string }>`.
    The default timeout is 120_000 ms.
  - Both `launch` and `runOnce` throw
    `refusing to start a container in ${cwd}: it is a git worktree, and its .git would hand the container the host repository`
    when `<cwd>/.git` is a file or a symlink.

- [ ] **Step 1: Write the failing tests.** Fake docker follows the pattern at runtime.test.ts:63. Pin `SMITH_DOCKER_CLAUDE_DIR` to a missing dir, as the neighbouring tests do.

```ts
test("DockerRuntime.launch: refuses a git worktree — its .git would hand the container the host repository", async () => {
  // dir with a `.git` FILE ("gitdir: /x/.git/worktrees/t") → rejects /it is a git worktree/; fake docker never called
});
test("DockerRuntime.launch: a clone mounts only itself and the read-only object stores it is given", async () => {
  // launch(name, "true", dir, undefined, { readOnlyMounts: ["/o1", "/o2"] }) → the -v values are
  // [`${dir}:/workspace`, "/o1:/o1:ro", "/o2:/o2:ro"]
});
test("DockerRuntime.runOnce: a throwaway, offline container with no credentials and no env", async () => {
  // SMITH_DOCKER_CLAUDE_DIR → a dir holding .credentials.json (to prove it is NOT mounted)
  // args contain "--rm", ["--network","none"], ["--entrypoint","/bin/bash"], `${dir}:/workspace`, "/o:/o:ro";
  // no "-e"; no "/home/agent/.claude" mount; they end with [image, "-c", cmd]
});
test("DockerRuntime.runOnce: reports a non-zero exit instead of throwing", async () => {
  // the fake docker rejects with { code: 3, stdout: "a", stderr: "b" } → { exitCode: 3, output: "ab" }
});
```

Image contract (`runtime.docker.test.ts`), using the `withContainer`/`run`/`untilOutput` helpers at :28-66:

```ts
test("image contract: an agent commits inside its own clone and cannot write the user's objects", { skip }, () => /*
  repo (init + empty commit) → clone = createTaskClone(repo, join(dir,"clone"), "contract", "main")
  rt.launch(name, `echo work > f.txt && git add f.txt && git commit -q -m "agent work" && (touch ${clone.readOnlyMounts[0]}/probe 2>/dev/null && echo OBJECTS-WRITABLE || echo objects-readonly)`,
            clone.path, undefined, { readOnlyMounts: clone.readOnlyMounts })
  output matches /objects-readonly/ and not /OBJECTS-WRITABLE/
  importTaskBranch(clone, sandboxedUploadPack(IMAGE, clone))
  → `git -C repo log -1 --format=%an <%ae>|%s smith/contract` === "smith agent <crew@smithagents.local>|agent work" */);

test("image contract: nothing a container plants runs on the host — finalize and import stay sandboxed", { skip }, () => /*
  M = join(dir, "markers") (a HOST path, never mounted)
  the agent container writes trap = `#!/bin/sh\nmkdir -p ${M} && touch ${M}/$(basename $0)\nexit 0`,
  installs it as .git/hooks/{pre-commit,post-commit,post-index-change,reference-transaction,post-checkout},
  sets core.fsmonitor to a copy of it, and leaves an uncommitted file leftover.txt
  → rt.runOnce(clone.path, finalizeCommand("contract", "t", true), clone.readOnlyMounts) → exitCode 0
  → importTaskBranch(clone, sandboxedUploadPack(IMAGE, clone))
  → `git -C repo show smith/contract:leftover.txt` succeeds; readdir(M) rejects ENOENT or is []
  POSITIVE CONTROL, last: execFile("git", ["status"], { cwd: clone.path }) on the HOST → readdir(M) is non-empty.
  If the control finds nothing, the traps were never armed and the test FAILS ("control failed — this test proved nothing"). */);
```

- [ ] **Step 2: Run the tests and confirm they fail.** Unit tests run without the image. Contract tests run with `SMITH_AGENT_IMAGE=smith-agent:latest`.

- [ ] **Step 3: Implement.**
  - `runOnce` args, in order: `run --rm --network none --entrypoint /bin/bash -v <cwd>:/workspace -w /workspace`, then `-v <m>:<m>:ro` for each mount, then `--cpus`/`--memory` from `DockerConfig` when set, then `<image> -c <command>`.
  - A rejected `this.docker(...)` with a numeric `code` becomes `{ exitCode: code, output: stdout + stderr }`.
  - Update the `RuntimeAdapter.launch` docblock to describe `opts`.

- [ ] **Step 4: Run the tests and confirm they pass.**
  - `runtime.test.ts`: `ℹ fail 0`.
  - `SMITH_AGENT_IMAGE=smith-agent:latest … src/runtime.docker.test.ts`: every test passes, **0 skipped**.

- [ ] **Step 5: Commit** with message `feat(swarm): docker refuses worktrees; read-only object mounts; offline one-shot containers`.

---

### Task 4: The dispatcher runs docker tasks in clones

**Files:**
- Modify: `swarm/src/dispatcher.ts`:
  - `dispatch()` (:213-292)
  - Extract `validateBaseBranch` from `prepareWorktree` (:366-369).
  - Extract `prepareSessionDir` from `prepareWorktree` (:388-405).
  - New `prepareTaskClone` and `finalizeAndImport`.
  - `openPullRequest` (:648-703) gains `from?`.
- Test: `swarm/src/dispatcher.test.ts`

**Interfaces:**
- Consumes: Tasks 1-3 (`createTaskClone`, `importTaskBranch`, `sandboxedUploadPack`, `finalizeCommand`, `TaskClone`, `DockerRuntime.runOnce`, `LaunchOptions`).
- Produces:
  - `export function taskClonePath(smithRoot: string, taskId: string): string` returns
    `join(smithRoot, "clones", taskId)`.
  - `private prepareTaskClone(manifest, connections): Promise<TaskClone>`
  - `private finalizeAndImport(manifest: TaskManifest, clone: TaskClone, runner: Pick<DockerRuntime, "runOnce">, uploadPack: string, completed: boolean): Promise<boolean>`.
    It never throws. It returns `true` only when the import succeeded.
  - `private openPullRequest(manifest: TaskManifest, cwd: string, from?: { head: string; baseRev: string }): Promise<string | undefined>`

- [ ] **Step 1: Write the failing tests.** Reach privates through a cast, as :576-579 does. Fixtures come from `makeWorkspaceFixture` (:340) or a plain repo.

```ts
test("prepareTaskClone: a docker task gets a fresh clone with smith-delegate, its plumbing excluded, and no branch in the user's repo", async () => {
  // manifest with context.repoPath = repo, branch "main", runtime "docker"
  // clone.path === taskClonePath(smithRoot, taskId); <clone>/bin/smith-delegate exists;
  // <clone>/.git/info/exclude contains "bin/smith-delegate"; repo has no refs/heads/smith/<taskId>
});
test("prepareTaskClone: a docker task with no repository is refused", async () => {
  // no repoPath → rejects /a docker task needs a repository/
});
test("prepareTaskClone: an invalid base branch is refused before any git runs", async () => {
  // branch "--upload-pack=x" → rejects /Invalid base branch/
});
test("openPullRequest from the user's repo: counts and titles from the base commit, pushes with hooks off, never reads HEAD", async () => {
  // stub the private run(cmd, args, cwd): record calls; reply "origin" to `git remote`, "1" to rev-list,
  //   "" to push, "feat: agent work" to log, "https://github.com/acme/web/pull/7" to gh
  // await openPullRequest(manifest, repo, { head: "smith/t-1", baseRev: "abc123" })
  // → every call's cwd === repo
  // → rev-list args ["rev-list", "--count", "abc123..smith/t-1"]; log uses "abc123..smith/t-1"
  // → push args ["-c", "core.hooksPath=/dev/null", "push", "--no-verify", "origin", "smith/t-1"]
  // → no arg is "HEAD" or ends with "..HEAD"; gh args include "--head", "smith/t-1"; it returns the URL
});
test("finalizeAndImport never throws: with docker gone, the clone is kept and the import reports false", async () => {
  // runner.runOnce rejects (daemon down); uploadPack "false" → resolves false; console.error mentions clone.path;
  // the clone directory still exists
});
```

- [ ] **Step 2: Run the tests and confirm they fail.**

- [ ] **Step 3: Implement.**
  - **In `dispatch()`:**
    - When `runtimeType === "docker"`: `clone = await this.prepareTaskClone(…)`, set
      `worktreePath = clone.path`, and launch with `{ readOnlyMounts: clone.readOnlyMounts }`.
      Otherwise, keep today's `prepareWorktree` path unchanged.
    - After `waitFor`, a docker task calls
      `imported = await this.finalizeAndImport(manifest, clone, runtime as DockerRuntime, sandboxedUploadPack(this.config.docker.image, clone), exitCode === 0)`,
      with an `instanceof DockerRuntime` check. A tmux task calls `ensureWorkCommitted` as today.
    - The PR step for docker runs only when `imported`:
      `openPullRequest(manifest, clone.repoPath, { head: clone.branch, baseRev: clone.baseSha })`.
    - `result.worktreePath` reports `clone.path` for docker.
  - **`prepareTaskClone`:**
    - `validateBaseBranch(base)` first.
    - A missing `context.repoPath` throws `a docker task needs a repository; this one has none`.
    - Then `createTaskClone(repoPath, taskClonePath(this.config.smithRoot, taskId), taskId, base)`
      and `prepareSessionDir(manifest, connections, clone.path)`. This is host work on the clone
      before launch, while it is still trusted.
  - **`finalizeAndImport`:**
    - `runOnce(clone.path, finalizeCommand(agentName ?? agent, taskId, completed), clone.readOnlyMounts)`.
      A non-zero exit is logged and the import continues.
    - Then `importTaskBranch(clone, uploadPack)`.
    - Any error is logged as `[dispatch] import failed for ${taskId}; clone kept at ${clone.path}:`
      and the method returns `false`.
  - **`openPullRequest` with `from`:**
    - Use `${from.baseRev}..${from.head}` for `rev-list` and `log`.
    - Push with `["-c", "core.hooksPath=/dev/null", "push", "--no-verify", "origin", from.head]`.
    - `gh` is unchanged; it already passes `--head smith/<taskId>`.
    - Without `from`, today's behaviour is byte-identical.

- [ ] **Step 4: Run the tests and confirm they pass.** Then run the full swarm suite (`cd swarm && SMITH_STATE_ROOT=$(mktemp -d) pnpm --config.verify-deps-before-run=false test`) and confirm `ℹ fail 0`. Run `tsc --noEmit`.

- [ ] **Step 5: Commit** with message `feat(swarm): docker tasks run in disposable clones; work comes home by sandboxed fetch`.

---

### Task 5: The real dispatcher, end to end, in docker

**Files:**
- Create: `swarm/src/dispatcher.docker.test.ts`. It is opt-in on `SMITH_AGENT_IMAGE`, and skips with
  a stated reason otherwise, like `runtime.docker.test.ts`.
- Modify: `docs/superpowers/specs/2026-08-16-workspace-instances-and-assignment-design.md`. At
  :147-151 and :441, add a dated note: the claim that "gitdirMount becomes unnecessary" was wrong,
  and docker tasks now use clones (link the new spec).

**Interfaces:**
- Consumes: `Dispatcher`, `loadConfig`, `taskClonePath` (Task 4).

- [ ] **Step 1: Write the test** "dispatch (docker): the agent's commit and its leftovers land on smith/<taskId> in the user's repo, and nothing it planted runs on the host".
  - **Setup:**
    - A realpath'd tmp dir with `repo` (`git init -b main`, one commit, **no origin**, so the PR
      step skips) and an empty `state/` as `smithRoot`. With no `cli-tools.json`, `gateReason`
      returns `""` (`cli-tools.ts:84-100`).
    - The **fake agent** is a `#!/bin/sh` script in the tmp dir. It:
      1. commits `work.txt` with message `feat: agent work`;
      2. writes `leftover.txt` and leaves it uncommitted;
      3. plants the Task 3 traps (hooks plus `core.fsmonitor`), each writing into `<tmp>/markers`.
  - **Credential pin:** set `SMITH_DOCKER_CLAUDE_DIR` to a missing dir for the test's duration,
    as `runtime.test.ts` does. Otherwise `credentialMount()` would mount the real
    `~/.smith/docker-auth` read-write into the test container.
  - **Config:**
    `loadConfig({ smithRoot, defaultRuntime: "docker", delegateBin: <fake agent path>, agentCommands: { ...NO_SUCH_BINARY, claude: "smith-delegate" }, docker: { image: IMAGE } })`.
    The dispatcher copies `delegateBin` to `<clone>/bin/smith-delegate`, which the image puts on
    PATH. The claude driver runs it with `--print '<prompt>'`, and the script ignores its args.
    Copy `NO_SUCH_BINARY` from `dispatcher.test.ts:21`.
  - **Act:** `await new Dispatcher(config).dispatch({ taskId: "t-docker", agent: "claude", runtime: "docker", prompt: "do it", context: { files: [], repository: "", branch: "main", repoPath: repo }, createdAt: new Date().toISOString(), priority: "normal" })`.
  - **Assert:**
    - `result.outcome === "completed"`.
    - `git -C repo log --format=%s main..smith/t-docker` lists `["task: claude — t-docker", "feat: agent work"]`.
    - `git -C repo show smith/t-docker:leftover.txt` is `"leftover"`.
    - `readdir(markers)` is empty or absent.
  - **Positive control, last:** host `git status` in `taskClonePath(smithRoot, "t-docker")` must
    make markers appear. Otherwise the test fails with "control failed".

- [ ] **Step 2: Run it against the image** (`SMITH_AGENT_IMAGE=smith-agent:latest …/dispatcher.docker.test.ts`). It passes with **0 skipped**. If it fails, fix the code, not the test, and record what the test caught.

- [ ] **Step 3: Run the negative control.** On a throwaway edit, revert just `finalizeAndImport` back to `ensureWorkCommitted` (host git in the clone). The same test must now **fail** on the markers assertion. Revert the edit, and record the failure line in the commit body.

- [ ] **Step 4: Commit** with message `test(swarm): the real dispatcher, in docker, end to end — planted git traps never fire on the host`.

---

### Task 6: Whole-branch gates and merge

- [ ] **Step 1: Run the gates.**
  - `pnpm -r run typecheck` exits 0.
  - The swarm suite shows `ℹ fail 0`.
  - Both image suites (`runtime.docker.test.ts`, `dispatcher.docker.test.ts`) pass with 0 skipped.
  - `make agent-image` passes. It runs the contract suite against a fresh candidate.
  - biome is at the baseline.
- [ ] **Step 2: Do a whole-branch review** against the spec's goals and THE RULE. Search the diff
  for any `git`/`gh` call whose cwd could be a clone after launch:
  `git diff origin/main -- swarm/src | grep -n -E 'git\(|run\("gh"|hardenedGit\('`, then read each
  hit.
- [ ] **Step 3: Merge.** Fast-forward `main` by ref after checking that origin/main is unchanged
  and the shared checkout is clean. Push with `gh auth switch --user ecruz165`, then switch back to
  `edwin-skoolscout`.
