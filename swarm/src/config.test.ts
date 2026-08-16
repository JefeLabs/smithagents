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
  try {
    const cfg = loadConfig({ smithRoot: join(dir, "relative-check") });
    assert.ok(isAbsolute(cfg.smithRoot), `smithRoot must be absolute, got ${cfg.smithRoot}`);
    assert.equal(cfg.queueDir, join(cfg.smithRoot, "queue"));
    assert.equal(cfg.worktreeDir, join(cfg.smithRoot, "worktrees"));
    assert.equal(cfg.logsDir, join(cfg.smithRoot, "logs"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
