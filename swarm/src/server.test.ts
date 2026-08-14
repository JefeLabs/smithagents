// Unit tests for server.ts's pure/extracted route helpers — mirrors
// agents.test.ts's approach (import the exported helper straight from
// server.js) rather than booting the full OrchestratorServer, which has real
// filesystem side effects.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import type { WorkspaceChannels } from "./channels.js";
import {
  buildCardAgendaPatch,
  buildChannelsUpdate,
  buildConnectorFields,
  buildConnectorUpdate,
  buildUserUpdate,
  buildVoiceUpdate,
  clearVoiceReferences,
  gitInitRequestedRepos,
  redactConnector,
  resolveAtlassianConnector,
  resolveCloseBy,
  resolveConnector,
  resolveTaskRuntime,
  resolveVoiceKeys,
  runJiraSearch,
  workspaceProblems,
} from "./server.js";
import type { ConnectorInstance, User } from "./users.js";
import { loadUsersFromDir, saveUser } from "./users.js";
import { addCard, createBoard } from "./work-items.js";
import type { Workspace } from "./workspaces.js";
import { isGitRepo } from "./workspaces.js";

const git = promisify(execFile);

// redactUser (the /me and /me/connectors response shaper) is a closure
// nested inside OrchestratorServer.registerRoutes, which is only ever called
// from start() right before app.listen() — this file's own header comment
// explains why it avoids booting the full OrchestratorServer (real
// filesystem/tmux/dispatcher side effects), and no lighter route-boot
// harness exists anywhere in this package's test suite (confirmed: no
// test file constructs OrchestratorServer or calls app.inject). So this
// exercises redactUser's actual behavior through redactConnector — the
// exported, module-level piece it delegates to for every connector in the
// list — which is the closest faithful substitute available without
// inventing a new harness. The route wiring (GET /me, GET /me/connectors)
// was verified by direct code inspection against the brief's spec instead.
test("redactConnector: secret fields become has<Field> booleans, non-secret fields keep their real value, never the raw secret", async () => {
  const dir = await mkdtemp(join(tmpdir(), "users-"));
  const instance: ConnectorInstance = {
    id: "c1",
    vendorId: "atlassian",
    label: "acme",
    fields: { email: "edwin@acme.com", apiToken: "super-secret-token" },
  };
  await saveUser(dir, { id: "edwin", name: "Edwin", default: true, connectors: [instance] });

  const [reloaded] = await loadUsersFromDir(dir);
  const redacted = redactConnector(reloaded!.connectors![0]!);

  assert.equal(redacted.id, "c1");
  assert.equal(redacted.vendorId, "atlassian");
  assert.equal(redacted.label, "acme");
  // Non-secret field: real value passes through.
  assert.deepEqual((redacted.fields as Record<string, unknown>).email, "edwin@acme.com");
  // Secret field: boolean presence flag, never the raw token.
  assert.equal((redacted.fields as Record<string, unknown>).hasApiToken, true);
  assert.equal(JSON.stringify(redacted).includes("super-secret-token"), false);
});

test("runJiraSearch resolves the connector then searches; a resolve error is a 400", async () => {
  const ok = await runJiraSearch(
    () => ({ email: "e@x.com", apiToken: "tok" }),
    { connectorId: "atl-1", siteUrl: "https://acme.atlassian.net", jql: "project = PROJ" },
    async () => [{ key: "PROJ-1", summary: "s", url: "u" }],
  );
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.payload, { issues: [{ key: "PROJ-1", summary: "s", url: "u" }] });

  const bad = await runJiraSearch(
    () => ({ error: "no such connector" }),
    { connectorId: "x", siteUrl: "https://a", jql: "j" },
    async () => [],
  );
  assert.equal(bad.status, 400);

  const missing = await runJiraSearch(
    () => ({ email: "e", apiToken: "t" }),
    { jql: "j" },
    async () => [],
  );
  assert.equal(missing.status, 400);
});

test("buildConnectorFields: POST /me/connectors — an unknown/extra field key is dropped, only registry-declared keys persist", () => {
  const result = buildConnectorFields("github", { token: "gh-tok", notARealField: "garbage" });
  assert.deepEqual(result, { token: "gh-tok" });
});

test("buildConnectorFields: an unknown vendorId (already rejected upstream by the route, but defensively) yields no fields", () => {
  const result = buildConnectorFields("not-a-real-vendor", { token: "x" });
  assert.deepEqual(result, {});
});

