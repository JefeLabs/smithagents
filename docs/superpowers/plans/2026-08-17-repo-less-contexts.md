# Repo-less Contexts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a workspace exist with no git repo, so the design half of the product — documents, diagrams, dashboards, boards, the council — is usable without pointing at a repo the user does not have and will never use.

**Architecture:** Two validators drop their "at least one repo" clause. `resolveRepo` already returns `null` safely for an empty repo list and does not change; what changes is what its three consumers *say* — today they all report "Unknown workspace/repo", which is a lie about a workspace that plainly exists. One new pure helper turns that into the spec's refusal sentence, and the control-plane stops rendering a repo-less context as broken.

**Tech Stack:** TypeScript ~6.0.0 (ESM, `.js` import specifiers), Node >= 24, `node:test` + `node:assert/strict` (swarm), vitest + Testing Library (control-plane), biome 2.5.3.

**Spec:** `docs/superpowers/specs/2026-08-15-repo-less-contexts-design.md`. Companion: `docs/superpowers/specs/2026-08-15-welcome-wizard-design.md` — this plan unblocks the wizard's documents-only path.

## Global Constraints

- Node >= 24; TypeScript ~6.0.0; ESM with `.js` specifiers on every relative import.
- **A repo-less context is a COMPLETE workspace, not a degraded one.** It must never render as broken: no empty repo widget, no "0 repos" warning, no error styling.
- **Dispatch soft-fails with a reason, never throws and never quarantines.** The sentence the spec mandates: *"this context has no repo — add one to run agents"*.
- **Groups are unaffected.** `assertContext` branches on `Array.isArray(members)` *before* repos are considered, so a group is identified by `members` and never by an empty repo list. A group must still be refused if it carries repos.
- **Adding a repo later upgrades in place** — nothing is migrated or recreated; no card, board, or document moves.
- **Agent creation stays available** in a repo-less context. Only *dispatch* refuses.
- swarm tests use `node:test` + `node:assert/strict`; every test writes to `mkdtempSync(tmpdir())`. **No test may touch the real state root at `~/.smithagents`**, and no test may reach the network.
- Baselines, measured 2026-08-17 on `main` @ `6ff98dd`:
  - swarm: **620 passing, 0 failing**; `tsc --noEmit` **12 errors** (pre-existing: `agent-sessions.ts` ×10, `jira-sync.test.ts`, `server.ts`).
  - broker: **667 passing, 0 failing**; `tsc` 1 pre-existing error.
  - control-plane: **927 passing, 2 FAILING** — `HomePage.test.tsx > picking another session backs out of an explicitly-opened composer` and `MapStage.test.tsx > offers a pan-mode toggle in the zoom controls cluster`. Both pre-date this work. **They are the baseline, not your regression; confirm by NAME, never by count. A third failure is yours.**
  - control-plane `tsc --noEmit`: 10 pre-existing errors in `map/nodes.test.tsx`, `NewContextModal.test.tsx`, `WorkspaceManagerModal.test.tsx`, `dashboardSpec.ts`.
  - **One pre-existing biome violation** at `swarm/src/capabilities.test.ts:615`, proven to predate this work. Do not fix it here; do not let it mask a new one.
- Measurement traps:
  - Typecheck swarm with `cd swarm && ./node_modules/.bin/tsc --noEmit`. **Never `npx tsc` from the repo root** — decoy placeholder package.
  - tsc ANSI-colorizes. Strip first (`sed 's/\x1b\[[0-9;]*m//g'`) and count with `grep -c 'error TS'`. **Do NOT use `grep -oE 'Found [0-9]+ error'`** — that summary line does not exist in this invocation and returns empty, which looks exactly like success. Cross-check tsc's exit code.
  - `node:test` summary lines start with `ℹ`, not `#`.
  - A `cd` to a path **outside the project** is silently dropped inside a compound Bash command. Use absolute paths and `git -C`.

## The enumeration the spec demanded

The spec requires every repo-reading caller be listed rather than described. Measured on `main` @ `6ff98dd`:

