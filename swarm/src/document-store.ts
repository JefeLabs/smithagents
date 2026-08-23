// The document store (spec 2026-08-22 §3): the fs+git facade over
// document-file (text), blueprints (schema), document-rules (gates), and
// document-proposals (branches). Truth is the disk — every read lists the
// directory, every mutation writes the file and commits exactly that file
// through the per-org-repo queue with the acting author. No cache.
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
import { commitPaths } from "./workspace-repos.js";
import { activeWorkspaces, configDirFor, slugForDir, type Workspace } from "./workspaces.js";

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
    return (await readdir(join(configDirFor(paths, ws), folder)))
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.slice(0, -3));
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
 * Write the file and commit exactly it. Returns the fresh wire shape.
 *
 * The write happens before `commitPaths` enters the per-org-repo queue, so a
 * concurrent reader can observe a written-but-uncommitted file — the same
 * state a hand edit produces, and accepted as such. Closing that window means
 * running the write INSIDE the queue, which needs a commit primitive that
 * does not itself enter the queue (`withOrgRepoQueue` is a plain promise
 * chain and re-entering it from a queued task deadlocks) — a change to
 * workspace-repos.ts, not to this module.
 */
async function writeDoc(
  paths: SmithPaths,
  loc: Located,
  doc: ParsedDocument,
  author: GitAuthor,
  message: string,
): Promise<DocWire> {
  await mkdir(dirname(loc.absPath), { recursive: true });
  const text = serializeDocumentFile(doc);
  await writeFile(loc.absPath, text);
  await commitPaths(paths, [loc.relPath], { author, message });
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
  const id = await freeId(paths, ws, bp.folder, documentFileId(now, effort, bp.id));
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
  return writeDoc(
    paths,
    located(paths, ws, bp.folder, id),
    doc,
    input.author,
    `${kindOf(bp.folder)}(${effort}): create`,
  );
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
  if (await readParsed(loc)) return { error: `already imported as ${id}`, status: 409 };
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
  await writeDoc(paths, loc, doc, SMITH_IDENTITY, `${kindOf(bp.folder)}(${effort}): import`);
  for (const p of legacy.proposals ?? []) {
    if (p.state !== "open" || !doc.sections.some((s) => s.id === p.sectionId)) continue;
    const proposed: ParsedDocument = {
      ...doc,
      sections: doc.sections.map((s) => (s.id === p.sectionId ? { ...s, body: normalizeMarkdown(p.newBody) } : s)),
    };
    await createProposal(paths, {
      slug: loc.slug,
      docId: id,
      relPath: loc.relPath,
      newFileText: serializeDocumentFile(proposed),
      sectionId: p.sectionId,
      author: agentAuthor(p.agentId),
      rationale: p.rationale,
    });
  }
  const r = await readParsed(loc);
  return r ? toWire(paths, loc, r.text, r.doc, bp) : { error: "import did not read back", status: 500 };
}

/**
 * Resolve, re-read, apply `change`, write, commit. The re-read and the
 * `structuredClone` are deliberate, not duplication: truth is the disk, so
 * every mutation starts from the file as it is now, and `change` gets a copy
 * it can edit freely without a partial mutation surviving a refusal.
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
  ) => Promise<
    { doc: ParsedDocument; message: string } | { error: string; status: number; problems?: Problem[] } | null
  >,
): Promise<StoreResult | null> {
  const loc = await resolveDocument(paths, workspaces, id);
  const r = loc && (await readParsed(loc));
  if (!loc || !r) return null;
  const bp = await blueprintFor(paths, loc.ws, r.doc.frontmatter.blueprint);
  const result = await change(structuredClone(r.doc), loc, bp);
  if (result === null) return null;
  if ("error" in result) return result;
  result.doc.frontmatter.updatedAt = nowIso();
  return writeDoc(paths, loc, result.doc, author, result.message);
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
    return { doc, message: `${kindOf(loc.folder)}(${doc.frontmatter.effort}): ${sectionId}` };
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
 * Re-cast under another blueprint: only within the same folder (the file
 * never moves — its name is its id, minted once), and only while every
 * section is empty (re-casting replaces the section set, so any body would be
 * discarded).
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
  return mutate(paths, workspaces, id, author, async (doc, loc) => {
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
    if (doc.sections.some((s) => s.body.trim()))
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
  await createProposal(paths, {
    slug: loc.slug,
    docId: id,
    relPath: loc.relPath,
    newFileText: serializeDocumentFile(proposed),
    sectionId: p.sectionId,
    author: agentAuthor(p.agentId),
    rationale: p.rationale,
  });
  return getDocument(paths, workspaces, id);
}

/**
 * Accept = the section write on main as the proposing agent, then the branch
 * goes. A stale proposal is refused: the text it was written against is gone.
 * The document is re-read at the end rather than returning `mutate`'s wire
 * shape, because that shape was built while the branch still existed.
 */
export async function acceptProposal(
  paths: SmithPaths,
  workspaces: Workspace[],
  id: string,
  proposalId: string,
): Promise<StoreResult | null> {
  const loc = await resolveDocument(paths, workspaces, id);
  const r = loc && (await readParsed(loc));
  if (!loc || !r) return null;
  const live = (
    await listProposals(paths, { slug: loc.slug, docId: id, relPath: loc.relPath, currentFileText: r.text })
  ).find((p) => p.id === proposalId);
  if (!live) return null;
  if (live.state === "stale") {
    return {
      error: `proposal ${proposalId} is stale — "${live.sectionId}" changed since it was written; reject it or ask for a new one`,
      status: 409,
    };
  }
  const result = await mutate(paths, workspaces, id, agentAuthor(live.agentId), async (doc, l) => {
    const s = doc.sections.find((x) => x.id === live.sectionId);
    if (!s) return null;
    s.body = live.newBody;
    return {
      doc,
      message: `${kindOf(l.folder)}(${doc.frontmatter.effort}): accept proposal ${proposalId} — ${live.sectionId}`,
    };
  });
  // A refusal from `mutate` is returned as itself: deleting the branch after
  // one, or returning the document as though the accept had happened, would
  // report a failure as a success.
  if (result === null) return null;
  if ("error" in result) return result;
  await deleteProposal(paths, { slug: loc.slug, docId: id, id: proposalId });
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
