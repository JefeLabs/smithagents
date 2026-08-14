import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, open, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { ENC_PREFIX } from "./secretbox.js";
import { loadUsersFromDir, resolveCurrentUser, saveUser, sweepEncryptUsers } from "./users.js";

// A fixed key for the whole file: saveUser/loadUsersFromDir now call
// resolveMasterKey() unconditionally, so every test here — not just the
// encryption-specific ones — would otherwise read-or-create the real
// ~/.smith/master.key. This machine runs multiple git worktrees sharing one
// HOME, so concurrent `npm test` runs would race on that real file.
const MASTER_HEX = randomBytes(32).toString("hex");
before(() => {
  process.env.SMITH_MASTER_KEY = MASTER_HEX;
});
after(() => {
  delete process.env.SMITH_MASTER_KEY;
});

test("loadUsersFromDir: a legacy user file (atlassian + github fields, no connectors) is upgraded on load into two ConnectorInstance entries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "users-legacy-"));
  await writeFile(
    join(dir, "me.json"),
    JSON.stringify({
      id: "me",
      name: "Edwin",
      default: true,
      atlassian: { email: "edwin@example.com", apiToken: "atl-tok" },
      github: { token: "gh-tok" },
    }),
  );
  const [user] = await loadUsersFromDir(dir);
  assert.equal(user!.connectors?.length, 2);
  const atlassian = user!.connectors!.find((c) => c.vendorId === "atlassian");
  const github = user!.connectors!.find((c) => c.vendorId === "github");
  assert.equal(atlassian?.label, "default");
  assert.equal(atlassian?.fields.email, "edwin@example.com");
  assert.equal(atlassian?.fields.apiToken, "atl-tok");
  assert.equal(github?.label, "default");
  assert.equal(github?.fields.token, "gh-tok");
  assert.ok(atlassian?.id && github?.id && atlassian.id !== github.id, "each gets its own generated id");
  // The legacy fields must not survive onto the in-memory User.
  assert.equal((user as unknown as { atlassian?: unknown }).atlassian, undefined);
});

test("loadUsersFromDir: a legacy user's connector ids are stable across repeated loads of the same file (no re-migration drift)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "users-legacy-stable-"));
  await writeFile(
    join(dir, "me.json"),
    JSON.stringify({
      id: "me",
      name: "Edwin",
      default: true,
      atlassian: { email: "edwin@example.com", apiToken: "atl-tok" },
      github: { token: "gh-tok" },
    }),
  );
  const [first] = await loadUsersFromDir(dir);
  const [second] = await loadUsersFromDir(dir);
  const firstAtlassian = first!.connectors!.find((c) => c.vendorId === "atlassian")!;
  const firstGithub = first!.connectors!.find((c) => c.vendorId === "github")!;
  const secondAtlassian = second!.connectors!.find((c) => c.vendorId === "atlassian")!;
  const secondGithub = second!.connectors!.find((c) => c.vendorId === "github")!;
  assert.equal(firstAtlassian.id, secondAtlassian.id, "atlassian connector id must be identical across separate loads");
  assert.equal(firstGithub.id, secondGithub.id, "github connector id must be identical across separate loads");
});

test("loadUsersFromDir: a legacy user with only atlassian (no github) upgrades to exactly one connector", async () => {
  const dir = await mkdtemp(join(tmpdir(), "users-legacy-partial-"));
  await writeFile(
    join(dir, "me.json"),
    JSON.stringify({ id: "me", name: "Edwin", atlassian: { email: "e@x.com", apiToken: "tok" } }),
  );
  const [user] = await loadUsersFromDir(dir);
  assert.equal(user!.connectors?.length, 1);
  assert.equal(user!.connectors![0]!.vendorId, "atlassian");
});

test("loadUsersFromDir: a user with no legacy fields and no connectors loads with connectors undefined, no crash", async () => {
  const dir = await mkdtemp(join(tmpdir(), "users-blank-"));
  await writeFile(join(dir, "me.json"), JSON.stringify({ id: "me", name: "Edwin" }));
  const [user] = await loadUsersFromDir(dir);
  assert.equal(user!.connectors, undefined);
});

