import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { instanceDir, instancesDir, workIdProblem } from "./workspace-instances.js";

test("instancesDir/instanceDir: instances live in the unversioned half", () => {
  assert.equal(instancesDir("/ws"), join("/ws", ".runtime", "instances"));
  assert.equal(instanceDir("/ws", "work-42"), join("/ws", ".runtime", "instances", "work-42"));
});

test("workIdProblem: accepts ordinary ids", () => {
  for (const id of ["work-42", "PROJ-1234", "a", "a_b.c", "0"]) {
    assert.equal(workIdProblem(id), null, `${id} should be usable`);
  }
});

test("workIdProblem: rejects anything that could escape the instances directory", () => {
  for (const id of ["../escape", "a/b", "a\\b", "..", ".", "", "   "]) {
    assert.ok(workIdProblem(id), `${id} must be rejected`);
  }
});

test("workIdProblem: rejects a leading dash so it cannot be read as a git flag", () => {
  assert.ok(workIdProblem("-upload-pack=x"), "a work id becomes a branch name and a path");
});

test("workIdProblem: the empty case says what is wrong, not something else", () => {
  const problem = workIdProblem("  ");
  assert.ok(problem);
  assert.doesNotMatch(problem, /separator/, "a blank id is not a separator problem");
});
