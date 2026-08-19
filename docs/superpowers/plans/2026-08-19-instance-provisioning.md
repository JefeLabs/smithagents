# Instance Provisioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a freshly created instance workable — copy the gitignored trees an agent needs and run the setup commands that rebuild them — without ever copying a secret.

**Architecture:** A new pure module `swarm/src/provisioning.ts` decides *what* to provision (a lockfile-driven detector, path guards, and override resolution) with no filesystem or process access, mirroring how `session-reconcile.ts` keeps policy pure and testable. A second layer executes the plan against a real member directory. `createInstance` gains a provisioning state and runs execution as a background job; session launch refuses an instance that is not `ready`.

**Tech Stack:** TypeScript ~6.0.0, Node ≥ 24, `node:test` + `node:assert/strict`, biome 2.5.3.

**Spec:** `docs/superpowers/specs/2026-08-17-instance-provisioning-design.md` — read it before starting any task.

## Global Constraints

- **Never copy a secret.** `.env`, `.env.*`, `*.pem`, `id_rsa*`, `master.key` are refused by the copy guard. This enforces §7 of `2026-08-16-workspace-instances-and-assignment-design.md`; it is not advisory.
- **Never create a symlink.** Every instance owns its whole tree.
- **Copy is an optimization; setup is the correctness path.** A failed copy yields a slow instance, never a broken one. The detector must never emit a `copy` entry its `setup` cannot reproduce.
- **`tsx` strips types at test time**, so tests cannot catch type errors. `pnpm --filter swarm typecheck` (`tsc --noEmit`) is the only type gate and must be run before every commit.
- **Lint baseline is zero diagnostics.** `pnpm --filter swarm lint` must be clean before every commit.
- **Tests are integration-style** in this package: real temp dirs via `mkdtempSync`, real `git` via `execFileSync`. Follow `swarm/src/workspace-instances.test.ts`.
- Run a single test file with: `cd swarm && node --import tsx --test src/provisioning.test.ts`

---

## File Structure

| file | responsibility |
| --- | --- |
| `swarm/src/provisioning.ts` (create) | Pure policy: `ProvisionPlan`, the lockfile detector, copy-path guards, override resolution. No `fs`, no `child_process`. |
| `swarm/src/provisioning.test.ts` (create) | Tests for the pure policy above. |
| `swarm/src/provision-exec.ts` (create) | Impure execution: read the member dir, copy paths, run setup commands. |
| `swarm/src/provision-exec.test.ts` (create) | Integration tests against real temp dirs. |
| `swarm/src/workspace-instances.ts` (modify) | `Instance` gains `provision`; `createInstance` starts the job. |
| `swarm/src/workspace-instances.test.ts` (modify) | State transitions on the instance. |
| `swarm/src/agent-sessions.ts` (modify) | `create()` refuses an instance that is not `ready`. |
| `swarm/src/agent-sessions.test.ts` (modify) | The launch gate. |

---

### Task 1: The plan type and the lockfile detector

**Files:**
- Create: `swarm/src/provisioning.ts`
- Test: `swarm/src/provisioning.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `interface ProvisionPlan { copy: string[]; setup: string[]; detectedBy: string }` and `detectPlan(files: string[]): ProvisionPlan`. `files` is a flat list of entry names at the member root — the caller reads the directory, so this stays pure.

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { detectPlan } from "./provisioning.js";

test("detectPlan: pnpm lockfile copies node_modules and installs frozen", () => {
  const plan = detectPlan(["package.json", "pnpm-lock.yaml"]);
  assert.deepEqual(plan.copy, ["node_modules"]);
  assert.deepEqual(plan.setup, ["pnpm install --frozen-lockfile"]);
  assert.equal(plan.detectedBy, "pnpm-lock.yaml");
});

test("detectPlan: npm lockfile uses ci", () => {
  const plan = detectPlan(["package-lock.json"]);
  assert.deepEqual(plan.setup, ["npm ci"]);
  assert.equal(plan.detectedBy, "package-lock.json");
});

test("detectPlan: yarn lockfile installs immutable", () => {
  const plan = detectPlan(["yarn.lock"]);
  assert.deepEqual(plan.setup, ["yarn install --immutable"]);
  assert.equal(plan.detectedBy, "yarn.lock");
});

test("detectPlan: no lockfile is an empty plan, not a failure", () => {
  const plan = detectPlan(["README.md"]);
  assert.deepEqual(plan.copy, []);
  assert.deepEqual(plan.setup, []);
  assert.equal(plan.detectedBy, "no lockfile");
});

test("detectPlan: detectedBy is always populated", () => {
  for (const files of [[], ["README.md"], ["pnpm-lock.yaml"]]) {
    assert.notEqual(detectPlan(files).detectedBy, "");
  }
});

test("detectPlan: pnpm wins when several lockfiles are present", () => {
  const plan = detectPlan(["yarn.lock", "package-lock.json", "pnpm-lock.yaml"]);
  assert.equal(plan.detectedBy, "pnpm-lock.yaml");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd swarm && node --import tsx --test src/provisioning.test.ts`
