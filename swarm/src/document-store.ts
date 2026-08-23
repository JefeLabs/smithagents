// The document store (spec 2026-08-22 §3): the fs+git facade over
// document-file (text), blueprints (schema), document-rules (gates), and
// document-proposals (branches). Truth is the disk — every read lists the
// directory, every mutation writes the file and commits exactly that file
// through the per-org-repo queue with the acting author. No cache.
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { type Blueprint, type BlueprintFolder, instantiateSections, loadBlueprintsFor } from "./blueprints.js";
import { loadCapabilities } from "./capabilities.js";
import {
  DOC_STATUSES,
  type DocSection,
  type DocStatus,
  documentFileId,
  type ParsedDocument,
  parseDocumentFile,
  serializeDocumentFile,
  slugify,
} from "./document-file.js";
import { createProposal, deleteProposal, listProposals, type ProposalWire } from "./document-proposals.js";
import { type Problem, type RuleResolvers, transitionProblems, validateDocument } from "./document-rules.js";
import { agentAuthor, type GitAuthor, SMITH_IDENTITY } from "./git-author.js";
import { normalizeMarkdown } from "./markdown-normalize.js";
import type { SmithPaths } from "./paths.js";
import { commitPathsInQueue, withOrgRepoQueue } from "./workspace-repos.js";
import { activeWorkspaces, configDirFor, slugForDir, type Workspace } from "./workspaces.js";

const run = promisify(execFile);

export interface DocWire {
  id: string;
  workspace: string;
  title: string;
  blueprintId: string;
  workType: string;
  effort: string;
  sections: DocSection[];
  participants: string[];
  proposals: ProposalWire[];
  pins: string[];
  status: DocStatus;
  createdAt: string;
  updatedAt: string;
  problems: Problem[];
}

export interface Located {
  ws: Workspace;
  slug: string;
  folder: BlueprintFolder;
  id: string;
  relPath: string;
  absPath: string;
}

export type StoreResult = DocWire | { error: string; status: number; problems?: Problem[] };

export interface LegacyDoc {
  id: string;
  title: string;
  blueprintId: string;
  workType: string;
  sections: DocSection[];
  participants: string[];
  proposals: Array<{
    id: string;
    sectionId: string;
    agentId: string;
    newBody: string;
    rationale: string;
    state: string;
    createdAt: string;
  }>;
  pins?: string[];
  status: DocStatus;
  createdAt: string;
  updatedAt: string;
}

/**
 * One id resolved to more than one file. The list is of `<workspace>/<folder>`
 * locations, not workspace names: a document id is only unique within ONE
 * FOLDER of one workspace, so the same stem can also collide across two
 * folders of the SAME workspace (only the `spec` blueprint adds a suffix, so
 * a plan and a dashboard minted in the same minute for the same effort share
 * a stem). Naming the folders makes that case readable instead of printing
 * one workspace name twice.
 */
export class AmbiguousDocumentError extends Error {
  constructor(id: string, locations: string[]) {
    super(
      `Document "${id}" exists in more than one place (${locations.join(", ")}) — address it through its workspace`,
    );
    this.name = "AmbiguousDocumentError";
  }
}

const FOLDERS: BlueprintFolder[] = ["specs", "plans", "dashboards"];
const kindOf = (folder: BlueprintFolder): string => folder.replace(/s$/, "");
const nowIso = (): string => new Date().toISOString();
/** Collapse runs of whitespace (line breaks included) to single spaces and trim. */
const squash = (text: string | undefined): string => (text ?? "").replace(/\s+/g, " ").trim();

/**
 * Why a string cannot be stored as an entry of a frontmatter list, or null.
 * The grammar is `key: [a, b]` (document-file.ts) — every entry is written
 * verbatim between the brackets, so a comma re-parses as two entries, a
 * bracket ends the list early, and a line break ends the whole key. Callers
 * refuse rather than silently mangle: `serializeDocumentFile` must never emit
 * frontmatter that `parseDocumentFile` then rejects, and a pin carrying a
 * newline would make the document unreadable outright.
 */
function listValueProblem(value: string): string | null {
  if (value.includes(",")) return "a comma would re-parse as two entries";
  if (/[[\]]/.test(value)) return "a square bracket would end the list";
  if (/[\n\r]/.test(value)) return "a line break would end the frontmatter key";
  return null;
}

