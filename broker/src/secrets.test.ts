import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveBrokerSecrets } from "./secrets.ts";

const tmpHome = () => mkdtemp(join(tmpdir(), "broker-secrets-"));

test("resolveBrokerSecrets: env wins; otherwise both tokens come from ~/.smith, generated once", async () => {
  const home = await tmpHome();
  const first = await resolveBrokerSecrets({}, home);
  const second = await resolveBrokerSecrets({}, home);
  assert.deepEqual(first, second);
  assert.match(first.swarmToken, /^[A-Za-z0-9_-]{43}$/);
  assert.match(first.bridgeToken, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first.swarmToken, first.bridgeToken);

  const envHome = await tmpHome();
  const fromEnv = await resolveBrokerSecrets({ SMITH_API_TOKEN: "a", SMITH_BROKER_TOKEN: "b" }, envHome);
  assert.deepEqual(fromEnv, { swarmToken: "a", bridgeToken: "b" });
  assert.deepEqual(await readdir(envHome), [], "env-supplied tokens write no files");
});

test("resolveBrokerSecrets: reads the api-token the swarm generated", async () => {
  const home = await tmpHome();
  await mkdir(join(home, ".smith"), { recursive: true });
  await writeFile(join(home, ".smith", "api-token"), "from-swarm\n");
  const secrets = await resolveBrokerSecrets({}, home);
  assert.equal(secrets.swarmToken, "from-swarm");
});