Expected: FAIL — `Cannot find module './provisioning.js'`

- [ ] **Step 3: Write minimal implementation**

```ts
// Provisioning policy — what a fresh instance needs before an agent can work.
//
// Deliberately pure: no fs, no child_process. The caller supplies the facts
// (which files exist, whether a path is tracked) so every branch is testable
// without a real checkout — the same discipline session-reconcile.ts keeps.

export interface ProvisionPlan {
  /** Gitignored paths to copy from the source checkout. */
  copy: string[];
  /** Commands run in the new member after copying. */
  setup: string[];
  /** Why this plan exists — a lockfile name, "no lockfile", or "config override". */
  detectedBy: string;
}

/**
 * Ordered because a repo can carry several lockfiles; the first match wins and
 * names itself in `detectedBy`, so a surprising plan is traceable to one file.
 */
const SIGNALS: Array<{ file: string; copy: string[]; setup: string[] }> = [
  { file: "pnpm-lock.yaml", copy: ["node_modules"], setup: ["pnpm install --frozen-lockfile"] },
  { file: "package-lock.json", copy: ["node_modules"], setup: ["npm ci"] },
  { file: "yarn.lock", copy: ["node_modules"], setup: ["yarn install --immutable"] },
];

/** `files` is a flat list of entry names at the member root. */
export function detectPlan(files: string[]): ProvisionPlan {
  const present = new Set(files);
  for (const signal of SIGNALS) {
    if (present.has(signal.file)) {
      return { copy: [...signal.copy], setup: [...signal.setup], detectedBy: signal.file };
    }
  }
  // A repo with no dependencies is correctly provisioned by doing nothing.
  return { copy: [], setup: [], detectedBy: "no lockfile" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd swarm && node --import tsx --test src/provisioning.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm --filter swarm typecheck && pnpm --filter swarm lint`
Expected: both clean. `tsx` strips types, so this is the only step that checks them.

- [ ] **Step 6: Commit**

```bash
git add swarm/src/provisioning.ts swarm/src/provisioning.test.ts
git commit -m "feat(swarm): lockfile-driven provision plan detector"
```

---

### Task 2: Copy-path guards

**Files:**
- Modify: `swarm/src/provisioning.ts`
- Test: `swarm/src/provisioning.test.ts`

**Interfaces:**
- Consumes: `ProvisionPlan` from Task 1.
- Produces: `type GuardVerdict = { ok: true } | { ok: false; reason: string }` and `checkCopyPath(path: string, facts: { tracked: boolean; existsInSource: boolean }): GuardVerdict`. Facts are supplied by the caller so the guard stays pure.

- [ ] **Step 1: Write the failing test**

```ts
import { checkCopyPath } from "./provisioning.js";

const OK = { tracked: false, existsInSource: true };

test("checkCopyPath: accepts an ordinary gitignored directory", () => {
  assert.deepEqual(checkCopyPath("node_modules", OK), { ok: true });
});

test("checkCopyPath: refuses secrets", () => {
  for (const p of [".env", ".env.local", "certs/server.pem", "id_rsa", "master.key"]) {
    const verdict = checkCopyPath(p, OK);
    assert.equal(verdict.ok, false, `${p} must be refused`);
    if (!verdict.ok) assert.match(verdict.reason, /secret/i);
  }
});

test("checkCopyPath: refuses a tracked path", () => {
  const verdict = checkCopyPath("src", { tracked: true, existsInSource: true });
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.match(verdict.reason, /tracked/i);
});

test("checkCopyPath: refuses absolute paths and parent escapes", () => {
  for (const p of ["/etc/passwd", "../outside", "a/../../b"]) {
    assert.equal(checkCopyPath(p, OK).ok, false, `${p} must be refused`);
  }
});

test("checkCopyPath: refuses a path absent from the source", () => {
  const verdict = checkCopyPath("node_modules", { tracked: false, existsInSource: false });
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.match(verdict.reason, /not present/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd swarm && node --import tsx --test src/provisioning.test.ts`
Expected: FAIL — `checkCopyPath is not a function`

