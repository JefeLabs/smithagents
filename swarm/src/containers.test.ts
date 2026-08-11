import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildExecutionModes,
  emptyContainersFile,
  loadContainersFile,
  probeDocker,
  saveContainersFile,
} from "./containers.js";

test("missing or corrupt file loads as disabled-docker default", async () => {
  const dir = await mkdtemp(join(tmpdir(), "containers-"));
  assert.deepEqual(await loadContainersFile(join(dir, "nope.json")), emptyContainersFile());
});

test("save/load round-trip preserves enabled flag", async () => {
  const dir = await mkdtemp(join(tmpdir(), "containers-"));
  const path = join(dir, "containers.json");
  await saveContainersFile(path, { version: 1, docker: { enabled: true } });
  assert.equal((await loadContainersFile(path)).docker.enabled, true);
});

test("probeDocker with code:0 and version in stdout reports ok", async () => {
  const ok = await probeDocker(async () => {
    return { code: 0, stdout: "27.0.1\n", stderr: "" };
  });
  assert.equal(ok.ok, true);
  assert.match(ok.detail, /27\.0\.1/);
});

test("probeDocker with code:null and empty stdout/stderr reports binary not found", async () => {
  const notFound = await probeDocker(async () => {
    return { code: null, stdout: "", stderr: "" };
  });
  assert.equal(notFound.ok, false);
  assert.match(notFound.detail, /binary not found/i);
});

test("probeDocker with code!==0 reports daemon unreachable", async () => {
  const unreachable = await probeDocker(async () => {
    return { code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" };
  });
  assert.equal(unreachable.ok, false);
  assert.match(unreachable.detail, /daemon unreachable/i);
});

test("buildExecutionModes gates by docker toggle and worker advertisement", () => {
  assert.deepEqual(buildExecutionModes(false, []), {
    "local-in-process": true,
    "local-docker": false,
    "remote-in-process": false,
    "remote-docker": false,
  });
  assert.deepEqual(buildExecutionModes(true, [["tmux"], ["docker"]]), {
    "local-in-process": true,
    "local-docker": true,
    "remote-in-process": true,
    "remote-docker": true,
  });
  assert.equal(buildExecutionModes(true, [["tmux"]])["remote-docker"], false);
});