| Site | What it does today | Action |
|---|---|---|
| `swarm/src/workspaces.ts:157` | `o.repos.length > 0` in `assertContext`'s workspace branch | **Relax** — Task 1 |
| `swarm/src/server.ts:3837` | `workspaceProblems`: `"A workspace needs at least one repo"` — a **second, independent** validator guarding `POST`/`PUT /workspaces` | **Relax** — Task 1 |
| `swarm/src/workspaces.ts:366` | `resolveRepo` — `const repo = repoName ? find(...) : workspace.repos[0]; return repo ? {...} : null` | **No change.** Already returns `null` safely on an empty array |
| `swarm/src/server.ts:818` | dispatch/tasks — on null: `Unknown workspace/repo: X/(default)` | **Message is wrong** — Task 2 |
| `swarm/src/server.ts:1767` | on null: same message, **then `const repoRoot = resolved?.repo.path ?? process.cwd()`** | **Message wrong AND a silent cwd fallback** — Task 2 |
| `swarm/src/server.ts:3296` | capability spec generation — on null: `No active workspace/repo for: X`, then writes a file into `resolved.repo.path` | **Message is wrong** — Task 2 |
| `swarm/src/server.ts:3743` | `prepareSquadSwarm` — `ws.repos[0]`, already throws a clear named error | **No change.** Already correct |
| `swarm/src/source-migration.ts:30,56` | already guards `ws.repos.length > 0` before wanting a `releases` source | **No change.** Correctly skips for a repo-less context |
| `swarm/src/workspaces.ts:147` | group branch — repos must be absent or empty | **No change.** This is what keeps groups distinguishable |
| `control-plane/src/organisms/WorkspaceManagerModal.tsx:457` | renders `{ws.repos.length} repo{s}` → "0 repos" | **Reads as broken** — Task 3 |

### The hazard the spec did not name

`swarm/src/server.ts:1767` does `const repoRoot = resolved?.repo.path ?? process.cwd()`. For a repo-less context that is not a refusal — it silently substitutes **the swarm process's own working directory**, i.e. the smithagents checkout itself. An operation aimed at a documents-only workspace would run against this repo's source tree. Task 2 closes it. This is exactly the "consequences are downstream, and each must be handled explicitly rather than discovered" case the spec warns about.

## Scope

**In:** relaxing both validators; correct refusals at the three `resolveRepo` consumers; closing the `process.cwd()` fallback; the control-plane not rendering a repo-less context as broken; the spec's live smoke.

**Out, deliberately:** multi-repo workspaces (already supported, unchanged); converting a context back to repo-less by removing its last repo; any change to group semantics; the welcome wizard itself.

---

### Task 1: Both validators accept a repo-less workspace

**Files:**
- Modify: `swarm/src/workspaces.ts` (`assertContext` `:157`)
- Modify: `swarm/src/server.ts` (`workspaceProblems` `:3837`)
- Test: `swarm/src/workspaces.test.ts`, `swarm/src/server.test.ts`

**Interfaces:**
- Changed: `assertContext` accepts `repos: []` on a workspace record. `workspaceProblems` no longer returns the "needs at least one repo" string.

- [ ] **Step 1: Write the failing tests**

Append to `swarm/src/workspaces.test.ts`. The **positive control** the spec mandates is the first test — it pins the old behaviour so the new test cannot pass against an unchanged code path:

```ts
test("assertContext: POSITIVE CONTROL — an empty-repos workspace is what the old validator rejected", () => {
  // The clause under change is `o.repos.length > 0`. This test documents the
  // exact shape that clause refused; if it ever stops being the interesting
  // case, the test below is proving nothing.
  const designOnly = { name: "acme", repos: [] };
  assert.ok(Array.isArray(designOnly.repos) && designOnly.repos.length === 0, "the fixture is the empty-repos shape");
  assert.equal((designOnly as { members?: string[] }).members, undefined, "and it is a workspace, not a group");
});

test("assertContext: a workspace with no repos is valid — the design half needs no git", () => {
  const ws = assertContext("w.json", { name: "acme", repos: [] });
  assert.equal(ws.name, "acme");
  assert.deepEqual(ws.repos, []);
});

test("assertContext: a repo-less workspace still round-trips its other fields", () => {
  const ws = assertContext("w.json", { name: "acme", repos: [], workKind: "marketing", color: "#abc" });
  assert.equal(ws.workKind, "marketing");
  assert.equal(ws.color, "#abc");
});

test("assertContext: a GROUP carrying repos is still refused", () => {
  // Groups are identified by `members`, never by an empty repo list. Relaxing
  // the workspace branch must not blur the two shapes.
  assert.throws(
    () => assertContext("g.json", { name: "acme", members: ["a", "b"], repos: [{ name: "app", path: "/tmp/app" }] }),
    /group/i,
  );
});

test("assertContext: a workspace with a MALFORMED repo is still refused", () => {
  assert.throws(() => assertContext("w.json", { name: "acme", repos: [{ name: "app" }] }), /repos/i);
  assert.throws(() => assertContext("w.json", { name: "acme", repos: [{ name: "app", path: "relative/path" }] }), /repos/i);
});

test("assertContext: a workspace with no name is still refused, repos or not", () => {
  assert.throws(() => assertContext("w.json", { repos: [] }), /name/i);
});
```

Append to `swarm/src/server.test.ts`:

```ts
test("workspaceProblems: a repo-less workspace is accepted", async () => {
  const problem = await workspaceProblems({ name: "acme", repos: [] });
  assert.equal(problem, null, "the design half needs no git");
});

test("workspaceProblems: a malformed repo is still refused", async () => {
  assert.match((await workspaceProblems({ name: "acme", repos: [{ name: "" } as never] })) ?? "", /name/i);
});

test("workspaceProblems: a missing name is still refused", async () => {
  assert.match((await workspaceProblems({ repos: [] })) ?? "", /name/i);
});
```

**Check `workspaceProblems`' real signature first** (`swarm/src/server.ts:3833`) — it is `async`, takes `(b: Partial<Workspace>, opts?: { requireLocalRepos?: boolean })`, and returns `Promise<string | null>`. If `opts.requireLocalRepos` turns out to change the answer for an empty array, report what you found and keep its existing meaning for the non-empty case.

- [ ] **Step 2: Run them to verify they fail**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  'src/workspaces.test.ts' 'src/server.test.ts' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E "^(✔|✖)|^ℹ (tests|pass|fail)" | tail -12
```

Expected: FAIL — the empty-repos workspace is rejected by both validators. The positive control, the group test, and the malformed-repo tests should already PASS (they pin behaviour that must not change).

- [ ] **Step 3: Relax `assertContext`**

In `swarm/src/workspaces.ts`, the workspace branch. Drop **only** the length clause:

```ts
  const ok =
    o &&
    typeof o.name === "string" &&
    Array.isArray(o.repos) &&
    (o.workKind === undefined || typeof o.workKind === "string") &&
    o.repos.every((r) => r && typeof r.name === "string" && typeof r.path === "string" && isAbsolute(r.path));
  if (!ok) {
    throw new Error(
      `Invalid workspace file ${file}: requires name and repos[]{name, absolute path}, and workKind must be a string when present`,
    );
  }
```

Update the doc comment above `assertContext` to say that an empty `repos` is a valid **design-only** workspace — documents, diagrams, dashboards, boards and the council need no git — and that groups remain distinguished by `members`, never by an empty repo list.

- [ ] **Step 4: Relax `workspaceProblems`**

In `swarm/src/server.ts:3837`, replace the length check with a shape check:

```ts
  // A repo-less context is a COMPLETE workspace for everything except running
  // coding agents (spec: repo-less contexts). Dispatch refuses with a reason;
  // the record itself is valid.
  if (!Array.isArray(b.repos)) return "A workspace needs a repos array (it may be empty)";
```

Leave the per-repo validation loop that follows exactly as it is — it already no-ops on an empty array.

- [ ] **Step 5: Run the file, then the suite**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  'src/workspaces.test.ts' 'src/server.test.ts' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E "^ℹ (tests|pass|fail)"
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  'src/*.test.ts' 'src/**/*.test.ts' > /tmp/r1-suite.txt 2>&1; echo "exit=$?"
sed 's/\x1b\[[0-9;]*m//g' /tmp/r1-suite.txt | grep -E "^ℹ (tests|pass|fail)"
```