/**
 * Where a document's file is. `configDirFor` carries the guard for a
 * workspace name that slugs to nothing (its subtree would be the shared
 * `workspaces/` parent, and a write there lands on every workspace at once),
 * so building the path through it means every caller inherits that refusal —
 * including `createDocument`, which is the only one that would otherwise
 * create the directory.
 */
function located(paths: SmithPaths, ws: Workspace, folder: BlueprintFolder, id: string): Located {
  const configDir = configDirFor(paths, ws);
  const slug = slugForDir(ws.name);
  return {
    ws,
    slug,
    folder,
    id,
    relPath: `workspaces/${slug}/${folder}/${id}.md`,
    absPath: join(configDir, folder, `${id}.md`),
  };
}

async function listIds(paths: SmithPaths, ws: Workspace, folder: BlueprintFolder): Promise<string[]> {
  try {
    // A DIRECTORY named `<id>.md` is not a document. Filtering on the name
    // alone let `resolveDocument` locate one, and `rejectProposal` — which
    // never reads the file — would then act on an id that is not a document
    // at all (task-7 review, M2). A symlink to a real file still counts.
    return (await readdir(join(configDirFor(paths, ws), folder), { withFileTypes: true }))
      .filter((e) => e.name.endsWith(".md") && !e.isDirectory())
      .map((e) => e.name.slice(0, -3));
  } catch {
    return [];
  }
}

async function readParsed(loc: Located): Promise<{ text: string; doc: ParsedDocument } | null> {
  let text: string;
  try {
    text = await readFile(loc.absPath, "utf8");
  } catch {
    return null;
  }
  const { doc } = parseDocumentFile(text);
  return doc ? { text, doc } : null;
}

function resolvers(paths: SmithPaths, ws: Workspace): RuleResolvers {
  let slices: Promise<Set<string>> | undefined;
  return {
    async specStatus(docId) {
      const r = await readParsed(located(paths, ws, "specs", docId));
      return r ? r.doc.frontmatter.status : null;
    },
    async sliceExists(sliceId) {
      // Memoized per resolvers() call: `listWorkspaceDocuments` validates every
      // document, and each document may name several slices — without this,
      // listing N documents with M slices each is N*M full reads of the
      // capability directory on one request. A fresh resolvers() per store
      // operation keeps truth on the disk (no cross-request cache).
      slices ??= loadCapabilities(paths.workCapabilities).then(
        ({ capabilities }) =>
          new Set(capabilities.filter((c) => c.workspaceId === ws.name).flatMap((c) => c.slices.map((s) => s.id))),
      );
      return (await slices).has(sliceId);
    },
  };
}

async function toWire(
  paths: SmithPaths,
  loc: Located,
  text: string,
  doc: ParsedDocument,
  bp: Blueprint | undefined,
): Promise<DocWire> {
  const fm = doc.frontmatter;
  const problems = bp
    ? await validateDocument(bp, doc, resolvers(paths, loc.ws))
    : [{ where: "frontmatter.blueprint", message: `unknown blueprint: ${fm.blueprint}` }];
  const proposals = await listProposals(paths, {
    slug: loc.slug,
    docId: loc.id,
    relPath: loc.relPath,
    currentFileText: text,
  });
  return {
    id: loc.id,
    workspace: loc.ws.name,
    title: fm.title,
    blueprintId: fm.blueprint,
    workType: fm.workType,
    effort: fm.effort,
    sections: doc.sections,
    participants: fm.participants,
    proposals,
    pins: fm.pins,
    status: fm.status,
    createdAt: fm.createdAt,
    updatedAt: fm.updatedAt,
    problems,
  };
}

async function blueprintFor(paths: SmithPaths, ws: Workspace, id: string): Promise<Blueprint | undefined> {
  return (await loadBlueprintsFor(paths, ws.name)).find((b) => b.id === id);
}

/**
 * Serialize, or the refusal to. `serializeDocumentFile` THROWS on an empty
 * required scalar or a section id outside `^[a-z0-9][a-z0-9-]*$` — both
 * reachable from a §6.1 blueprint file or a §9.3 legacy document, neither of
 * which this module authors. Every write path goes through here so those
 * arrive as an ordinary `{error, status}` refusal instead of an unhandled 500
 * (task-7 review, I1). `blueprints.ts` rejects such a file at load, so this is
 * the second of two layers, not the only one.
 */