- [ ] **Step 3: Write minimal implementation**

Append to `swarm/src/provisioning.ts`:

```ts
export type GuardVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Secrets are never provisioned. §7 of the workspace-instances design decided
 * that credentials are retrieved on demand and never held by the instance;
 * because overrides are user-authored, someone will eventually list `.env`, so
 * that decision is enforced here rather than documented and hoped for.
 */
const SECRET_PATTERNS: RegExp[] = [/(^|\/)\.env($|\.)/i, /\.pem$/i, /(^|\/)id_rsa/i, /(^|\/)master\.key$/i];

export function checkCopyPath(path: string, facts: { tracked: boolean; existsInSource: boolean }): GuardVerdict {
  if (SECRET_PATTERNS.some((re) => re.test(path))) {
    return { ok: false, reason: `"${path}" looks like a secret; secrets are never copied into an instance` };
  }
  if (path.startsWith("/")) return { ok: false, reason: `"${path}" is absolute; only member-relative paths are copied` };
  if (path.split("/").includes("..")) {
    return { ok: false, reason: `"${path}" escapes the member root` };
  }
  // A tracked path is already in the worktree; copying over it would shadow the
  // checkout with a stale copy.
  if (facts.tracked) return { ok: false, reason: `"${path}" is tracked by git and is already in the worktree` };
  if (!facts.existsInSource) return { ok: false, reason: `"${path}" is not present in the source checkout` };
  return { ok: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd swarm && node --import tsx --test src/provisioning.test.ts`
Expected: PASS, 11 tests

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm --filter swarm typecheck && pnpm --filter swarm lint`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add swarm/src/provisioning.ts swarm/src/provisioning.test.ts
git commit -m "feat(swarm): copy-path guards refuse secrets, tracked paths, and escapes"
```

---

### Task 3: Override resolution and the detected-vs-override asymmetry

**Files:**
- Modify: `swarm/src/provisioning.ts`
- Test: `swarm/src/provisioning.test.ts`

**Interfaces:**
- Consumes: `ProvisionPlan`, `checkCopyPath`, `GuardVerdict`.
- Produces: `interface ProvisionOverride { copy: string[]; setup: string[] }` and
  `resolvePlan(detected: ProvisionPlan, override: ProvisionOverride | undefined): ProvisionPlan` plus
  `applyGuards(plan: ProvisionPlan, isOverride: boolean, factsFor: (p: string) => { tracked: boolean; existsInSource: boolean }): { plan: ProvisionPlan; warnings: string[] }` — throws on an override violation, warns and drops on a detected one.

- [ ] **Step 1: Write the failing test**

```ts
import { applyGuards, resolvePlan } from "./provisioning.js";

const clean = () => ({ tracked: false, existsInSource: true });

test("resolvePlan: an override replaces the detected plan rather than merging", () => {
  const detected = { copy: ["node_modules"], setup: ["pnpm install --frozen-lockfile"], detectedBy: "pnpm-lock.yaml" };
  const plan = resolvePlan(detected, { copy: [".cache"], setup: ["make deps"] });
  assert.deepEqual(plan.copy, [".cache"]);
  assert.deepEqual(plan.setup, ["make deps"]);
  assert.equal(plan.detectedBy, "config override");
});

test("resolvePlan: no override keeps the detected plan untouched", () => {
  const detected = { copy: ["node_modules"], setup: ["npm ci"], detectedBy: "package-lock.json" };
  assert.deepEqual(resolvePlan(detected, undefined), detected);
});

test("applyGuards: a detected plan drops a bad path with a warning", () => {
  const plan = { copy: ["node_modules", "gone"], setup: [], detectedBy: "pnpm-lock.yaml" };
  const facts = (p: string) => ({ tracked: false, existsInSource: p !== "gone" });
  const result = applyGuards(plan, false, facts);
  assert.deepEqual(result.plan.copy, ["node_modules"]);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /not present/i);
});

test("applyGuards: an override naming .env throws — this is how §7 is enforced", () => {
  const plan = { copy: [".env"], setup: [], detectedBy: "config override" };
  assert.throws(() => applyGuards(plan, true, clean), /secret/i);
});

test("applyGuards: a detected plan never throws", () => {
  const plan = { copy: ["../escape"], setup: [], detectedBy: "pnpm-lock.yaml" };
  const result = applyGuards(plan, false, clean);
  assert.deepEqual(result.plan.copy, []);
  assert.equal(result.warnings.length, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd swarm && node --import tsx --test src/provisioning.test.ts`