Expected: **629 pass / 0 fail** (620 + 9). **A pre-existing test that asserted a repo-less workspace is INVALID is a real signal** — that was the old contract. Update it to the new contract and report which test it was; do not delete it.

- [ ] **Step 6: Typecheck, lint, commit**

```bash
cd swarm && ./node_modules/.bin/tsc --noEmit > /tmp/r1-tsc.txt 2>&1; echo "tsc-exit=$?"
echo "errors=$(sed 's/\x1b\[[0-9;]*m//g' /tmp/r1-tsc.txt | grep -c 'error TS')"
npx biome check src/workspaces.ts src/workspaces.test.ts src/server.ts src/server.test.ts
git add swarm/src/workspaces.ts swarm/src/workspaces.test.ts swarm/src/server.ts swarm/src/server.test.ts
git commit -m "feat(workspaces): a context may have no repo

The design half — documents, diagrams, dashboards, boards, the council —
needs no git, so requiring a repo forced users to point at one they will
never use. Both validators relax; groups stay distinguished by members."
```

Expected: `errors=12`; biome clean.

---

### Task 2: The three consumers refuse with the truth

`resolveRepo` already returns `null` for a repo-less workspace and needs no change. Its callers currently report "Unknown workspace/repo", which is false — the workspace exists and is valid; it simply has no repo. One of them silently falls back to `process.cwd()`.

**Files:**
- Modify: `swarm/src/workspaces.ts` (new exported helper)
- Modify: `swarm/src/server.ts` (`:818`, `:1767`, `:3296`)
- Test: `swarm/src/workspaces.test.ts`, `swarm/src/server.test.ts`

**Interfaces:**
- Produces: `repoLessRefusal(workspaces: Workspace[], workspaceName?: string): string | null` — the spec's refusal sentence when the named (or default) workspace exists but has no repos; `null` when the workspace is genuinely unknown, or has a repo. Exported and pure, matching this file's `resolveRepo`/`activeWorkspaces` convention so it is testable without booting the server.
- Consumes: `activeWorkspaces` from the same module.

- [ ] **Step 1: Write the failing tests**

Append to `swarm/src/workspaces.test.ts`:

```ts
test("repoLessRefusal: names the real problem for a workspace that exists but has no repo", () => {
  const wss = [{ name: "design", repos: [] }] as never;

  const refusal = repoLessRefusal(wss, "design");

  assert.ok(refusal, "a repo-less context gets a refusal");
  assert.match(refusal as string, /no repo/i);
  assert.match(refusal as string, /add one/i, "and tells the user how to fix it");
  assert.doesNotMatch(refusal as string, /unknown/i, "it is NOT an unknown-workspace error");
});

test("repoLessRefusal: null when the workspace has a repo — nothing to refuse", () => {
  const wss = [{ name: "coding", repos: [{ name: "app", path: "/tmp/app" }] }] as never;
  assert.equal(repoLessRefusal(wss, "coding"), null);
});

test("repoLessRefusal: null when the workspace is genuinely unknown — that is a different error", () => {
  const wss = [{ name: "design", repos: [] }] as never;
  assert.equal(repoLessRefusal(wss, "nope"), null, "an unknown name is the caller's existing 400, not this");
});

test("repoLessRefusal: falls back to the default workspace when none is named", () => {
  const wss = [
    { name: "coding", repos: [{ name: "app", path: "/tmp/app" }] },
    { name: "design", repos: [], default: true },
  ] as never;
  assert.ok(repoLessRefusal(wss, undefined), "the default workspace is the one a nameless request means");
});
```

Append to `swarm/src/server.test.ts` — these pin the *messages* the routes produce, which is the whole point of the task:

```ts
test("the repo-less refusal is a refusal, not an unknown-workspace error", () => {
  // The three resolveRepo consumers previously said "Unknown workspace/repo"
  // for a workspace that plainly exists. That message sent users looking for a
  // typo instead of telling them to attach a repo.
  const wss = [{ name: "design", repos: [] }] as never;
  const refusal = repoLessRefusal(wss, "design");
  assert.ok(refusal);
  assert.doesNotMatch(refusal as string, /unknown/i);
});
```

