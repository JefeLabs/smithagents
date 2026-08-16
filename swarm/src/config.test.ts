import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { test } from "node:test";
import { defaultStateRoot, loadConfig } from "./config.js";

test("defaultStateRoot: ~/.smithagents unless SMITH_STATE_ROOT overrides it", () => {
  const saved = process.env.SMITH_STATE_ROOT;
  try {
    delete process.env.SMITH_STATE_ROOT;
    assert.equal(defaultStateRoot(), join(homedir(), ".smithagents"));

    process.env.SMITH_STATE_ROOT = "/custom/root";
    assert.equal(defaultStateRoot(), "/custom/root");

    // An empty value is not an override — it is an unset variable spelled badly.
    process.env.SMITH_STATE_ROOT = "";
    assert.equal(defaultStateRoot(), join(homedir(), ".smithagents"));
  } finally {
    if (saved === undefined) delete process.env.SMITH_STATE_ROOT;
    else process.env.SMITH_STATE_ROOT = saved;
  }
});

test("loadConfig: a relative smithRoot override is resolved, not passed through raw", () => {
  // Regression: the `...overrides` spread used to re-apply the caller's raw
  // string over the resolved value, so smithRoot came back relative while
  // queueDir/worktreeDir/logsDir stayed absolute — split-brain state.
  const dir = mkdtempSync(join(tmpdir(), "smith-cfg-"));
  const cwdBefore = process.cwd();
  try {
    // A genuinely relative string — an already-absolute path (as this test
    // used to pass) leaves resolve() a no-op, so the clobber bug (the raw
    // override re-applied over the resolved value) would slip through
    // undetected: isAbsolute() passes either way when the input was already
    // absolute. Only a relative input distinguishes the two. chdir into the
    // disposable tmp dir first so resolving it — and the directories
    // loadConfig creates — land there instead of wherever the suite happened
    // to be launched from; the assertions below check internal consistency
    // (smithRoot vs. its derived dirs), not any specific expected path, so
    // they don't depend on what that cwd actually is.
    process.chdir(dir);
    const cfg = loadConfig({ smithRoot: "relative-check" });
    assert.ok(isAbsolute(cfg.smithRoot), `smithRoot must be absolute, got ${cfg.smithRoot}`);
    assert.equal(cfg.queueDir, join(cfg.smithRoot, "queue"));
    assert.equal(cfg.worktreeDir, join(cfg.smithRoot, "worktrees"));
    assert.equal(cfg.logsDir, join(cfg.smithRoot, "logs"));
  } finally {
    process.chdir(cwdBefore);
    rmSync(dir, { recursive: true, force: true });
  }
});