Expected: FAIL — `resolvePlan is not a function`

- [ ] **Step 3: Write minimal implementation**

Append to `swarm/src/provisioning.ts`:

```ts
export interface ProvisionOverride {
  copy: string[];
  setup: string[];
}

/**
 * An override REPLACES the detected plan. Merging would produce a union nobody
 * wrote in full, and the first surprising copy would send someone reading
 * detector source to find out where a path came from.
 */
export function resolvePlan(detected: ProvisionPlan, override: ProvisionOverride | undefined): ProvisionPlan {
  if (!override) return detected;
  return { copy: [...override.copy], setup: [...override.setup], detectedBy: "config override" };
}

/**
 * The asymmetry is deliberate: a user who wrote a path meant it and must be told
 * they cannot have it; a detector that guessed wrong must not fail the instance.
 */
export function applyGuards(
  plan: ProvisionPlan,
  isOverride: boolean,
  factsFor: (path: string) => { tracked: boolean; existsInSource: boolean },
): { plan: ProvisionPlan; warnings: string[] } {
  const copy: string[] = [];
  const warnings: string[] = [];
  for (const path of plan.copy) {
    const verdict = checkCopyPath(path, factsFor(path));
    if (verdict.ok) {
      copy.push(path);
      continue;
    }
    if (isOverride) throw new Error(`provision override: ${verdict.reason}`);
    warnings.push(verdict.reason);
  }
  return { plan: { ...plan, copy }, warnings };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd swarm && node --import tsx --test src/provisioning.test.ts`
Expected: PASS, 16 tests

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm --filter swarm typecheck && pnpm --filter swarm lint`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add swarm/src/provisioning.ts swarm/src/provisioning.test.ts
git commit -m "feat(swarm): override replaces detected plan; overrides throw where detection warns"
```

---

### Task 4: Copy execution

**Files:**
- Create: `swarm/src/provision-exec.ts`
- Test: `swarm/src/provision-exec.test.ts`

**Interfaces:**
- Consumes: `ProvisionPlan` from Task 1.
- Produces: `copyProvisionPaths(source: string, dest: string, paths: string[]): Promise<{ copied: string[]; failed: Array<{ path: string; reason: string }> }>`. Never throws — a failed copy is reported, not raised, because setup rebuilds what copy provides.

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { copyProvisionPaths } from "./provision-exec.js";

