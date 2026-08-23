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

/**
 * The only shape a real, machine-allocated proposal number can take as a ref
 * segment or a caller-supplied id: no fractional forms, no leading zero, no
 * leading `+`, no leading/trailing whitespace, no scientific notation.
 * `Number()` coerces every one of those aliases to the SAME integer a real id
 * could have (`Number("1.0") === 1`, `Number(" 1") === 1`, …), so validation
 * has to reject the STRING before it ever reaches `Number()` — checking
 * `Number.isInteger()` after the fact is too late, because the alias and the
 * real id are, by then, indistinguishable (task-6 review, Important #2–#4).
 */
const PROPOSAL_ID_RE = /^[1-9]\d*$/;

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

/**
 * The proposal numbers that actually exist under this document's ref prefix.
 * Each ref segment is validated as a STRING against `PROPOSAL_ID_RE` before
 * `Number()` ever sees it — a hand-made ref named `1.0`, `+1`, `01`, or
 * `1e21` is dropped here, never counted for `<n>` allocation and never
 * listed as a duplicate of the real proposal it would otherwise alias onto
 * (task-6 review, Important #3–#4).
 */
async function existingNumbers(dir: string, slug: string, docId: string): Promise<number[]> {
  const prefix = proposalPrefix(slug, docId);
  const out = await git(dir, ["for-each-ref", "--format=%(refname)", prefix]);
  return out
    .split("\n")
    .filter(Boolean)
    .map((ref) => ref.slice(prefix.length))
    .filter((segment) => PROPOSAL_ID_RE.test(segment))
    .map(Number);
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
    // `--path` runs the blob through the SAME clean/eol filters as adding at
    // this path would (core.autocrlf, .gitattributes) — without it, a CRLF
    // body hashes to a different blob than committing the same text
    // normally would, so a diff against main reports the whole file as
    // changed instead of just the proposed section (task-6 review,
    // Important #1). The bare hash-object step never touched the index
    // anyway, so this stays outside the private-index scope below.
    const blob = (
      await git(dir, ["hash-object", "-w", "--path", p.relPath, "--stdin"], undefined, p.newFileText)
    ).trim();
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

/**
 * Show the file's text at one point, returning `null` — never `""` — when
 * the path or ref cannot be read there. `null` and `""` are NOT the same
 * thing: `""` is a legitimate (if unusual) file body, e.g. a proposal that
 * empties the document; only `null` means "this point does not carry the
 * file at all." Conflating the two used to silently drop a real, emptying
 * proposal from the listing (task-6 review, Minor #6).
 */
async function showFile(dir: string, sha: string, relPath: string): Promise<string | null> {
  try {
    return await git(dir, ["show", `${sha}:${relPath}`]);
  } catch {
    return null;
  }
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
    // No merge-base with main means no shared history at all — by spec §4 a
    // proposal's parent IS main, so a ref with none cannot be a real
    // proposal. Falling through used to default `baseText` to `""`, which
    // made every section "differ" and misattributed the branch's FIRST
    // section as the proposed edit — text nobody proposed (task-6 review,
    // Minor #5). Skip the ref outright instead.
    if (base === null) return null;
    const branchText = await showFile(dir, sha, relPath);
    if (branchText === null) return null; // the file does not exist on this branch at all
    const baseText = await showFile(dir, base, relPath);
    if (baseText === null) return null; // the file did not exist yet at the branch point — nothing to diff against
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
  // Validate the STRING before it ever reaches Number() — see PROPOSAL_ID_RE.
  if (!PROPOSAL_ID_RE.test(p.id)) return null;
  const n = Number(p.id);
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
  if (base === null) return null; // no shared history with main — not a real proposal (spec §4)
  const branchText = await showFile(dir, sha, p.relPath);
  if (branchText === null) return null; // the branch does not carry this file — nothing to show
  const baseText = await showFile(dir, base, p.relPath);
  if (baseText === null) return null;
  return { branchText, baseText };
}

/** Delete the branch; reflog keeps the commit. False when it was already gone. */
export async function deleteProposal(
  paths: SmithPaths,
  p: { slug: string; docId: string; id: string },
): Promise<boolean> {
  return withOrgRepoQueue(paths.orgRepo, async () => {
    // Validate the STRING before it ever reaches Number() — see
    // PROPOSAL_ID_RE. Delete is the destructive verb: Number("1.0") and
    // Number("1") are the same value, so without this an alias id deletes
    // the real proposal (task-6 review, Important #2).
    if (!PROPOSAL_ID_RE.test(p.id)) return false;
    const n = Number(p.id);
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