test("buildConnectorFields: fields undefined (nothing submitted) yields an empty object, not a crash", () => {
  const result = buildConnectorFields("github", undefined);
  assert.deepEqual(result, {});
});

test("buildConnectorUpdate: a blank submitted secret field falls back to the existing stored value", () => {
  const existing: ConnectorInstance = { id: "c1", vendorId: "github", label: "personal", fields: { token: "old-tok" } };
  const merged = buildConnectorUpdate(existing, { fields: { token: "" } });
  assert.equal(merged.fields.token, "old-tok");
});

test("buildConnectorUpdate: a non-blank submitted field overrides the existing value", () => {
  const existing: ConnectorInstance = { id: "c1", vendorId: "github", label: "personal", fields: { token: "old-tok" } };
  const merged = buildConnectorUpdate(existing, { fields: { token: "new-tok" } });
  assert.equal(merged.fields.token, "new-tok");
});

test("buildConnectorUpdate: omitting fields entirely leaves all existing fields untouched, only label changes", () => {
  const existing: ConnectorInstance = {
    id: "c1",
    vendorId: "datadog",
    label: "old-label",
    fields: { site: "us1", apiKey: "k", appKey: "a" },
  };
  const merged = buildConnectorUpdate(existing, { label: "new-label" });
  assert.equal(merged.label, "new-label");
  assert.deepEqual(merged.fields, { site: "us1", apiKey: "k", appKey: "a" });
});

test("buildConnectorUpdate: vendorId is immutable — even if the caller sends one, it never changes", () => {
  const existing: ConnectorInstance = { id: "c1", vendorId: "github", label: "x", fields: { token: "t" } };
  const merged = buildConnectorUpdate(existing, { fields: {} } as {
    label?: string;
    fields?: Record<string, string>;
  } & {
    vendorId?: string;
  });
  assert.equal(merged.vendorId, "github");
});

test("buildConnectorUpdate: applies trim-then-fallback uniformly to a non-secret field too (site/region), not just secrets", () => {
  const existing: ConnectorInstance = {
    id: "c1",
    vendorId: "datadog",
    label: "x",
    fields: { site: "us1", apiKey: "k", appKey: "a" },
  };
  const merged = buildConnectorUpdate(existing, { fields: { site: "  ", apiKey: "k", appKey: "a" } });
  assert.equal(merged.fields.site, "us1"); // blank (whitespace-only) submission falls back, doesn't wipe
});

test('resolveConnector: no connectorId set (undefined) returns the "pick a connector first" error, not a match', () => {
  const user: User = {
    id: "edwin",
    name: "Edwin",
    connectors: [{ id: "c1", vendorId: "atlassian", label: "x", fields: {} }],
  };
  const resolved = resolveConnector(undefined, "atlassian", "an Atlassian", "workspace", user);
  assert.deepEqual(resolved, { error: "Pick an Atlassian connector for this workspace first" });
});

test('resolveConnector: a connectorId with no matching instance at all returns the "no longer exists" error', () => {
  const user: User = {
    id: "edwin",
    name: "Edwin",
    connectors: [{ id: "c1", vendorId: "atlassian", label: "x", fields: {} }],
  };
  const resolved = resolveConnector("does-not-exist", "atlassian", "an Atlassian", "workspace", user);
  assert.deepEqual(resolved, { error: "The connector picked for this workspace no longer exists — pick another" });
});

test("resolveConnector: a connectorId matching an instance of the WRONG vendor is treated as not found, not returned", () => {
  const user: User = {
    id: "edwin",
    name: "Edwin",
    connectors: [{ id: "c1", vendorId: "github", label: "x", fields: { token: "t" } }],
  };
  // c1 exists, but as a github connector — asking for it scoped to 'atlassian' must not cross-match.
  const resolved = resolveConnector("c1", "atlassian", "an Atlassian", "workspace", user);
  assert.deepEqual(resolved, { error: "The connector picked for this workspace no longer exists — pick another" });
});

test("resolveConnector: a connectorId matching a same-vendor instance returns it", () => {
  const instance: ConnectorInstance = {
    id: "c1",
    vendorId: "atlassian",
    label: "acme",
    fields: { email: "e", apiToken: "t" },
  };
  const user: User = { id: "edwin", name: "Edwin", connectors: [instance] };
  const resolved = resolveConnector("c1", "atlassian", "an Atlassian", "workspace", user);
  assert.deepEqual(resolved, { instance });
});

