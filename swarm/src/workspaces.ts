// Workspaces — named groupings of one or more repos the crew can work in.
// One JSON file per workspace under .smith/workspaces/. Delegations name a
// workspace/repo; the dispatcher cuts the task's worktree from that repo.

import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { SmithPaths } from "./paths.js";
import { loadRegistry, removeRegistryEntry, saveRegistryEntry } from "./workspace-registry.js";

export interface WorkspaceRepo {
  name: string;
  /** Absolute path to the local clone the dispatcher worktrees from. */
  path: string;
  /** Git remote URL — informational (PRs, prompts). */
  repository?: string;
  /** Base branch for task worktrees. Default: main. */
  branch?: string;
  /** GitHub API pointer — separate from `repository` (informational remote URL). connectorId is optional: unset means "no GitHub tool access resolved for this repo" (soft-fail, not a required field). */
  github?: { owner: string; repo: string; connectorId?: string };
}

/** A pollable external origin owned by this context (spec 2026-08-13
    queue-sources): the BROKER polls it, the queue bindings on boards decide
    where its findings card. `preset` is UI sugar — executors read origin/transform. */
export interface ContextSource {
  id: string;
  name: string;
  preset: "jira" | "releases" | "topic" | "observability" | "support" | "custom";
  origin: { connectorId?: string; url?: string; query?: string };
  cadence: "hourly" | "6h" | "nightly";
  transform: { mode: "map" } | { mode: "analyze"; prompt?: string };
  enabled: boolean;
}

const SOURCE_PRESETS = new Set(["jira", "releases", "topic", "observability", "support", "custom"]);
const SOURCE_CADENCES = new Set(["hourly", "6h", "nightly"]);

/** Absent or a valid array — never half-checked, same contract as validSprint. */
export function validSources(v: unknown): boolean {
  if (v === undefined) return true;
  if (!Array.isArray(v)) return false;
  return v.every((s) => {
    const o = s as Partial<ContextSource>;
    return (
      o !== null &&
      typeof o === "object" &&
      typeof o.id === "string" &&
      o.id.length > 0 &&
      typeof o.name === "string" &&
      SOURCE_PRESETS.has(o.preset as string) &&
      typeof o.origin === "object" &&
      o.origin !== null &&
      SOURCE_CADENCES.has(o.cadence as string) &&
      (o.transform?.mode === "map" || o.transform?.mode === "analyze") &&
      typeof o.enabled === "boolean"
    );
  });
}

export interface Workspace {
  name: string;
  description?: string;
  repos: WorkspaceRepo[];
  /** The workspace used when a delegation names none. */
  default?: boolean;
  /** Archived in place: hidden from roster/delegation, kept for history. */
  archived?: boolean;
  /** Non-secret Jira/Confluence pointer. Credentials live on User.connectors, never here. connectorId is optional: unset means "no Atlassian tool access resolved for this workspace" (soft-fail). */
  atlassian?: {
    siteUrl: string;
    jiraProjectKeys?: string[];
    confluenceSpaceKeys?: string[];
    connectorId?: string;
  };
  /** Default-context links every session in this workspace inherits (spec 2026-08-07). */
  links?: string[];
  /** Optional identity colour; the UI falls back to a hash of `name`. */
  color?: string;
  /** Opt-in sprint definition (date-range spec 2026-08-12) — absent means this workspace has no sprints. */
  sprint?: { anchor: string; lengthDays: number };
  /** Pollable external origins owned by this context (spec 2026-08-13 queue-sources) — absent means none configured. */
  sources?: ContextSource[];
  /**
   * ONE CONTEXT ENTITY (spec 2026-08-13, Edwin: "a group is a workspace made
   * up of many workspaces" / "there is a group attribute for workspace"):
   * PRESENT (even empty) = this context contains other contexts — it IS a
   * group; absent = a plain workspace. Presence is the kind, so an empty
   * group stays a group. Groupish records carry `repos: []`; mixed
   * containment is invalid.
   */
  members?: string[];
  /**
   * Absolute path to this workspace's own directory — the container for its
   * config repo, project repos, and ephemeral instances. Absent means the
   * default under the state root; set explicitly to keep a workspace where the
   * user keeps code.
   */
  dir?: string;
}