function serializeOrRefuse(doc: ParsedDocument): { text: string } | { error: string; status: number } {
  try {
    return { text: serializeDocumentFile(doc) };
  } catch (err) {
    return { error: `this document cannot be written — ${(err as Error).message}`, status: 400 };
  }
}

/** True when the org repo has uncommitted changes at exactly this path (untracked counts). */
async function isDirty(orgRepo: string, relPath: string): Promise<boolean> {
  const { stdout } = await run("git", ["status", "--porcelain", "--", relPath], { cwd: orgRepo });
  return stdout.toString().trim() !== "";
}

/** What a mutation produced: the file's bytes as re-read from disk, pinned inside the queue. */
interface WrittenDoc {
  loc: Located;
  text: string;
  doc: ParsedDocument;
}

/**
 * THE CALLER MUST ALREADY HOLD THE ORG-REPO QUEUE (see `mutate`). Write the
 * file, commit exactly it, and return its BYTES as re-read from disk.
 *
 * The write and the commit must sit in ONE queue slot: a second writer landing
 * between them clobbers the file, and the commit then carries that writer's
 * content under this caller's author and message — which is why this uses
 * `commitPathsInQueue` and must never be reached from outside the queue.
 *
 * The re-read is here, not in the caller, because THAT is what makes the
 * return value honest: these bytes are the ones this mutation put on disk, not
 * the in-memory copy the caller asked for (task-7 review, C1 defect 3). What
 * is deliberately NOT here is the wire projection — see `project`.
 */
async function writeDocInQueue(
  paths: SmithPaths,
  loc: Located,
  doc: ParsedDocument,
  author: GitAuthor,
  message: string,
): Promise<WrittenDoc | { error: string; status: number }> {
  const serialized = serializeOrRefuse(doc);
  if ("error" in serialized) return serialized;
  await mkdir(dirname(loc.absPath), { recursive: true });
  await writeFile(loc.absPath, serialized.text);
  await commitPathsInQueue(paths, [loc.relPath], { author, message });
  const fresh = await readParsed(loc);
  if (!fresh) return { error: `${loc.relPath} did not read back after being written`, status: 500 };
  return { loc, text: fresh.text, doc: fresh.doc };
}

/**
 * The wire projection — **run this AFTER releasing the queue, never inside it.**
 *
 * Why it is safe out here: the document's own bytes were pinned inside the
 * queue by `writeDocInQueue`, so `sections`, `title`, `status` and the rest are
 * exactly what this mutation wrote and cannot drift. The two DERIVED fields are
 * independently mutable and always have been — `proposals` reads branches under
 * `refs/heads/proposals/`, which move without touching `main`, and `problems` is
 * advisory validation over cross-document facts that can change a millisecond
 * later either way. `getDocument` already computes both outside any lock, so
 * running them inside the critical section buys no consistency a caller could
 * rely on.
 *
 * Why it MATTERS that it is out here: `listProposals` spawns several git
 * subprocesses per open proposal. Measured, it added ~28ms per open proposal to
 * the time the queue was HELD — 42ms with none, 269ms with eight — and the
 * org-repo queue is global, so every other workspace's mutation waited behind
 * it. If you are tempted to move this back inside for tidiness, re-read this
 * paragraph first.
 */
async function project(paths: SmithPaths, written: WrittenDoc): Promise<DocWire> {
  const { loc, text, doc } = written;
  return toWire(paths, loc, text, doc, await blueprintFor(paths, loc.ws, doc.frontmatter.blueprint));
}