test("resolveConnector: a null user (no current user resolved at all) is treated the same as no matching connector", () => {
  const resolved = resolveConnector("c1", "atlassian", "an Atlassian", "workspace", null);
  assert.deepEqual(resolved, { error: "The connector picked for this workspace no longer exists — pick another" });
});

// Regression coverage for fix round 2: resolveAtlassianConnector backs both
// lookup-ticket and search-docs, and its whole reason to exist is enforcing
// that the connector guard is checked BEFORE the route's own required-field
// check — the exact order the resolveConnector extraction accidentally
// inverted in both routes (caught only by manual review, not a test).
test("resolveAtlassianConnector: invalid on BOTH axes at once (no connectorId AND missing required field) returns the connector error, not the missing-field error", () => {
  const resolved = resolveAtlassianConnector(undefined, null, { name: "ticketKey", value: undefined });
  assert.deepEqual(resolved, { error: "Pick an Atlassian connector for this workspace first" });
});

test("resolveAtlassianConnector: a resolvable connector but a missing required field still reports the missing-field error", () => {
  const instance: ConnectorInstance = {
    id: "c1",
    vendorId: "atlassian",
    label: "acme",
    fields: { email: "e", apiToken: "t" },
  };
  const user: User = { id: "edwin", name: "Edwin", connectors: [instance] };
  const resolved = resolveAtlassianConnector("c1", user, { name: "ticketKey", value: undefined });
  assert.deepEqual(resolved, { error: "Missing required field: ticketKey" });
});

test("resolveAtlassianConnector: both a resolvable connector and a present required field returns the instance", () => {
  const instance: ConnectorInstance = {
    id: "c1",
    vendorId: "atlassian",
    label: "acme",
    fields: { email: "e", apiToken: "t" },
  };
  const user: User = { id: "edwin", name: "Edwin", connectors: [instance] };
  const resolved = resolveAtlassianConnector("c1", user, { name: "ticketKey", value: "PROJ-123" });
  assert.deepEqual(resolved, { instance, field: "PROJ-123" });
});

test("workspaceProblems: rejects an atlassian block with no site URL, accepts one with", async () => {
  const repoDir = await mkdtemp(join(tmpdir(), "ws-git-"));
  await git("git", ["init", "-q"], { cwd: repoDir });
  const base: Partial<Workspace> = { name: "acme", repos: [{ name: "web", path: repoDir }] };

  const missing = await workspaceProblems({ ...base, atlassian: { siteUrl: "" } });
  assert.match(missing ?? "", /site URL/);

  const ok = await workspaceProblems({ ...base, atlassian: { siteUrl: "https://acme.atlassian.net" } });
  assert.equal(ok, null);
});

test("buildChannelsUpdate: a submitted discord block replaces the existing one wholesale (no partial-field merge needed — unlike User.atlassian, there is only one credential field, botToken, so there is no sibling-field-blanking risk to guard against)", () => {
  const existing = { discord: { botToken: "old-tok", textChannels: ["1"], voiceChannels: [] } };
  const merged = buildChannelsUpdate(existing, {
    discord: { botToken: "new-tok", textChannels: ["1", "2"], voiceChannels: ["9"] },
  });
  assert.deepEqual(merged, { discord: { botToken: "new-tok", textChannels: ["1", "2"], voiceChannels: ["9"] } });
});

test("buildChannelsUpdate: omitting discord in the submitted body preserves the existing config", () => {
  const existing = { discord: { botToken: "old-tok", textChannels: ["1"], voiceChannels: [] } };
  const merged = buildChannelsUpdate(existing, {});
  assert.deepEqual(merged, existing);
});

test("buildChannelsUpdate: no existing config and no submitted discord block yields an empty config", () => {
  assert.deepEqual(buildChannelsUpdate(null, {}), {});
});

test("buildChannelsUpdate: an empty submitted botToken preserves the existing token, only channel lists update", () => {
  const existing = { discord: { botToken: "saved-tok", textChannels: ["1"], voiceChannels: [] } };
  const merged = buildChannelsUpdate(existing, {
    discord: { botToken: "", textChannels: ["1", "2"], voiceChannels: ["9"] },
  });
  assert.deepEqual(merged, { discord: { botToken: "saved-tok", textChannels: ["1", "2"], voiceChannels: ["9"] } });
});

