import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { decodeAvatarData, readAvatar, stageAvatar } from "./avatars.js";

// Smallest possible valid-magic PNG payload for tests: real header, junk body.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("body")]);
const dirs = async () => ({
  liveDir: await mkdtemp(join(tmpdir(), "av-live-")),
  presetDir: await mkdtemp(join(tmpdir(), "av-preset-")),
});

test("decodeAvatarData: accepts a small png, rejects non-png and oversize", () => {
  assert.deepEqual(decodeAvatarData(PNG.toString("base64")), PNG);
  assert.throws(() => decodeAvatarData(Buffer.from("GIF89a...").toString("base64")), /PNG/);
  const big = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]);
  assert.throws(() => decodeAvatarData(big.toString("base64")), /2 MB/);
  assert.throws(() => decodeAvatarData(""), /PNG/);
});

test("stageAvatar: writes avatarData as <id>.png in liveDir", async () => {
  const { liveDir, presetDir } = await dirs();
  const file = await stageAvatar({ agentId: "nena", liveDir, presetDir, avatarData: PNG.toString("base64") });
  assert.equal(file, "nena.png");
  assert.deepEqual(await readFile(join(liveDir, "nena.png")), PNG);
});

test("stageAvatar: copies preset art into liveDir under the agent id", async () => {
  const { liveDir, presetDir } = await dirs();
  await writeFile(join(presetDir, "minerva.png"), PNG);
  const file = await stageAvatar({ agentId: "minerva-2", liveDir, presetDir, avatarPreset: "minerva" });
  assert.equal(file, "minerva-2.png");
  assert.deepEqual(await readFile(join(liveDir, "minerva-2.png")), PNG);
});

test("stageAvatar: no avatar in body -> undefined; missing preset art and bad ids throw", async () => {
  const { liveDir, presetDir } = await dirs();
  assert.equal(await stageAvatar({ agentId: "x", liveDir, presetDir }), undefined);
  await assert.rejects(stageAvatar({ agentId: "x", liveDir, presetDir, avatarPreset: "ghost" }), /ghost/);
  await assert.rejects(
    stageAvatar({ agentId: "../evil", liveDir, presetDir, avatarData: PNG.toString("base64") }),
    /id/i,
  );
  await assert.rejects(stageAvatar({ agentId: "x", liveDir, presetDir, avatarPreset: "../evil" }), /preset/i);
});

test("readAvatar: liveDir wins, presetDir is the fallback, bad names and misses are null", async () => {
  const { liveDir, presetDir } = await dirs();
  await writeFile(join(presetDir, "a.png"), Buffer.from("preset"));
  assert.deepEqual(await readAvatar("a.png", liveDir, presetDir), Buffer.from("preset"));
  await writeFile(join(liveDir, "a.png"), Buffer.from("live"));
  assert.deepEqual(await readAvatar("a.png", liveDir, presetDir), Buffer.from("live"));
  assert.equal(await readAvatar("missing.png", liveDir, presetDir), null);
  assert.equal(await readAvatar("../../etc/passwd", liveDir, presetDir), null);
  assert.equal(await readAvatar("UPPER.png", liveDir, presetDir), null);
});