test("loadUsersFromDir: an already-migrated user (has connectors) is passed through untouched, even if stray legacy keys are also present", async () => {
  const dir = await mkdtemp(join(tmpdir(), "users-already-"));
  await writeFile(
    join(dir, "me.json"),
    JSON.stringify({
      id: "me",
      name: "Edwin",
      connectors: [{ id: "c1", vendorId: "github", label: "personal", fields: { token: "tok" } }],
      github: { token: "stray-legacy-value" }, // must be ignored, not merged in again
    }),
  );
  const [user] = await loadUsersFromDir(dir);
  assert.equal(user!.connectors?.length, 1);
  assert.equal(user!.connectors![0]!.fields.token, "tok");
});

test("round-trip: saving a migrated user and reloading it produces the identical connectors array (no re-migration, no drift)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "users-roundtrip-"));
  const instance = { id: "abc-123", vendorId: "github", label: "acme-corp", fields: { token: "gh-tok" } };
  await saveUser(dir, { id: "me", name: "Edwin", default: true, connectors: [instance] });
  const [reloaded] = await loadUsersFromDir(dir);
  assert.deepEqual(reloaded!.connectors, [instance]);
});

test("saveUser: still writes with owner-only permissions (0o700 dir, 0o600 file) — unchanged by this task", async () => {
  const dir = await mkdtemp(join(tmpdir(), "users-perms-"));
  await saveUser(dir, { id: "me", name: "Edwin", connectors: [] });
  const { stat } = await import("node:fs/promises");
  const fileStat = await stat(join(dir, "me.json"));
  assert.equal(fileStat.mode & 0o777, 0o600);
});

test("resolveCurrentUser: unchanged behavior — default-flagged user, else sole file, else null", () => {
  const a = { id: "a", name: "A", connectors: [] };
  const b = { id: "b", name: "B", default: true, connectors: [] };
  assert.equal(resolveCurrentUser([a, b]), b);
  assert.equal(resolveCurrentUser([a]), a);
  assert.equal(resolveCurrentUser([]), null);
});

test("saveUser encrypts secret fields on disk; loadUsersFromDir decrypts them in memory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "users-enc-"));
  await saveUser(dir, {
    id: "me",
    name: "You",
    default: true,
    connectors: [{ id: "c1", vendorId: "github", label: "personal", fields: { token: "ghp_raw" } }],
  });
  const onDisk = JSON.parse(await readFile(join(dir, "me.json"), "utf8"));
  assert.ok(String(onDisk.connectors[0].fields.token).startsWith(ENC_PREFIX), "secret must be encrypted at rest");
  const [user] = await loadUsersFromDir(dir);
  assert.equal(user!.connectors![0]!.fields.token, "ghp_raw"); // decrypted in memory
});

test("non-secret fields stay plaintext on disk (files remain inspectable)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "users-enc-"));
  await saveUser(dir, {
    id: "me",
    name: "You",
    default: true,
    connectors: [{ id: "c1", vendorId: "atlassian", label: "acme", fields: { email: "e@a.com", apiToken: "tok" } }],
  });
  const onDisk = JSON.parse(await readFile(join(dir, "me.json"), "utf8"));
  assert.equal(onDisk.connectors[0].fields.email, "e@a.com");
  assert.ok(String(onDisk.connectors[0].fields.apiToken).startsWith(ENC_PREFIX));
});

test("sweepEncryptUsers: rewrites a plaintext legacy file once, then is a no-op", async () => {
  const dir = await mkdtemp(join(tmpdir(), "users-sweep-"));
  const fh = await open(join(dir, "me.json"), "w", 0o600); // hand-written plaintext file, as upgrades find it
  await fh.writeFile(
    JSON.stringify({
      id: "me",
      name: "You",
      default: true,
      connectors: [{ id: "c1", vendorId: "github", label: "personal", fields: { token: "ghp_plain" } }],
    }),
  );
  await fh.close();
  assert.equal(await sweepEncryptUsers(dir), 1);
  const onDisk = JSON.parse(await readFile(join(dir, "me.json"), "utf8"));
  assert.ok(String(onDisk.connectors[0].fields.token).startsWith(ENC_PREFIX));
  assert.equal(await sweepEncryptUsers(dir), 0); // already encrypted → untouched
  const [user] = await loadUsersFromDir(dir);
  assert.equal(user!.connectors![0]!.fields.token, "ghp_plain");
});