test("buildChannelsUpdate: no existing token and an empty submitted botToken yields an empty-string token, not a crash", () => {
  const merged = buildChannelsUpdate(null, { discord: { botToken: "", textChannels: ["1"], voiceChannels: [] } });
  assert.deepEqual(merged, { discord: { botToken: "", textChannels: ["1"], voiceChannels: [] } });
});

test('buildChannelsUpdate: a submission that omits both channel lists (e.g. {"discord":{"botToken":"x"}}) falls back to the existing lists rather than persisting undefined', () => {
  const existing = { discord: { botToken: "old-tok", textChannels: ["1"], voiceChannels: ["9"] } };
  const merged = buildChannelsUpdate(existing, { discord: { botToken: "new-tok" } } as Partial<WorkspaceChannels>);
  assert.deepEqual(merged, { discord: { botToken: "new-tok", textChannels: ["1"], voiceChannels: ["9"] } });
});

test("buildChannelsUpdate: omitting both lists with no existing config falls back to empty arrays, not undefined", () => {
  const merged = buildChannelsUpdate(null, { discord: { botToken: "tok" } } as Partial<WorkspaceChannels>);
  assert.deepEqual(merged, { discord: { botToken: "tok", textChannels: [], voiceChannels: [] } });
});

test("buildChannelsUpdate: omitting only voiceChannels preserves the existing voice list while textChannels updates", () => {
  const existing = { discord: { botToken: "tok", textChannels: ["1"], voiceChannels: ["9"] } };
  const merged = buildChannelsUpdate(existing, {
    discord: { botToken: "tok", textChannels: ["2", "3"] },
  } as Partial<WorkspaceChannels>);
  assert.deepEqual(merged, { discord: { botToken: "tok", textChannels: ["2", "3"], voiceChannels: ["9"] } });
});

test("workspaceProblems: rejects a repo github block missing owner or repo, accepts a complete one", async () => {
  const repoDir = await mkdtemp(join(tmpdir(), "ws-git-"));
  await git("git", ["init", "-q"], { cwd: repoDir });

  const missing = await workspaceProblems({
    name: "acme",
    repos: [{ name: "web", path: repoDir, github: { owner: "acme", repo: "" } }],
  });
  assert.match(missing ?? "", /GitHub owner and repo/);

  const ok = await workspaceProblems({
    name: "acme",
    repos: [{ name: "web", path: repoDir, github: { owner: "acme", repo: "web" } }],
  });
  assert.equal(ok, null);
});

test("workspaceProblems: a connectorId on atlassian or repo.github is ignored entirely — never inspected, never rejected", async () => {
  const repoDir = await mkdtemp(join(tmpdir(), "ws-git-"));
  await git("git", ["init", "-q"], { cwd: repoDir });

  const ok = await workspaceProblems({
    name: "acme",
    repos: [{ name: "web", path: repoDir, github: { owner: "acme", repo: "web", connectorId: "c1" } }],
    atlassian: { siteUrl: "https://acme.atlassian.net", connectorId: "c2" },
  });
  assert.equal(ok, null);
});

test("workspaceProblems: links must be an array of strings when present", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ws-links-"));
  await git("git", ["init"], { cwd: dir });
  const base = { name: "acme", repos: [{ name: "web", path: dir }] } as Partial<Workspace>;
  assert.equal(await workspaceProblems({ ...base, links: ["https://a", "https://b"] }), null);
  assert.match((await workspaceProblems({ ...base, links: "nope" as never })) ?? "", /links/);
});

// POST /workspaces/:name/verify-atlassian's two new 400-guard branches (no
// connectorId set; connectorId set but no matching connector in
// user.connectors) are NOT covered by a route-level test here. Every other
// test in this file exercises server.ts's extracted, module-level pure
// functions (workspaceProblems, buildConnectorUpdate, buildChannelsUpdate,
// redactConnector) rather than booting OrchestratorServer — this file's own
// header comment explains why (real filesystem/tmux/dispatcher side
// effects), and registerRoutes() (where these two branches live) is only
// ever invoked from start(), immediately before app.listen() — there is no
// lighter-weight route-boot harness anywhere in this package's test suite to
// match (confirmed: grepped every *.test.ts in src/ for OrchestratorServer
// construction or Fastify .inject usage — none exists). Rather than invent a
// new harness for this task alone, the two branches were verified by direct
// code inspection against the brief's specified "after" snippet (exact
// match) instead. Flagged here for visibility rather than silently omitted.

