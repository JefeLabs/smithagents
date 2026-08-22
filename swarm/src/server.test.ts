// Unit tests for server.ts's pure/extracted route helpers — mirrors
// agents.test.ts's approach (import the exported helper straight from
// server.js) rather than booting the full OrchestratorServer, which has real
// filesystem side effects.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import type { WorkspaceChannels } from "./channels.js";
import { makeOrgRepo } from "./org-repo.fixture.js";
import { smithPaths } from "./paths.js";
import { ENGINES } from "./personas.js";
import {
  archiveWorkspaceBoards,
  buildBrainEngineUpdate,
  buildCardAgendaPatch,
  buildChannelsUpdate,
  buildConnectorFields,
  buildConnectorUpdate,
  buildEnginesUpdate,
  buildResearchEngineUpdate,
  buildUserUpdate,
  buildVoiceUpdate,
  buildWorkspaceCreate,
  buildWorkspaceUpdate,
  clearVoiceReferences,
  gitInitRequestedRepos,
  isValidWorkspaceCreateRepos,
  prepareSquadSwarm,
  redactBrainEngine,
  redactConnector,
  redactEngines,
  redactResearchEngine,
  redactUser,
  resolveAtlassianConnector,
  resolveCloseBy,
  resolveConnector,
  resolveTaskRuntime,
  resolveVoiceKeys,
  runJiraSearch,
  workKindForCapability,
  workKindsPayload,
  workspaceProblems,
} from "./server.js";
import { appendUpdate, feedPath, readFeed } from "./squad-feed.js";
import type { ConnectorInstance, User } from "./users.js";
import { loadUsersFromDir, saveUser } from "./users.js";
import { addCard, createBoard } from "./work-items.js";
import type { Workspace } from "./workspaces.js";
import { configDirFor, isGitRepo, repoLessRefusal, saveWorkspace } from "./workspaces.js";

const git = promisify(execFile);

// redactConnector is the piece redactUser (below, exported module-level like
// this one) delegates to for every connector in the list — covered here in
// isolation. The route wiring itself (GET /me, GET /me/connectors) is not
// exercised: this file's own header comment explains why it avoids booting
// the full OrchestratorServer (real filesystem/tmux/dispatcher side
// effects), and no lighter route-boot harness exists anywhere in this
// package's test suite (confirmed: no test file constructs OrchestratorServer
// or calls app.inject). That wiring was verified by direct code inspection
// against the brief's spec instead.
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

test("workspaceProblems: relaxed mode accepts a URL-only repo submitted with an empty path", async () => {
  const origin = await mkdtemp(join(tmpdir(), "ws-origin-"));
  await git("git", ["init", "-q"], { cwd: origin });
  const b: Partial<Workspace> = { name: "pg", repos: [{ name: "app", path: "", repository: origin }] };

  const result = await workspaceProblems(b, { requireLocalRepos: false });

  assert.equal(result, null, "an empty path is legitimate pre-clone, when a repository URL is given");
});

test("workspaceProblems: strict mode still rejects that same URL-only repo — the relaxed pass does not widen the saved-record contract", async () => {
  const origin = await mkdtemp(join(tmpdir(), "ws-origin-strict-"));
  await git("git", ["init", "-q"], { cwd: origin });
  const b: Partial<Workspace> = { name: "pg", repos: [{ name: "app", path: "", repository: origin }] };

  const result = await workspaceProblems(b);

  assert.match(result ?? "", /path must be absolute/, "default (strict) mode is unchanged");
});

test("workspaceProblems: relaxed mode still rejects a non-empty relative path", async () => {
  const b: Partial<Workspace> = {
    name: "pg",
    repos: [{ name: "app", path: "relative/path", repository: "https://example.com/x.git" }],
  };

  const result = await workspaceProblems(b, { requireLocalRepos: false });

  assert.match(result ?? "", /path must be absolute/, "a path that IS given must still be absolute, even relaxed");
});

test("workspaceProblems: rejects a repo name that would escape or collapse onto the workspace directory", async () => {
  // Mirrors repoDirFor's own guard (workspace-repos.ts) — this must 400 here,
  // at the route, rather than reach materializeRepos and surface as an
  // unhandled 500 from repoDirFor.
  const escaping: Partial<Workspace> = {
    name: "pg",
    repos: [{ name: "../../escaped", path: "", repository: "https://example.com/x.git" }],
  };
  const collapsing: Partial<Workspace> = {
    name: "pg",
    repos: [{ name: ".", path: "", repository: "https://example.com/x.git" }],
  };

  const first = await workspaceProblems(escaping, { requireLocalRepos: false });
  const second = await workspaceProblems(collapsing, { requireLocalRepos: false });

  assert.match(first ?? "", /escape/i, "an escaping repo name 400s instead of surfacing later as a 500");
  assert.match(second ?? "", /escape/i, "so does a name that collapses onto the workspace directory itself");
});

