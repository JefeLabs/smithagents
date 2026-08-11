import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { decryptSecret, ENC_PREFIX, encryptSecret, isEncrypted, resolveMasterKey } from "./secretbox.js";

const KEY = randomBytes(32);

test("roundtrip: encrypt then decrypt returns the original value", () => {
  const out = encryptSecret("sk-super-secret", KEY);
  assert.ok(out.startsWith(ENC_PREFIX));
  assert.equal(decryptSecret(out, KEY), "sk-super-secret");
});

test("format: enc:v1: plus three base64 segments; unique IV per call", () => {
  const a = encryptSecret("same", KEY);
  const b = encryptSecret("same", KEY);
  assert.notEqual(a, b); // fresh IV every time
  const segs = a.slice(ENC_PREFIX.length).split(":");
  assert.equal(segs.length, 3);
  for (const s of segs) assert.doesNotThrow(() => Buffer.from(s, "base64"));
});

test("isEncrypted: true only for the enc:v1: prefix", () => {
  assert.equal(isEncrypted(encryptSecret("x", KEY)), true);
  assert.equal(isEncrypted("sk-plaintext"), false);
  assert.equal(isEncrypted(""), false);
});

test("decryptSecret: wrong key throws, never returns garbage", () => {
  const out = encryptSecret("value", KEY);
  assert.throws(() => decryptSecret(out, randomBytes(32)));
});

test("decryptSecret: malformed input throws", () => {
  assert.throws(() => decryptSecret("enc:v1:not-valid", KEY));
});

test("resolveMasterKey: SMITH_MASTER_KEY env var wins and needs no file", async () => {
  const hex = randomBytes(32).toString("hex");
  const key = await resolveMasterKey({ SMITH_MASTER_KEY: hex }, "/nonexistent-home");
  assert.deepEqual(key, Buffer.from(hex, "hex"));
});

test("resolveMasterKey: invalid env value throws with a clear message", async () => {
  await assert.rejects(resolveMasterKey({ SMITH_MASTER_KEY: "too-short" }, "/nonexistent-home"), /SMITH_MASTER_KEY/);
});

test("resolveMasterKey: generates ~/.smith/master.key (0600) once and reuses it", async () => {
  const home = await mkdtemp(join(tmpdir(), "sbox-home-"));
  const first = await resolveMasterKey({}, home);
  const second = await resolveMasterKey({}, home);
  assert.deepEqual(first, second);
  assert.equal(first.length, 32);
  const filePath = join(home, ".smith", "master.key");
  const mode = (await stat(filePath)).mode & 0o777;
  assert.equal(mode, 0o600);
  assert.match((await readFile(filePath, "utf8")).trim(), /^[0-9a-f]{64}$/);
});