export async function listWorkspaceDocuments(paths: SmithPaths, ws: Workspace): Promise<DocWire[]> {
  const out: DocWire[] = [];
  const bps = await loadBlueprintsFor(paths, ws.name);
  for (const folder of FOLDERS) {
    for (const id of await listIds(paths, ws, folder)) {
      const loc = located(paths, ws, folder, id);
      const r = await readParsed(loc);
      // An unparseable file is not a document; it is left for a human and
      // never served half-read. Skipped rather than thrown: this path runs on
      // every UI refresh, and one hand-edited file must not take out the whole
      // workspace's listing.
      if (r)
        out.push(
          await toWire(
            paths,
            loc,
            r.text,
            r.doc,
            bps.find((b) => b.id === r.doc.frontmatter.blueprint),
          ),
        );
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function listDocuments(paths: SmithPaths, workspaces: Workspace[]): Promise<DocWire[]> {
  const all: DocWire[] = [];
  for (const ws of activeWorkspaces(workspaces)) all.push(...(await listWorkspaceDocuments(paths, ws)));
  return all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function resolveDocument(paths: SmithPaths, workspaces: Workspace[], id: string): Promise<Located | null> {
  const hits: Located[] = [];
  for (const ws of activeWorkspaces(workspaces)) {
    for (const folder of FOLDERS) {
      if ((await listIds(paths, ws, folder)).includes(id)) hits.push(located(paths, ws, folder, id));
    }
  }
  if (hits.length > 1) {
    throw new AmbiguousDocumentError(
      id,
      hits.map((h) => `${h.ws.name}/${h.folder}`),
    );
  }
  return hits[0] ?? null;
}

export async function getDocument(paths: SmithPaths, workspaces: Workspace[], id: string): Promise<DocWire | null> {
  const loc = await resolveDocument(paths, workspaces, id);
  const r = loc && (await readParsed(loc));
  return loc && r
    ? toWire(paths, loc, r.text, r.doc, await blueprintFor(paths, loc.ws, r.doc.frontmatter.blueprint))
    : null;
}

async function freeId(paths: SmithPaths, ws: Workspace, folder: BlueprintFolder, base: string): Promise<string> {
  const taken = new Set(await listIds(paths, ws, folder));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

export async function createDocument(
  paths: SmithPaths,
  ws: Workspace,
  input: {
    blueprintId: string;
    workType?: string;
    title?: string;
    effort?: string;
    author: GitAuthor;
    now?: () => string;
  },
): Promise<StoreResult> {
  const bp = await blueprintFor(paths, ws, input.blueprintId);
  if (!bp) return { error: `unknown blueprint: ${input.blueprintId}`, status: 400 };
  const workType = input.workType ?? bp.workTypes[0] ?? "";
  const sections = instantiateSections(bp, workType);
  if (!sections) return { error: `workType must be one of: ${bp.workTypes.join(", ")}`, status: 400 };
  const now = (input.now ?? nowIso)();
  // `title` is a REQUIRED frontmatter scalar, and serializeDocumentFile throws
  // on an empty one rather than write `title: ` for parse to reject. A user
  // blueprint file may legally carry `"name": ""` (blueprints.ts keeps any
  // string), so the fallback runs one step further to the id.
  const title = squash(input.title) || squash(bp.name) || bp.id;
  const effort = slugify(squash(input.effort) || title); // slugify is TOTAL (document-file.ts) — no fallback needed
  const base = documentFileId(now, effort, bp.id);
  const doc: ParsedDocument = {
    frontmatter: {
      title,
      blueprint: bp.id,
      workType,
      status: "drafting",
      effort,
      slices: [],
      participants: [],
      pins: [],
      createdAt: now,
      updatedAt: now,
    },
    sections,
  };
  // `freeId` reads the directory that decides the id, so it MUST be in the
  // same queue slot as the write. Outside it, two creates for one effort in
  // the same minute both see the base id free, both mint it, and the second
  // write destroys the first document outright (task-7 review: 20/20).
  const written = await withOrgRepoQueue(paths.orgRepo, async () => {
    const id = await freeId(paths, ws, bp.folder, base);
    return writeDocInQueue(
      paths,
      located(paths, ws, bp.folder, id),
      doc,
      input.author,
      `${kindOf(bp.folder)}(${effort}): create`,
    );
  });
  // Queue released. The derived fields are computed out here — see `project`.
  return "error" in written ? written : project(paths, written);
}

/**
 * §9.3: a legacy broker Doc → file. Idempotent by id: the same legacy doc
 * (same createdAt + title) imported twice is refused. Open proposals become
 * branches; decided ones are dropped.
 *
 * Metadata is checked BEFORE anything is written, because a legacy JSON file
 * carries no guarantee that its fields still satisfy §2.2 — and a file whose
 * frontmatter `parseDocumentFile` rejects is a document destroyed by its own
 * migration. `createdAt` is identity (it mints the id) so a bad one refuses;
 * `updatedAt` is derived, so a bad one is replaced with now().
 */
export async function importDocument(
  paths: SmithPaths,
  ws: Workspace,
  legacy: LegacyDoc,
  now: () => string = nowIso,
): Promise<StoreResult> {
  const bp = await blueprintFor(paths, ws, legacy.blueprintId);
  if (!bp) return { error: `unknown blueprint: ${legacy.blueprintId}`, status: 400 };
  if (Number.isNaN(Date.parse(legacy.createdAt)))
    return { error: `createdAt "${legacy.createdAt}" is not an ISO date`, status: 400 };
  if (!bp.workTypes.includes(legacy.workType))
    return { error: `workType must be one of: ${bp.workTypes.join(", ")}`, status: 400 };
  if (!DOC_STATUSES.includes(legacy.status))
    return { error: `status must be one of ${DOC_STATUSES.join(" | ")}`, status: 400 };
  const participants = legacy.participants ?? [];
  const pins = legacy.pins ?? [];
  for (const [key, values] of [
    ["participants", participants],
    ["pins", pins],
  ] as const) {
    for (const value of values) {
      const problem = listValueProblem(value);
      if (problem) return { error: `${key} entry ${JSON.stringify(value)} cannot be stored — ${problem}`, status: 400 };
    }
  }
  const title = squash(legacy.title) || squash(bp.name) || bp.id;
  const effort = slugify(title); // slugify is TOTAL (document-file.ts) — no fallback needed
  const id = documentFileId(legacy.createdAt, effort, bp.id);
  const loc = located(paths, ws, bp.folder, id);
  const doc: ParsedDocument = {
    frontmatter: {
      title,
      blueprint: bp.id,
      workType: legacy.workType,
      status: legacy.status,
      effort,
      slices: [],
      participants,
      pins,
      createdAt: legacy.createdAt,
      updatedAt: Number.isNaN(Date.parse(legacy.updatedAt)) ? now() : legacy.updatedAt,
    },
    sections: legacy.sections.map((s) => ({ ...s, body: normalizeMarkdown(s.body) })),
  };
  // The "already imported" check and the write are ONE queue slot, so two
  // concurrent imports of the same legacy document cannot both find the file
  // absent. The proposal branches below are deliberately OUTSIDE it:
  // `createProposal` takes the queue itself, and `withOrgRepoQueue` is a plain
  // promise chain — calling it from inside a queued task deadlocks.
  const written = await withOrgRepoQueue(paths.orgRepo, async () => {
    if (await readParsed(loc)) return { error: `already imported as ${id}`, status: 409 };
    return writeDocInQueue(paths, loc, doc, SMITH_IDENTITY, `${kindOf(bp.folder)}(${effort}): import`);
  });
  if ("error" in written) return written;
  for (const p of legacy.proposals ?? []) {
    if (p.state !== "open" || !doc.sections.some((s) => s.id === p.sectionId)) continue;
    const proposed: ParsedDocument = {
      ...doc,
      sections: doc.sections.map((s) => (s.id === p.sectionId ? { ...s, body: normalizeMarkdown(p.newBody) } : s)),
    };
    const serialized = serializeOrRefuse(proposed);
    // A proposal that cannot be serialized is skipped, not thrown: the
    // document itself is already imported, and losing one pending edit must
    // not abort the rest of a §9.3 migration.
    if ("error" in serialized) continue;
    await createProposal(paths, {
      slug: loc.slug,
      docId: id,
      relPath: loc.relPath,
      newFileText: serialized.text,
      sectionId: p.sectionId,
      author: agentAuthor(p.agentId),
      rationale: p.rationale,
    });
  }
  const r = await readParsed(loc);
  return r ? toWire(paths, loc, r.text, r.doc, bp) : { error: "import did not read back", status: 500 };
}

/**
 * Resolve, re-read, apply `change`, write, commit — **all inside ONE
 * org-repo queue slot**. Every mutation in this module goes through here.
 *
 * The queue is what makes a mutation atomic against another mutation of the
 * same file. It is a read-modify-write: each `change` produces a WHOLE
 * serialized document from the text it read, so two overlapping mutations
 * outside the queue are plain last-writer-wins — the task-7 review measured
 * 8/8 lost edits on a two-section patch, 30/30 on three, and 5/8 `setStatus`
 * calls reporting a `final` the disk never received. Nothing in that sequence
 * is safe to leave outside.
 *
 * DEADLOCK DISCIPLINE: `withOrgRepoQueue` is a plain promise chain, so a
 * queued task must NEVER call another queueing function — the inner task
 * chains after its own enclosing task's completion token and neither ever
 * settles. Everything reachable from `change` must therefore be a READ
 * (`readParsed`, `listIds`, `loadBlueprintsFor`, `loadCapabilities`,
 * `listProposals`, `isDirty`) or the non-queueing `commitPathsInQueue`.
 * `createProposal`/`deleteProposal`/`commitPaths`/`commitConfigFiles` all
 * queue internally and must stay outside — which is why `addProposal`,
 * `acceptProposal` and `rejectProposal` call them sequentially rather than
 * from within a queued task of their own.
 *
 * The re-read and the `structuredClone` are deliberate, not duplication:
 * truth is the disk, so every mutation starts from the file as it is now, and
 * `change` gets a copy it can edit freely without a partial mutation
 * surviving a refusal. `change` may override the author (the accept path
 * commits as the proposing agent, whose identity is only known once the
 * proposal has been read inside the queue).
 */
async function mutate(
  paths: SmithPaths,
  workspaces: Workspace[],
  id: string,
  author: GitAuthor,
  change: (
    doc: ParsedDocument,
    loc: Located,
    bp: Blueprint | undefined,
    text: string,
  ) => Promise<
    | { doc: ParsedDocument; message: string; author?: GitAuthor }
    | { error: string; status: number; problems?: Problem[] }
    | null
  >,
): Promise<StoreResult | null> {
  const written = await withOrgRepoQueue<WrittenDoc | { error: string; status: number; problems?: Problem[] } | null>(
    paths.orgRepo,
    async () => {
      const loc = await resolveDocument(paths, workspaces, id);
      const r = loc && (await readParsed(loc));
      if (!loc || !r) return null;
      const bp = await blueprintFor(paths, loc.ws, r.doc.frontmatter.blueprint);
      const result = await change(structuredClone(r.doc), loc, bp, r.text);
      if (result === null) return null;
      if ("error" in result) return result;
      result.doc.frontmatter.updatedAt = nowIso();
      return writeDocInQueue(paths, loc, result.doc, result.author ?? author, result.message);
    },
  );
  // The queue is RELEASED here: `withOrgRepoQueue` resolves when its task
  // resolves, and the next queued task is chained on exactly that promise. So
  // everything below runs concurrently with whoever was waiting — which is the
  // whole point of doing the projection out here. See `project`.
  if (written === null) return null;
  if ("error" in written) return written;
  return project(paths, written);
}

export function patchSection(
  paths: SmithPaths,
  workspaces: Workspace[],
  id: string,
  sectionId: string,
  body: string,
  author: GitAuthor,
): Promise<StoreResult | null> {
  return mutate(paths, workspaces, id, author, async (doc, loc) => {
    const s = doc.sections.find((x) => x.id === sectionId);
    if (!s) return null;
    s.body = normalizeMarkdown(body);
    // The preamble's id is `""` (§2.2), which would end the commit subject at
    // the colon and leave a blank entry in the audit trail.
    const label = sectionId || "preamble";
    return { doc, message: `${kindOf(loc.folder)}(${doc.frontmatter.effort}): ${label}` };
  });
}

export function renameDocument(
  paths: SmithPaths,
  workspaces: Workspace[],
  id: string,
  title: string,
  author: GitAuthor,
): Promise<StoreResult | null> {
  return mutate(paths, workspaces, id, author, async (doc, loc) => {
    // Refused rather than written: `title` is REQUIRED, and an empty one
    // serializes as `title: `, which parseDocumentFile rejects — the document
    // would be unreadable from its own rename.
    const clean = squash(title);
    if (!clean) return { error: "a document needs a title", status: 400 };
    doc.frontmatter.title = clean;
    return { doc, message: `${kindOf(loc.folder)}(${doc.frontmatter.effort}): rename` };
  });
}

export function setPins(
  paths: SmithPaths,
  workspaces: Workspace[],
  id: string,
  pins: string[],
  author: GitAuthor,
): Promise<StoreResult | null> {
  return mutate(paths, workspaces, id, author, async (doc, loc) => {
    const clean = [...new Set(pins.map((p) => p.trim()).filter(Boolean))];
    for (const pin of clean) {
      const problem = listValueProblem(pin);
      if (problem) return { error: `pin ${JSON.stringify(pin)} cannot be stored — ${problem}`, status: 400 };
    }
    doc.frontmatter.pins = clean;
    return { doc, message: `${kindOf(loc.folder)}(${doc.frontmatter.effort}): pins` };
  });
}

/**
 * Has the user written anything here yet? A section counts as untouched when
 * it is empty OR still byte-identical to the starter its OWN blueprint seeded
 * (`instantiateSections` writes `starter` as the birth body, and both diagram
 * blueprints ship one). Without this, a just-created `er` document could never
 * be re-cast to `sequence` — the user picks the wrong diagram type and is told
 * they have content they never typed (task-7 review, I2).
 */
function isUntouched(doc: ParsedDocument, bp: Blueprint | undefined): boolean {
  const starters = new Map(
    (bp ? (instantiateSections(bp, doc.frontmatter.workType) ?? []) : []).map((s) => [s.id, s.body]),
  );
  return doc.sections.every((s) => !s.body.trim() || s.body === starters.get(s.id));
}

/**
 * Re-cast under another blueprint: only within the same folder (the file
 * never moves — its name is its id, minted once), and only while the user has
 * written nothing (re-casting replaces the section set, so any body the user
 * typed would be discarded).
 *
 * Order matters when both refusals apply: the folder is reported first
 * because it is the one that can never be satisfied for this document —
 * emptying the sections would still not make a plan out of a spec file, and
 * "create a new document instead" is the actionable answer.
 */
export function changeBlueprint(
  paths: SmithPaths,
  workspaces: Workspace[],
  id: string,
  blueprintId: string,
  workType: string | undefined,
  author: GitAuthor,
): Promise<StoreResult | null> {
  return mutate(paths, workspaces, id, author, async (doc, loc, current) => {
    const bp = await blueprintFor(paths, loc.ws, blueprintId);
    if (!bp) return { error: `unknown blueprint: ${blueprintId}`, status: 400 };
    const wt = workType ?? bp.workTypes[0] ?? "";
    const sections = instantiateSections(bp, wt);
    if (!sections) return { error: `workType must be one of: ${bp.workTypes.join(", ")}`, status: 400 };
    if (bp.folder !== loc.folder) {
      return {
        error: `"${blueprintId}" lives in ${bp.folder}/, this document in ${loc.folder}/ — create a new document instead`,
        status: 409,
      };
    }
    if (!isUntouched(doc, current))
      return { error: "the document already has content — re-casting would discard it", status: 409 };
    doc.frontmatter.blueprint = bp.id;
    doc.frontmatter.workType = wt;
    doc.sections = sections;
    return { doc, message: `${kindOf(loc.folder)}(${doc.frontmatter.effort}): blueprint → ${bp.id}` };
  });
}

export function setStatus(
  paths: SmithPaths,
  workspaces: Workspace[],
  id: string,
  status: DocStatus,
  author: GitAuthor,
): Promise<StoreResult | null> {
  return mutate(paths, workspaces, id, author, async (doc, loc, bp) => {
    if (!bp) return { error: `unknown blueprint: ${doc.frontmatter.blueprint}`, status: 409 };
    const problems = await transitionProblems(bp, doc, status, resolvers(paths, loc.ws));
    if (problems.length > 0) {
      return {
        error: `cannot move to ${status}: ${problems.map((p) => `${p.where} — ${p.message}`).join("; ")}`,
        status: 409,
        problems,
      };
    }
    doc.frontmatter.status = status;
    return { doc, message: `${kindOf(loc.folder)}(${doc.frontmatter.effort}): status → ${status}` };
  });
}

export async function addProposal(
  paths: SmithPaths,
  workspaces: Workspace[],
  id: string,
  p: { sectionId: string; newBody: string; agentId: string; rationale: string },
): Promise<StoreResult | null> {
  const loc = await resolveDocument(paths, workspaces, id);
  const r = loc && (await readParsed(loc));
  if (!loc || !r) return null;
  if (!r.doc.sections.some((s) => s.id === p.sectionId)) return null;
  const proposed: ParsedDocument = {
    ...r.doc,
    sections: r.doc.sections.map((s) => (s.id === p.sectionId ? { ...s, body: normalizeMarkdown(p.newBody) } : s)),
  };
  const serialized = serializeOrRefuse(proposed);
  if ("error" in serialized) return serialized;
  await createProposal(paths, {
    slug: loc.slug,
    docId: id,
    relPath: loc.relPath,
    newFileText: serialized.text,
    sectionId: p.sectionId,
    author: agentAuthor(p.agentId),
    rationale: p.rationale,
  });
  return getDocument(paths, workspaces, id);
}

/**
 * Accept = the section write on main as the proposing agent, then the branch
 * goes. Two refusals guard it, and both are evaluated INSIDE `mutate`'s queue
 * slot against the same read the write is built from — outside it, either
 * could be decided against a file that has since changed:
 *
 * - **stale**: the text the proposal was written against is gone.
 * - **dirty** (spec §4): the document's own file has uncommitted changes.
 *   Accepting would sweep a human's hand edit into the agent's commit, so the
 *   human's paragraph would land authored by the agent — the exact guarantee
 *   §1.4 exists to provide (task-7 review, I3). Scoped to THIS document's
 *   file: an unrelated dirty file elsewhere in the org repo is not this
 *   accept's business.
 *
 * `deleteProposal` runs after `mutate` returns, never inside it — it takes the
 * queue itself (see the deadlock discipline on `mutate`). The document is then
 * re-read, because `mutate`'s wire shape was built while the branch still
 * existed and would still list the accepted proposal.
 */
export async function acceptProposal(
  paths: SmithPaths,
  workspaces: Workspace[],
  id: string,
  proposalId: string,
): Promise<StoreResult | null> {
  // Resolved up front only for the slug, which is a function of the workspace
  // name; `mutate` re-resolves and re-reads authoritatively inside the queue.
  const pre = await resolveDocument(paths, workspaces, id);
  if (!pre) return null;
  const result = await mutate(paths, workspaces, id, SMITH_IDENTITY, async (doc, loc, _bp, text) => {
    const live = (
      await listProposals(paths, { slug: loc.slug, docId: id, relPath: loc.relPath, currentFileText: text })
    ).find((p) => p.id === proposalId);
    if (!live) return null;
    if (live.state === "stale") {
      return {
        error: `proposal ${proposalId} is stale — "${live.sectionId}" changed since it was written; reject it or ask for a new one`,
        status: 409,
      };
    }
    if (await isDirty(paths.orgRepo, loc.relPath)) {
      return {
        error: `${loc.relPath} has uncommitted changes — commit or discard them before accepting`,
        status: 409,
      };
    }
    const s = doc.sections.find((x) => x.id === live.sectionId);
    if (!s) return null;
    s.body = live.newBody;
    return {
      doc,
      message: `${kindOf(loc.folder)}(${doc.frontmatter.effort}): accept proposal ${proposalId} — ${live.sectionId}`,
      author: agentAuthor(live.agentId),
    };
  });
  // A refusal from `mutate` is returned as itself: deleting the branch after
  // one, or returning the document as though the accept had happened, would
  // report a failure as a success.
  if (result === null) return null;
  if ("error" in result) return result;
  await deleteProposal(paths, { slug: pre.slug, docId: id, id: proposalId });
  return getDocument(paths, workspaces, id);
}

export async function rejectProposal(
  paths: SmithPaths,
  workspaces: Workspace[],
  id: string,
  proposalId: string,
): Promise<StoreResult | null> {
  const loc = await resolveDocument(paths, workspaces, id);
  if (!loc) return null;
  const gone = await deleteProposal(paths, { slug: loc.slug, docId: id, id: proposalId });
  return gone ? getDocument(paths, workspaces, id) : null;
}