test("sweepEncryptUsers: a corrupt file is skipped, not thrown — the valid sibling still gets encrypted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "users-sweep-corrupt-"));
  await writeFile(join(dir, "broken.json"), "{ not valid json", "utf8"); // malformed JSON
  await writeFile(join(dir, "bad-shape.json"), JSON.stringify({ connectors: [] }), "utf8"); // parses, fails assertUser (no id/name)
  const fh = await open(join(dir, "ok.json"), "w", 0o600);
  await fh.writeFile(
    JSON.stringify({
      id: "ok",
      name: "You",
      default: true,
      connectors: [{ id: "c1", vendorId: "github", label: "personal", fields: { token: "ghp_plain" } }],
    }),
  );
  await fh.close();

  // Boot-time contract (spec: degrade-never-crash): neither corrupt file
  // throws out of the sweep, and the valid file is still processed.
  assert.equal(await sweepEncryptUsers(dir), 1);
  const onDisk = JSON.parse(await readFile(join(dir, "ok.json"), "utf8"));
  assert.ok(String(onDisk.connectors[0].fields.token).startsWith(ENC_PREFIX));
});

test("a value that fails to decrypt is passed through as-is (connected-but-failing-verify, spec §3), not a crash", async () => {
  const dir = await mkdtemp(join(tmpdir(), "users-badkey-"));
  await saveUser(dir, {
    id: "me",
    name: "You",
    default: true,
    connectors: [{ id: "c1", vendorId: "github", label: "personal", fields: { token: "ghp_raw" } }],
  });
  process.env.SMITH_MASTER_KEY = randomBytes(32).toString("hex"); // key rotated out from under the file
  const [user] = await loadUsersFromDir(dir);
  assert.ok(String(user!.connectors![0]!.fields.token).startsWith(ENC_PREFIX)); // ciphertext passthrough
  process.env.SMITH_MASTER_KEY = MASTER_HEX; // restore the file-wide key for any test that runs after this one
});

test("loadUsersFromDir: legacy voice.hideInactive is dropped and enabled derived — on only when BOTH slots were set", async () => {
  const dir = await mkdtemp(join(tmpdir(), "users-voice-migrate-"));
  await writeFile(
    join(dir, "both.json"),
    JSON.stringify({
      id: "both",
      name: "Both",
      default: true,
      connectors: [],
      voice: { stt: { instanceId: "a" }, tts: { instanceId: "b" }, hideInactive: true },
    }),
  );
  await writeFile(
    join(dir, "one.json"),
    JSON.stringify({
      id: "one",
      name: "One",
      connectors: [],
      voice: { stt: { instanceId: "a" }, hideInactive: false },
    }),
  );
  const users = await loadUsersFromDir(dir);
  const both = users.find((u) => u.id === "both");
  const one = users.find((u) => u.id === "one");
  assert.equal(both?.voice?.enabled, true, "both slots configured → migrates enabled (voice kept working)");
  assert.equal(one?.voice?.enabled, false, "one slot → cannot be enabled");
  for (const u of [both, one]) {
    assert.equal(u?.voice?.hideInactive, undefined, "legacy field must not survive onto the in-memory User");
  }
});

test("loadUsersFromDir: an explicit voice.enabled survives load untouched (no re-derive on already-migrated records)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "users-voice-stable-"));
  await writeFile(
    join(dir, "me.json"),
    JSON.stringify({
      id: "me",
      name: "Me",
      default: true,
      connectors: [],
      voice: { stt: { instanceId: "a" }, tts: { instanceId: "b" }, enabled: false },
    }),
  );
  const [user] = await loadUsersFromDir(dir);
  assert.equal(user!.voice?.enabled, false, "a user who turned Voice Mode off stays off despite both slots being set");
});
