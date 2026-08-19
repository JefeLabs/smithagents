import assert from "node:assert/strict";
import { test } from "node:test";
import { applyGuards, checkCopyPath, detectPlan, resolvePlan } from "./provisioning.js";

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

test("detectPlan: every copy entry is reproducible by its own setup — the invariant the whole design rests on", () => {
  // Copy is an optimization; setup is the correctness path. A copy entry that
  // setup cannot rebuild turns a recoverable slow path into a broken instance.
  for (const f of ["pnpm-lock.yaml", "package-lock.json", "yarn.lock"]) {
    const plan = detectPlan([f]);
    if (plan.copy.length > 0) assert.ok(plan.setup.length > 0, `${f}: copies but cannot rebuild`);
  }
});

const OK = { tracked: false, existsInSource: true };

test("checkCopyPath: accepts an ordinary gitignored directory", () => {
  assert.deepEqual(checkCopyPath("node_modules", OK), { ok: true });
});

test("checkCopyPath: refuses secrets — this is how §7 stops being advisory", () => {
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

const clean = () => ({ tracked: false, existsInSource: true });

test("resolvePlan: an override REPLACES the detected plan rather than merging", () => {
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

test("applyGuards: a DETECTED plan drops a bad path with a warning and never throws", () => {
  const plan = { copy: ["node_modules", "gone"], setup: [], detectedBy: "pnpm-lock.yaml" };
  const facts = (p: string) => ({ tracked: false, existsInSource: p !== "gone" });
  const result = applyGuards(plan, false, facts);
  assert.deepEqual(result.plan.copy, ["node_modules"]);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0] ?? "", /not present/i);
});

test("applyGuards: an OVERRIDE naming .env throws — the asymmetry is the point", () => {
  // A user who wrote the path meant it and must be told they cannot have it; a
  // detector that guessed wrong must not fail the instance.
  const plan = { copy: [".env"], setup: [], detectedBy: "config override" };
  assert.throws(() => applyGuards(plan, true, clean), /secret/i);
});

test("applyGuards: a detected plan with an escaping path drops it silently-but-warned", () => {
  const plan = { copy: ["../escape"], setup: [], detectedBy: "pnpm-lock.yaml" };
  const result = applyGuards(plan, false, clean);
  assert.deepEqual(result.plan.copy, []);
  assert.equal(result.warnings.length, 1);
});

test("applyGuards: setup and detectedBy survive guarding untouched", () => {
  const plan = { copy: ["gone"], setup: ["pnpm install"], detectedBy: "pnpm-lock.yaml" };
  const result = applyGuards(plan, false, () => ({ tracked: false, existsInSource: false }));
  assert.deepEqual(result.plan.setup, ["pnpm install"]);
  assert.equal(result.plan.detectedBy, "pnpm-lock.yaml");
});

test("checkCopyPath: refuses the credential dotfiles a user would plausibly add", () => {
  // Every one of these is gitignored and sits beside node_modules, and a user
  // adding an override for private-registry installs would reach for the first.
  for (const p of [
    ".npmrc",
    ".netrc",
    ".git-credentials",
    ".pypirc",
    ".docker/config.json",
    ".ssh/id_ed25519",
    ".aws/credentials",
  ]) {
    assert.equal(checkCopyPath(p, OK).ok, false, `${p} must be refused`);
  }
});

test("checkCopyPath: refuses credential files by extension wherever they sit", () => {
  for (const p of ["certs/client.p12", "keys/app.key", "a/b/store.jks", "service-account.json", "secrets.yaml"]) {
    assert.equal(checkCopyPath(p, OK).ok, false, `${p} must be refused`);
  }
});

test("checkCopyPath: still admits the dotted build and cache entries the spec wants", () => {
  for (const p of [".cache", ".turbo", ".next", ".vscode/settings.json", ".yarn/cache"]) {
    assert.deepEqual(checkCopyPath(p, OK), { ok: true }, `${p} must be allowed`);
  }
});

test("checkCopyPath: normalizes before judging — the guard and the copy must not disagree", () => {
  // Each of these resolves to something the raw-string check could miss.
  for (const p of ["./.env", "a//../../b", "a\\..\\b", "node_modules/./../../etc"]) {
    assert.equal(checkCopyPath(p, OK).ok, false, `${p} must be refused`);
  }
  // ...while a merely untidy path that resolves somewhere legitimate still passes.
  assert.deepEqual(checkCopyPath("./node_modules/", OK), { ok: true });
});

test("checkCopyPath: refuses a Windows-absolute path", () => {
  assert.equal(checkCopyPath("C:\\secrets\\key", OK).ok, false);
});
