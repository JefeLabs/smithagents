import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadChannelsFor, saveChannels } from "./channels.js";

test("saveChannels rejects a bad workspace-name slug and round-trips a good one, including the bot token", async () => {
  const dir = await mkdtemp(join(tmpdir(), "channels-"));
  await assert.rejects(() =>
    saveChannels(dir, "Bad Name", { discord: { botToken: "x", textChannels: [], voiceChannels: [] } }),
  );
  await saveChannels(dir, "acme", {
    discord: { botToken: "discord-tok", textChannels: ["111"], voiceChannels: ["222"] },
  });
  const loaded = await loadChannelsFor(dir, "acme");
  assert.deepEqual(loaded, { discord: { botToken: "discord-tok", textChannels: ["111"], voiceChannels: ["222"] } });
});

test("saveChannels writes owner-only permissions (0o600), same as users.ts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "channels-"));
  await saveChannels(dir, "acme", { discord: { botToken: "tok", textChannels: [], voiceChannels: [] } });
  const st = await stat(join(dir, "acme.json"));
  assert.equal(st.mode & 0o777, 0o600);
});

test("loadChannelsFor returns null for a workspace with no channels file yet", async () => {
  const dir = await mkdtemp(join(tmpdir(), "channels-"));
  assert.equal(await loadChannelsFor(dir, "nope"), null);
});