/** The group attribute, applied: a context with `members` (even []) is a group. */
export function isGroupRecord(w: Workspace): boolean {
  return w.members !== undefined;
}

function assertContext(file: string, v: unknown): Workspace {
  const o = v as Partial<Workspace>;
  if (o && Array.isArray(o.members)) {
    const ok =
      typeof o.name === "string" &&
      o.members.every((m) => typeof m === "string") &&
      (o.repos === undefined || (Array.isArray(o.repos) && o.repos.length === 0));
    if (!ok) {
      throw new Error(`Invalid group file ${file}: requires name, members[] of names, and NO repos (one or the other)`);
    }
    return { ...o, repos: [] } as Workspace;
  }
  const ok =
    o &&
    typeof o.name === "string" &&
    Array.isArray(o.repos) &&
    o.repos.length > 0 &&
    o.repos.every((r) => r && typeof r.name === "string" && typeof r.path === "string" && isAbsolute(r.path));
  if (!ok) {
    throw new Error(`Invalid workspace file ${file}: requires name and repos[]{name, absolute path}`);
  }
  return o as Workspace;
}

/**
 * Every context record in `dir` — plain workspaces AND groupish ones. The
 * store's raw read; collision checks and the group views build on it.
 */
export async function loadAllContextsFromDir(dir: string): Promise<Workspace[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const contexts: Workspace[] = [];
  for (const file of entries.filter((f) => f.endsWith(".json"))) {
    const raw = await readFile(join(dir, file), "utf8");
    contexts.push(assertContext(file, JSON.parse(raw)));
  }
  return contexts;
}

/**
 * PLAIN workspaces only — what every work path (dispatch, boards, sessions,
 * repo resolution) consumes. Groupish records can host none of that, so the
 * filter lives at the loader and no call site needs auditing twice.
 */
export async function loadWorkspacesFromDir(dir: string): Promise<Workspace[]> {
  return (await loadAllContextsFromDir(dir)).filter((w) => !isGroupRecord(w));
}

/** A workspace's own record, inside its directory. */
export function settingsPathFor(dir: string): string {
  return join(dir, "config", "settings.json");
}

/**
 * Every workspace: those registered with their own settings.json, plus any flat
 * record under paths.workspaces that has not migrated yet. Reading both is what
 * lets the relocation happen separately — an unmigrated workspace still loads.
 *
 * On a duplicate name the settings.json copy wins: it is where writes go, so it
 * is the newer of the two.
 */