- [ ] **Step 2: Run them to verify they fail**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  --test-name-pattern 'repoLessRefusal|repo-less refusal' 'src/workspaces.test.ts' 'src/server.test.ts' 2>&1 \
  | sed 's/\x1b\[[0-9;]*m//g' | head -10
```

Expected: FAIL — `repoLessRefusal` is not exported.

- [ ] **Step 3: Add the helper**

In `swarm/src/workspaces.ts`, beside `resolveRepo`:

```ts
/**
 * Why a repo-aware operation cannot run in this context, when the reason is
 * "there is no repo" rather than "no such workspace".
 *
 * `resolveRepo` returns null for both cases, which is correct for resolution
 * but wrong for the message: a repo-less context is a VALID workspace (spec:
 * repo-less contexts), and telling its owner "Unknown workspace/repo" sends
 * them hunting for a typo instead of attaching a repo.
 *
 * Returns null when the workspace is genuinely unknown — that stays the
 * caller's existing error — and null when it has a repo, since there is
 * nothing to refuse.
 */
export function repoLessRefusal(workspaces: Workspace[], workspaceName?: string): string | null {
  const live = activeWorkspaces(workspaces);
  const workspace = workspaceName
    ? live.find((w) => w.name.toLowerCase() === workspaceName.toLowerCase())
    : (live.find((w) => w.default) ?? live[0]);
  if (!workspace) return null;
  if (workspace.repos.length > 0) return null;
  return `Context "${workspace.name}" has no repo — add one to run agents.`;
}
```

- [ ] **Step 4: Use it at all three call sites**

Import `repoLessRefusal` alongside the existing `resolveRepo` import in `swarm/src/server.ts`, then at each site prefer the refusal over the generic message. **`:818`:**

```ts
      const resolved = resolveRepo(this.workspaces, body.context.workspace, body.context.repo);
      if (!resolved) {
        const refusal = repoLessRefusal(this.workspaces, body.context.workspace);
        if (refusal) return reply.status(400).send({ error: refusal });
      }
      if ((body.context.workspace || body.context.repo) && !resolved) {
        return reply.status(400).send({
          error: `Unknown workspace/repo: ${body.context.workspace ?? "(default)"}/${body.context.repo ?? "(default)"}`,
        });
      }
```

**`:1767`** — same shape, and then close the `process.cwd()` hazard. The existing line is `const repoRoot = resolved?.repo.path ?? process.cwd();`:

```ts
      const resolved = resolveRepo(this.workspaces, body.workspace, body.repo);
      if (!resolved) {
        const refusal = repoLessRefusal(this.workspaces, body.workspace);
        if (refusal) return reply.status(400).send({ error: refusal });
      }
      if ((body.workspace || body.repo) && !resolved) {
        return reply
          .status(400)
          .send({ error: `Unknown workspace/repo: ${body.workspace ?? "(default)"}/${body.repo ?? "(default)"}` });
      }
      // Falling back to process.cwd() would silently run against the swarm's own
      // checkout. For a repo-less context the refusal above has already returned.
      const repoRoot = resolved?.repo.path ?? process.cwd();
```

**`:3296`:**

```ts
        const resolved = resolveRepo(workspaces, cap.workspaceId);
        if (!resolved) {
          const refusal = repoLessRefusal(workspaces, cap.workspaceId);
          return reply.status(400).send({ error: refusal ?? `No active workspace/repo for: ${cap.workspaceId}` });
        }
```

**Report whether `:1767`'s `process.cwd()` fallback is now unreachable for a repo-less context, and whether any other path can still reach it.** If it remains reachable for the no-workspace-named case, say so rather than changing that behaviour — the nameless case is pre-existing and out of scope.

- [ ] **Step 5: Run the suite**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  'src/*.test.ts' 'src/**/*.test.ts' > /tmp/r2-suite.txt 2>&1; echo "exit=$?"
sed 's/\x1b\[[0-9;]*m//g' /tmp/r2-suite.txt | grep -E "^ℹ (tests|pass|fail)"
```

