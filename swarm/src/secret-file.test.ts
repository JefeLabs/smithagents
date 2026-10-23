import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { adminAuthHeader, apiTokenPath, ensureSecretFile, resolveApiToken } from "./secret-file.js";

async function withHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "secret-"));
  try {
    await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("ensureSecretFile: creates a 0600 token in a 0700 dir, and returns the same token next time", () =>
  withHome(async (home) => {
    const path = apiTokenPath(home);
    const first = await ensureSecretFile(path);
    assert.match(first, /^[A-Za-z0-9_-]{43}$/);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(dirname(path))).mode & 0o777, 0o700);
    assert.equal(await ensureSecretFile(path), first);
  }));

test("ensureSecretFile: eight simultaneous first calls agree on one token and leave no temp files", () =>
  withHome(async (home) => {
    const path = apiTokenPath(home);
    const tokens = await Promise.all(Array.from({ length: 8 }, () => ensureSecretFile(path)));
    assert.equal(new Set(tokens).size, 1);
    assert.deepEqual(await readdir(dirname(path)), ["api-token"]);
  }));

test("ensureSecretFile: an empty file is refused, not silently replaced", () =>
  withHome(async (home) => {
    const path = apiTokenPath(home);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "\n");
    await assert.rejects(ensureSecretFile(path), /is empty/);
  }));

test("resolveApiToken: a non-blank SMITH_API_TOKEN wins and no file is written", () =>
  withHome(async (home) => {
    assert.equal(await resolveApiToken({ SMITH_API_TOKEN: "  env-tok  " }, home), "env-tok");
    await assert.rejects(access(apiTokenPath(home)));
  }));

test("resolveApiToken: a blank SMITH_API_TOKEN falls back to the generated file", () =>
  withHome(async (home) => {
    const token = await resolveApiToken({ SMITH_API_TOKEN: "  " }, home);
    assert.equal(token, (await readFile(apiTokenPath(home), "utf8")).trim());
  }));

test("adminAuthHeader: a Bearer header carrying the resolved token", () =>
  withHome(async (home) => {
    assert.deepEqual(await adminAuthHeader({ SMITH_API_TOKEN: "t" }, home), { authorization: "Bearer t" });
  }));