export async function loadWorkspaces(paths: SmithPaths): Promise<Workspace[]> {
  const out: Workspace[] = [];
  const seen = new Set<string>();

  const registry = await loadRegistry(paths);
  for (const [, dir] of Object.entries(registry)) {
    try {
      const raw = await readFile(settingsPathFor(dir), "utf8");
      const ws = assertContext(settingsPathFor(dir), JSON.parse(raw));
      seen.add(ws.name);
      out.push(ws);
    } catch (err) {
      // A registered workspace whose settings file is missing is not fatal —
      // the flat record below may still cover it during the transition.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  for (const ws of await loadWorkspacesFromDir(paths.workspaces)) {
    if (seen.has(ws.name)) continue;
    seen.add(ws.name);
    out.push(ws);
  }
  return out;
}

/**
 * Every context name in the ONE namespace (spec 2026-08-13): dual-source
 * plain workspaces plus groupish records. Groups never migrate out of the
 * flat directory — a group owns no repos and no directory of its own — so
 * they are read straight off loadAllContextsFromDir; only the workspace half
 * needs the dual-source read. Namespace-collision checks (workspace/group
 * creation, migrateGroupsDir's rename-on-collision) need this union:
 * loadAllContextsFromDir alone goes blind to a workspace the moment it
 * migrates to config/settings.json.
 */
export async function loadAllContexts(paths: SmithPaths): Promise<Workspace[]> {
  const groups = (await loadAllContextsFromDir(paths.workspaces)).filter(isGroupRecord);
  return [...(await loadWorkspaces(paths)), ...groups];
}

/** Workspaces visible to the roster, catalog, and delegation. */
export function activeWorkspaces(workspaces: Workspace[]): Workspace[] {
  return workspaces.filter((w) => !w.archived);
}

/**
 * Default a blank/omitted branch to "main" — mirrors POST /workspaces so PUT can't
 * persist an empty branch. Also drops the transient creation-time `initGit` flag
 * (POST strips it via explicit field mapping; PUT has no such mapping, so without
 * this it would round-trip straight to disk).
 */
export function normalizeRepoBranch(repos: Array<WorkspaceRepo & { initGit?: boolean }>): WorkspaceRepo[] {
  return repos.map(({ initGit: _initGit, ...r }) => ({ ...r, branch: r.branch?.trim() || "main" }));
}

/**
 * Resolve a delegation's workspace/repo names to a concrete repo.
 * Omitted workspace -> the default (flagged, else first). Omitted repo -> the
 * workspace's first repo. Returns null when nothing matches.
 */
export function resolveRepo(
  workspaces: Workspace[],
  workspaceName?: string,
  repoName?: string,
): { workspace: Workspace; repo: WorkspaceRepo } | null {
  const live = activeWorkspaces(workspaces);
  const workspace = workspaceName
    ? live.find((w) => w.name.toLowerCase() === workspaceName.toLowerCase())
    : (live.find((w) => w.default) ?? live[0]);
  if (!workspace) return null;
  const repo = repoName
    ? workspace.repos.find((r) => r.name.toLowerCase() === repoName.toLowerCase())
    : workspace.repos[0];
  return repo ? { workspace, repo } : null;
}

/** Write one workspace to its own directory and register it. Mirror of agents.saveAgent. */
export async function saveWorkspace(paths: SmithPaths, ws: Workspace): Promise<void> {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(ws.name)) {
    throw new Error(`Invalid workspace name "${ws.name}": use lowercase letters, digits and dashes`);
  }
  const dir = await ensureWorkspaceDir(paths, ws);
  await writeFile(settingsPathFor(dir), `${JSON.stringify(ws, null, 2)}\n`);
  await saveRegistryEntry(paths, ws.name, dir);
}

/**
 * Deregister a workspace and remove its flat record, if any. The workspace's
 * directory (and any config/settings.json inside it) is deliberately left —
 * this deletes no data. A missing registry entry or flat file is a no-op
 * rather than an error, matching removeRegistryEntry's contract: the caller
 * (the DELETE /workspaces route) already checks existence and 404s before
 * calling this, so this function's own job is just to be idempotent.
 */
export async function removeWorkspaceFile(paths: SmithPaths, name: string): Promise<void> {
  await removeRegistryEntry(paths, name);
  await rm(join(paths.workspaces, `${name}.json`), { force: true });
}

/** True when `path` is inside a git repository (worktrees are cut from here). */
export async function isGitRepo(path: string): Promise<boolean> {
  try {
    await promisify(execFile)("git", ["rev-parse", "--git-dir"], { cwd: path });
    return true;
  } catch {
    return false;
  }
}

/** `git init` an existing directory — the one case where workspace creation may create the repo instead of rejecting the path (creation-time `initGit` flag). */
export async function initGitRepo(path: string): Promise<void> {
  await promisify(execFile)("git", ["init"], { cwd: path });
}

/**
 * The invariant: while any OTHER active workspace exists, the default cannot
 * be archived or deleted — the caller must crown a successor first.
 * Returns the human-readable refusal, or null when the removal is fine.
 */