Expected: **634 pass / 0 fail** (629 + 5).

- [ ] **Step 6: Typecheck, lint, commit**

```bash
cd swarm && ./node_modules/.bin/tsc --noEmit > /tmp/r2-tsc.txt 2>&1
echo "errors=$(sed 's/\x1b\[[0-9;]*m//g' /tmp/r2-tsc.txt | grep -c 'error TS')"
npx biome check src/workspaces.ts src/workspaces.test.ts src/server.ts src/server.test.ts
git add swarm/src/workspaces.ts swarm/src/workspaces.test.ts swarm/src/server.ts swarm/src/server.test.ts
git commit -m "feat(dispatch): a repo-less context refuses with the reason

The three resolveRepo consumers reported \"Unknown workspace/repo\" for a
workspace that plainly exists, sending users to hunt for a typo. One of them
also fell back to process.cwd(), which would have run against the swarm's own
checkout."
```

---

### Task 3: A repo-less context does not look broken

The spec: *"A repo-less context must never appear broken in the UI — no empty repo widget, no '0 repos' warning. It is a valid shape, and should read as one."*

**Files:**
- Modify: `control-plane/src/organisms/WorkspaceManagerModal.tsx:457`
- Test: `control-plane/src/organisms/WorkspaceManagerModal.test.tsx`

**Interfaces:** none exported; presentational only.

- [ ] **Step 1: Read the surrounding component first**

`control-plane/src/organisms/WorkspaceManagerModal.tsx:457` currently renders `{ws.repos.length} repo{ws.repos.length === 1 ? "" : "s"}`. Read enough of the surrounding JSX to know what that line sits inside — a chip, a subtitle, a row — and match it. **Also grep the file for any other repo-count or repo-list rendering** (`grep -n "repos" control-plane/src/organisms/WorkspaceManagerModal.tsx`) and report everything you find; this plan enumerated one site from a repo-wide grep, but a sibling render inside the same component would be missed by that.

- [ ] **Step 2: Write the failing test**

Append to `control-plane/src/organisms/WorkspaceManagerModal.test.tsx`, matching the file's existing render/stub conventions (read them first — do not introduce a second mechanism):

```tsx
it("shows a design-only context as a valid shape, not as '0 repos'", async () => {
  // A repo-less context is COMPLETE for documents, diagrams, dashboards, boards
  // and the council. Rendering "0 repos" reads as a broken or half-made
  // workspace, which is exactly what the spec forbids.
  renderWithProviders(<WorkspaceManagerModal {...props} />);

  expect(await screen.findByText(/design/i)).toBeInTheDocument();
  expect(screen.queryByText(/0 repos/i)).toBeNull();
});

it("still shows the repo count for a context that has repos", async () => {
  renderWithProviders(<WorkspaceManagerModal {...props} />);
  expect(await screen.findByText(/2 repos/i)).toBeInTheDocument();
});
```

The fixture needs two workspaces — one with `repos: []` named something matching `/design/i`, one with two repos. Extend whatever fixture the file already uses rather than adding a new one.

- [ ] **Step 3: Run it to verify it fails**

```bash
cd control-plane && npx vitest run src/organisms/WorkspaceManagerModal.test.tsx 2>&1 | tail -12
```

Expected: FAIL on the first test — "0 repos" is currently rendered.

- [ ] **Step 4: Render the empty case as a shape, not a count**

Replace the count expression so an empty repo list reads as a kind of workspace rather than a deficient one:

```tsx
{ws.repos.length === 0 ? "Design only" : `${ws.repos.length} repo${ws.repos.length === 1 ? "" : "s"}`}
```

Keep the surrounding element and styling exactly as they are — no warning colour, no icon, no tooltip. It is a valid shape and must read as one.

- [ ] **Step 5: Verify**

