// Proposals as branches (spec 2026-08-22 §4). A pending edit is a commit on
// refs/heads/proposals/<slug>/<docId>/<n> whose parent is main; the live
// checkout is never touched — the commit is built with plumbing against a
// temporary index. Accept and reject are the store's job (document-store.ts):
// accept is an ordinary section write on main with the proposal's author,
// reject deletes the branch. Reflog keeps deleted proposals for git's default
// 90 days.
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { splitSections } from "./document-file.js";
import { type GitAuthor, SMITH_IDENTITY } from "./git-author.js";
import type { SmithPaths } from "./paths.js";
import { withOrgRepoQueue } from "./workspace-repos.js";

const run = promisify(execFile);

export interface ProposalWire {
  id: string;
  sectionId: string;
  agentId: string;
  newBody: string;
  rationale: string;
  state: "open" | "stale";
  createdAt: string;
}

export function proposalRef(slug: string, docId: string, n: number): string {
  return `refs/heads/proposals/${slug}/${docId}/${n}`;
}

function proposalPrefix(slug: string, docId: string): string {
  return `refs/heads/proposals/${slug}/${docId}/`;
}

/**
 * Run a git command, optionally feeding `input` to its stdin (the only case
 * that needs it is `hash-object -w --stdin`). `promisify(execFile)` returns a
 * promise carrying a `.child` property (Node's own documented escape hatch
 * for exactly this) — writing to `child.stdin` before awaiting is enough;
 * verified directly against this repo's Node version rather than assumed.
 */