export function defaultViolation(all: Workspace[], removingName: string): string | null {
  const active = activeWorkspaces(all);
  const target = active.find((w) => w.name === removingName);
  const isDefault = target && (Boolean(target.default) || (!active.some((w) => w.default) && active[0] === target));
  if (isDefault && active.length > 1) {
    return `"${removingName}" is the default workspace — set another default first`;
  }
  return null;
}

/**
 * A workspace name reduced to a safe directory name. Lowercased, non-alphanumerics
 * collapsed to single dashes, edges trimmed — so a name can never contain a path
 * separator or a `..` segment and escape its parent.
 */
export function slugForDir(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Where this workspace's directory is. An explicit `dir` wins and is resolved to
 * absolute; otherwise it defaults under the state root, named from the slug.
 */
export function workspaceDir(paths: SmithPaths, ws: Workspace): string {
  return ws.dir ? resolve(ws.dir) : join(paths.workspaces, slugForDir(ws.name));
}

/**
 * Create this workspace's directory and its two fixed children, and return the
 * resolved path. `config/` is the versioned half (settings, boards, artifacts);
 * `.runtime/` is the unversioned half (instances, logs, local caches). Both are
 * created empty here — filling them is later work.
 *
 * Idempotent: `mkdir -p` semantics, existing contents untouched.
 *
 * A name that slugs to the empty string (e.g. "..." or "///") would otherwise
 * make workspaceDir() resolve to `paths.workspaces` itself — the shared parent
 * every workspace directory lives under — and this function would create
 * config/ and .runtime/ directly inside it. Refuse instead of writing there;
 * a workspace whose name can't become a directory is a caller error to fix,
 * not one to paper over with a substitute name.
 *
 * Reachable from POST /workspaces today: its upstream checks only test
 * `.trim()`, so a name like "..." passes them, slugifies to "", and reaches
 * this function before saveWorkspace's name regex ever gets a look — this
 * guard is what rejects it now. It also covers the back-fill caller the next
 * plan adds, which walks existing records directly rather than going through
 * POST.
 */
export async function ensureWorkspaceDir(paths: SmithPaths, ws: Workspace): Promise<string> {
  if (!ws.dir && !slugForDir(ws.name)) {
    throw new Error(
      `Workspace name "${ws.name}" has no characters usable in a directory name — refusing to create its ` +
        `directory inside the shared workspaces root`,
    );
  }
  const dir = workspaceDir(paths, ws);
  await mkdir(join(dir, "config"), { recursive: true });
  await mkdir(join(dir, ".runtime"), { recursive: true });
  return dir;
}

/**
 * Where a board's file lives. A board carrying a known `workspaceId` belongs to
 * that workspace's config; everything else — the workspace-less `personal`
 * board, and any board whose workspace record has been deleted — stays in the
 * host work directory, so an orphan remains loadable instead of pointing at a
 * directory that does not exist.
 */
export function boardsDirFor(paths: SmithPaths, workspaces: Workspace[], workspaceId: string | undefined): string {
  if (!workspaceId) return paths.work;
  const ws = workspaces.find((w) => w.name === workspaceId);
  return ws ? join(workspaceDir(paths, ws), "config", "boards") : paths.work;
}

/**
 * Workspaces whose directories collide. `slugForDir` is lossier than the name
 * validator — "ab" and "ab-" are both valid names and both slug to "ab" — so two
 * records can resolve to one directory and silently share its contents. Nothing
 * creates such a pair through the API today, because POST slugifies before
 * saving, but that invariant lives in the handler rather than in the type.
 */
export function collidingWorkspaceDirs(
  paths: SmithPaths,
  workspaces: Workspace[],
): Array<{ dir: string; names: string[] }> {
  const byDir = new Map<string, string[]>();
  for (const ws of workspaces) {
    const dir = workspaceDir(paths, ws);
    byDir.set(dir, [...(byDir.get(dir) ?? []), ws.name]);
  }
  return [...byDir.entries()].filter(([, names]) => names.length > 1).map(([dir, names]) => ({ dir, names }));
}