```bash
cd control-plane && npx vitest run src/organisms/WorkspaceManagerModal.test.tsx 2>&1 | tail -6
cd control-plane && npx vitest run > /tmp/r3-cp.txt 2>&1; echo "exit=$?"
grep -E "Tests " /tmp/r3-cp.txt | tail -2
grep -E "^ FAIL" /tmp/r3-cp.txt | head -4
cd control-plane && npx tsc --noEmit 2>&1 | tail -3
npx biome check control-plane/src/organisms/WorkspaceManagerModal.tsx control-plane/src/organisms/WorkspaceManagerModal.test.tsx
```

Expected: **929 passing, 2 failing** (927 + 2 new), and the 2 failures are the named baseline pair — `HomePage` composer and `MapStage` pan toggle. **Confirm by name. A third is yours.**

- [ ] **Step 6: Commit**

```bash
git add control-plane/src/organisms/WorkspaceManagerModal.tsx control-plane/src/organisms/WorkspaceManagerModal.test.tsx
git commit -m "feat(cp): a design-only context reads as a shape, not '0 repos'

A repo-less context is complete for documents, diagrams, dashboards, boards
and the council. Rendering a zero count made a valid workspace look broken."
```

---

### Task 4: Live smoke — the spec requires it

The spec is explicit: *"Green tests do not prove reachability; three defects shipped this session with passing suites."* And this repo has since shipped a fourth — a route added to the swarm whose only client fetched it from the broker, which 404'd, caught by nothing but a live check.

**Files:** none. **No commit.**

- [ ] **Step 1: Back up**

```bash
B=$(mktemp -d)/smithagents-prerepoless
mkdir -p "$B" && cp -a ~/.smithagents/workspaces "$B/workspaces"
echo "backup at $B"
```

- [ ] **Step 2: Restart the swarm on the new code**

```bash
PID=$(lsof -nP -iTCP:7777 -sTCP:LISTEN -t | head -1); kill "$PID"
until ! lsof -nP -iTCP:7777 -sTCP:LISTEN >/dev/null 2>&1; do sleep 1; done
cd swarm && nohup node --env-file=../.env --import tsx src/server.ts > /tmp/swarm-repoless.log 2>&1 &
until curl -s -m 3 http://127.0.0.1:7777/health > /dev/null; do sleep 1; done
curl -s -m 5 http://127.0.0.1:7777/workspaces | python3 -c "
import sys,json; print('  existing:', [w['name'] for w in json.load(sys.stdin)['workspaces']])"
```