test("workKindForCapability: resolves the workspace's own vocabulary — the lookup POST /work/capabilities and its slices/send sibling now share, so a capability-seeded board no longer falls back to product/software regardless of the workspace's choice", () => {
  const workspaces: Workspace[] = [
    { name: "acme", workKind: "marketing", repos: [{ name: "app", path: "/tmp/app" }] },
    { name: "other", repos: [{ name: "app", path: "/tmp/app2" }] },
  ];

  assert.equal(workKindForCapability(workspaces, "acme"), "marketing");
  assert.equal(workKindForCapability(workspaces, "other"), undefined, "no workKind set — falls through to product");
  assert.equal(
    workKindForCapability(workspaces, "no-such-workspace"),
    undefined,
    "an unresolved workspace degrades to product rather than throwing",
  );
});

// buildWorkspaceCreate/buildWorkspaceUpdate are POST/PUT /workspaces' explicit
// field lists, pulled out so a field silently missing from the list (as
// workKind was, final review round Important #3) is a unit-test failure
// rather than a live-install regression: with workKind omitted from the
// literal, every path below asserting it fails, since the built record never
// carries it regardless of what the caller submitted.
test("buildWorkspaceCreate: a submitted workKind is trimmed onto the record; omitting it leaves the field absent", () => {
  const repos = [{ name: "app", path: "/tmp/app" }];

  const withKind = buildWorkspaceCreate("acme", repos, { workKind: "  marketing  " }, []);
  assert.equal(withKind.workKind, "marketing");

  const withoutKind = buildWorkspaceCreate("acme", repos, {}, []);
  assert.equal(withoutKind.workKind, undefined);
});