async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv, input?: string): Promise<string> {
  const child = run("git", args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (input !== undefined && child.child.stdin) {
    child.child.stdin.end(input);
  }
  return (await child).stdout.toString();
}

async function existingNumbers(dir: string, slug: string, docId: string): Promise<number[]> {
  const prefix = proposalPrefix(slug, docId);
  const out = await git(dir, ["for-each-ref", "--format=%(refname)", prefix]);
  return out
    .split("\n")
    .filter(Boolean)
    .map((ref) => Number(ref.slice(prefix.length)))
    .filter((n) => Number.isInteger(n));
}

/** The rationale is the commit subject; the section id rides as a trailer so listing never has to diff to find it. */
function messageFor(rationale: string, sectionId: string): string {
  const subject = rationale.replace(/\s+/g, " ").trim() || "proposal";
  return `${subject}\n\nSection: ${sectionId}\n`;
}

export async function createProposal(
  paths: SmithPaths,
  p: {
    slug: string;
    docId: string;
    relPath: string;
    newFileText: string;
    sectionId: string;
    author: GitAuthor;
    rationale: string;
  },
): Promise<{ id: string }> {
  return withOrgRepoQueue(paths.orgRepo, async () => {
    const dir = paths.orgRepo;
    const base = (await git(dir, ["rev-parse", "refs/heads/main"])).trim();
    // Allocated INSIDE the queue (spec §4 amendment) — two concurrent
    // createProposal calls on the same document must never see the same
    // existingNumbers() snapshot.
    const n = Math.max(0, ...(await existingNumbers(dir, p.slug, p.docId))) + 1;
    const blob = (await git(dir, ["hash-object", "-w", "--stdin"], undefined, p.newFileText)).trim();
    // A private index: read main's tree into it, swap the one blob, write the
    // tree. The repo's own index — and the live checkout — never see any of it.
    const tmp = await mkdtemp(join(tmpdir(), "proposal-index-"));
    const env = { GIT_INDEX_FILE: join(tmp, "index") };
    try {
      await git(dir, ["read-tree", base], env);
      await git(dir, ["update-index", "--add", "--cacheinfo", `100644,${blob},${p.relPath}`], env);
      const tree = (await git(dir, ["write-tree"], env)).trim();
      const commit = (
        await git(dir, ["commit-tree", tree, "-p", base, "-m", messageFor(p.rationale, p.sectionId)], {
          GIT_AUTHOR_NAME: p.author.name,
          GIT_AUTHOR_EMAIL: p.author.email,
          GIT_COMMITTER_NAME: SMITH_IDENTITY.name,
          GIT_COMMITTER_EMAIL: SMITH_IDENTITY.email,
        })
      ).trim();
      await git(dir, ["update-ref", proposalRef(p.slug, p.docId, n), commit]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
    return { id: String(n) };
  });
}

function sectionBody(text: string, sectionId: string): string | undefined {
  return splitSections(text.replace(/^---\n[\s\S]*?\n---\n?/, "")).find((s) => s.id === sectionId)?.body;
}

/** `git show <sha>:<relPath>`, degrading to `""` when the path or ref cannot be read at that point — a hand-made branch may not carry the file at all. */
async function showFile(dir: string, sha: string, relPath: string): Promise<string> {
  return git(dir, ["show", `${sha}:${relPath}`]).catch(() => "");
}

/**
 * One proposal's wire shape, or `null` if this branch cannot be turned into
 * one — a hand-made or otherwise malformed ref (unrelated history so
 * merge-base fails, no file at all at `relPath`, no section changed). Total:
 * every git call inside is allowed to fail; a bad ref is dropped, never
 * thrown, because `listProposals` runs on every document read and one
 * malformed branch must not take out the rest of the listing (`for-each-ref`
 * finding the ref at all is the only thing assumed).
 */
async function readProposal(
  dir: string,
  relPath: string,
  currentFileText: string,
  n: number,
  ref: string,
): Promise<ProposalWire | null> {
  try {
    const [sha, author, date, subject, body] = (
      await git(dir, ["log", "-1", "--format=%H%x00%an%x00%aI%x00%s%x00%b", ref])
    ).split("\0");
    if (!sha) return null;
    const sectionId = /^Section: (.+)$/m.exec(body ?? "")?.[1]?.trim();
    const base = await git(dir, ["merge-base", "refs/heads/main", sha])
      .then((s) => s.trim())
      .catch(() => null);
    const branchText = await showFile(dir, sha, relPath);
    if (!branchText) return null; // nothing to show — the file does not exist on this branch
    const baseText = base ? await showFile(dir, base, relPath) : "";
    // Without a trailer (a hand-made branch), find the one section that changed.
    const changed =
      sectionId ??
      splitSections(branchText.replace(/^---\n[\s\S]*?\n---\n?/, "")).find(
        (s) => sectionBody(baseText, s.id) !== s.body,
      )?.id;
    if (!changed) return null;
    const newBody = sectionBody(branchText, changed) ?? "";
    const stale = sectionBody(baseText, changed) !== sectionBody(currentFileText, changed);
    return {
      id: String(n),
      sectionId: changed,
      agentId: author,
      newBody,
      rationale: subject,
      state: stale ? "stale" : "open",
      createdAt: date,
    };
  } catch {
    // Any other git failure on this one ref (a corrupt object, a ref that
    // does not resolve to a commit, …) drops just this proposal.
    return null;
  }
}

export async function listProposals(
  paths: SmithPaths,
  p: { slug: string; docId: string; relPath: string; currentFileText: string },
): Promise<ProposalWire[]> {
  const dir = paths.orgRepo;
  const out: ProposalWire[] = [];
  const numbers = await existingNumbers(dir, p.slug, p.docId).catch(() => [] as number[]);
  for (const n of numbers.sort((a, b) => a - b)) {
    const proposal = await readProposal(dir, p.relPath, p.currentFileText, n, proposalRef(p.slug, p.docId, n));
    if (proposal) out.push(proposal);
  }
  return out;
}

export async function proposalFileText(
  paths: SmithPaths,
  p: { slug: string; docId: string; id: string; relPath: string },
): Promise<{ branchText: string; baseText: string } | null> {
  const dir = paths.orgRepo;
  const n = Number(p.id);
  if (!Number.isInteger(n)) return null;
  const ref = proposalRef(p.slug, p.docId, n);
  let sha: string;
  try {
    sha = (await git(dir, ["rev-parse", "--verify", "--quiet", ref])).trim();
    if (!sha) return null;
  } catch {
    return null;
  }
  const base = await git(dir, ["merge-base", "refs/heads/main", sha])
    .then((s) => s.trim())
    .catch(() => null);
  const branchText = await git(dir, ["show", `${sha}:${p.relPath}`]).catch(() => null);
  if (branchText === null) return null; // the branch does not carry this file — nothing to show
  const baseText = base ? await showFile(dir, base, p.relPath) : "";
  return { branchText, baseText };
}

/** Delete the branch; reflog keeps the commit. False when it was already gone. */
export async function deleteProposal(
  paths: SmithPaths,
  p: { slug: string; docId: string; id: string },
): Promise<boolean> {
  return withOrgRepoQueue(paths.orgRepo, async () => {
    const n = Number(p.id);
    if (!Number.isInteger(n)) return false;
    const ref = proposalRef(p.slug, p.docId, n);
    try {
      const sha = (await git(paths.orgRepo, ["rev-parse", "--verify", "--quiet", ref])).trim();
      if (!sha) return false;
    } catch {
      return false;
    }
    await git(paths.orgRepo, ["update-ref", "-d", ref]);
    return true;
  });
}