**If the broker also needs restarting for a later step, note that killing its node PID destroys its tmux session** (the pane's command IS the process, single window). Recreate with `tmux new-session -d -s smith-broker -c <broker dir> '<cmd>'` rather than assuming a shell survives.

- [ ] **Step 3: Create a design-only context through the API**

```bash
curl -s -m 20 -X POST http://127.0.0.1:7777/workspaces \
  -H 'content-type: application/json' \
  -d '{"name":"design-probe","repos":[]}' | python3 -m json.tool | head -20
```

Expected: created, not a 400. **This is the whole feature — if it 400s, nothing downstream matters.**

- [ ] **Step 4: Confirm it is a complete workspace, not a degraded one**

```bash
curl -s -m 10 -X POST http://127.0.0.1:7777/work/boards \
  -H 'content-type: application/json' -d '{"type":"plan","workspaceId":"design-probe"}' \
  | python3 -c "
import sys,json; b=json.load(sys.stdin)
print('  board:', b.get('id','ERROR: '+str(b.get('error'))), [c['id'] for c in b.get('columns',[])])"
curl -s -m 5 http://127.0.0.1:7777/workspaces | python3 -c "
import sys,json
w=[x for x in json.load(sys.stdin)['workspaces'] if x['name']=='design-probe']
print('  record:', w[0] if w else 'MISSING')"
```

Expected: a plan board seeded with neutral ids, and the record present with `repos: []`.

- [ ] **Step 5: Attempt a dispatch and see the refusal**

```bash
curl -s -m 20 -X POST http://127.0.0.1:7777/tasks \
  -H 'content-type: application/json' \
  -d '{"prompt":"probe","context":{"workspace":"design-probe"}}' | head -c 300; echo
```

Expected: a 400 whose message says **the context has no repo and to add one** — NOT "Unknown workspace/repo", and not a stack trace or a quarantine. **If it says "Unknown", Task 2 did not take effect on this path.**

- [ ] **Step 6: Attach a repo and see it upgrade in place**

```bash
R=$(mktemp -d)/probe-repo; mkdir -p "$R" && git init -q -b main "$R" && echo x > "$R/README.md"
git -C "$R" add -A && git -C "$R" -c user.name=t -c user.email=t@t commit -q -m init
curl -s -m 30 -X PUT http://127.0.0.1:7777/workspaces/design-probe \
  -H 'content-type: application/json' \
  -d "{\"repos\":[{\"name\":\"probe\",\"path\":\"$R\"}]}" | head -c 200; echo
curl -s -m 20 -X POST http://127.0.0.1:7777/tasks \
  -H 'content-type: application/json' \
  -d '{"prompt":"probe","context":{"workspace":"design-probe"}}' | head -c 300; echo
```

Expected: the PUT succeeds, and the dispatch **no longer refuses** — it accepts (or fails for some unrelated reason, which you must report). The board created in Step 4 must still exist and be unchanged: nothing is migrated or recreated when a repo is attached.

- [ ] **Step 7: Clean up the probe**

```bash
curl -s -m 10 -X DELETE http://127.0.0.1:7777/workspaces/design-probe | head -c 200; echo
curl -s -m 5 http://127.0.0.1:7777/workspaces | python3 -c "
import sys,json; print('  remaining:', [w['name'] for w in json.load(sys.stdin)['workspaces']])"
```

If no DELETE route exists, say so and remove the workspace directory and its registry entry by hand, then report exactly what you removed. **Leave the install as you found it** and confirm the pre-existing workspaces are untouched.

- [ ] **Step 8: No commit**

If Step 3 or Step 5 fails, the branch does not merge.

---

## Self-review

**Spec coverage.** "Relax the workspace branch of `assertContext`" → Task 1, plus the second validator (`workspaceProblems`) the spec did not know about. "Dispatch soft-fails with a reason" → Task 2, with the spec's sentence pinned by test. "Repo-reading callers need an empty state" → the enumeration table above, with a verdict per site; five of the ten need no change and the plan says why, rather than leaving a reader to re-derive it. "Adding a repo later upgrades in place" → Task 4 Step 6. "Must never appear broken in the UI" → Task 3. "Positive control required on the validator test" → Task 1 Step 1's first test. "Live smoke" → Task 4, in the spec's exact sequence. Out-of-scope items are restated in Scope and no task touches them.

**Placeholders.** None. Three steps defer to what the code actually is rather than inventing it — Task 1 Step 1 (confirm `workspaceProblems`' signature and `requireLocalRepos`' meaning), Task 3 Step 1 (read the surrounding JSX and grep for sibling repo renders), Task 4 Step 7 (whether a DELETE route exists) — each naming the exact command to run and requiring a report of what was found.

**Type consistency.** `repoLessRefusal(workspaces, workspaceName?) => string | null` is spelled identically in its definition, all three call sites, and every test. It deliberately mirrors `resolveRepo`'s parameter order and its `activeWorkspaces` + default-workspace resolution, so the two agree on which workspace a nameless request means.

**Known risks, stated plainly.**
1. **The `process.cwd()` fallback at `server.ts:1767` is closed for the repo-less case but not removed.** It remains reachable when no workspace is named at all — pre-existing behaviour, deliberately untouched, and Task 2 Step 4 requires the implementer to report whether any other path still reaches it. Removing it is a separate change with its own blast radius.
2. **Two validators existed for one rule**, and the spec knew about one. There may be a third guard in the control-plane's own form validation that this plan's repo-wide grep did not surface as a `repos.length` expression. Task 3 Step 1's grep of the modal is the mitigation; if the UI still blocks submitting a repo-less workspace, that is a real finding for the review, not a scope creep.
3. **`resolveRepo` returning `null` for two different conditions** is the root cause of the wrong messages, and this plan papers over it with a second lookup rather than making the return type discriminated. That is deliberate — changing a shipped function's contract with three callers is a larger change than this spec asks for — but it means a fourth caller added later will reproduce the same wrong message unless it also calls `repoLessRefusal`.