test("gitInitRequestedRepos: inits only flagged non-repo paths, leaves existing repos alone, reports unusable paths", async () => {
  const fresh = await mkdtemp(join(tmpdir(), "nw-fresh-"));
  const existing = await mkdtemp(join(tmpdir(), "nw-existing-"));
  await git("git", ["init"], { cwd: existing });
  assert.equal(
    await gitInitRequestedRepos([
      { name: "a", path: fresh, initGit: true },
      { name: "b", path: existing, initGit: true },
      { name: "c", path: join(fresh, "never-flagged") },
    ]),
    null,
  );
  assert.equal(await isGitRepo(fresh), true);
  assert.equal(await isGitRepo(existing), true);
  const missing = join(fresh, "no-such-dir", "deeper");
  assert.match((await gitInitRequestedRepos([{ name: "x", path: missing, initGit: true }]))!, /git init failed/);
});

test("resolveTaskRuntime: manifest wins, else server default — no workspace clause", () => {
  assert.equal(resolveTaskRuntime("docker", "tmux").runtime, "docker");
  assert.equal(resolveTaskRuntime(undefined, "tmux").runtime, "tmux");
});

test('resolveTaskRuntime: remote-* runtimes map to location "remote"', () => {
  assert.equal(resolveTaskRuntime("remote-tmux", "tmux").location, "remote");
  assert.equal(resolveTaskRuntime("remote-docker", "tmux").location, "remote");
  assert.equal(resolveTaskRuntime("remote", "tmux").location, "remote");
  assert.equal(resolveTaskRuntime("docker", "tmux").location, "docker");
  assert.equal(resolveTaskRuntime("tmux", "docker").location, "local");
});

test("buildUserUpdate: renaming the operator carries connectors and voice forward untouched", () => {
  const existing: User = {
    id: "me",
    name: "Old Name",
    default: true,
    connectors: [{ id: "c1", vendorId: "github", label: "personal", fields: { token: "ghp" } }],
    voice: { stt: { instanceId: "dg1" }, hideInactive: true },
  };
  const r = buildUserUpdate(existing, { name: "New Name" });
  assert.equal(r.name, "New Name");
  assert.deepEqual(r.connectors, existing.connectors);
  assert.deepEqual(r.voice, existing.voice); // the regression this guards: voice used to be dropped here
});

test('buildUserUpdate: no existing user → defaults id "me"/name "You", no voice', () => {
  assert.deepEqual(buildUserUpdate(null, {}), {
    id: "me",
    name: "You",
    default: true,
    connectors: undefined,
    voice: undefined,
  });
});

test('buildUserUpdate: blank submitted name falls back to the existing name (not "You")', () => {
  const existing: User = { id: "me", name: "Keep Me", default: true };
  assert.equal(buildUserUpdate(existing, { name: "  " }).name, "Keep Me");
});

const voiceUser: User = {
  id: "me",
  name: "You",
  default: true,
  connectors: [
    { id: "dg1", vendorId: "deepgram", label: "personal", fields: { apiKey: "dg-key" } },
    { id: "el1", vendorId: "elevenlabs", label: "personal", fields: { apiKey: "el-key" } },
    { id: "gh1", vendorId: "github", label: "personal", fields: { token: "ghp" } },
  ],
};

test("buildVoiceUpdate: both slots assigned + enabled:true → Voice Mode on", () => {
  const r = buildVoiceUpdate(voiceUser, { stt: { instanceId: "dg1" }, tts: { instanceId: "el1" }, enabled: true });
  assert.deepEqual(r, { voice: { stt: { instanceId: "dg1" }, tts: { instanceId: "el1" }, enabled: true } });
});

test("buildVoiceUpdate: enabled:true with a missing slot is coerced off, not an error (server-enforced gate)", () => {
  const r = buildVoiceUpdate(voiceUser, { stt: { instanceId: "dg1" }, tts: null, enabled: true });
  assert.deepEqual(r, { voice: { stt: { instanceId: "dg1" }, enabled: false } });
});

test("buildVoiceUpdate: null slots clear; omitted enabled defaults off", () => {
  const r = buildVoiceUpdate(voiceUser, { stt: null, tts: null });
  assert.deepEqual(r, { voice: { enabled: false } });
});

test("buildVoiceUpdate: enabling is explicit — both slots set with enabled omitted stays off", () => {
  const r = buildVoiceUpdate(voiceUser, { stt: { instanceId: "dg1" }, tts: { instanceId: "el1" } });
  assert.deepEqual(r, { voice: { stt: { instanceId: "dg1" }, tts: { instanceId: "el1" }, enabled: false } });
});

