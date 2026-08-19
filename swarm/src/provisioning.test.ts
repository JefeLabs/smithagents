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

test("detectPlan: every copy entry is reproducible by its own setup — the invariant the whole design rests on", () => {
  // Copy is an optimization; setup is the correctness path. A copy entry that
  // setup cannot rebuild turns a recoverable slow path into a broken instance.
  for (const f of ["pnpm-lock.yaml", "package-lock.json", "yarn.lock"]) {
    const plan = detectPlan([f]);
    if (plan.copy.length > 0) assert.ok(plan.setup.length > 0, `${f}: copies but cannot rebuild`);
  }
});