test("copyProvisionPaths: copies a directory and reports it", async () => {
  const root = mkdtempSync(join(tmpdir(), "prov-"));
  try {
    const source = join(root, "src");
    const dest = join(root, "dst");
    mkdirSync(join(source, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(source, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
    mkdirSync(dest, { recursive: true });

    const result = await copyProvisionPaths(source, dest, ["node_modules"]);

    assert.deepEqual(result.copied, ["node_modules"]);
    assert.deepEqual(result.failed, []);
    assert.ok(statSync(join(dest, "node_modules", "pkg", "index.js")).isFile());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("copyProvisionPaths: the copy is independent, never a symlink", async () => {
  const root = mkdtempSync(join(tmpdir(), "prov-"));
  try {
    const source = join(root, "src");
    const dest = join(root, "dst");
    mkdirSync(join(source, "cache"), { recursive: true });
    writeFileSync(join(source, "cache", "a.txt"), "original\n");
    mkdirSync(dest, { recursive: true });

    await copyProvisionPaths(source, dest, ["cache"]);
    writeFileSync(join(dest, "cache", "a.txt"), "changed\n");

    assert.equal(statSync(join(dest, "cache")).isSymbolicLink(), false);
    assert.equal(
      // The source must be untouched — a shared tree is what this design forbids.
      require("node:fs").readFileSync(join(source, "cache", "a.txt"), "utf8"),
      "original\n",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("copyProvisionPaths: a missing path is reported, never thrown", async () => {
  const root = mkdtempSync(join(tmpdir(), "prov-"));
  try {
    const source = join(root, "src");
    const dest = join(root, "dst");
    mkdirSync(source, { recursive: true });
    mkdirSync(dest, { recursive: true });

    const result = await copyProvisionPaths(source, dest, ["absent"]);

    assert.deepEqual(result.copied, []);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].path, "absent");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd swarm && node --import tsx --test src/provision-exec.test.ts`
Expected: FAIL — `Cannot find module './provision-exec.js'`

- [ ] **Step 3: Write minimal implementation**

```ts
// Provisioning execution — the impure half. Policy lives in provisioning.ts.
import { cp } from "node:fs/promises";
import { join } from "node:path";

/**
 * Copy each path from the workspace's own checkout into the new member.
 *
 * Never throws. A failed copy is an optimization that did not happen: the plan's
 * setup commands rebuild whatever copy would have provided, so the worst outcome
 * is a cold build, which is the status quo without this feature at all.
 *
 * Never symlinks. Every instance owns its whole tree, because a shared
 * node_modules is shared mutable state between concurrent agents.
 */
export async function copyProvisionPaths(
  source: string,
  dest: string,
  paths: string[],
): Promise<{ copied: string[]; failed: Array<{ path: string; reason: string }> }> {
  const copied: string[] = [];
  const failed: Array<{ path: string; reason: string }> = [];
  for (const path of paths) {
    try {
      await cp(join(source, path), join(dest, path), {
        recursive: true,
        // Follow nothing: a symlink in the source must not become a link out of
        // the instance.
        dereference: false,
        force: true,
      });
      copied.push(path);
    } catch (err) {
      failed.push({ path, reason: (err as Error).message });
    }
  }
  return { copied, failed };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd swarm && node --import tsx --test src/provision-exec.test.ts`
Expected: PASS, 3 tests

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm --filter swarm typecheck && pnpm --filter swarm lint`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add swarm/src/provision-exec.ts swarm/src/provision-exec.test.ts
git commit -m "feat(swarm): copy provision paths, reporting failures instead of raising"
```

---

### Task 5: Setup command execution

**Files:**
- Modify: `swarm/src/provision-exec.ts`
- Test: `swarm/src/provision-exec.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks beyond the module itself.
- Produces: `runSetupCommands(cwd: string, commands: string[], timeoutMs: number): Promise<{ ok: true } | { ok: false; command: string; output: string }>`. Stops at the first failure and returns its command and combined output.

- [ ] **Step 1: Write the failing test**

```ts
import { runSetupCommands } from "./provision-exec.js";

test("runSetupCommands: runs in order and reports success", async () => {
  const root = mkdtempSync(join(tmpdir(), "prov-"));
  try {
    const result = await runSetupCommands(root, ["echo one > a.txt", "echo two > b.txt"], 20_000);
    assert.deepEqual(result, { ok: true });
    assert.ok(statSync(join(root, "a.txt")).isFile());
    assert.ok(statSync(join(root, "b.txt")).isFile());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runSetupCommands: stops at the first failure and names it", async () => {
  const root = mkdtempSync(join(tmpdir(), "prov-"));
  try {
    const result = await runSetupCommands(root, ["exit 3", "echo never > never.txt"], 20_000);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.command, "exit 3");
    assert.throws(() => statSync(join(root, "never.txt")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runSetupCommands: an empty list succeeds", async () => {
  const root = mkdtempSync(join(tmpdir(), "prov-"));
  try {
    assert.deepEqual(await runSetupCommands(root, [], 20_000), { ok: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd swarm && node --import tsx --test src/provision-exec.test.ts`
Expected: FAIL — `runSetupCommands is not a function`

- [ ] **Step 3: Write minimal implementation**

Append to `swarm/src/provision-exec.ts`:

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * Run the plan's setup commands in the member, in order, stopping at the first
 * failure. Unlike copying, setup IS the correctness path: if it fails the
 * instance is not workable and must be reported as failed.
 */
export async function runSetupCommands(
  cwd: string,
  commands: string[],
  timeoutMs: number,
): Promise<{ ok: true } | { ok: false; command: string; output: string }> {
  for (const command of commands) {
    try {
      await exec("/bin/sh", ["-c", command], { cwd, timeout: timeoutMs });
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message: string };
      return { ok: false, command, output: `${e.stdout ?? ""}${e.stderr ?? ""}` || e.message };
    }
  }
  return { ok: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd swarm && node --import tsx --test src/provision-exec.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm --filter swarm typecheck && pnpm --filter swarm lint`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add swarm/src/provision-exec.ts swarm/src/provision-exec.test.ts
git commit -m "feat(swarm): run provision setup commands, stopping at the first failure"
```

---

### Task 6: Provisioning state on the instance, run in the background

**Files:**
- Modify: `swarm/src/workspace-instances.ts` (the `Instance` interface at lines 52-57; the end of `createInstance` at line 222)
- Test: `swarm/src/workspace-instances.test.ts`

**Interfaces:**
- Consumes: `detectPlan`, `resolvePlan`, `applyGuards` (Tasks 1-3); `copyProvisionPaths`, `runSetupCommands` (Tasks 4-5).
- Produces: `type ProvisionState = "provisioning" | "ready" | "failed"`; `Instance` gains
  `provision: { state: ProvisionState; detectedBy: string; error?: string }`; and
  `provisionInstance(inst: Instance, overrides: Record<string, ProvisionOverride | undefined>, timeoutMs: number): Promise<Instance["provision"]>`.
  `createInstance` returns with `state: "provisioning"` and does **not** await `provisionInstance`.

- [ ] **Step 1: Write the failing test**

```ts
import { createInstance, provisionInstance } from "./workspace-instances.js";

// `makeWorkspace(label, repos)` already exists in this file (line 58). It is
// SYNCHRONOUS and returns `{ dir, ws }` — not `workspaceDir`. Existing tests
// pass `ws as never` because the helper's shape is narrower than `Workspace`.

test("createInstance: returns immediately with state provisioning", async () => {
  const { dir, ws } = makeWorkspace("prov-a", ["app"]);
  const inst = await createInstance(dir, ws as never, "work-1", ["app"]);
  assert.equal(inst.provision.state, "provisioning");
});

test("provisionInstance: a member with no lockfile becomes ready", async () => {
  const { dir, ws } = makeWorkspace("prov-b", ["app"]);
  const inst = await createInstance(dir, ws as never, "work-2", ["app"]);
  const result = await provisionInstance(inst, {}, 20_000);
  assert.equal(result.state, "ready");
  assert.equal(result.detectedBy, "no lockfile");
});

test("provisionInstance: a failing setup command marks it failed and keeps the worktrees", async () => {
  const { dir, ws } = makeWorkspace("prov-c", ["app"]);
  const inst = await createInstance(dir, ws as never, "work-3", ["app"]);
  const result = await provisionInstance(inst, { app: { copy: [], setup: ["exit 7"] } }, 20_000);
  assert.equal(result.state, "failed");
  assert.match(result.error ?? "", /exit 7/);
  // Nothing is destroyed on failure.
  assert.ok(statSync(inst.members[0].path).isDirectory());
});

test("provisionInstance: an override naming .env fails the instance", async () => {
  const { dir, ws } = makeWorkspace("prov-d", ["app"]);
  const inst = await createInstance(dir, ws as never, "work-4", ["app"]);
  const result = await provisionInstance(inst, { app: { copy: [".env"], setup: [] } }, 20_000);
  assert.equal(result.state, "failed");
  assert.match(result.error ?? "", /secret/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd swarm && node --import tsx --test src/workspace-instances.test.ts`
Expected: FAIL — `provisionInstance is not a function`, and `inst.provision` undefined

- [ ] **Step 3: Write minimal implementation**

In `swarm/src/workspace-instances.ts`, add the import and extend the interface:

```ts
import { copyProvisionPaths, runSetupCommands } from "./provision-exec.js";
import { applyGuards, detectPlan, type ProvisionOverride, resolvePlan } from "./provisioning.js";

export type ProvisionState = "provisioning" | "ready" | "failed";

export interface Instance {
  workId: string;
  dir: string;
  branch: string;
  members: InstanceMember[];
  /** Set to `provisioning` by createInstance; advanced by provisionInstance. */
  provision: { state: ProvisionState; detectedBy: string; error?: string };
}
```

Change the final return of `createInstance` (line 222) from:

```ts
  return { workId, dir, branch, members };
```

to:

```ts
  // Provisioning runs as a job, not inline: copying a tree and running an
  // install takes seconds to minutes, and a blocking create makes
  // worktree-per-work-item unusable in practice.
  return { workId, dir, branch, members, provision: { state: "provisioning", detectedBy: "pending" } };
```

Then append:

```ts
/**
 * Fill a created instance's members so an agent can actually build in them.
 *
 * Copy failures are warnings — setup rebuilds what copy provides — while a setup
 * failure marks the instance failed. Nothing is destroyed on failure: the
 * worktrees and branches stay, matching destroyInstance's own refusal to discard
 * work it did not create.
 */
export async function provisionInstance(
  inst: Instance,
  overrides: Record<string, ProvisionOverride | undefined>,
  timeoutMs: number,
): Promise<Instance["provision"]> {
  let detectedBy = "no lockfile";
  for (const member of inst.members) {
    const entries = await readdir(member.path).catch(() => [] as string[]);
    const plan = resolvePlan(detectPlan(entries), overrides[member.name]);
    detectedBy = plan.detectedBy;

    let guarded: ReturnType<typeof applyGuards>;
    try {
      guarded = applyGuards(plan, plan.detectedBy === "config override", (path) => ({
        tracked: false,
        existsInSource: existsSync(join(member.source, path)),
      }));
    } catch (err) {
      return { state: "failed", detectedBy, error: (err as Error).message };
    }

    await copyProvisionPaths(member.source, member.path, guarded.plan.copy);

    const setup = await runSetupCommands(member.path, guarded.plan.setup, timeoutMs);
    if (!setup.ok) {
      return { state: "failed", detectedBy, error: `setup "${setup.command}" failed: ${setup.output}` };
    }
  }
  return { state: "ready", detectedBy };
}
```

Add `readdir` to the existing `node:fs/promises` import and `existsSync` from `node:fs`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd swarm && node --import tsx --test src/workspace-instances.test.ts`
Expected: PASS — the 35 existing tests plus 4 new ones

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm --filter swarm typecheck && pnpm --filter swarm lint`
Expected: both clean. Expect `tsc` to flag every other construction of `Instance` that now lacks `provision` — fix each by adding `provision: { state: "provisioning", detectedBy: "pending" }`. This is exactly the check `tsx` cannot perform.

- [ ] **Step 6: Commit**

```bash
git add swarm/src/workspace-instances.ts swarm/src/workspace-instances.test.ts
git commit -m "feat(swarm): instances carry provisioning state, filled by a background job"
```

---

### Task 7: Session launch is gated on ready

**Files:**
- Modify: `swarm/src/agent-sessions.ts` (inside `create()`, after the `toolGate` check at line 98)
- Test: `swarm/src/agent-sessions.test.ts`

**Interfaces:**
- Consumes: `ProvisionState` from Task 6.
- Produces: `AgentSessionConfig` gains an optional
  `instanceProvisionState?: (cwd: string) => Promise<ProvisionState | null>` — resolves the state for the instance a session would run in, or `null` when the session is not instance-backed. Absent means no gating, matching how `toolGate` and `store` are already optional for tests.

- [ ] **Step 1: Write the failing test**

There is **no** `makeManager` helper in this file. Managers are constructed
inline — see `lazyManager` (line 186) and `broken` (line 234) for the pattern.
Follow it, reusing the file-level `runtime`, `toolScript`, `FakeDriver`, `AGENT`,
and `repoRoot` that the existing `before` hook sets up.

```ts
/** Same shape as the file-level manager, plus the gate under test. */
function gatedManager(state: "provisioning" | "ready" | "failed" | null) {
  return new AgentSessionManager(runtime, {
    agentCommands: { claude: toolScript },
    worktreeDir: ".smith/worktrees",
    resolveDriver: () => new FakeDriver(),
    pollIntervalMs: 100,
    readinessTimeoutMs: 10_000,
    turnTimeoutMs: 10_000,
    instanceProvisionState: async () => state,
  });
}

test("create: refuses a session whose instance is still provisioning", async () => {
  await assert.rejects(
    () => gatedManager("provisioning").create(AGENT, JSON.stringify(AGENT), repoRoot, "main"),
    /provisioning/i,
    "a half-built tree must not accept an agent",
  );
});

test("create: refuses a session whose instance failed to provision", async () => {
  await assert.rejects(
    () => gatedManager("failed").create(AGENT, JSON.stringify(AGENT), repoRoot, "main"),
    /failed/i,
  );
});

test("create: proceeds when the instance is ready", async () => {
  const info = await gatedManager("ready").create(AGENT, JSON.stringify(AGENT), repoRoot, "main");
  created.push(info.id);
  assert.equal(info.status, "starting");
});

test("create: proceeds when there is no instance to gate on", async () => {
  const info = await gatedManager(null).create(AGENT, JSON.stringify(AGENT), repoRoot, "main");
  created.push(info.id);
  assert.equal(info.status, "starting");
});
```

> Push every created id onto `created` — the file's `after` hook destroys them,
> and a session left running leaks a tmux session into the next test run.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd swarm && node --import tsx --test src/agent-sessions.test.ts`
Expected: FAIL — the first two tests resolve instead of rejecting, because no gate exists.

- [ ] **Step 3: Write minimal implementation**

In `swarm/src/agent-sessions.ts`, add to `AgentSessionConfig`:

```ts
  /** Provision state of the instance this session would run in; null when not
   *  instance-backed. Absent = no gating (tests, ephemeral runs). */
  instanceProvisionState?: (cwd: string) => Promise<ProvisionState | null>;
```

and immediately after the `toolGate` check inside `create()`:

```ts
    // A half-populated tree produces failures indistinguishable from real ones:
    // a dependency missing because it has not been copied YET looks exactly like
    // one that is genuinely absent.
    const provision = await this.config.instanceProvisionState?.(repoRoot);
    if (provision === "provisioning") {
      throw new ToolLaunchError(agent.engine.cli, "the instance is still provisioning — wait for it to be ready");
    }
    if (provision === "failed") {
      throw new ToolLaunchError(agent.engine.cli, "the instance failed to provision — check its setup output");
    }
```

Import `ProvisionState` from `./workspace-instances.js`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd swarm && node --import tsx --test src/agent-sessions.test.ts`
Expected: PASS — existing tests plus 4 new ones

- [ ] **Step 5: Full suite, typecheck, lint**

Run: `pnpm --filter swarm test && pnpm --filter swarm typecheck && pnpm --filter swarm lint`
Expected: all clean.

- [ ] **Step 6: Commit**

```bash
git add swarm/src/agent-sessions.ts swarm/src/agent-sessions.test.ts
git commit -m "feat(swarm): refuse to launch an agent into an unprovisioned instance"
```

---

## Wiring note for the caller

`swarm/src/server.ts:3811` currently does:

```ts
const instance = await createInstance(dir, ws, taskId, [repo.name], { base: repo.branch });
```

After Task 6 that call still returns immediately, now with `provision.state === "provisioning"`. The server must start the job without awaiting it and record the result:

```ts
const instance = await createInstance(dir, ws, taskId, [repo.name], { base: repo.branch });
void provisionInstance(instance, provisionOverridesFor(ws), 600_000).then((p) => {
  instance.provision = p;
});
```

Reading provision overrides out of `config/settings.json` is deliberately left to the caller: this plan's modules take overrides as a parameter so they stay testable without a workspace on disk.

---

## Deliberate gaps against the spec

Two things the spec asks for that this plan does not build. Both are recorded
here rather than silently dropped, so a reviewer can reject the omission.

**1. No APFS clone-copy.** Spec §5 asks for copy-on-write via `cp -c` where the
filesystem supports it, falling back to a plain recursive copy. Task 4 implements
only the fallback, using `fs.cp`. The spec itself calls the clone "an
optimization on the same semantics", so the behaviour is correct and only the
speed is missing — but on a large `node_modules` that difference is seconds
versus near-instant, and it is worth a follow-up once provisioning is proven.

**2. No cancel, retry, or progress.** Spec §6 says the job's progress and current
setup command are readable and that it can be cancelled or retried. This plan
gives the job a terminal state and nothing else. That is enough for the launch
gate in Task 7 to be correct, and not enough for the UI the spec describes. It
needs a job registry keyed by instance, which is a second plan — and one that
should follow spec 4, since that is where a user would watch the progress.

Neither gap blocks the value: an instance that provisions itself and refuses to
launch an agent into a half-built tree is the whole of the problem statement.