test("buildVoiceUpdate: unknown instance id → error", () => {
  const r = buildVoiceUpdate(voiceUser, { stt: { instanceId: "nope" }, tts: null });
  assert.ok("error" in r && /nope/.test(r.error));
});

test("buildVoiceUpdate: wrong-capability instance rejected (github can neither hear nor speak; elevenlabs cannot do STT in v1)", () => {
  for (const instanceId of ["gh1", "el1"]) {
    const r = buildVoiceUpdate(voiceUser, { stt: { instanceId }, tts: null });
    assert.ok("error" in r, `expected error for stt=${instanceId}`);
  }
});

test("clearVoiceReferences: deleting a selected instance clears that slot AND forces Voice Mode off", () => {
  const voice = { stt: { instanceId: "dg1" }, tts: { instanceId: "el1" }, enabled: true };
  assert.deepEqual(clearVoiceReferences(voice, "dg1"), { tts: { instanceId: "el1" }, enabled: false });
  assert.deepEqual(clearVoiceReferences(voice, "other"), voice);
  assert.equal(clearVoiceReferences(undefined, "dg1"), undefined);
});

test("resolveVoiceKeys: resolves selected slots to raw keys; unset/dangling/empty → null per slot", () => {
  assert.deepEqual(
    resolveVoiceKeys({ ...voiceUser, voice: { stt: { instanceId: "dg1" }, tts: { instanceId: "el1" } } }),
    {
      stt: { vendorId: "deepgram", apiKey: "dg-key" },
      tts: { vendorId: "elevenlabs", apiKey: "el-key" },
    },
  );
  assert.deepEqual(resolveVoiceKeys({ ...voiceUser, voice: { stt: { instanceId: "gone" } } }), {
    stt: null,
    tts: null,
  });
  assert.deepEqual(resolveVoiceKeys(null), { stt: null, tts: null });
});

test("buildCardAgendaPatch: grab claims, state flips, null releases", () => {
  const b = createBoard("deliver", "ws");
  const c = addCard(b, { title: "auth", columnId: "review" });
  buildCardAgendaPatch(c, "edwin", { action: "grab" }, "2026-08-13T10:00:00.000Z");
  assert.equal(c.agenda?.by, "edwin");
  buildCardAgendaPatch(c, "edwin", { state: "today", intent: "chasing the flaky suite" }, "2026-08-13T11:00:00.000Z");
  assert.equal(c.agenda?.state, "today");
  buildCardAgendaPatch(c, "edwin", null, "2026-08-13T12:00:00.000Z");
  assert.equal(c.agenda, undefined);
});

test("buildCardAgendaPatch refuses to flip a card held by someone else", () => {
  const b = createBoard("deliver", "ws");
  const c = addCard(b, { title: "auth", columnId: "review" });
  buildCardAgendaPatch(c, "ana", { action: "grab" }, "2026-08-13T10:00:00.000Z");
  assert.throws(() => buildCardAgendaPatch(c, "edwin", { state: "today" }, "2026-08-13T11:00:00.000Z"), /not held by/);
});

test("resolveCloseBy overwrites a client-supplied by, never falls back to it", () => {
  // A softened `close.by ?? userId` would keep "attacker" here, since ?? only
  // falls through on null/undefined, not on a truthy client-supplied string.
  // Asserting "edwin" specifically (not just "not attacker") is what pins
  // this to a stomp instead of a fallback.
  const result = resolveCloseBy({ by: "attacker", text: "done" }, "edwin");
  assert.equal(result?.by, "edwin");
});

test("resolveCloseBy: no current user resolved falls back to an empty by, not undefined", () => {
  const result = resolveCloseBy({ by: "attacker", text: "done" }, undefined);
  assert.equal(result?.by, "");
});

test("resolveCloseBy: no close in the patch is a no-op", () => {
  assert.equal(resolveCloseBy(undefined, "edwin"), undefined);
});

test("resolveVoiceKeys: a still-encrypted apiKey (lost/rotated master key) resolves null, not the ciphertext", () => {
  const undecryptable: User = {
    ...voiceUser,
    connectors: [{ id: "dg1", vendorId: "deepgram", label: "personal", fields: { apiKey: "enc:v1:iv:ct:tag" } }],
    voice: { stt: { instanceId: "dg1" } },
  };
  assert.deepEqual(resolveVoiceKeys(undecryptable), { stt: null, tts: null });
});