test("buildWorkspaceUpdate: workKind follows the same undefined-keeps/blank-clears/value-sets rule as description and color", () => {
  const existing: Workspace = {
    name: "acme",
    workKind: "marketing",
    repos: [{ name: "app", path: "/tmp/app" }],
  };

  assert.equal(buildWorkspaceUpdate(existing, {}).workKind, "marketing", "an absent field in the body keeps it");
  assert.equal(
    buildWorkspaceUpdate(existing, { workKind: "  consulting  " }).workKind,
    "consulting",
    "a submitted value is trimmed and replaces it",
  );
  assert.equal(
    buildWorkspaceUpdate(existing, { workKind: "" }).workKind,
    undefined,
    "an explicit blank clears it, same as description/color",
  );
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

// RED evidence for the boards-into-workspaces final fix wave (2026-08-16):
// POST /reset (scope.agents) archives paths.work but never touches any
// workspace's config/boards, so a reset the user explicitly asked for leaves
// every workspace's boards sitting there untouched. archiveWorkspaceBoards is
// the extracted helper that closes this — pulled out of the route handler so
// it's unit-testable without booting the server, same as workspaceProblems above.
test("archiveWorkspaceBoards: renames a workspace's boards to a timestamped sibling, mirroring the host archive", async () => {
  const root = await mkdtemp(join(tmpdir(), "reset-boards-"));
  const paths = smithPaths(root);
  const ws: Workspace = { name: "acme", repos: [{ name: "web", path: root }] };
  const boardsDir = join(configDirFor(paths, ws), "boards");
  await mkdir(boardsDir, { recursive: true });
  await writeFile(join(boardsDir, "acme-plan.json"), "{}");

  const stamp = "20260816T000000";
  await archiveWorkspaceBoards(paths, [ws], stamp);

  await assert.rejects(stat(boardsDir), /ENOENT/);
  assert.equal(await readFile(join(`${boardsDir}-archived-${stamp}`, "acme-plan.json"), "utf8"), "{}");
});

test("archiveWorkspaceBoards: a workspace whose name slugs to nothing is skipped, not a 500 — the sync throw the rename's .catch cannot cover", async () => {
  const root = await mkdtemp(join(tmpdir(), "reset-boards-noslug-"));
  const paths = smithPaths(root);
  // configDirFor throws synchronously on this name, OUTSIDE the rename's
  // .catch — without the skip, POST /reset 500s and no workspace gets
  // archived, not even the healthy one beside it.
  const dots: Workspace = { name: "...", repos: [] };
  const acme: Workspace = { name: "acme", repos: [] };
  const boardsDir = join(configDirFor(paths, acme), "boards");
  await mkdir(boardsDir, { recursive: true });
  await writeFile(join(boardsDir, "acme-plan.json"), "{}");

  await assert.doesNotReject(archiveWorkspaceBoards(paths, [dots, acme], "20260822T000000"));

  await assert.rejects(stat(boardsDir), /ENOENT/, "the healthy workspace beside it was still archived");
});

test("archiveWorkspaceBoards: a workspace with no boards yet is not an error (best-effort, matches the sibling archives)", async () => {
  const root = await mkdtemp(join(tmpdir(), "reset-boards-empty-"));
  const paths = smithPaths(root);
  const ws: Workspace = { name: "fresh", repos: [{ name: "web", path: root }] };
  await assert.doesNotReject(archiveWorkspaceBoards(paths, [ws], "20260816T000000"));
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
  // Was a `deepEqual` against a literal listing `connectors: undefined,
  // voice: undefined` — an artifact of the old allow-list building the object
  // field-by-field. The spread-based rewrite (this task) carries forward only
  // what `existing` actually has, so those keys are simply absent, not
  // present-with-undefined. Node's assert.deepEqual (strict) distinguishes
  // the two, so this pins the new, correct shape instead.
  assert.deepEqual(buildUserUpdate(null, {}), {
    id: "me",
    name: "You",
    default: true,
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

// THE first-run case, and the one the shipped build gets wrong. During the
// welcome wizard nothing is saved yet — `user.voice` is undefined — so a
// resolver that can only read the SAVED slot returns null here and the ▶ Say
// something preview refuses on every first run. Passing the wizard's
// in-progress choice as an override is the whole fix, and a wrong impl that
// ignores `overrides` (or that reads the saved slot first) fails this exact
// assertion while every saved-slot test above still passes.
test("resolveVoiceKeys: a tts override resolves that instance's key while the SAVED slot is unset", () => {
  assert.deepEqual(resolveVoiceKeys({ ...voiceUser, voice: undefined }, { tts: "el1" }), {
    stt: null,
    tts: { vendorId: "elevenlabs", apiKey: "el-key" },
  });
});

// An override that merely agreed with the saved slot would be indistinguishable
// from ignoring it. Here the saved slot points at a DIFFERENT instance, so only
// an implementation that actually prefers the override can answer "el-key".
test("resolveVoiceKeys: a tts override wins over a different saved tts assignment", () => {
  const twoKeys: User = {
    ...voiceUser,
    connectors: [
      ...(voiceUser.connectors ?? []),
      { id: "el2", vendorId: "elevenlabs", label: "spare", fields: { apiKey: "el-key-2" } },
    ],
    voice: { tts: { instanceId: "el2" } },
  };
  assert.deepEqual(resolveVoiceKeys(twoKeys, { tts: "el1" }).tts, { vendorId: "elevenlabs", apiKey: "el-key" });
});

// Never trust the id blind. The override arrives from a browser, and the save
// path's own capability gate (buildVoiceUpdate) has not run on it — without
// this check a GitHub token, or a Deepgram key, would be handed to ElevenLabs
// as a speaking credential. Refusal is null, NOT a quiet fall back to the
// saved slot: a preview that spoke with a key other than the one on screen
// would be worse than one that declines.
test("resolveVoiceKeys: a tts override whose vendor lacks the tts capability resolves null, and does not fall back to the saved slot", () => {
  const saved: User = { ...voiceUser, voice: { tts: { instanceId: "el1" } } };
  for (const instanceId of ["gh1", "dg1"]) {
    assert.equal(resolveVoiceKeys(saved, { tts: instanceId }).tts, null, `expected null for tts=${instanceId}`);
  }
});

test("resolveVoiceKeys: a tts override naming an instance this user does not have resolves null", () => {
  const saved: User = { ...voiceUser, voice: { tts: { instanceId: "el1" } } };
  assert.equal(resolveVoiceKeys(saved, { tts: "someone-elses-instance" }).tts, null);
});

// The override is per-slot: overriding tts must not disturb the stt slot the
// live mic is already listening through.
test("resolveVoiceKeys: a tts override leaves the saved stt slot alone", () => {
  const saved: User = { ...voiceUser, voice: { stt: { instanceId: "dg1" }, tts: { instanceId: "el1" } } };
  assert.deepEqual(resolveVoiceKeys(saved, { tts: "el1" }).stt, { vendorId: "deepgram", apiKey: "dg-key" });
});

test("resolveVoiceKeys: a still-encrypted apiKey (lost/rotated master key) resolves null, not the ciphertext", () => {
  const undecryptable: User = {
    ...voiceUser,
    connectors: [{ id: "dg1", vendorId: "deepgram", label: "personal", fields: { apiKey: "enc:v1:iv:ct:tag" } }],
    voice: { stt: { instanceId: "dg1" } },
  };
  assert.deepEqual(resolveVoiceKeys(undecryptable), { stt: null, tts: null });
});

const ENGINES_FIXTURE = [
  { cli: "claude", label: "Claude Code", models: ["claude-opus", "claude-sonnet"], warmSessions: true },
  { cli: "agy", label: "Antigravity", models: ["default"], warmSessions: false },
  {
    cli: "api:anthropic",
    label: "API — Anthropic",
    models: ["claude-haiku-4-5"],
    warmSessions: false,
    kind: "api" as const,
  },
];
/** Returns '' when the tool may be used, else the human reason — mirrors gateReason. */
const openGate = () => "";
const closedGate = () => "claude is not logged in";

test("buildResearchEngineUpdate accepts a known, active CLI engine", () => {
  const r = buildResearchEngineUpdate({ cli: "agy" }, ENGINES_FIXTURE, openGate);
  assert.deepEqual(r, { researchEngine: { cli: "agy", model: undefined } });
});

test("buildResearchEngineUpdate accepts a model from that engine's list", () => {
  const r = buildResearchEngineUpdate({ cli: "claude", model: "claude-sonnet" }, ENGINES_FIXTURE, openGate);
  assert.deepEqual(r, { researchEngine: { cli: "claude", model: "claude-sonnet" } });
});

test("buildResearchEngineUpdate rejects an unknown cli", () => {
  const r = buildResearchEngineUpdate({ cli: "nope" }, ENGINES_FIXTURE, openGate);
  assert.match((r as { error: string }).error, /Unknown engine/);
});

test("buildResearchEngineUpdate rejects an api-kind engine", () => {
  // Research mode spawns a CLI; an api entry has no binary to run.
  const r = buildResearchEngineUpdate({ cli: "api:anthropic" }, ENGINES_FIXTURE, openGate);
  assert.match((r as { error: string }).error, /not a CLI engine/);
});

test("buildResearchEngineUpdate rejects a CLI whose registry gate is closed", () => {
  const r = buildResearchEngineUpdate({ cli: "claude" }, ENGINES_FIXTURE, closedGate);
  assert.match((r as { error: string }).error, /not logged in/);
});

test("buildResearchEngineUpdate rejects a model the engine does not list", () => {
  const r = buildResearchEngineUpdate({ cli: "agy", model: "gpt-5" }, ENGINES_FIXTURE, openGate);
  assert.match((r as { error: string }).error, /Unknown model/);
});

test("buildResearchEngineUpdate clears the setting on null", () => {
  const r = buildResearchEngineUpdate(null, ENGINES_FIXTURE, openGate);
  assert.deepEqual(r, { researchEngine: undefined });
});

test("each rejection names the check that failed, never a silent coercion", () => {
  const messages = [
    buildResearchEngineUpdate({ cli: "nope" }, ENGINES_FIXTURE, openGate),
    buildResearchEngineUpdate({ cli: "api:anthropic" }, ENGINES_FIXTURE, openGate),
    buildResearchEngineUpdate({ cli: "claude" }, ENGINES_FIXTURE, closedGate),
    buildResearchEngineUpdate({ cli: "agy", model: "gpt-5" }, ENGINES_FIXTURE, openGate),
  ].map((r) => (r as { error: string }).error);
  assert.equal(new Set(messages).size, 4, "four distinct failures need four distinct messages");
});

test("redactResearchEngine: no stored setting -> null", () => {
  assert.equal(redactResearchEngine(null, openGate), null);
});

test("redactResearchEngine: a stored setting whose cli still passes its gate is returned as-is", () => {
  const u: User = { id: "me", name: "You", default: true, researchEngine: { cli: "claude", model: "claude-opus" } };
  assert.deepEqual(redactResearchEngine(u, openGate), { cli: "claude", model: "claude-opus" });
});

test("redactResearchEngine: a stored setting whose cli no longer passes its gate is hidden as null", () => {
  // The write-time gate check (buildResearchEngineUpdate) only stops a BAD
  // choice from being saved — it says nothing about a GOOD choice going bad
  // later (the cli logs out, or gets disabled in the registry). Without a
  // read-time check too, GET keeps handing back a dead cli forever and
  // resolveResearchEngine (broker/src/research-engine.ts) keeps spawning it,
  // failing every research turn instead of degrading to Anthropic.
  const u: User = { id: "me", name: "You", default: true, researchEngine: { cli: "claude" } };
  assert.equal(redactResearchEngine(u, closedGate), null);
});

test("buildBrainEngineUpdate: null clears, cli is gated, local needs a baseUrl", () => {
  const ok = () => "";
  assert.deepEqual(buildBrainEngineUpdate(null, ENGINES, ok), { brainEngine: undefined });

  assert.deepEqual(buildBrainEngineUpdate({ kind: "cli", provider: "claude" }, ENGINES, ok), {
    brainEngine: { kind: "cli", provider: "claude" },
  });

  // A gated CLI is refused with the gate's own reason, like research does.
  const gated = () => "binary not found on PATH";
  assert.deepEqual(buildBrainEngineUpdate({ kind: "cli", provider: "claude" }, ENGINES, gated), {
    error: "binary not found on PATH",
  });

  assert.deepEqual(buildBrainEngineUpdate({ kind: "local", provider: "lmstudio" }, ENGINES, ok), {
    error: "local engines require a baseUrl",
  });

  assert.deepEqual(
    buildBrainEngineUpdate({ kind: "api", provider: "gemini", model: "gemini-flash-latest" }, ENGINES, ok),
    { brainEngine: { kind: "api", provider: "gemini", model: "gemini-flash-latest" } },
  );

  assert.deepEqual(buildBrainEngineUpdate({ kind: "api", provider: "nope" }, ENGINES, ok), {
    error: "Unknown api provider: nope",
  });
});

test("buildBrainEngineUpdate: only claude may be saved as a cli brain — the rest accept --json-schema without enforcing it", () => {
  const ok = () => "";
  assert.deepEqual(buildBrainEngineUpdate({ kind: "cli", provider: "claude" }, ENGINES, ok), {
    brainEngine: { kind: "cli", provider: "claude" },
  });

  for (const provider of ["codex", "opencode", "copilot", "agy"]) {
    const r = buildBrainEngineUpdate({ kind: "cli", provider }, ENGINES, ok);
    assert.ok("error" in r, `expected ${provider} to be refused as a brain`);
    assert.match((r as { error: string }).error, /claude|--json-schema/i);
  }
});

test("redactBrainEngine hides a cli whose gate now fails", () => {
  const u = { id: "me", name: "You", brainEngine: { kind: "cli" as const, provider: "claude" } };
  assert.deepEqual(
    redactBrainEngine(u, () => ""),
    { kind: "cli", provider: "claude" },
  );
  assert.equal(
    redactBrainEngine(u, () => "not installed"),
    null,
  );
});

// ── buildEnginesUpdate / redactEngines ───────────────────────────────
//
// The three engine roles share ONE validated save path. The hazard these
// tests exist for is specific: `buildUserUpdate` SPREADS rather than
// allow-lists, so `quickEngine` and `fallbackEngine` would round-trip
// through PUT /me perfectly while bypassing every allowlist `brainEngine`
// has had since the brain-engine spec — a wrong thing that looks right at
// every step and fails silently rather than loudly.

test("buildEnginesUpdate: every role is gated by the SAME allowlists as the main brain", () => {
  const ok = () => "";
  // Looped over the roles rather than written out for `main` alone: a fourth
  // role added later without a validated path fails here, which is the whole
  // point. A per-role copy of this assertion would pass for whichever roles
  // its author remembered.
  for (const role of ["main", "quick", "fallback"] as const) {
    const cli = buildEnginesUpdate({ [role]: { kind: "cli", provider: "agy" } }, ENGINES, ok);
    assert.ok("error" in cli, `${role}: agy must be refused as a cli engine`);
    assert.match((cli as { error: string }).error, /claude|--json-schema/i, `${role}: refused for the stated reason`);

    const api = buildEnginesUpdate({ [role]: { kind: "api", provider: "openai" } }, ENGINES, ok);
    assert.ok("error" in api, `${role}: openai must be refused as an api engine`);

    const local = buildEnginesUpdate({ [role]: { kind: "local", provider: "lmstudio" } }, ENGINES, ok);
    assert.deepEqual(local, { error: "local engines require a baseUrl" }, `${role}: local needs a baseUrl`);

    const gated = buildEnginesUpdate({ [role]: { kind: "cli", provider: "claude" } }, ENGINES, () => "not logged in");
    assert.deepEqual(gated, { error: "not logged in" }, `${role}: the cli gate applies`);

    const kind = buildEnginesUpdate({ [role]: { kind: "wat", provider: "claude" } }, ENGINES, ok);
    assert.ok("error" in kind, `${role}: an unknown kind must be refused`);
  }
});

test("buildEnginesUpdate: each role writes its own field", () => {
  const ok = () => "";
  assert.deepEqual(buildEnginesUpdate({ main: { kind: "cli", provider: "claude" } }, ENGINES, ok), {
    brainEngine: { kind: "cli", provider: "claude" },
  });
  assert.deepEqual(
    buildEnginesUpdate(
      { quick: { kind: "local", provider: "lmstudio", baseUrl: "http://127.0.0.1:1234" } },
      ENGINES,
      ok,
    ),
    { quickEngine: { kind: "local", provider: "lmstudio", baseUrl: "http://127.0.0.1:1234" } },
  );
  assert.deepEqual(buildEnginesUpdate({ fallback: { kind: "api", provider: "gemini" } }, ENGINES, ok), {
    fallbackEngine: { kind: "api", provider: "gemini" },
  });
});

test('buildEnginesUpdate: the fallback\'s "nothing" is a VALUE — it persists as null, never as an omission', () => {
  // The bug class this closes is the voice-flip one this codebase already
  // fixed once: the route MERGES (`{...existing, ...patch}`), so a choice
  // recorded as an omitted field leaves the previous engine in place. A user
  // who says "nothing — I'll just tell you" after picking Gemini would keep
  // silently falling back to Gemini.
  const patch = buildEnginesUpdate({ fallback: null }, ENGINES, () => "");
  assert.ok(!("error" in patch), "an explicit nothing is accepted, not refused");
  assert.ok(Object.hasOwn(patch, "fallbackEngine"), "the field is PRESENT in the patch, not omitted");
  assert.strictEqual(
    (patch as { fallbackEngine?: unknown }).fallbackEngine,
    null,
    "and its value is null, not undefined",
  );

  // The claim that actually matters is about the FILE, not the object: an
  // `undefined` survives a spread but vanishes through JSON.stringify, which
  // is exactly how an "explicit nothing" becomes an omission on disk and the
  // old engine comes back on the next load.
  const existing = { id: "me", name: "You", fallbackEngine: { kind: "api" as const, provider: "gemini" } };
  const merged = { ...existing, ...patch };
  const onDisk = JSON.parse(JSON.stringify(merged)) as Record<string, unknown>;
  assert.ok(Object.hasOwn(onDisk, "fallbackEngine"), "and it survives serialisation as a stored null");
  assert.strictEqual(onDisk.fallbackEngine, null, "the previously stored engine is GONE, not kept");
});

test("buildEnginesUpdate: a null main or quick CLEARS, the way PUT /me/brain-engine's null already does", () => {
  const ok = () => "";
  const main = buildEnginesUpdate({ main: null }, ENGINES, ok);
  assert.ok(Object.hasOwn(main, "brainEngine"));
  assert.strictEqual((main as { brainEngine?: unknown }).brainEngine, undefined);

  const quick = buildEnginesUpdate({ quick: null }, ENGINES, ok);
  assert.ok(Object.hasOwn(quick, "quickEngine"));
  assert.strictEqual((quick as { quickEngine?: unknown }).quickEngine, undefined);
});

test("buildEnginesUpdate: a role the body never mentions is left alone", () => {
  const patch = buildEnginesUpdate({ main: { kind: "cli", provider: "claude" } }, ENGINES, () => "");
  assert.equal(Object.hasOwn(patch, "quickEngine"), false, "quick is untouched, not cleared");
  assert.equal(Object.hasOwn(patch, "fallbackEngine"), false, "fallback is untouched, not cleared");

  const existing = {
    id: "me",
    name: "You",
    quickEngine: { kind: "api" as const, provider: "gemini" },
    fallbackEngine: null,
  };
  const merged = { ...existing, ...patch };
  assert.deepEqual(merged.quickEngine, { kind: "api", provider: "gemini" });
  assert.strictEqual(merged.fallbackEngine, null);
});

test("buildEnginesUpdate: an unknown key is REFUSED, never silently dropped", () => {
  // This route exists because `buildUserUpdate` spreads: an arbitrary field
  // round-trips through PUT /me looking perfectly saved. A typo'd role here
  // would do the same thing on this route — accept the request, save
  // nothing, and report success — so the body is allow-listed even though
  // the fields it writes are not.
  const typo = buildEnginesUpdate({ mian: { kind: "cli", provider: "claude" } }, ENGINES, () => "");
  assert.ok("error" in typo, "an unknown role is an error, not a no-op");
  assert.match((typo as { error: string }).error, /mian/);

  for (const body of [null, "main", 7, [{ kind: "cli" }]]) {
    const r = buildEnginesUpdate(body, ENGINES, () => "");
    assert.ok("error" in r, `a ${typeof body} body must be refused: ${JSON.stringify(body)}`);
  }
});

test('the fallback\'s "nothing" survives a real save and reload — not just a JSON.stringify', async () => {
  // The one claim the pure tests above can only simulate. `saveUser` encrypts
  // and rewrites the record, `loadUsersFromDir` migrates it on the way back,
  // and either could plausibly drop a null on the floor — at which point the
  // engine the user just rejected quietly returns on the next request. This
  // walks the actual path: patch -> merge -> disk -> reload.
  const dir = await mkdtemp(join(tmpdir(), "engines-"));
  try {
    await saveUser(dir, {
      id: "me",
      name: "Edwin",
      default: true,
      fallbackEngine: { kind: "api", provider: "gemini" },
    });

    const patch = buildEnginesUpdate({ fallback: null }, ENGINES, () => "");
    assert.ok(!("error" in patch));
    const [existing] = await loadUsersFromDir(dir);
    await saveUser(dir, { ...(existing as User), ...patch });

    const [reloaded] = await loadUsersFromDir(dir);
    assert.strictEqual(
      reloaded?.fallbackEngine,
      null,
      "the stored gemini engine is gone, replaced by an explicit null",
    );
    const raw = JSON.parse(await readFile(join(dir, "me.json"), "utf8")) as Record<string, unknown>;
    assert.ok(Object.hasOwn(raw, "fallbackEngine"), "and the FILE holds the key, rather than having dropped it");
    assert.strictEqual(raw.fallbackEngine, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("redactEngines: a stored engine whose cli gate now fails reads as unset, in every role", () => {
  const u: User = {
    id: "me",
    name: "You",
    brainEngine: { kind: "cli", provider: "claude" },
    quickEngine: { kind: "cli", provider: "claude" },
    fallbackEngine: { kind: "cli", provider: "claude" },
  };
  assert.deepEqual(
    redactEngines(u, () => ""),
    {
      main: { kind: "cli", provider: "claude" },
      quick: { kind: "cli", provider: "claude" },
      fallback: { kind: "cli", provider: "claude" },
    },
  );
  assert.deepEqual(
    redactEngines(u, () => "not installed"),
    { main: null, quick: null, fallback: null },
  );
  assert.deepEqual(
    redactEngines(null, () => ""),
    { main: null, quick: null, fallback: null },
  );
});

// ── prepareSquadSwarm ────────────────────────────────────────────────
//
// A local fixture rather than one imported from workspace-instances.test.ts:
// fixtures are not a shared API here, and coupling two suites through one
// makes either harder to change.

/** A real git repo with one commit, standing in for a workspace's project repo. */
async function makeGitOrigin(path: string): Promise<string> {
  await mkdir(path, { recursive: true });
  await git("git", ["init", "-q", "-b", "main", path]);
  await writeFile(join(path, "README.md"), "app\n");
  await git("git", ["add", "-A"], { cwd: path });
  await git("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"], { cwd: path });
  return path;
}

/**
 * A saved workspace with a real org repo at `paths.orgRepo` holding its
 * subtree, ready for createInstance's sparse config member.
 */
async function makeSquadWorkspace(root: string): Promise<Workspace> {
  const paths = smithPaths(root);
  const origin = await makeGitOrigin(join(root, "origin"));
  const ws = { name: "pg", repos: [{ name: "app", path: origin, branch: "main" }] } as Workspace;
  await saveWorkspace(paths, ws);
  makeOrgRepo(root, ["pg"]);
  return ws;
}

test("prepareSquadSwarm: every member gets a worktree, a branch, and its own driver's persona", async () => {
  const root = await mkdtemp(join(tmpdir(), "psq-"));
  try {
    const paths = smithPaths(root);
    const ws = await makeSquadWorkspace(root);

    const prepared = await prepareSquadSwarm(paths, ws, "t-1", [
      { name: "Gabriel", pane: 1, model: "gemini-pro", role: "leader", squad: "alpha" },
      { name: "Santiago", pane: 2, model: "claude-sonnet", role: "developer", squad: "alpha" },
    ]);

    assert.equal(prepared.members.length, 2);
    for (const m of prepared.members) {
      assert.ok((await stat(m.path)).isDirectory(), `${m.name} has a worktree`);
      assert.equal(m.branch, `smith/members/t-1/${m.name.toLowerCase()}`);
      assert.ok(m.persona.length > 0, `${m.name} was told who it is`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prepareSquadSwarm: each member is told who it is in ITS OWN cli's dialect", async () => {
  const root = await mkdtemp(join(tmpdir(), "psq-dialect-"));
  try {
    const paths = smithPaths(root);
    const ws = await makeSquadWorkspace(root);

    const prepared = await prepareSquadSwarm(paths, ws, "t-6", [
      { name: "Gabriel", pane: 1, model: "gemini-pro", role: "leader", squad: "alpha" },
      { name: "Santiago", pane: 2, model: "claude-sonnet", role: "developer", squad: "alpha" },
    ]);

    const leader = prepared.members.find((m) => m.name === "Gabriel");
    const member = prepared.members.find((m) => m.name === "Santiago");

    // The whole point of a mixed-vendor squad: a gemini leader must NOT be
    // handed CLAUDE.md, which its CLI would never read.
    assert.deepEqual(leader?.persona, ["AGENTS.md"], "the agy-backed leader gets AGENTS.md");
    assert.deepEqual(member?.persona, ["CLAUDE.md"], "the claude member gets CLAUDE.md");
    assert.ok((await stat(join(leader!.path, "AGENTS.md"))).isFile(), "written into the leader's own worktree");
    assert.ok((await stat(join(member!.path, "CLAUDE.md"))).isFile(), "written into the member's own worktree");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prepareSquadSwarm: an explicit tool overrides the model's default cli", async () => {
  const root = await mkdtemp(join(tmpdir(), "psq-tool-"));
  try {
    const paths = smithPaths(root);
    const ws = await makeSquadWorkspace(root);

    const prepared = await prepareSquadSwarm(paths, ws, "t-7", [
      // A claude model deliberately run on copilot — an agent is not bound to
      // one CLI, so the explicit tool wins over the model's default.
      { name: "Gabriel", pane: 1, model: "claude-sonnet", role: "leader", squad: "alpha", tool: "copilot" },
    ]);

    assert.deepEqual(prepared.members[0].persona, [".github/copilot-instructions.md"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prepareSquadSwarm: a tool with no driver is refused by name, never silently defaulted", async () => {
  const root = await mkdtemp(join(tmpdir(), "psq-nodriver-"));
  try {
    const paths = smithPaths(root);
    const ws = await makeSquadWorkspace(root);

    await assert.rejects(
      () =>
        prepareSquadSwarm(paths, ws, "t-8", [
          { name: "Gabriel", pane: 1, model: "claude-sonnet", role: "leader", squad: "alpha", tool: "nosuchcli" },
        ]),
      /Gabriel.*nosuchcli/s,
      "the error names the member and the tool",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prepareSquadSwarm: the feed is ready before any member starts", async () => {
  const root = await mkdtemp(join(tmpdir(), "psq-feed-"));
  try {
    const paths = smithPaths(root);
    const ws = await makeSquadWorkspace(root);

    const prepared = await prepareSquadSwarm(paths, ws, "t-2", [
      { name: "Gabriel", pane: 1, model: "gemini-pro", role: "leader", squad: "alpha" },
    ]);

    await appendUpdate(prepared.instanceDir, "Gabriel", "starting");
    assert.deepEqual(
      (await readFeed(prepared.instanceDir)).map((u) => u.agentName),
      ["Gabriel"],
    );
    assert.equal(prepared.feed, feedPath(prepared.instanceDir));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prepareSquadSwarm: members are isolated from each other on real workspace repos", async () => {
  const root = await mkdtemp(join(tmpdir(), "psq-iso-"));
  try {
    const paths = smithPaths(root);
    const ws = await makeSquadWorkspace(root);

    const prepared = await prepareSquadSwarm(paths, ws, "t-3", [
      { name: "Gabriel", pane: 1, model: "gemini-pro", role: "leader", squad: "alpha" },
      { name: "Santiago", pane: 2, model: "claude-sonnet", role: "developer", squad: "alpha" },
    ]);
    const [a, b] = prepared.members;

    await writeFile(join(a.path, "DRAFT.md"), "uncommitted\n");

    await assert.rejects(() => stat(join(b.path, "DRAFT.md")), "uncommitted work does not leak between members");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workKindsPayload: every kind ships its labels and presets", () => {
  const payload = workKindsPayload();

  const ids = payload.kinds.map((k) => k.id);
  assert.ok(ids.includes("product"), "product is offered");
  assert.ok(ids.includes("creator"), "so is a non-software kind");

  const creator = payload.kinds.find((k) => k.id === "creator");
  assert.equal(creator?.columns.complete, "Posted");
  assert.ok(
    creator?.presets.some((p) => p.id === "tiktok" && p.cadence === "hourly"),
    "presets carry their default cadence, which the sheet needs",
  );
});

test("workspaceProblems: a repo-less workspace is accepted", async () => {
  const problem = await workspaceProblems({ name: "acme", repos: [] });
  assert.equal(problem, null, "the design half needs no git");
});

test("workspaceProblems: a malformed repo is still refused", async () => {
  assert.match((await workspaceProblems({ name: "acme", repos: [{ name: "" } as never] })) ?? "", /name/i);
});

test("workspaceProblems: a missing name is still refused", async () => {
  assert.match((await workspaceProblems({ repos: [] })) ?? "", /name/i);
});

// POST /workspaces has its own narrowing gate below workspaceProblems
// (isValidWorkspaceCreateRepos) so buildWorkspaceCreate can receive a
// non-optional repos array. It must accept exactly what workspaceProblems
// accepts, or the route still 400s on a payload the validator now allows —
// which is exactly the bug fix round 1 found (fix round 1, spec: repo-less
// contexts).
test("isValidWorkspaceCreateRepos: an empty array is a valid repos payload — the route guard must not re-impose the old length check", () => {
  assert.equal(isValidWorkspaceCreateRepos([]), true);
});

test("isValidWorkspaceCreateRepos: a non-empty array is still valid", () => {
  assert.equal(isValidWorkspaceCreateRepos([{ name: "web", path: "/tmp/web" }]), true);
});

test("isValidWorkspaceCreateRepos: a missing or non-array repos is still refused", () => {
  assert.equal(isValidWorkspaceCreateRepos(undefined), false);
  assert.equal(isValidWorkspaceCreateRepos("nope"), false);
  assert.equal(isValidWorkspaceCreateRepos(null), false);
});

test("the repo-less refusal is a refusal, not an unknown-workspace error", () => {
  // The three resolveRepo consumers previously said "Unknown workspace/repo"
  // for a workspace that plainly exists. That message sent users looking for a
  // typo instead of telling them to attach a repo.
  const wss = [{ name: "design", repos: [] }] as never;
  const refusal = repoLessRefusal(wss, "design");
  assert.ok(refusal);
  assert.doesNotMatch(refusal as string, /unknown/i);
});

test("buildUserUpdate: PRESERVES fields it does not set — the brain engine survives a rename", () => {
  // This is the third instance of this bug class in this codebase
  // (buildWorkspaceCreate dropped workKind; doc-edit dropped unschema-ed
  // fields). An allow-list literal silently erases everything not listed, and
  // the wizard's very first step calls PUT /me.
  const existing = {
    id: "me",
    name: "Edwin",
    default: true,
    brainEngine: { kind: "api" as const, provider: "gemini" },
    researchEngine: { cli: "claude" },
    agendaSweptDay: "2026-08-17",
  };

  const merged = buildUserUpdate(existing as never, { name: "Edwina" });

  assert.equal(merged.name, "Edwina", "the rename applies");
  assert.deepEqual(merged.brainEngine, { kind: "api", provider: "gemini" }, "brainEngine survives");
  assert.deepEqual(merged.researchEngine, { cli: "claude" }, "researchEngine survives");
  assert.equal(merged.agendaSweptDay, "2026-08-17", "agendaSweptDay survives");
});

test("buildUserUpdate: creates a usable record when there is no existing user", () => {
  const created = buildUserUpdate(null, { name: "Edwin" });
  assert.equal(created.id, "me");
  assert.equal(created.name, "Edwin");
  assert.equal(created.default, true);
});

test("buildUserUpdate: records wizard progress, and omitting it preserves what was there", () => {
  const first = buildUserUpdate(null, { name: "Edwin", setup: { mode: "local", step: "fork" } });
  assert.deepEqual(first.setup, { mode: "local", step: "fork" });

  const renamed = buildUserUpdate(first, { name: "Edwina" });
  assert.deepEqual(renamed.setup, { mode: "local", step: "fork" }, "progress is not lost by an unrelated update");
});

test("redactUser: says PLAINLY whether a real user record exists", () => {
  // The spec detects first run by "the absence of a user record", but the old
  // payload fabricated {name:"You"} for null — indistinguishable from a real
  // user named You. The client could not detect first run at all.
  const fresh = redactUser(null);
  assert.equal(fresh.placeholder, true, "no saved user yet");

  const real = redactUser({ id: "me", name: "You", default: true } as never);
  assert.equal(real.placeholder, false, "a REAL user named 'You' is not a placeholder");
  assert.equal(real.name, "You");
});

test("redactUser: exposes setup progress so the wizard can resume", () => {
  const u = redactUser({ id: "me", name: "Edwin", setup: { mode: "local", step: "fork" } } as never);
  assert.deepEqual(u.setup, { mode: "local", step: "fork" });
});

test("redactUser: still never leaks a connector secret", () => {
  const u = redactUser({
    id: "me",
    name: "Edwin",
    connectors: [{ id: "c1", vendorId: "atlassian", label: "acme", fields: { email: "e@x.com", apiToken: "SECRET" } }],
  } as never);
  assert.equal(JSON.stringify(u).includes("SECRET"), false, "redaction is not weakened by the new fields");
});
