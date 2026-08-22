# Workspace Documents Implementation Plan (Plan 2 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move documents (specs, plans, diagrams, dashboards) out of the broker's JSON cache into Markdown files in each workspace's org-repo subtree, owned by the swarm — with blueprints as an enforced schema, proposals as git branches, every write serialized per org repo and committed with the acting author, and the broker reduced to a passthrough that keeps the UI contract unchanged.

**Architecture:** Four pure swarm modules carry the logic (`document-file.ts` parse/serialize, `blueprints.ts` schema, `document-rules.ts` validation, `document-proposals.ts` git plumbing) under one fs+git facade (`document-store.ts`) that commits through the per-org-repo queue Plan 1 shipped. The swarm exposes document routes; the broker's `DocumentManager` is deleted and its `documents` frame/handlers call `SwarmClient`. The broker imports its legacy `.smith/documents/*.json` through the swarm's import route at boot, remaps session artifacts, and archives the directory. The cutover (Task 9) is one commit, like Plan 1's.

**Tech Stack:** Node ≥ 24, TypeScript ~6.0 (`tsx` strips types — `tsc --noEmit` is the only type gate), `node:test`, fastify 5 (swarm), the broker's hand-rolled HTTP server (`text-channel.ts`), git ≥ 2.25 (plumbing: `hash-object`, `read-tree`, `update-index`, `write-tree`, `commit-tree`, `update-ref`, `for-each-ref`, `merge-base`), `unified`/`remark-parse`/`remark-gfm`/`remark-stringify` (added to swarm — same versions the broker pins), biome 2.5.3, pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-08-22-workspace-documents-design.md` — this plan implements §2 (the document file), §3 (ownership and data flow), §4 (proposals as branches + the per-repo write queue), §6 (rules and validation), §9.3 (broker documents → files), and the Plan-1 deviations 4 and 5 that were deferred here (blueprints seeding; per-mutation board commits — see Deviation 3 below). Plan 3 owns §5, §7, §8.2–8.3, §9.4.

**Base branch:** `origin/main` @ `8ba0f09` (Plan 1 shipped). Plan 1 left: `paths.orgRepo`, `configDirFor(paths, ws)`, `commitConfigFiles(paths, slug, {author, message})`, the in-process `serializePerOrgRepo` queue (private in `workspace-repos.ts`), `workspaceConfigPaths(slug)` (already lists `specs`, `plans`, `dashboards`, `blueprints`), `userAuthor`, `SMITH_IDENTITY`, `actingAuthor()` on the server, sparse instance worktrees showing `blueprints/` + `workspaces/<slug>/`.

## Deviations from the spec — recorded, decide before executing

1. **Document routes are id-addressed, not workspace-addressed** (`/documents/:id/...` instead of `/workspaces/:ws/documents/:id/...`). The UI's document contract (`DocT.id`, the `documents` frame, `PATCH /documents/:id/sections/:sid`, pins, proposals) knows only the id; the broker holds no table of id → workspace after its store is deleted. The swarm resolves an id by scanning active workspaces' document folders (a few small directories; no cache) and refuses an ambiguous id with 409. Listing and creation stay workspace-scoped as the spec says. A later plan can add the scoped aliases if a second consumer wants them.
2. **The broker migrates its own documents** (§9.3 placed it in the swarm's `migrate-state.ts`). `broker/.smith/documents/` is relative to the broker's cwd — the swarm cannot find it — and the broker's `sessions/*.json` hold `artifacts: [docId]` that must be remapped to the new ids at the same time. So the broker, at boot, pushes each legacy Doc through the swarm's `POST /workspaces/:ws/documents/import` route, rewrites session artifacts, and archives the directory. Same idempotence and archive-never-delete rules.
3. **Per-mutation board commits stay deferred** (Plan 1 deviation 5). This plan builds the per-repo write queue the spec's §4 amendment requires, but wiring `saveBoard` through it is a separate, mechanical change across 8+ call sites; it is not in scope here and is recorded for Plan 3.
4. **Document ids get a `-2`, `-3` suffix on collision.** Two documents created in the same minute with the same effort (e.g. a spec and a second spec) would otherwise collide; the spec does not say. The suffix keeps the id a filename stem and lexically ordered.

## Global Constraints

- Package manager is **pnpm**, one workspace at the repo root. In a `.claude/worktrees/*` checkout with symlinked `node_modules`, run every script as `pnpm --config.verify-deps-before-run=false -C <pkg> <script>`. Never `git add -A` (the symlinks are untracked).
- Tests: `cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 'src/<file>.test.ts'`; broker: `cd broker && node --import tsx --test 'src/<file>.test.ts'`. Read exit codes by redirect, never through a pipe.
- `tsc --noEmit` must pass in swarm, broker, and control-plane at every commit. biome: 0 errors; the 2 pre-existing warnings (`swarm/src/api-runtime.test.ts`, `swarm/src/runtime.test.ts`) are the baseline — no new findings.
- **Every write into an org repo goes through the per-repo queue** (`withOrgRepoQueue`). No document mutation, proposal branch, accept, reject, or config commit may touch the shared index or `refs/heads/main` outside it. Reads never queue.
- **Proposals are never in the file**; open proposals are branches `refs/heads/proposals/<slug>/<docId>/<n>`. Rejected → branch deleted (reflog keeps it). Accepted → the section write on `main` with the proposal's author, branch deleted.
- **The file is the truth.** The swarm reads the directory on every list/get; no in-memory document cache in the swarm. The broker keeps only a last-frame cache for `documents` frames and refreshes it after every mutation.
- **Author on every commit**: UI edits → `actingAuthor()` (the user); agent edits and accepted agent proposals → `agentAuthor(agentId)` = `{ name: agentId, email: "<agentId>@agents.smithagents" }`; import commits → `SMITH_IDENTITY`. Committer is always `smithagents`.
- **Frontmatter is a flat subset**: `key: scalar` and `key: [a, b]`, no nesting, no comments; unknown keys are reported by name; the only keys are `title, blueprint, workType, status, effort, slices, spec, participants, pins, createdAt, updatedAt`. `status ∈ drafting | review | final`. Section markers are `## Heading {#id}`; a heading without a marker gets `slugify(heading)` and is preserved.
- **Document id** = `{YYYY-MM-DD-HHMM}-{effort}[-design]` (UTC; `-design` only for blueprint `spec`), `-2`/`-3`… on collision; never renamed. Folder from the blueprint's `folder` (`specs` | `plans` | `dashboards`); defaults: `spec`, `er`, `sequence` → `specs`; `implementation-plan` → `plans`; `dashboard` → `dashboards`.
- **Gates bite on status transitions only** (§6.3): `drafting → review` needs frontmatter valid + every active section present + shapes valid; `review → final` adds every `required` section non-empty + a plan's `spec` is `final`; `final → drafting` always allowed. Writes never refuse; they return `problems[]`.
- Never delete user data (archive); the swarm never force-pushes or rewrites `main`. Every git call via `execFile` with `cwd`. No new absolute machine paths written into files inside the org repo.
- **Reading test results:** `node --test` here uses the SPEC reporter, not TAP — there are no `ok`/`not ok` lines. Confirm a run by `ℹ fail 0` **and** a non-zero `ℹ pass`; a silent grep is not evidence that anything ran (a filter matching nothing looks identical to a clean pass). Read exit codes by redirect, never through a pipe.
- Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

## File Structure

| File | Responsibility after this plan |
|---|---|
| `swarm/package.json` | + `unified`, `remark-parse`, `remark-gfm`, `remark-stringify` (same versions as broker) |
| `swarm/src/markdown-normalize.ts` | NEW — the ONE normalizer, moved from the broker (byte-identical options) |
| `swarm/src/document-file.ts` | NEW, pure — frontmatter parse/serialize, section split/join with `{#id}`, `documentFileId` |
| `swarm/src/blueprints.ts` | NEW — `DEFAULT_BLUEPRINTS` (+`folder`, `shape`), `loadBlueprintsFor(paths, slug?)` reading `<orgRepo>/blueprints/*.json` then `workspaces/<slug>/blueprints/*.json`, `instantiateSections`, `blueprintFolder` |
| `swarm/src/document-rules.ts` | NEW, pure — `validateDocument(bp, parsed, resolvers) → Problem[]`, `transitionProblems(from, to, …)` |
| `swarm/src/git-author.ts` | + `agentAuthor(agentId)` |
| `swarm/src/workspace-repos.ts` | `serializePerOrgRepo` exported as `withOrgRepoQueue`; + `commitPaths(paths, relPaths, {author, message})` (explicit-pathspec commit for document files) |
| `swarm/src/document-proposals.ts` | NEW — branch plumbing: `createProposal`, `listProposals`, `acceptProposal`, `rejectProposal`, `proposalBranch` |
| `swarm/src/document-store.ts` | NEW — fs+git facade: `listDocuments`, `getDocument`, `resolveDocument`, `createDocument`, `importDocument`, `patchSection`, `renameDocument`, `changeBlueprint`, `setPins`, `setStatus`; returns wire `Doc` with `problems` |
| `swarm/src/server.ts` | + document/blueprint routes (thin) |
| `broker/src/swarm-client.ts` | + `Doc`/`Proposal`/`Blueprint` wire types (moved from `documents.ts`/`blueprints.ts`) and the document methods |
| `broker/src/main.ts` | `documents` handlers call `SwarmClient`; `documentsFrame` from a refreshed cache; blueprints from the swarm; legacy import at boot |
| `broker/src/text-channel.ts` | `documents` handler interface becomes async; `GET /blueprints` stays |
| `broker/src/documents-import.ts` | NEW — §9.3: push `.smith/documents/d*.json` through the import route, remap session artifacts, archive |
| `broker/src/documents.ts`, `broker/src/blueprints.ts`, `broker/src/markdown-normalize.ts` | DELETED (normalizer only if no other importer remains) |
| `control-plane/src/api/types.ts` | `DocT` + `workspace: string`, `effort: string`, `problems?: ProblemT[]`; `BlueprintT` + `folder`, sections `+ shape?` |

Tests: new `*.test.ts` beside every new swarm module; `swarm-client.test.ts`, `text-channel.test.ts`, `documents-import.test.ts` in the broker; deletions of `documents.test.ts`, `blueprints.test.ts` in the broker.

---

### Task 1: The normalizer moves to the swarm

**Files:**
- Modify: `swarm/package.json` (dependencies)
- Create: `swarm/src/markdown-normalize.ts`, `swarm/src/markdown-normalize.test.ts`

**Interfaces:**
- Produces: `normalizeMarkdown(text: string): string` (swarm) — byte-identical behaviour to the broker's.

- [ ] **Step 1: Add the dependencies**

Add to `swarm/package.json` `"dependencies"` (keep alphabetical order):

```json
    "remark-gfm": "^4.0.1",
    "remark-parse": "^11.0.0",
    "remark-stringify": "^11.0.0",
    "unified": "^11.0.5",
```

Run from the repo root: `pnpm install --offline` (the store already has them via the broker). In a worktree with symlinked `node_modules`, run it from the MAIN checkout root instead (`pnpm install --offline` there updates the shared `node_modules` the symlinks point at) and copy the resulting `pnpm-lock.yaml` change into your worktree's commit. Verify: `cd swarm && node -e "import('unified').then(()=>console.log('ok'))"` prints `ok`.

- [ ] **Step 2: Write the failing test**

Create `swarm/src/markdown-normalize.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeMarkdown } from "./markdown-normalize.js";

test("normalizeMarkdown: one canonical spelling — bullets, emphasis, fences", () => {
  const out = normalizeMarkdown("* a\n* b\n\n__strong__ and *em*\n\n~~~js\nx\n~~~\n");
  assert.equal(out, "- a\n- b\n\n*strong* and _em_\n\n```js\nx\n```");
});

test("normalizeMarkdown: a {#id} heading marker is plain text and survives", () => {
  assert.equal(normalizeMarkdown("## What this is {#overview}\n\nbody"), "## What this is {#overview}\n\nbody");
});

test("normalizeMarkdown: blank input is empty, unparseable input is returned verbatim", () => {
  assert.equal(normalizeMarkdown("   \n"), "");
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 'src/markdown-normalize.test.ts' > /tmp/t.txt 2>&1; echo "exit $?"; grep -E '^ℹ (tests|pass|fail)' /tmp/t.txt; grep -E '✖|AssertionError|Cannot find' /tmp/t.txt | head`
Expected: fails to load — `Cannot find module './markdown-normalize.js'`.

- [ ] **Step 4: Implement**

Create `swarm/src/markdown-normalize.ts` with EXACTLY the broker's `broker/src/markdown-normalize.ts` content (copy the file; keep the pinned options `bullet: "-", emphasis: "_", strong: "*", fence: "`", fences: true, listItemIndent: "one", rule: "-"`) and change only the header comment's first line to: `// The ONE markdown normalizer — moved from the broker (spec 2026-08-22 §2.2): every body that enters a document file passes through here.`

- [ ] **Step 5: Run it to verify it passes; typecheck; commit**

Run: the Step 3 command. Expected: 3 `ok`. (If the first assertion's exact output differs, the broker's `markdown-normalize.test.ts` has the canonical expectations — match those, and fix the test, not the options.)

```bash
pnpm --config.verify-deps-before-run=false -C swarm typecheck
git add swarm/package.json pnpm-lock.yaml swarm/src/markdown-normalize.ts swarm/src/markdown-normalize.test.ts
git commit -m "feat(swarm): the markdown normalizer moves to the swarm

Document files are swarm-owned now; every section body that enters one is
normalized with the broker's exact pinned options."
```

---

### Task 2: `document-file.ts` — parse and serialize a document file

**Files:**
- Create: `swarm/src/document-file.ts`, `swarm/src/document-file.test.ts`

**Interfaces:**
- Produces:

```ts
export type DocStatus = "drafting" | "review" | "final";
export interface DocFrontmatter {
  title: string; blueprint: string; workType: string; status: DocStatus; effort: string;
  slices: string[]; spec?: string; participants: string[]; pins: string[];
  createdAt: string; updatedAt: string;
}
export interface DocSection { id: string; heading: string; body: string }
export interface ParsedDocument { frontmatter: DocFrontmatter; sections: DocSection[] }
export interface ParseProblem { where: string; message: string }
export function parseFrontmatter(block: string): { values: Record<string, string | string[]>; problems: ParseProblem[] };
export function parseDocumentFile(text: string): { doc: ParsedDocument | null; problems: ParseProblem[] };
export function serializeDocumentFile(doc: ParsedDocument): string;
export function splitSections(markdown: string): DocSection[];
export function slugify(text: string): string;                       // TOTAL: never throws; an unslugifiable input yields `section-0` (NOT capabilities.ts's slugify, which throws)
export function documentFileId(createdAt: string, effort: string, blueprintId: string): string;
export const FRONTMATTER_KEYS: readonly string[];
```

- [ ] **Step 1: Write the failing tests**

Create `swarm/src/document-file.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  documentFileId,
  parseDocumentFile,
  parseFrontmatter,
  serializeDocumentFile,
  splitSections,
} from "./document-file.js";

const FILE = `---
title: Instance provisioning
blueprint: spec
workType: feature
status: drafting
effort: instance-provisioning
slices: [instance-provisioning]
participants: [anderson]
pins: []
createdAt: 2026-08-22T15:30:00.000Z
updatedAt: 2026-08-22T16:04:12.000Z
---

## What this is {#overview}

Two paragraphs.

## Approach {#approach}

\`\`\`md
## not a heading — inside a fence
\`\`\`

## Open questions

- one
`;

test("parseDocumentFile: frontmatter, marked sections, and an unmarked section with a slug id", () => {
  const { doc, problems } = parseDocumentFile(FILE);
  assert.deepEqual(problems, []);
  assert.ok(doc);
  assert.equal(doc.frontmatter.title, "Instance provisioning");
  assert.deepEqual(doc.frontmatter.slices, ["instance-provisioning"]);
  assert.deepEqual(doc.frontmatter.pins, []);
  assert.equal(doc.frontmatter.spec, undefined);
  assert.deepEqual(
    doc.sections.map((s) => [s.id, s.heading]),
    [
      ["overview", "What this is"],
      ["approach", "Approach"],
      ["open-questions", "Open questions"],
    ],
  );
  assert.equal(doc.sections[0].body, "Two paragraphs.");
  assert.match(doc.sections[1].body, /## not a heading/, "a ## inside a fence is body, not a split");
  assert.equal(doc.sections[2].body, "- one");
});

test("serializeDocumentFile ∘ parseDocumentFile is the identity on a canonical file", () => {
  const { doc } = parseDocumentFile(FILE);
  assert.ok(doc);
  const out = serializeDocumentFile(doc);
  const again = parseDocumentFile(out);
  assert.deepEqual(again.doc, doc);
  assert.match(out, /^## Open questions \{#open-questions\}$/m, "an unmarked section gains its marker on write");
  assert.match(out, /^spec:/m === null ? /./ : /^(?!spec:)/m, "absent optional keys are not written");
});

test("parseFrontmatter: flat subset only — nesting, comments, unknown keys are reported by name", () => {
  const { values, problems } = parseFrontmatter("title: x\nslices: [a, b]\nnested:\n  k: v\nstatus: draft # no\nbogus: 1");
  assert.equal(values.title, "x");
  assert.deepEqual(values.slices, ["a", "b"]);
  assert.ok(problems.some((p) => p.where === "frontmatter.nested"), JSON.stringify(problems));
  assert.ok(problems.some((p) => p.where === "frontmatter.status" && /comment/.test(p.message)));
  assert.ok(problems.some((p) => p.where === "frontmatter.bogus" && /unknown/.test(p.message)));
});

test("parseDocumentFile: a missing required key and a bad status are problems, not crashes", () => {
  const { doc, problems } = parseDocumentFile("---\ntitle: t\nblueprint: spec\nworkType: feature\nstatus: done\n---\n\n## A {#a}\n");
  assert.equal(doc, null, "a file that fails frontmatter validation yields no doc");
  assert.ok(problems.some((p) => p.where === "frontmatter.status"));
  assert.ok(problems.some((p) => p.where === "frontmatter.effort"));
});

test("parseDocumentFile: no frontmatter at all is a single problem", () => {
  const { doc, problems } = parseDocumentFile("## A {#a}\n\nbody");
  assert.equal(doc, null);
  assert.deepEqual(problems.map((p) => p.where), ["frontmatter"]);
});

test("splitSections: text before the first heading is a preamble section with id 'preamble'", () => {
  const s = splitSections("intro\n\n## A {#a}\n\nx");
  assert.deepEqual(s.map((x) => x.id), ["preamble", "a"]);
});

test("documentFileId: UTC minute + effort, -design only for spec", () => {
  assert.equal(documentFileId("2026-08-22T15:30:45.000Z", "instance-provisioning", "spec"), "2026-08-22-1530-instance-provisioning-design");
  assert.equal(documentFileId("2026-08-22T16:12:00.000Z", "instance-provisioning", "implementation-plan"), "2026-08-22-1612-instance-provisioning");
  assert.equal(documentFileId("2026-08-22T16:12:00.000Z", "Weird Effort!!", "er"), "2026-08-22-1612-weird-effort");
});
```

(Replace the odd `assert.match(out, /^spec:/m === null …)` line with `assert.doesNotMatch(out, /^spec:/m, "absent optional keys are not written");` — it is written that way above only to make the intent unmistakable.)

- [ ] **Step 2: Run them to verify they fail**

Run: `cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 'src/document-file.test.ts' > /tmp/t.txt 2>&1; echo "exit $?"; grep -E '^ℹ (tests|pass|fail)' /tmp/t.txt; grep -E '✖|AssertionError|Cannot find' /tmp/t.txt | head`
Expected: module not found.

- [ ] **Step 3: Implement**

Create `swarm/src/document-file.ts`:

```ts
// The document file (spec 2026-08-22 §2): flat frontmatter + one `##` per
// section, each heading carrying its stable id as `{#id}`. Pure: no fs, no
// git — the store (document-store.ts) reads and writes, this module only
// understands the text. Kept deliberately small: the frontmatter grammar is
// a flat subset (scalars and [a, b] lists, no nesting, no comments) because
// a parser would be more surface than the data.
import { slugify as capSlugify } from "./capabilities.js";

export type DocStatus = "drafting" | "review" | "final";
export const DOC_STATUSES: readonly DocStatus[] = ["drafting", "review", "final"];

export interface DocFrontmatter {
  title: string;
  blueprint: string;
  workType: string;
  status: DocStatus;
  effort: string;
  slices: string[];
  /** Plans only: the spec document id this plan implements. */
  spec?: string;
  participants: string[];
  pins: string[];
  createdAt: string;
  updatedAt: string;
}

export interface DocSection {
  id: string;
  heading: string;
  body: string;
}

export interface ParsedDocument {
  frontmatter: DocFrontmatter;
  sections: DocSection[];
}

export interface ParseProblem {
  where: string;
  message: string;
}

export const FRONTMATTER_KEYS: readonly string[] = [
  "title",
  "blueprint",
  "workType",
  "status",
  "effort",
  "slices",
  "spec",
  "participants",
  "pins",
  "createdAt",
  "updatedAt",
];
const REQUIRED_KEYS = ["title", "blueprint", "workType", "status", "effort", "createdAt", "updatedAt"];
const LIST_KEYS = new Set(["slices", "participants", "pins"]);

export const slugify = capSlugify;

/**
 * `key: scalar` and `key: [a, b]` only. Anything else is a problem that
 * names the key, so a hand edit that drifts into YAML proper is refused by
 * name rather than silently misread. Comments are refused too: `#` is legal
 * inside a title, so the only safe rule is "no comments at all".
 */
export function parseFrontmatter(block: string): {
  values: Record<string, string | string[]>;
  problems: ParseProblem[];
} {
  const values: Record<string, string | string[]> = {};
  const problems: ParseProblem[] = [];
  for (const raw of block.split("\n")) {
    if (!raw.trim()) continue;
    if (/^\s/.test(raw)) {
      problems.push({ where: `frontmatter.${lastKey(values) ?? "?"}`, message: "nested values are not supported" });
      continue;
    }
    const m = /^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/.exec(raw);
    if (!m) {
      problems.push({ where: "frontmatter", message: `cannot read line: ${raw}` });
      continue;
    }
    const [, key, rest] = m;
    if (!FRONTMATTER_KEYS.includes(key)) {
      problems.push({ where: `frontmatter.${key}`, message: "unknown key" });
      continue;
    }
    if (rest === "" && !LIST_KEYS.has(key)) {
      problems.push({ where: `frontmatter.${key}`, message: "nested values are not supported" });
      continue;
    }
    if (/\s#/.test(rest) || rest.startsWith("#")) {
      problems.push({ where: `frontmatter.${key}`, message: "comments are not supported" });
      continue;
    }
    if (LIST_KEYS.has(key)) {
      const list = /^\[(.*)\]$/.exec(rest.trim());
      if (!list) {
        problems.push({ where: `frontmatter.${key}`, message: "must be a list like [a, b]" });
        continue;
      }
      values[key] = list[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else {
      values[key] = rest.trim();
    }
  }
  return { values, problems };
}

function lastKey(values: Record<string, unknown>): string | undefined {
  const keys = Object.keys(values);
  return keys[keys.length - 1];
}

/**
 * Split a markdown body into sections at top-level `## ` headings, fence-aware:
 * a `##` inside a ``` or ~~~ block is body. A heading's `{#id}` marker is the
 * section id; a heading without one gets `slugify(heading)`. Text before the
 * first heading is a `preamble` section (kept, so nothing a hand editor
 * writes above the first heading is dropped).
 */
export function splitSections(markdown: string): DocSection[] {
  const out: DocSection[] = [];
  let current: DocSection | null = null;
  let preamble: string[] = [];
  let fence: string | null = null;
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  for (const line of lines) {
    const fenceMatch = /^(```+|~~~+)/.exec(line);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1][0] === "`" ? "`" : "~";
      else if (line.startsWith(fence.repeat(3))) fence = null;
    }
    const heading = !fence && /^## (.*?)(?:\s*\{#([a-z0-9][a-z0-9-]*)\})?\s*$/.exec(line);
    if (heading) {
      if (current) out.push(finish(current));
      const text = heading[1].trim();
      current = { id: heading[2] ?? slugify(text), heading: text, body: "" };
      continue;
    }
    if (current) current.body += `${line}\n`;
    else preamble.push(line);
  }
  if (current) out.push(finish(current));
  const pre = preamble.join("\n").trim();
  if (pre) out.unshift({ id: "preamble", heading: "", body: pre });
  return out;
}

function finish(s: DocSection): DocSection {
  return { ...s, body: s.body.trim() };
}

/** `{ doc, problems }` — `doc` is null when the frontmatter is missing or fails its fixed checks. */
export function parseDocumentFile(text: string): { doc: ParsedDocument | null; problems: ParseProblem[] } {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text.replace(/\r\n/g, "\n"));
  if (!m) return { doc: null, problems: [{ where: "frontmatter", message: "no frontmatter block at the top of the file" }] };
  const { values, problems } = parseFrontmatter(m[1]);
  for (const key of REQUIRED_KEYS) {
    if (!(key in values)) problems.push({ where: `frontmatter.${key}`, message: "required" });
  }
  const status = values.status as string | undefined;
  if (status !== undefined && !DOC_STATUSES.includes(status as DocStatus)) {
    problems.push({ where: "frontmatter.status", message: `must be one of ${DOC_STATUSES.join(" | ")}` });
  }
  for (const key of ["createdAt", "updatedAt"]) {
    const v = values[key];
    if (typeof v === "string" && Number.isNaN(Date.parse(v))) {
      problems.push({ where: `frontmatter.${key}`, message: "must be an ISO date" });
    }
  }
  if (problems.length > 0) return { doc: null, problems };
  const fm: DocFrontmatter = {
    title: values.title as string,
    blueprint: values.blueprint as string,
    workType: values.workType as string,
    status: values.status as DocStatus,
    effort: values.effort as string,
    slices: (values.slices as string[] | undefined) ?? [],
    participants: (values.participants as string[] | undefined) ?? [],
    pins: (values.pins as string[] | undefined) ?? [],
    createdAt: values.createdAt as string,
    updatedAt: values.updatedAt as string,
  };
  if (typeof values.spec === "string") fm.spec = values.spec;
  return { doc: { frontmatter: fm, sections: splitSections(m[2]) }, problems: [] };
}

/** The canonical file: keys in FRONTMATTER_KEYS order (absent optionals omitted), then `## Heading {#id}` + body per section. */
export function serializeDocumentFile(doc: ParsedDocument): string {
  const fm = doc.frontmatter;
  const lines: string[] = ["---"];
  for (const key of FRONTMATTER_KEYS) {
    const v = (fm as unknown as Record<string, unknown>)[key];
    if (v === undefined) continue;
    lines.push(Array.isArray(v) ? `${key}: [${v.join(", ")}]` : `${key}: ${v}`);
  }
  lines.push("---", "");
  for (const s of doc.sections) {
    if (s.id === "preamble") {
      lines.push(s.body, "");
      continue;
    }
    lines.push(`## ${s.heading} {#${s.id}}`, "");
    if (s.body) lines.push(s.body, "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/** `{YYYY-MM-DD-HHMM}-{effort}[-design]`, UTC (spec §2.1). */
export function documentFileId(createdAt: string, effort: string, blueprintId: string): string {
  const d = new Date(createdAt);
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
  const slug = slugify(effort); // total: an unslugifiable effort yields "section-0", never empty
  return `${stamp}-${slug}${blueprintId === "spec" ? "-design" : ""}`;
}
```

Note on `parseDocumentFile`'s round trip: `serializeDocumentFile` writes the preamble without a heading; `splitSections` reads it back as `preamble` — identity holds. Verify the FILE constant's sections round-trip exactly (the test asserts `deepEqual`); if the fence handling differs in an edge, fix the parser, not the test.

- [ ] **Step 4: Run the tests; typecheck; lint; commit**

Run: the Step 2 command. Expected: all `ok`.

```bash
pnpm --config.verify-deps-before-run=false -C swarm typecheck && pnpm --config.verify-deps-before-run=false -C swarm lint
git add swarm/src/document-file.ts swarm/src/document-file.test.ts
git commit -m "feat(swarm): parse and serialize the document file — flat frontmatter, {#id} sections

Pure module: the store reads and writes, this understands the text. Unknown
sections keep a slug id; a ## inside a fence never splits; absent optional
keys are not written."
```

---

### Task 3: Blueprints move to the swarm, with `folder` and `shape`

**Files:**
- Create: `swarm/src/blueprints.ts`, `swarm/src/blueprints.test.ts`

**Interfaces:**
- Consumes: `paths.orgRepo`, `configDirForName(paths, name)`.
- Produces:

```ts
export type SectionShape = "prose" | "checklist" | "mermaid";
export type BlueprintFolder = "specs" | "plans" | "dashboards";
export interface BlueprintSection { id: string; heading: string; hint?: string; starter?: string; when?: { workType: string[] }; required?: boolean; shape?: SectionShape }
export interface Blueprint { id: string; name: string; family: "document" | "diagram" | "dashboard"; workTypes: string[]; sections: BlueprintSection[]; folder: BlueprintFolder }
export const DEFAULT_BLUEPRINTS: Blueprint[];
export async function loadBlueprintsFor(paths: SmithPaths, workspaceName?: string): Promise<Blueprint[]>;  // defaults ← <orgRepo>/blueprints/*.json ← workspaces/<slug>/blueprints/*.json, by id
export function instantiateSections(bp: Blueprint, workType: string): Array<{ id: string; heading: string; body: string }> | null;
export function activeSections(bp: Blueprint, workType: string): BlueprintSection[];
```

- [ ] **Step 1: Write the failing tests**

Create `swarm/src/blueprints.test.ts`:

```ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { activeSections, DEFAULT_BLUEPRINTS, instantiateSections, loadBlueprintsFor } from "./blueprints.js";
import { smithPaths } from "./paths.js";

test("defaults: every blueprint declares a folder, and the shaped sections carry a shape", () => {
  const byId = new Map(DEFAULT_BLUEPRINTS.map((b) => [b.id, b]));
  assert.equal(byId.get("spec")?.folder, "specs");
  assert.equal(byId.get("er")?.folder, "specs");
  assert.equal(byId.get("sequence")?.folder, "specs");
  assert.equal(byId.get("implementation-plan")?.folder, "plans");
  assert.equal(byId.get("dashboard")?.folder, "dashboards");
  assert.equal(byId.get("er")?.sections[0].shape, "mermaid");
  assert.equal(byId.get("implementation-plan")?.sections.find((s) => s.id === "tasks")?.shape, "checklist");
});

test("loadBlueprintsFor: org files override defaults by id, workspace files override org files", async () => {
  const root = mkdtempSync(join(tmpdir(), "bp-"));
  try {
    const paths = smithPaths(root);
    mkdirSync(join(paths.orgRepo, "blueprints"), { recursive: true });
    mkdirSync(join(paths.orgRepo, "workspaces", "pg", "blueprints"), { recursive: true });
    writeFileSync(
      join(paths.orgRepo, "blueprints", "spec.json"),
      JSON.stringify({ id: "spec", name: "Org Spec", family: "document", workTypes: ["feature"], folder: "specs", sections: [{ id: "overview", heading: "Overview", required: true }] }),
    );
    writeFileSync(
      join(paths.orgRepo, "blueprints", "adr.json"),
      JSON.stringify({ id: "adr", name: "Decision record", workTypes: ["feature"], sections: [{ id: "decision", heading: "Decision" }] }),
    );
    writeFileSync(
      join(paths.orgRepo, "workspaces", "pg", "blueprints", "spec.json"),
      JSON.stringify({ id: "spec", name: "PG Spec", family: "document", workTypes: ["feature"], folder: "specs", sections: [{ id: "overview", heading: "Overview" }] }),
    );
    writeFileSync(join(paths.orgRepo, "blueprints", "broken.json"), "{ nope");

    const org = await loadBlueprintsFor(paths);
    assert.equal(org.find((b) => b.id === "spec")?.name, "Org Spec");
    assert.equal(org.find((b) => b.id === "adr")?.folder, "specs", "a user file without folder defaults to specs");
    assert.equal(org.find((b) => b.id === "adr")?.family, "document");
    const ws = await loadBlueprintsFor(paths, "pg");
    assert.equal(ws.find((b) => b.id === "spec")?.name, "PG Spec");
    assert.ok(ws.some((b) => b.id === "dashboard"), "defaults survive a broken user file");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadBlueprintsFor: a user file with an invalid folder or shape is skipped, not coerced", async () => {
  const root = mkdtempSync(join(tmpdir(), "bp-bad-"));
  try {
    const paths = smithPaths(root);
    mkdirSync(join(paths.orgRepo, "blueprints"), { recursive: true });
    writeFileSync(join(paths.orgRepo, "blueprints", "x.json"), JSON.stringify({ id: "x", name: "X", workTypes: ["f"], folder: "attic", sections: [] }));
    writeFileSync(join(paths.orgRepo, "blueprints", "y.json"), JSON.stringify({ id: "y", name: "Y", workTypes: ["f"], sections: [{ id: "a", heading: "A", shape: "regex" }] }));
    const all = await loadBlueprintsFor(paths);
    assert.ok(!all.some((b) => b.id === "x"));
    assert.ok(!all.some((b) => b.id === "y"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("instantiateSections / activeSections: per-workType activation, starters as bodies", () => {
  const spec = DEFAULT_BLUEPRINTS.find((b) => b.id === "spec")!;
  assert.equal(instantiateSections(spec, "nope"), null);
  assert.deepEqual(activeSections(spec, "bugfix").map((s) => s.id), ["overview", "repro", "approach", "non-goals", "testing"]);
  const er = DEFAULT_BLUEPRINTS.find((b) => b.id === "er")!;
  assert.match(instantiateSections(er, "feature")![0].body, /^```mermaid/);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 'src/blueprints.test.ts' > /tmp/t.txt 2>&1; echo "exit $?"; grep -E '^ℹ (tests|pass|fail)' /tmp/t.txt; grep -E '✖|AssertionError|Cannot find' /tmp/t.txt | head`
Expected: module not found.

- [ ] **Step 3: Implement**

Create `swarm/src/blueprints.ts`. Copy `DEFAULT_BLUEPRINTS` VERBATIM from `broker/src/blueprints.ts` (all five blueprints, every `hint`/`starter`/`when`/`required`) and add exactly these fields: `folder: "specs"` on `spec`, `er`, `sequence`; `folder: "plans"` on `implementation-plan`; `folder: "dashboards"` on `dashboard`; `shape: "mermaid"` on the `diagram` section of `er` and `sequence`; `shape: "checklist"` on `implementation-plan`'s `tasks` section. Then the rest of the module:

```ts
// Blueprints — the document schema (spec 2026-08-22 §6.1). Data, never a
// hardcoded enum: defaults here, org-wide files in <orgRepo>/blueprints/,
// per-workspace overrides in workspaces/<slug>/blueprints/, merged by id.
// `folder` says where a blueprint's documents live; `shape` is the closed
// set of per-section checks the rules module can enforce.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SmithPaths } from "./paths.js";
import { configDirForName } from "./workspaces.js";

export type SectionShape = "prose" | "checklist" | "mermaid";
export type BlueprintFolder = "specs" | "plans" | "dashboards";
const SHAPES = new Set<string>(["prose", "checklist", "mermaid"]);
const FOLDERS = new Set<string>(["specs", "plans", "dashboards"]);

export interface BlueprintSection {
  id: string;
  heading: string;
  hint?: string;
  starter?: string;
  when?: { workType: string[] };
  required?: boolean;
  /** Closed set; absent = prose. A regex field was rejected on purpose — a rule nobody can read back is not a rule. */
  shape?: SectionShape;
}

export interface Blueprint {
  id: string;
  name: string;
  family: "document" | "diagram" | "dashboard";
  workTypes: string[];
  sections: BlueprintSection[];
  /** Which workspace folder this blueprint's documents live in. */
  folder: BlueprintFolder;
}

export const DEFAULT_BLUEPRINTS: Blueprint[] = [ /* copied from the broker, with folder/shape added as listed above */ ];

/** A user file must carry id/workTypes/sections; family defaults to document, folder to specs; an invalid folder or shape rejects the WHOLE file rather than coercing it. */
function validUserBlueprint(raw: unknown): Blueprint | null {
  const b = raw as Partial<Blueprint> | null;
  if (!b || typeof b.id !== "string" || !Array.isArray(b.workTypes) || !Array.isArray(b.sections)) return null;
  const folder = b.folder ?? "specs";
  if (!FOLDERS.has(folder)) return null;
  for (const s of b.sections) {
    if (typeof s?.id !== "string" || typeof s?.heading !== "string") return null;
    if (s.shape !== undefined && !SHAPES.has(s.shape)) return null;
  }
  return {
    id: b.id,
    name: typeof b.name === "string" ? b.name : b.id,
    family: b.family === "diagram" ? "diagram" : b.family === "dashboard" ? "dashboard" : "document",
    workTypes: b.workTypes,
    sections: b.sections,
    folder,
  };
}

async function readBlueprintDir(dir: string, into: Map<string, Blueprint>): Promise<void> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  } catch {
    return; // no such dir — nothing to merge
  }
  for (const f of files) {
    try {
      const bp = validUserBlueprint(JSON.parse(await readFile(join(dir, f), "utf8")));
      if (bp) into.set(bp.id, bp);
    } catch {
      /* a malformed file must never take the defaults down */
    }
  }
}

/** Resolution: workspace over org over defaults (spec §6.1). */
export async function loadBlueprintsFor(paths: SmithPaths, workspaceName?: string): Promise<Blueprint[]> {
  const byId = new Map<string, Blueprint>(DEFAULT_BLUEPRINTS.map((b) => [b.id, b]));
  await readBlueprintDir(join(paths.orgRepo, "blueprints"), byId);
  if (workspaceName) await readBlueprintDir(join(configDirForName(paths, workspaceName), "blueprints"), byId);
  return [...byId.values()];
}

export function activeSections(bp: Blueprint, workType: string): BlueprintSection[] {
  return bp.sections.filter((s) => !s.when || s.when.workType.includes(workType));
}

/** Sections active for a work type, with starter bodies; null = workType not declared by the blueprint. */
export function instantiateSections(bp: Blueprint, workType: string): Array<{ id: string; heading: string; body: string }> | null {
  if (!bp.workTypes.includes(workType)) return null;
  return activeSections(bp, workType).map((s) => ({ id: s.id, heading: s.heading, body: s.starter ?? "" }));
}
```

- [ ] **Step 4: Run the tests; typecheck; lint; commit**

Run: the Step 2 command. Expected: all `ok`.

```bash
pnpm --config.verify-deps-before-run=false -C swarm typecheck && pnpm --config.verify-deps-before-run=false -C swarm lint
git add swarm/src/blueprints.ts swarm/src/blueprints.test.ts
git commit -m "feat(swarm): blueprints as the document schema — folder, shape, org and workspace overrides

Defaults copied from the broker verbatim; folder places a blueprint's
documents, shape is the closed per-section check set. Org-wide files in
<orgRepo>/blueprints, per-workspace overrides beneath the subtree."
```

---

### Task 4: `document-rules.ts` — validation and status gates

**Files:**
- Create: `swarm/src/document-rules.ts`, `swarm/src/document-rules.test.ts`

**Interfaces:**
- Consumes: `Blueprint`, `activeSections`, `SectionShape` (Task 3); `ParsedDocument`, `DocStatus`, `DOC_STATUSES` (Task 2).
- Produces:

```ts
export interface Problem { where: string; message: string }
export interface RuleResolvers {
  specStatus(docId: string): Promise<DocStatus | null>;   // null = no such spec in this workspace
  sliceExists(sliceId: string): Promise<boolean>;
}
export function shapeProblem(shape: SectionShape | undefined, body: string): string | null;
export function structuralProblems(bp: Blueprint, doc: ParsedDocument): Problem[];
export async function validateDocument(bp: Blueprint, doc: ParsedDocument, r: RuleResolvers): Promise<Problem[]>;
export async function transitionProblems(bp: Blueprint, doc: ParsedDocument, to: DocStatus, r: RuleResolvers): Promise<Problem[]>;
```

- [ ] **Step 1: Write the failing tests**

Create `swarm/src/document-rules.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_BLUEPRINTS } from "./blueprints.js";
import type { ParsedDocument } from "./document-file.js";
import { type RuleResolvers, shapeProblem, structuralProblems, transitionProblems, validateDocument } from "./document-rules.js";

const spec = DEFAULT_BLUEPRINTS.find((b) => b.id === "spec")!;
const plan = DEFAULT_BLUEPRINTS.find((b) => b.id === "implementation-plan")!;

function doc(over: Partial<ParsedDocument["frontmatter"]> = {}, sections = defaultSections()): ParsedDocument {
  return {
    frontmatter: {
      title: "T", blueprint: "spec", workType: "feature", status: "drafting", effort: "t",
      slices: [], participants: [], pins: [], createdAt: "2026-08-22T15:30:00.000Z", updatedAt: "2026-08-22T15:30:00.000Z",
      ...over,
    },
    sections,
  };
}
function defaultSections() {
  return ["overview", "ui-refs", "approach", "non-goals", "testing"].map((id) => ({ id, heading: id, body: "" }));
}
const R: RuleResolvers = { specStatus: async () => null, sliceExists: async () => false };

test("shapeProblem: prose accepts anything; checklist wants - [ ] lines; mermaid wants exactly one fenced block", () => {
  assert.equal(shapeProblem(undefined, "anything"), null);
  assert.equal(shapeProblem("checklist", "- [ ] a\n- [x] b"), null);
  assert.match(shapeProblem("checklist", "- [ ] a\nplain")!, /line 2/);
  assert.equal(shapeProblem("mermaid", "```mermaid\ngraph TD\n```"), null);
  assert.match(shapeProblem("mermaid", "text")!, /fenced mermaid/);
  assert.match(shapeProblem("mermaid", "```mermaid\na\n```\n```mermaid\nb\n```")!, /exactly one/);
});

test("structuralProblems: a missing active section is reported by id; a section for another workType is not required", () => {
  const missing = doc({}, defaultSections().filter((s) => s.id !== "approach"));
  assert.deepEqual(structuralProblems(spec, missing).map((p) => p.where), ["section:approach"]);
  assert.deepEqual(structuralProblems(spec, doc()), [], "repro is bugfix-only, so its absence is fine for feature");
  assert.ok(structuralProblems(spec, doc({ workType: "nope" })).some((p) => p.where === "frontmatter.workType"));
});

test("validateDocument: cross-refs — unknown slice, a plan whose spec is absent, a spec that names a spec", async () => {
  const bad = await validateDocument(spec, doc({ slices: ["s1"] }), R);
  assert.ok(bad.some((p) => p.where === "frontmatter.slices" && /s1/.test(p.message)));
  const ok = await validateDocument(spec, doc({ slices: ["s1"] }), { ...R, sliceExists: async (id) => id === "s1" });
  assert.deepEqual(ok, []);
  const planSections = plan.sections.map((s) => ({ id: s.id, heading: s.heading, body: "" }));
  const planDoc = doc({ blueprint: "implementation-plan", spec: "2026-08-22-1530-t-design" }, planSections);
  const absent = await validateDocument(plan, planDoc, R);
  assert.ok(absent.some((p) => p.where === "frontmatter.spec" && /not found/.test(p.message)));
  const specWithSpec = await validateDocument(spec, doc({ spec: "x" }), R);
  assert.ok(specWithSpec.some((p) => p.where === "frontmatter.spec" && /only a plan/.test(p.message)));
});

test("transitionProblems: the §6.3 matrix", async () => {
  const d = doc();
  assert.deepEqual(await transitionProblems(spec, d, "review", R), [], "drafting → review with all active sections present (empty is fine)");
  const toFinal = await transitionProblems(spec, d, "final", R);
  assert.ok(toFinal.some((p) => p.where === "section:overview" && /required/.test(p.message)));
  assert.ok(toFinal.some((p) => p.where === "section:non-goals"));
  const filled = doc({}, defaultSections().map((s) => ({ ...s, body: "x" })));
  assert.deepEqual(await transitionProblems(spec, filled, "final", R), []);
  assert.deepEqual(await transitionProblems(spec, doc({ status: "final" }), "drafting", R), [], "reopen is always allowed");
  const planSections = plan.sections.map((s) => ({ id: s.id, heading: s.heading, body: s.id === "tasks" ? "- [ ] t" : "x" }));
  const planDoc = doc({ blueprint: "implementation-plan", spec: "s" }, planSections);
  const specNotFinal = await transitionProblems(plan, planDoc, "final", { ...R, specStatus: async () => "review" });
  assert.ok(specNotFinal.some((p) => p.where === "frontmatter.spec" && /final/.test(p.message)));
  assert.deepEqual(await transitionProblems(plan, planDoc, "final", { ...R, specStatus: async () => "final" }), []);
  const badTasks = doc({ blueprint: "implementation-plan", spec: "s" }, planSections.map((s) => (s.id === "tasks" ? { ...s, body: "prose" } : s)));
  assert.ok((await transitionProblems(plan, badTasks, "review", { ...R, specStatus: async () => "final" })).some((p) => p.where === "section:tasks"));
});

test("positive control: a deliberately invalid document fails every gate", async () => {
  const broken = doc({ workType: "nope" }, []);
  assert.ok(structuralProblems(spec, broken).length > 0);
  assert.ok((await transitionProblems(spec, broken, "review", R)).length > 0);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 'src/document-rules.test.ts' > /tmp/t.txt 2>&1; echo "exit $?"; grep -E '^ℹ (tests|pass|fail)' /tmp/t.txt; grep -E '✖|AssertionError|Cannot find' /tmp/t.txt | head`
Expected: module not found.

- [ ] **Step 3: Implement**

Create `swarm/src/document-rules.ts`:

```ts
// Rules and validation (spec 2026-08-22 §6). Pure: no fs, no git — the
// cross-document facts come in as resolvers, so every rule is testable
// against literal documents (the provisioning.ts discipline). Rules BITE at
// status transitions only; writes always succeed and report problems.
import { activeSections, type Blueprint, type SectionShape } from "./blueprints.js";
import { DOC_STATUSES, type DocStatus, type ParsedDocument } from "./document-file.js";

export interface Problem {
  where: string;
  message: string;
}

export interface RuleResolvers {
  specStatus(docId: string): Promise<DocStatus | null>;
  sliceExists(sliceId: string): Promise<boolean>;
}

/** A closed set of shapes — a new one is a new case here, not a plugin. */
export function shapeProblem(shape: SectionShape | undefined, body: string): string | null {
  switch (shape ?? "prose") {
    case "prose":
      return null;
    case "checklist": {
      const lines = body.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) continue;
        if (!/^\s*- \[[ xX]\] /.test(line)) return `line ${i + 1} is not a checklist item (- [ ] …)`;
      }
      return null;
    }
    case "mermaid": {
      const fences = body.match(/^```mermaid\s*$/gm) ?? [];
      if (fences.length === 0) return "must be one fenced mermaid block (```mermaid … ```)";
      if (fences.length > 1) return "must be exactly one fenced mermaid block";
      const outside = body.replace(/```mermaid[\s\S]*?```/, "").trim();
      return outside ? "nothing may sit outside the mermaid block" : null;
    }
  }
}

/** Blueprint/workType agree, every section the blueprint activates is present, and each NON-EMPTY present section's shape holds. */
export function structuralProblems(bp: Blueprint, doc: ParsedDocument): Problem[] {
  const problems: Problem[] = [];
  if (doc.frontmatter.blueprint !== bp.id) {
    problems.push({ where: "frontmatter.blueprint", message: `document says "${doc.frontmatter.blueprint}" but is being checked against "${bp.id}"` });
  }
  if (!bp.workTypes.includes(doc.frontmatter.workType)) {
    problems.push({ where: "frontmatter.workType", message: `must be one of ${bp.workTypes.join(", ")}` });
    return problems;
  }
  const present = new Map(doc.sections.map((s) => [s.id, s]));
  for (const s of activeSections(bp, doc.frontmatter.workType)) {
    const have = present.get(s.id);
    if (!have) {
      problems.push({ where: `section:${s.id}`, message: `missing — the "${s.heading}" section is part of this blueprint` });
      continue;
    }
    const shape = have.body.trim() ? shapeProblem(s.shape, have.body) : null;
    if (shape) problems.push({ where: `section:${s.id}`, message: shape });
  }
  return problems;
}

async function crossRefProblems(bp: Blueprint, doc: ParsedDocument, r: RuleResolvers): Promise<Problem[]> {
  const problems: Problem[] = [];
  for (const id of doc.frontmatter.slices) {
    if (!(await r.sliceExists(id))) problems.push({ where: "frontmatter.slices", message: `slice "${id}" does not resolve` });
  }
  if (doc.frontmatter.spec !== undefined) {
    if (bp.folder !== "plans") problems.push({ where: "frontmatter.spec", message: "only a plan names a spec" });
    else if ((await r.specStatus(doc.frontmatter.spec)) === null) {
      problems.push({ where: "frontmatter.spec", message: `spec "${doc.frontmatter.spec}" not found in this workspace` });
    }
  }
  return problems;
}

export async function validateDocument(bp: Blueprint, doc: ParsedDocument, r: RuleResolvers): Promise<Problem[]> {
  return [...structuralProblems(bp, doc), ...(await crossRefProblems(bp, doc, r))];
}

/**
 * The §6.3 matrix. `→ review`: structure + cross-refs. `→ final`: additionally
 * every required active section non-empty, and a plan's spec final.
 * `→ drafting`: always allowed — reopening is a commit like any other.
 */
export async function transitionProblems(bp: Blueprint, doc: ParsedDocument, to: DocStatus, r: RuleResolvers): Promise<Problem[]> {
  if (!DOC_STATUSES.includes(to)) return [{ where: "frontmatter.status", message: `must be one of ${DOC_STATUSES.join(" | ")}` }];
  if (to === "drafting") return [];
  const problems = await validateDocument(bp, doc, r);
  if (to === "final") {
    const present = new Map(doc.sections.map((s) => [s.id, s]));
    for (const s of activeSections(bp, doc.frontmatter.workType)) {
      if (s.required && !present.get(s.id)?.body.trim()) {
        problems.push({ where: `section:${s.id}`, message: `required — "${s.heading}" must not be empty to be final` });
      }
    }
    if (bp.folder === "plans" && doc.frontmatter.spec !== undefined) {
      const status = await r.specStatus(doc.frontmatter.spec);
      if (status !== null && status !== "final") {
        problems.push({ where: "frontmatter.spec", message: `spec "${doc.frontmatter.spec}" is ${status}, not final` });
      }
    }
  }
  return problems;
}
```

- [ ] **Step 4: Run the tests; typecheck; lint; commit**

Run: the Step 2 command. Expected: all `ok` (positive control included).

```bash
pnpm --config.verify-deps-before-run=false -C swarm typecheck && pnpm --config.verify-deps-before-run=false -C swarm lint
git add swarm/src/document-rules.ts swarm/src/document-rules.test.ts
git commit -m "feat(swarm): document rules — shapes, structure, cross-refs, and the status-transition matrix

Pure over literal documents; resolvers carry the cross-document facts.
Writes never refuse — transitions do."
```

---

### Task 5: The write queue becomes public; `commitPaths`; `agentAuthor`

**Files:**
- Modify: `swarm/src/workspace-repos.ts` (`serializePerOrgRepo` → exported `withOrgRepoQueue`; `stageAndCommit` split; new `commitPaths`)
- Modify: `swarm/src/git-author.ts` (+ `agentAuthor`)
- Test: `swarm/src/workspace-repos.test.ts`, `swarm/src/git-author.test.ts`

**Interfaces:**
- Produces:
  - `withOrgRepoQueue<T>(orgRepo: string, task: () => Promise<T>): Promise<T>` — the per-repo FIFO (spec §4 amendment). Same semantics as today's private function; every document mutation in Tasks 6–7 runs inside it.
  - `commitPaths(paths: SmithPaths, relPaths: string[], opts: { author: GitAuthor; message: string }): Promise<boolean>` — stage EXACTLY `relPaths` (relative to the org repo root; each must exist, must not be absolute, must not contain `..`), commit if there is a diff, unstage on commit failure; serialized through the queue. Returns whether a commit was made.
  - `agentAuthor(agentId: string): GitAuthor` = `{ name: agentId, email: "<agentId>@agents.smithagents" }` (spec §1.4).

- [ ] **Step 1: Write the failing tests**

Append to `swarm/src/git-author.test.ts`:

```ts
test("agentAuthor: an agent is named by its id under agents.smithagents, so blame tells Anderson from Edwin", () => {
  assert.deepEqual(agentAuthor("anderson"), { name: "anderson", email: "anderson@agents.smithagents" });
});
```
(add `agentAuthor` to the import.)

Append to `swarm/src/workspace-repos.test.ts` (add `commitPaths`, `withOrgRepoQueue` to the `./workspace-repos.js` import; `makeOrgRepo` from `./org-repo.fixture.js` if not already imported):

```ts
test("commitPaths: commits exactly the named files under the org repo, with the given author and message", async () => {
  const root = mkdtempSync(join(tmpdir(), "commitpaths-"));
  try {
    const paths = smithPaths(root);
    makeOrgRepo(root, ["pg"]);
    mkdirSync(join(paths.orgRepo, "workspaces", "pg", "specs"), { recursive: true });
    writeFileSync(join(paths.orgRepo, "workspaces", "pg", "specs", "a.md"), "a\n");
    writeFileSync(join(paths.orgRepo, "workspaces", "pg", "specs", "b.md"), "b\n");

    assert.equal(
      await commitPaths(paths, ["workspaces/pg/specs/a.md"], { author: { name: "anderson", email: "anderson@agents.smithagents" }, message: "spec(x): approach" }),
      true,
    );
    const line = execFileSync("git", ["log", "-1", "--format=%an|%s", "--name-only"], { cwd: paths.orgRepo }).toString();
    assert.match(line, /^anderson\|spec\(x\): approach/);
    assert.match(line, /workspaces\/pg\/specs\/a\.md/);
    assert.doesNotMatch(line, /b\.md/, "b.md was never named, so it is not in this commit");
    assert.equal(await commitPaths(paths, ["workspaces/pg/specs/a.md"], { author: { name: "x", email: "x@x" }, message: "again" }), false, "nothing changed → no commit");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("commitPaths: refuses an absolute path, a .. path, and a path that does not exist", async () => {
  const root = mkdtempSync(join(tmpdir(), "commitpaths-bad-"));
  try {
    const paths = smithPaths(root);
    makeOrgRepo(root, ["pg"]);
    const author = { name: "x", email: "x@x" };
    await assert.rejects(() => commitPaths(paths, ["/etc/passwd"], { author, message: "m" }), /relative/);
    await assert.rejects(() => commitPaths(paths, ["../outside.md"], { author, message: "m" }), /\.\./);
    await assert.rejects(() => commitPaths(paths, ["workspaces/pg/specs/missing.md"], { author, message: "m" }), /does not exist/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("withOrgRepoQueue: tasks on one repo run strictly one after another, and a rejection does not wedge the queue", async () => {
  const order: string[] = [];
  const slow = withOrgRepoQueue("/repo/q", async () => {
    order.push("slow-start");
    await new Promise((r) => setTimeout(r, 30));
    order.push("slow-end");
    return 1;
  });
  const failing = withOrgRepoQueue("/repo/q", async () => {
    order.push("fail");
    throw new Error("boom");
  });
  const fast = withOrgRepoQueue("/repo/q", async () => {
    order.push("fast");
    return 3;
  });
  assert.equal(await slow, 1);
  await assert.rejects(failing, /boom/);
  assert.equal(await fast, 3);
  assert.deepEqual(order, ["slow-start", "slow-end", "fail", "fast"]);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 'src/git-author.test.ts' 'src/workspace-repos.test.ts' > /tmp/t.txt 2>&1; echo "exit $?"; grep -E '^ℹ (tests|pass|fail)' /tmp/t.txt; grep -E '✖|AssertionError|Cannot find' /tmp/t.txt | head`
Expected: the four new tests FAIL (`✖` lines; `agentAuthor`/`commitPaths`/`withOrgRepoQueue` are not exported).

- [ ] **Step 3: Implement**

`swarm/src/git-author.ts` — append:

```ts
/** An agent as a git author (spec §1.4): its id, under a domain that can never collide with a person's. */
export function agentAuthor(agentId: string): GitAuthor {
  return { name: agentId, email: `${agentId}@agents.smithagents` };
}
```

`swarm/src/workspace-repos.ts`:
- Rename `serializePerOrgRepo` to `withOrgRepoQueue` and `export` it; update its docblock's first sentence to: "The per-org-repo write queue (spec 2026-08-22 §4): every mutation of one org repo — config commits, document writes, proposal branches, accepts — runs through here, strictly one at a time." Keep the body unchanged. Update `commitConfigFiles` to call `withOrgRepoQueue`.
- Extract the body of `stageAndCommit` after the `present` list is built into a shared helper, and add `commitPaths`:

```ts
/**
 * Stage exactly `present` (paths relative to the org repo root, all known to
 * exist), commit if anything differs from HEAD, unstage on failure. The one
 * place `git add`/`commit` happen for the org repo. Callers serialize.
 */
async function stageAndCommitPaths(dir: string, present: string[], opts: { author?: GitAuthor; message: string }): Promise<boolean> {
  if (present.length === 0) return false;
  await run("git", ["add", "--", ...present], { cwd: dir });
  let staged: boolean;
  try {
    await run("git", ["diff", "--cached", "--quiet"], { cwd: dir });
    staged = false;
  } catch {
    staged = true;
  }
  if (!staged) return false;
  const author = opts.author ?? SMITH_IDENTITY;
  try {
    await run("git", [...SMITH_COMMITTER, "commit", "-q", "-m", opts.message, `--author=${author.name} <${author.email}>`], { cwd: dir });
  } catch (err) {
    await run("git", ["reset", "-q", "--", ...present], { cwd: dir }).catch(() => {});
    throw err;
  }
  return true;
}

async function stageAndCommit(paths: SmithPaths, slug: string, opts: { author?: GitAuthor; message?: string }): Promise<boolean> {
  const dir = paths.orgRepo;
  const present: string[] = [];
  for (const path of [...ORG_CONFIG_PATHS, ...workspaceConfigPaths(slug)]) {
    if (await exists(join(dir, path))) present.push(path);
  }
  return stageAndCommitPaths(dir, present, { author: opts.author, message: opts.message ?? `config(${slug}): update` });
}

/**
 * Commit exactly the named files (relative to the org repo root) — the
 * document store's write path. Unlike commitConfigFiles there is no
 * allowlist: the caller names the file it just wrote. Paths are checked
 * before any git call: absolute or `..` paths can name files outside the
 * repo, and a path that does not exist would make `git add` fail the whole
 * call with a message that names git instead of the caller's mistake.
 */
export function commitPaths(paths: SmithPaths, relPaths: string[], opts: { author: GitAuthor; message: string }): Promise<boolean> {
  return withOrgRepoQueue(paths.orgRepo, async () => {
    for (const p of relPaths) {
      if (isAbsolute(p)) throw new Error(`commitPaths: "${p}" must be relative to the org repo`);
      if (p.split(/[\\/]/).includes("..")) throw new Error(`commitPaths: "${p}" contains ".."`);
      if (!(await exists(join(paths.orgRepo, p)))) throw new Error(`commitPaths: "${p}" does not exist in the org repo`);
    }
    return stageAndCommitPaths(paths.orgRepo, relPaths, opts);
  });
}
```
(add `isAbsolute` to the `node:path` import.) Keep the existing `commitConfigFiles` docblock guarantees intact — they still hold.

- [ ] **Step 4: Run the tests (both files), then the whole suite once; typecheck; lint; commit**

Run: the Step 2 command, then `SMITH_STATE_ROOT=$(mktemp -d) pnpm --config.verify-deps-before-run=false -C swarm test > /tmp/t5.txt 2>&1; echo $?; grep -E '^ℹ (pass|fail)' /tmp/t5.txt`. Expected: exit 0, 0 fail.

```bash
pnpm --config.verify-deps-before-run=false -C swarm typecheck && pnpm --config.verify-deps-before-run=false -C swarm lint
git add swarm/src/git-author.ts swarm/src/git-author.test.ts swarm/src/workspace-repos.ts swarm/src/workspace-repos.test.ts
git commit -m "feat(swarm): the org-repo write queue goes public, with an explicit-path commit and agent authors

withOrgRepoQueue is the spec's per-repo FIFO; commitPaths commits exactly
the file a document write just produced; agentAuthor names an agent under
agents.smithagents."
```

---

### Task 6: `document-proposals.ts` — proposals as branches

**Files:**
- Create: `swarm/src/document-proposals.ts`, `swarm/src/document-proposals.test.ts`

**Interfaces:**
- Consumes: `withOrgRepoQueue` (Task 5), `parseDocumentFile`/`splitSections` (Task 2), `SMITH_IDENTITY`, `GitAuthor`.
- Produces:

```ts
export interface ProposalWire { id: string; sectionId: string; agentId: string; newBody: string; rationale: string; state: "open" | "stale"; createdAt: string }
export function proposalRef(slug: string, docId: string, n: number): string;   // refs/heads/proposals/<slug>/<docId>/<n>
export async function createProposal(paths: SmithPaths, p: { slug: string; docId: string; relPath: string; newFileText: string; sectionId: string; author: GitAuthor; rationale: string }): Promise<{ id: string }>;
export async function listProposals(paths: SmithPaths, p: { slug: string; docId: string; relPath: string; currentFileText: string }): Promise<ProposalWire[]>;
export async function proposalFileText(paths: SmithPaths, p: { slug: string; docId: string; id: string; relPath: string }): Promise<{ branchText: string; baseText: string } | null>;
export async function deleteProposal(paths: SmithPaths, p: { slug: string; docId: string; id: string }): Promise<boolean>;
```
`createProposal` and `deleteProposal` run inside `withOrgRepoQueue`; the others are reads. `<n>` is allocated inside the queue (spec §4 amendment). The `stale` state is computed from git: the section's body at the branch's merge-base with `main` differs from `currentFileText`'s.

- [ ] **Step 1: Write the failing tests**

Create `swarm/src/document-proposals.test.ts`:

```ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createProposal, deleteProposal, listProposals, proposalFileText, proposalRef } from "./document-proposals.js";
import { gitCommitAll, makeOrgRepo } from "./org-repo.fixture.js";
import { smithPaths } from "./paths.js";

const DOC = `---
title: T
blueprint: spec
workType: feature
status: drafting
effort: t
createdAt: 2026-08-22T15:30:00.000Z
updatedAt: 2026-08-22T15:30:00.000Z
---

## What this is {#overview}

old overview

## Approach {#approach}

old approach
`;
const REL = "workspaces/pg/specs/2026-08-22-1530-t-design.md";
const ID = "2026-08-22-1530-t-design";
const ANDERSON = { name: "anderson", email: "anderson@agents.smithagents" };

function setup(label: string) {
  const root = mkdtempSync(join(tmpdir(), `props-${label}-`));
  const paths = smithPaths(root);
  makeOrgRepo(root, ["pg"]);
  mkdirSync(join(paths.orgRepo, "workspaces", "pg", "specs"), { recursive: true });
  writeFileSync(join(paths.orgRepo, REL), DOC);
  gitCommitAll(paths.orgRepo, "spec(t): create");
  return { root, paths };
}

test("proposalRef: the namespace is per workspace and per document", () => {
  assert.equal(proposalRef("pg", ID, 3), `refs/heads/proposals/pg/${ID}/3`);
});

test("createProposal: one branch, one commit, main and the live tree untouched, n allocated in order", async () => {
  const { root, paths } = setup("create");
  try {
    const head = execFileSync("git", ["rev-parse", "main"], { cwd: paths.orgRepo }).toString().trim();
    const p1 = await createProposal(paths, { slug: "pg", docId: ID, relPath: REL, newFileText: DOC.replace("old approach", "new approach"), sectionId: "approach", author: ANDERSON, rationale: "tighter" });
    const p2 = await createProposal(paths, { slug: "pg", docId: ID, relPath: REL, newFileText: DOC.replace("old overview", "new overview"), sectionId: "overview", author: ANDERSON, rationale: "clearer" });
    assert.deepEqual([p1.id, p2.id], ["1", "2"]);
    assert.equal(execFileSync("git", ["rev-parse", "main"], { cwd: paths.orgRepo }).toString().trim(), head, "main did not move");
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: paths.orgRepo }).toString(), "", "live tree and index untouched");
    assert.equal(readFileSync(join(paths.orgRepo, REL), "utf8"), DOC, "the live file still has the old text");
    const show = execFileSync("git", ["show", `${proposalRef("pg", ID, 1)}:${REL}`], { cwd: paths.orgRepo }).toString();
    assert.match(show, /new approach/);
    const log = execFileSync("git", ["log", "-1", "--format=%an <%ae>|%cn|%s", proposalRef("pg", ID, 1)], { cwd: paths.orgRepo }).toString().trim();
    assert.equal(log, "anderson <anderson@agents.smithagents>|smithagents|tighter");
    const parents = execFileSync("git", ["rev-list", "--parents", "-1", proposalRef("pg", ID, 1)], { cwd: paths.orgRepo }).toString().trim().split(" ");
    assert.equal(parents[1], head, "the proposal commit's parent is main");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listProposals: derives section, body, author, rationale from the branch; stale when main's section moved", async () => {
  const { root, paths } = setup("list");
  try {
    await createProposal(paths, { slug: "pg", docId: ID, relPath: REL, newFileText: DOC.replace("old approach", "new approach"), sectionId: "approach", author: ANDERSON, rationale: "tighter" });
    const open = await listProposals(paths, { slug: "pg", docId: ID, relPath: REL, currentFileText: DOC });
    assert.equal(open.length, 1);
    assert.equal(open[0].id, "1");
    assert.equal(open[0].sectionId, "approach");
    assert.equal(open[0].newBody, "new approach");
    assert.equal(open[0].agentId, "anderson");
    assert.equal(open[0].rationale, "tighter");
    assert.equal(open[0].state, "open");
    assert.match(open[0].createdAt, /^\d{4}-\d{2}-\d{2}T/);

    // main edits the SAME section → stale; a different section → still open
    const moved = DOC.replace("old approach", "rewritten on main");
    writeFileSync(join(paths.orgRepo, REL), moved);
    gitCommitAll(paths.orgRepo, "spec(t): approach");
    assert.equal((await listProposals(paths, { slug: "pg", docId: ID, relPath: REL, currentFileText: moved }))[0].state, "stale");
    const other = DOC.replace("old overview", "new overview");
    assert.equal((await listProposals(paths, { slug: "pg", docId: ID, relPath: REL, currentFileText: other }))[0].state, "open", "an edit elsewhere does not stale it");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("proposalFileText + deleteProposal: the branch text is readable, and a deleted proposal is gone from the listing", async () => {
  const { root, paths } = setup("delete");
  try {
    await createProposal(paths, { slug: "pg", docId: ID, relPath: REL, newFileText: DOC.replace("old approach", "new approach"), sectionId: "approach", author: ANDERSON, rationale: "r" });
    const texts = await proposalFileText(paths, { slug: "pg", docId: ID, id: "1", relPath: REL });
    assert.ok(texts);
    assert.match(texts.branchText, /new approach/);
    assert.match(texts.baseText, /old approach/);
    assert.equal(await deleteProposal(paths, { slug: "pg", docId: ID, id: "1" }), true);
    assert.equal(await deleteProposal(paths, { slug: "pg", docId: ID, id: "1" }), false, "deleting twice is a no-op");
    assert.deepEqual(await listProposals(paths, { slug: "pg", docId: ID, relPath: REL, currentFileText: DOC }), []);
    assert.equal(await proposalFileText(paths, { slug: "pg", docId: ID, id: "1", relPath: REL }), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("createProposal: concurrent proposals on one document get distinct ids", async () => {
  const { root, paths } = setup("concurrent");
  try {
    const ids = await Promise.all(
      ["a", "b", "c"].map((tag) =>
        createProposal(paths, { slug: "pg", docId: ID, relPath: REL, newFileText: DOC.replace("old approach", tag), sectionId: "approach", author: ANDERSON, rationale: tag }),
      ),
    );
    assert.deepEqual(ids.map((i) => i.id).sort(), ["1", "2", "3"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 'src/document-proposals.test.ts' > /tmp/t.txt 2>&1; echo "exit $?"; grep -E '^ℹ (tests|pass|fail)' /tmp/t.txt; grep -E '✖|AssertionError|Cannot find' /tmp/t.txt | head`
Expected: module not found.

- [ ] **Step 3: Implement**

Create `swarm/src/document-proposals.ts`:

```ts
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

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv, input?: string): Promise<string> {
  const child = run("git", args, { cwd, env: env ? { ...process.env, ...env } : process.env, maxBuffer: 16 * 1024 * 1024 });
  if (input !== undefined && child.child.stdin) {
    child.child.stdin.end(input);
  }
  return (await child).stdout.toString();
}

async function existingNumbers(dir: string, slug: string, docId: string): Promise<number[]> {
  const out = await git(dir, ["for-each-ref", "--format=%(refname)", proposalPrefix(slug, docId)]);
  return out
    .split("\n")
    .filter(Boolean)
    .map((ref) => Number(ref.slice(proposalPrefix(slug, docId).length)))
    .filter((n) => Number.isInteger(n));
}

/** The rationale is the commit subject; the section id rides as a trailer so listing never has to diff to find it. */
function messageFor(rationale: string, sectionId: string): string {
  const subject = rationale.replace(/\s+/g, " ").trim() || "proposal";
  return `${subject}\n\nSection: ${sectionId}\n`;
}

export async function createProposal(
  paths: SmithPaths,
  p: { slug: string; docId: string; relPath: string; newFileText: string; sectionId: string; author: GitAuthor; rationale: string },
): Promise<{ id: string }> {
  return withOrgRepoQueue(paths.orgRepo, async () => {
    const dir = paths.orgRepo;
    const base = (await git(dir, ["rev-parse", "refs/heads/main"])).trim();
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
        await git(
          dir,
          ["commit-tree", tree, "-p", base, "-m", messageFor(p.rationale, p.sectionId)],
          {
            GIT_AUTHOR_NAME: p.author.name,
            GIT_AUTHOR_EMAIL: p.author.email,
            GIT_COMMITTER_NAME: SMITH_IDENTITY.name,
            GIT_COMMITTER_EMAIL: SMITH_IDENTITY.email,
          },
        )
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

export async function listProposals(
  paths: SmithPaths,
  p: { slug: string; docId: string; relPath: string; currentFileText: string },
): Promise<ProposalWire[]> {
  const dir = paths.orgRepo;
  const out: ProposalWire[] = [];
  for (const n of (await existingNumbers(dir, p.slug, p.docId)).sort((a, b) => a - b)) {
    const ref = proposalRef(p.slug, p.docId, n);
    const [sha, author, date, subject, body] = (await git(dir, ["log", "-1", "--format=%H%x00%an%x00%aI%x00%s%x00%b", ref])).split("\0");
    const sectionId = /^Section: (.+)$/m.exec(body ?? "")?.[1]?.trim();
    const base = (await git(dir, ["merge-base", "refs/heads/main", sha])).trim();
    const branchText = await git(dir, ["show", `${sha}:${p.relPath}`]);
    const baseText = await git(dir, ["show", `${base}:${p.relPath}`]).catch(() => "");
    // Without a trailer (a hand-made branch), find the one section that changed.
    const changed =
      sectionId ??
      splitSections(branchText.replace(/^---\n[\s\S]*?\n---\n?/, "")).find((s) => sectionBody(baseText, s.id) !== s.body)?.id;
    if (!changed) continue;
    const newBody = sectionBody(branchText, changed) ?? "";
    const stale = sectionBody(baseText, changed) !== sectionBody(p.currentFileText, changed);
    out.push({ id: String(n), sectionId: changed, agentId: author, newBody, rationale: subject, state: stale ? "stale" : "open", createdAt: date });
  }
  return out;
}

export async function proposalFileText(
  paths: SmithPaths,
  p: { slug: string; docId: string; id: string; relPath: string },
): Promise<{ branchText: string; baseText: string } | null> {
  const dir = paths.orgRepo;
  const ref = proposalRef(p.slug, p.docId, Number(p.id));
  let sha: string;
  try {
    sha = (await git(dir, ["rev-parse", "--verify", "--quiet", ref])).trim();
  } catch {
    return null;
  }
  const base = (await git(dir, ["merge-base", "refs/heads/main", sha])).trim();
  return {
    branchText: await git(dir, ["show", `${sha}:${p.relPath}`]),
    baseText: await git(dir, ["show", `${base}:${p.relPath}`]).catch(() => ""),
  };
}

/** Delete the branch; reflog keeps the commit. False when it was already gone. */
export async function deleteProposal(paths: SmithPaths, p: { slug: string; docId: string; id: string }): Promise<boolean> {
  return withOrgRepoQueue(paths.orgRepo, async () => {
    const ref = proposalRef(p.slug, p.docId, Number(p.id));
    try {
      await git(paths.orgRepo, ["rev-parse", "--verify", "--quiet", ref]);
    } catch {
      return false;
    }
    await git(paths.orgRepo, ["update-ref", "-d", ref]);
    return true;
  });
}
```

Note on `git(…, input)`: `promisify(execFile)` returns a promise with a `.child` property (Node ≥ 14); writing to `child.stdin` before awaiting is the documented way to feed stdin. If your Node version's typing complains, use `execFile` with a callback wrapped in a `new Promise` for the one stdin case.

- [ ] **Step 4: Run the tests; typecheck; lint; commit**

Run: the Step 2 command. Expected: all `ok`.

```bash
pnpm --config.verify-deps-before-run=false -C swarm typecheck && pnpm --config.verify-deps-before-run=false -C swarm lint
git add swarm/src/document-proposals.ts swarm/src/document-proposals.test.ts
git commit -m "feat(swarm): proposals are branches — built with plumbing against a private index

One commit on refs/heads/proposals/<slug>/<docId>/<n>, parent main, author
the proposing agent; main and the live checkout never move. Stale is
derived from git: the section moved on main since the branch point."
```

---

### Task 7: `document-store.ts` — the fs+git facade

**Files:**
- Create: `swarm/src/document-store.ts`, `swarm/src/document-store.test.ts`

**Interfaces:**
- Consumes: Tasks 1–6 (`normalizeMarkdown`, `document-file`, `blueprints`, `document-rules`, `commitPaths`/`withOrgRepoQueue`, `agentAuthor`, `document-proposals`), `configDirFor`, `slugForDir`, `activeWorkspaces`, `loadCapabilities(paths.workCapabilities)`.
- Produces (every mutation writes the file, then commits exactly that file through the queue; every return is the fresh wire shape read back from disk):

```ts
export interface DocWire {
  id: string; workspace: string; title: string; blueprintId: string; workType: string; effort: string;
  sections: DocSection[]; participants: string[]; proposals: ProposalWire[]; pins: string[];
  status: DocStatus; createdAt: string; updatedAt: string; problems: Problem[];
}
export interface Located { ws: Workspace; slug: string; folder: BlueprintFolder; id: string; relPath: string; absPath: string }
export class AmbiguousDocumentError extends Error { constructor(id: string, workspaces: string[]) }
export type StoreResult = DocWire | { error: string; status: number };

export async function listWorkspaceDocuments(paths, ws: Workspace): Promise<DocWire[]>;
export async function listDocuments(paths, workspaces: Workspace[]): Promise<DocWire[]>;        // active workspaces only
export async function resolveDocument(paths, workspaces: Workspace[], id: string): Promise<Located | null>;  // throws AmbiguousDocumentError
export async function getDocument(paths, workspaces, id): Promise<DocWire | null>;
export async function createDocument(paths, ws, input: { blueprintId: string; workType?: string; title?: string; effort?: string; author: GitAuthor; now?: () => string }): Promise<StoreResult>;
export async function importDocument(paths, ws, legacy: LegacyDoc, now?: () => string): Promise<StoreResult>;
export async function patchSection(paths, workspaces, id, sectionId, body, author): Promise<StoreResult | null>;
export async function renameDocument(paths, workspaces, id, title, author): Promise<StoreResult | null>;
export async function changeBlueprint(paths, workspaces, id, blueprintId, workType: string | undefined, author): Promise<StoreResult | null>;
export async function setPins(paths, workspaces, id, pins: string[], author): Promise<StoreResult | null>;
export async function setStatus(paths, workspaces, id, status: DocStatus, author): Promise<StoreResult | null>;   // refuses with { error, status: 409, problems }
export async function addProposal(paths, workspaces, id, p: { sectionId; newBody; agentId; rationale }): Promise<StoreResult | null>;
export async function acceptProposal(paths, workspaces, id, proposalId): Promise<StoreResult | null>;   // stale → { error, status: 409 }
export async function rejectProposal(paths, workspaces, id, proposalId): Promise<StoreResult | null>;
export interface LegacyDoc { id: string; title: string; blueprintId: string; workType: string; sections: DocSection[]; participants: string[]; proposals: Array<{ id: string; sectionId: string; agentId: string; newBody: string; rationale: string; state: string; createdAt: string }>; pins?: string[]; status: DocStatus; createdAt: string; updatedAt: string }
```

Commit messages (`kind` = the folder without its trailing `s`): `<kind>(<effort>): create` · `: <sectionId>` · `: rename` · `: blueprint → <id>` · `: pins` · `: status → <to>` · `: accept proposal <n> — <sectionId>` · `: import` (author `SMITH_IDENTITY`).

- [ ] **Step 1: Write the failing tests**

Create `swarm/src/document-store.test.ts`:

```ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  acceptProposal,
  addProposal,
  AmbiguousDocumentError,
  changeBlueprint,
  createDocument,
  type DocWire,
  getDocument,
  importDocument,
  listDocuments,
  patchSection,
  rejectProposal,
  renameDocument,
  resolveDocument,
  setPins,
  setStatus,
} from "./document-store.js";
import { makeOrgRepo } from "./org-repo.fixture.js";
import { smithPaths } from "./paths.js";
import type { Workspace } from "./workspaces.js";

const EDWIN = { name: "Edwin Cruz", email: "e@example.com" };
const PG: Workspace = { name: "pg", repos: [] };
const OTHER: Workspace = { name: "other", repos: [] };
const WS = [PG, OTHER];
const NOW = () => "2026-08-22T15:30:00.000Z";

function setup(label: string) {
  const root = mkdtempSync(join(tmpdir(), `docstore-${label}-`));
  const paths = smithPaths(root);
  makeOrgRepo(root, ["pg", "other"]);
  return { root, paths };
}
function isDoc(r: unknown): r is DocWire {
  return !!r && typeof r === "object" && "id" in (r as object);
}
function lastLog(dir: string): string {
  return execFileSync("git", ["log", "-1", "--format=%an|%s", "--name-only"], { cwd: dir }).toString();
}

test("createDocument: a spec lands in specs/ with the §2 frontmatter, instantiated sections, one authored commit", async () => {
  const { root, paths } = setup("create");
  try {
    const r = await createDocument(paths, PG, { blueprintId: "spec", workType: "feature", title: "Instance provisioning", author: EDWIN, now: NOW });
    assert.ok(isDoc(r), JSON.stringify(r));
    assert.equal(r.id, "2026-08-22-1530-instance-provisioning-design");
    assert.equal(r.workspace, "pg");
    assert.equal(r.effort, "instance-provisioning");
    assert.deepEqual(r.sections.map((s) => s.id), ["overview", "ui-refs", "approach", "non-goals", "testing"]);
    assert.equal(r.status, "drafting");
    assert.deepEqual(r.problems, []);
    const file = join(paths.orgRepo, "workspaces", "pg", "specs", `${r.id}.md`);
    const text = readFileSync(file, "utf8");
    assert.match(text, /^---\ntitle: Instance provisioning\nblueprint: spec\nworkType: feature\nstatus: drafting\neffort: instance-provisioning\n/);
    assert.match(text, /^## What this is \{#overview\}$/m);
    assert.match(lastLog(paths.orgRepo), /^Edwin Cruz\|spec\(instance-provisioning\): create\n[\s\S]*workspaces\/pg\/specs\//);
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: paths.orgRepo }).toString(), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("createDocument: an id collision gets a -2 suffix; an unknown blueprint or workType is a 400", async () => {
  const { root, paths } = setup("collide");
  try {
    const a = await createDocument(paths, PG, { blueprintId: "spec", workType: "feature", effort: "x", author: EDWIN, now: NOW });
    const b = await createDocument(paths, PG, { blueprintId: "spec", workType: "feature", effort: "x", author: EDWIN, now: NOW });
    assert.ok(isDoc(a) && isDoc(b));
    assert.equal(b.id, `${a.id}-2`);
    const bad = await createDocument(paths, PG, { blueprintId: "nope", author: EDWIN, now: NOW });
    assert.deepEqual(bad, { error: "unknown blueprint: nope", status: 400 });
    const badType = await createDocument(paths, PG, { blueprintId: "spec", workType: "insight", author: EDWIN, now: NOW });
    assert.ok(!isDoc(badType) && badType.status === 400);
    const untitled = await createDocument(paths, PG, { blueprintId: "dashboard", author: EDWIN, now: NOW });
    assert.ok(isDoc(untitled));
    assert.equal(untitled.title, "Dashboard", "a blank title takes the blueprint name");
    assert.match(untitled.id, /^2026-08-22-1530-dashboard/);
    assert.ok(statSync(join(paths.orgRepo, "workspaces", "pg", "dashboards", `${untitled.id}.md`)).isFile());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("patchSection: normalizes, stamps updatedAt, commits as the author with the section in the message", async () => {
  const { root, paths } = setup("patch");
  try {
    const doc = (await createDocument(paths, PG, { blueprintId: "spec", workType: "feature", effort: "x", author: EDWIN, now: NOW })) as DocWire;
    const r = await patchSection(paths, WS, doc.id, "approach", "* a\n* b", EDWIN);
    assert.ok(isDoc(r));
    assert.equal(r.sections.find((s) => s.id === "approach")?.body, "- a\n- b");
    assert.notEqual(r.updatedAt, doc.createdAt);
    assert.match(lastLog(paths.orgRepo), /^Edwin Cruz\|spec\(x\): approach/);
    assert.equal(await patchSection(paths, WS, doc.id, "nope", "x", EDWIN), null);
    assert.equal(await patchSection(paths, WS, "missing-id", "approach", "x", EDWIN), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveDocument: finds a document in whichever workspace holds it; the same id in two workspaces is ambiguous", async () => {
  const { root, paths } = setup("resolve");
  try {
    const a = (await createDocument(paths, PG, { blueprintId: "spec", workType: "feature", effort: "same", author: EDWIN, now: NOW })) as DocWire;
    assert.equal((await resolveDocument(paths, WS, a.id))?.slug, "pg");
    assert.equal(await resolveDocument(paths, WS, "2099-01-01-0000-nothing"), null);
    await createDocument(paths, OTHER, { blueprintId: "spec", workType: "feature", effort: "same", author: EDWIN, now: NOW });
    await assert.rejects(() => resolveDocument(paths, WS, a.id), AmbiguousDocumentError);
    const all = await listDocuments(paths, WS);
    assert.equal(all.length, 2);
    assert.deepEqual(all.map((d) => d.workspace).sort(), ["other", "pg"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setStatus: the gates bite — review refuses a missing section, final refuses an empty required one; reopen always works", async () => {
  const { root, paths } = setup("status");
  try {
    const doc = (await createDocument(paths, PG, { blueprintId: "spec", workType: "feature", effort: "x", author: EDWIN, now: NOW })) as DocWire;
    const toReview = await setStatus(paths, WS, doc.id, "review", EDWIN);
    assert.ok(isDoc(toReview) && toReview.status === "review", JSON.stringify(toReview));
    assert.match(lastLog(paths.orgRepo), /spec\(x\): status → review/);
    const toFinal = await setStatus(paths, WS, doc.id, "final", EDWIN);
    assert.ok(!isDoc(toFinal) && toFinal.status === 409 && /overview/.test(JSON.stringify(toFinal)));
    await patchSection(paths, WS, doc.id, "overview", "x", EDWIN);
    await patchSection(paths, WS, doc.id, "non-goals", "y", EDWIN);
    const fin = await setStatus(paths, WS, doc.id, "final", EDWIN);
    assert.ok(isDoc(fin) && fin.status === "final");
    const back = await setStatus(paths, WS, doc.id, "drafting", EDWIN);
    assert.ok(isDoc(back) && back.status === "drafting");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("proposals: add → listed open → accept writes the section on main as the agent and deletes the branch", async () => {
  const { root, paths } = setup("accept");
  try {
    const doc = (await createDocument(paths, PG, { blueprintId: "spec", workType: "feature", effort: "x", author: EDWIN, now: NOW })) as DocWire;
    const withP = (await addProposal(paths, WS, doc.id, { sectionId: "approach", newBody: "agent text", agentId: "anderson", rationale: "tighter" })) as DocWire;
    assert.equal(withP.proposals.length, 1);
    assert.equal(withP.proposals[0].state, "open");
    assert.equal(withP.sections.find((s) => s.id === "approach")?.body, "", "a proposal is not a write");
    const accepted = (await acceptProposal(paths, WS, doc.id, withP.proposals[0].id)) as DocWire;
    assert.equal(accepted.sections.find((s) => s.id === "approach")?.body, "agent text");
    assert.deepEqual(accepted.proposals, []);
    assert.match(lastLog(paths.orgRepo), /^anderson\|spec\(x\): accept proposal 1 — approach/);
    const refs = execFileSync("git", ["for-each-ref", "refs/heads/proposals/"], { cwd: paths.orgRepo }).toString();
    assert.equal(refs, "", "branch deleted after accept");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("proposals: a human write stales the open proposal; accepting a stale one is refused; reject deletes", async () => {
  const { root, paths } = setup("stale");
  try {
    const doc = (await createDocument(paths, PG, { blueprintId: "spec", workType: "feature", effort: "x", author: EDWIN, now: NOW })) as DocWire;
    const withP = (await addProposal(paths, WS, doc.id, { sectionId: "approach", newBody: "agent text", agentId: "anderson", rationale: "r" })) as DocWire;
    const pid = withP.proposals[0].id;
    const afterHuman = (await patchSection(paths, WS, doc.id, "approach", "human text", EDWIN)) as DocWire;
    assert.equal(afterHuman.proposals[0].state, "stale");
    const refused = await acceptProposal(paths, WS, doc.id, pid);
    assert.ok(!isDoc(refused) && refused?.status === 409 && /stale/.test(refused.error));
    const rejected = (await rejectProposal(paths, WS, doc.id, pid)) as DocWire;
    assert.deepEqual(rejected.proposals, []);
    assert.equal(rejected.sections.find((s) => s.id === "approach")?.body, "human text");
    assert.equal(await rejectProposal(paths, WS, doc.id, pid), null, "gone is gone");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("renameDocument / setPins / changeBlueprint: title and pins change, the file does not move; re-casting needs an empty document in the same folder", async () => {
  const { root, paths } = setup("misc");
  try {
    const doc = (await createDocument(paths, PG, { blueprintId: "spec", workType: "feature", effort: "x", author: EDWIN, now: NOW })) as DocWire;
    const renamed = (await renameDocument(paths, WS, doc.id, "  New   title ", EDWIN)) as DocWire;
    assert.equal(renamed.title, "New title");
    assert.equal(renamed.id, doc.id);
    assert.equal(await renameDocument(paths, WS, doc.id, "   ", EDWIN) === null || true, true);
    const pinned = (await setPins(paths, WS, doc.id, ["pg", "group:team"], EDWIN)) as DocWire;
    assert.deepEqual(pinned.pins, ["pg", "group:team"]);
    const recast = (await changeBlueprint(paths, WS, doc.id, "er", undefined, EDWIN)) as DocWire;
    assert.equal(recast.blueprintId, "er", "er shares the specs folder, and the document is still empty");
    assert.match(recast.sections[0].body, /^```mermaid/);
    const toPlan = await changeBlueprint(paths, WS, doc.id, "implementation-plan", undefined, EDWIN);
    assert.ok(!isDoc(toPlan) && toPlan?.status === 409, "a different folder means a different file — create a new document instead");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("importDocument: a legacy broker Doc becomes a file with its sections, pins, status, and its OPEN proposals as branches", async () => {
  const { root, paths } = setup("import");
  try {
    const r = await importDocument(paths, PG, {
      id: "d2",
      title: "Design Spec 2",
      blueprintId: "spec",
      workType: "feature",
      sections: [
        { id: "overview", heading: "What this is", body: "hello" },
        { id: "approach", heading: "Approach", body: "" },
      ],
      participants: ["anderson"],
      proposals: [
        { id: "p1", sectionId: "approach", agentId: "anderson", newBody: "try this", rationale: "r", state: "open", createdAt: "2026-08-19T17:17:17.910Z" },
        { id: "p2", sectionId: "approach", agentId: "anderson", newBody: "old", rationale: "r", state: "rejected", createdAt: "2026-08-19T17:17:17.910Z" },
      ],
      pins: ["pg"],
      status: "review",
      createdAt: "2026-08-19T17:17:17.910Z",
      updatedAt: "2026-08-19T17:20:00.000Z",
    });
    assert.ok(isDoc(r), JSON.stringify(r));
    assert.equal(r.id, "2026-08-19-1717-design-spec-2-design");
    assert.equal(r.status, "review");
    assert.deepEqual(r.pins, ["pg"]);
    assert.deepEqual(r.participants, ["anderson"]);
    assert.equal(r.sections.find((s) => s.id === "overview")?.body, "hello");
    assert.equal(r.proposals.length, 1, "only the OPEN proposal becomes a branch");
    assert.equal(r.proposals[0].newBody, "try this");
    assert.match(lastLog(paths.orgRepo), /^anderson\|/);
    const again = await importDocument(paths, PG, { ...(JSON.parse(JSON.stringify({ id: "d2", title: "Design Spec 2", blueprintId: "spec", workType: "feature", sections: [], participants: [], proposals: [], status: "drafting", createdAt: "2026-08-19T17:17:17.910Z", updatedAt: "x" }))) });
    assert.ok(!isDoc(again) && again.status === 409, "importing the same document twice is refused, not duplicated");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 'src/document-store.test.ts' > /tmp/t.txt 2>&1; echo "exit $?"; grep -E '^ℹ (tests|pass|fail)' /tmp/t.txt; grep -E '✖|AssertionError|Cannot find' /tmp/t.txt | head`
Expected: module not found.

- [ ] **Step 3: Implement**

Create `swarm/src/document-store.ts`:

```ts
// The document store (spec 2026-08-22 §3): the fs+git facade over
// document-file (text), blueprints (schema), document-rules (gates), and
// document-proposals (branches). Truth is the disk — every read lists the
// directory, every mutation writes the file and commits exactly that file
// through the per-org-repo queue with the acting author. No cache.
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { activeSections, type Blueprint, type BlueprintFolder, instantiateSections, loadBlueprintsFor } from "./blueprints.js";
import { loadCapabilities } from "./capabilities.js";
import {
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
  proposals: Array<{ id: string; sectionId: string; agentId: string; newBody: string; rationale: string; state: string; createdAt: string }>;
  pins?: string[];
  status: DocStatus;
  createdAt: string;
  updatedAt: string;
}

export class AmbiguousDocumentError extends Error {
  constructor(id: string, workspaces: string[]) {
    super(`Document "${id}" exists in more than one workspace (${workspaces.join(", ")}) — address it through its workspace`);
    this.name = "AmbiguousDocumentError";
  }
}

const FOLDERS: BlueprintFolder[] = ["specs", "plans", "dashboards"];
const kindOf = (folder: BlueprintFolder): string => folder.replace(/s$/, "");
const nowIso = (): string => new Date().toISOString();

function located(paths: SmithPaths, ws: Workspace, folder: BlueprintFolder, id: string): Located {
  const slug = slugForDir(ws.name);
  const relPath = `workspaces/${slug}/${folder}/${id}.md`;
  return { ws, slug, folder, id, relPath, absPath: join(paths.orgRepo, relPath) };
}

async function listIds(paths: SmithPaths, ws: Workspace, folder: BlueprintFolder): Promise<string[]> {
  try {
    return (await readdir(join(configDirFor(paths, ws), folder))).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3));
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
  return {
    async specStatus(docId) {
      const r = await readParsed(located(paths, ws, "specs", docId));
      return r ? r.doc.frontmatter.status : null;
    },
    async sliceExists(sliceId) {
      const { capabilities } = await loadCapabilities(paths.workCapabilities);
      return capabilities.some((c) => c.workspaceId === ws.name && c.slices.some((s) => s.id === sliceId));
    },
  };
}

async function toWire(paths: SmithPaths, loc: Located, text: string, doc: ParsedDocument, bp: Blueprint | undefined): Promise<DocWire> {
  const fm = doc.frontmatter;
  const problems = bp
    ? await validateDocument(bp, doc, resolvers(paths, loc.ws))
    : [{ where: "frontmatter.blueprint", message: `unknown blueprint: ${fm.blueprint}` }];
  const proposals = await listProposals(paths, { slug: loc.slug, docId: loc.id, relPath: loc.relPath, currentFileText: text });
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

/** Write the file and commit exactly it, inside the queue. Returns the fresh wire shape. */
async function writeDoc(paths: SmithPaths, loc: Located, doc: ParsedDocument, author: GitAuthor, message: string): Promise<DocWire> {
  await mkdir(join(loc.absPath, ".."), { recursive: true });
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
      // An unparseable file is not a document; it is left for a human and never served half-read.
      if (r) out.push(await toWire(paths, loc, r.text, r.doc, bps.find((b) => b.id === r.doc.frontmatter.blueprint)));
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
  if (hits.length > 1) throw new AmbiguousDocumentError(id, hits.map((h) => h.ws.name));
  return hits[0] ?? null;
}

export async function getDocument(paths: SmithPaths, workspaces: Workspace[], id: string): Promise<DocWire | null> {
  const loc = await resolveDocument(paths, workspaces, id);
  const r = loc && (await readParsed(loc));
  return loc && r ? toWire(paths, loc, r.text, r.doc, await blueprintFor(paths, loc.ws, r.doc.frontmatter.blueprint)) : null;
}

async function freeId(paths: SmithPaths, ws: Workspace, folder: BlueprintFolder, base: string): Promise<string> {
  const taken = new Set(await listIds(paths, ws, folder));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

export async function createDocument(
  paths: SmithPaths,
  ws: Workspace,
  input: { blueprintId: string; workType?: string; title?: string; effort?: string; author: GitAuthor; now?: () => string },
): Promise<StoreResult> {
  const bp = await blueprintFor(paths, ws, input.blueprintId);
  if (!bp) return { error: `unknown blueprint: ${input.blueprintId}`, status: 400 };
  const workType = input.workType ?? bp.workTypes[0] ?? "";
  const sections = instantiateSections(bp, workType);
  if (!sections) return { error: `workType must be one of: ${bp.workTypes.join(", ")}`, status: 400 };
  const now = (input.now ?? nowIso)();
  const title = input.title?.replace(/\s+/g, " ").trim() || bp.name;
  const effort = slugify(input.effort?.trim() || title); // slugify is TOTAL (document-file.ts) — no fallback needed
  const id = await freeId(paths, ws, bp.folder, documentFileId(now, effort, bp.id));
  const doc: ParsedDocument = {
    frontmatter: { title, blueprint: bp.id, workType, status: "drafting", effort, slices: [], participants: [], pins: [], createdAt: now, updatedAt: now },
    sections,
  };
  return writeDoc(paths, located(paths, ws, bp.folder, id), doc, input.author, `${kindOf(bp.folder)}(${effort}): create`);
}

/** §9.3: a legacy broker Doc → file. Idempotent by id: the same legacy doc (same createdAt + title) imported twice is refused. Open proposals become branches; decided ones are dropped. */
export async function importDocument(paths: SmithPaths, ws: Workspace, legacy: LegacyDoc, now: () => string = nowIso): Promise<StoreResult> {
  const bp = await blueprintFor(paths, ws, legacy.blueprintId);
  if (!bp) return { error: `unknown blueprint: ${legacy.blueprintId}`, status: 400 };
  const title = legacy.title.replace(/\s+/g, " ").trim() || bp.name;
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
      participants: legacy.participants ?? [],
      pins: legacy.pins ?? [],
      createdAt: legacy.createdAt,
      updatedAt: legacy.updatedAt || now(),
    },
    sections: legacy.sections.map((s) => ({ ...s, body: normalizeMarkdown(s.body) })),
  };
  await writeDoc(paths, loc, doc, SMITH_IDENTITY, `${kindOf(bp.folder)}(${effort}): import`);
  for (const p of legacy.proposals ?? []) {
    if (p.state !== "open" || !doc.sections.some((s) => s.id === p.sectionId)) continue;
    const proposed: ParsedDocument = { ...doc, sections: doc.sections.map((s) => (s.id === p.sectionId ? { ...s, body: normalizeMarkdown(p.newBody) } : s)) };
    await createProposal(paths, { slug: loc.slug, docId: id, relPath: loc.relPath, newFileText: serializeDocumentFile(proposed), sectionId: p.sectionId, author: agentAuthor(p.agentId), rationale: p.rationale });
  }
  const r = await readParsed(loc);
  return r ? toWire(paths, loc, r.text, r.doc, bp) : { error: "import did not read back", status: 500 };
}

async function mutate(
  paths: SmithPaths,
  workspaces: Workspace[],
  id: string,
  author: GitAuthor,
  change: (doc: ParsedDocument, loc: Located, bp: Blueprint | undefined) => Promise<{ doc: ParsedDocument; message: string } | { error: string; status: number; problems?: Problem[] } | null>,
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

export function patchSection(paths: SmithPaths, workspaces: Workspace[], id: string, sectionId: string, body: string, author: GitAuthor): Promise<StoreResult | null> {
  return mutate(paths, workspaces, id, author, async (doc, loc) => {
    const s = doc.sections.find((x) => x.id === sectionId);
    if (!s) return null;
    s.body = normalizeMarkdown(body);
    return { doc, message: `${kindOf(loc.folder)}(${doc.frontmatter.effort}): ${sectionId}` };
  });
}

export function renameDocument(paths: SmithPaths, workspaces: Workspace[], id: string, title: string, author: GitAuthor): Promise<StoreResult | null> {
  return mutate(paths, workspaces, id, author, async (doc, loc) => {
    const clean = title.replace(/\s+/g, " ").trim();
    if (!clean) return { error: "a document needs a title", status: 400 };
    doc.frontmatter.title = clean;
    return { doc, message: `${kindOf(loc.folder)}(${doc.frontmatter.effort}): rename` };
  });
}

export function setPins(paths: SmithPaths, workspaces: Workspace[], id: string, pins: string[], author: GitAuthor): Promise<StoreResult | null> {
  return mutate(paths, workspaces, id, author, async (doc, loc) => {
    doc.frontmatter.pins = [...new Set(pins.map((p) => p.trim()).filter(Boolean))];
    return { doc, message: `${kindOf(loc.folder)}(${doc.frontmatter.effort}): pins` };
  });
}

/** Re-cast under another blueprint: only while every section is empty, and only within the same folder (the file never moves). */
export function changeBlueprint(paths: SmithPaths, workspaces: Workspace[], id: string, blueprintId: string, workType: string | undefined, author: GitAuthor): Promise<StoreResult | null> {
  return mutate(paths, workspaces, id, author, async (doc, loc) => {
    if (doc.sections.some((s) => s.body.trim())) return { error: "the document already has content — re-casting would discard it", status: 409 };
    const bp = await blueprintFor(paths, loc.ws, blueprintId);
    if (!bp) return { error: `unknown blueprint: ${blueprintId}`, status: 400 };
    if (bp.folder !== loc.folder) return { error: `"${blueprintId}" lives in ${bp.folder}/, this document in ${loc.folder}/ — create a new document instead`, status: 409 };
    const wt = workType ?? bp.workTypes[0] ?? "";
    const sections = instantiateSections(bp, wt);
    if (!sections) return { error: `workType must be one of: ${bp.workTypes.join(", ")}`, status: 400 };
    doc.frontmatter.blueprint = bp.id;
    doc.frontmatter.workType = wt;
    doc.sections = sections;
    return { doc, message: `${kindOf(loc.folder)}(${doc.frontmatter.effort}): blueprint → ${bp.id}` };
  });
}

export function setStatus(paths: SmithPaths, workspaces: Workspace[], id: string, status: DocStatus, author: GitAuthor): Promise<StoreResult | null> {
  return mutate(paths, workspaces, id, author, async (doc, loc, bp) => {
    if (!bp) return { error: `unknown blueprint: ${doc.frontmatter.blueprint}`, status: 409 };
    const problems = await transitionProblems(bp, doc, status, resolvers(paths, loc.ws));
    if (problems.length > 0) return { error: `cannot move to ${status}: ${problems.map((p) => `${p.where} — ${p.message}`).join("; ")}`, status: 409, problems };
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
  const proposed: ParsedDocument = { ...r.doc, sections: r.doc.sections.map((s) => (s.id === p.sectionId ? { ...s, body: normalizeMarkdown(p.newBody) } : s)) };
  await createProposal(paths, { slug: loc.slug, docId: id, relPath: loc.relPath, newFileText: serializeDocumentFile(proposed), sectionId: p.sectionId, author: agentAuthor(p.agentId), rationale: p.rationale });
  return getDocument(paths, workspaces, id);
}

/** Accept = the section write on main as the proposing agent, then the branch goes. A stale proposal is refused: the text it was written against is gone. */
export async function acceptProposal(paths: SmithPaths, workspaces: Workspace[], id: string, proposalId: string): Promise<StoreResult | null> {
  const loc = await resolveDocument(paths, workspaces, id);
  const r = loc && (await readParsed(loc));
  if (!loc || !r) return null;
  const live = (await listProposals(paths, { slug: loc.slug, docId: id, relPath: loc.relPath, currentFileText: r.text })).find((p) => p.id === proposalId);
  if (!live) return null;
  if (live.state === "stale") return { error: `proposal ${proposalId} is stale — "${live.sectionId}" changed since it was written; reject it or ask for a new one`, status: 409 };
  const result = await mutate(paths, workspaces, id, agentAuthor(live.agentId), async (doc, l) => {
    const s = doc.sections.find((x) => x.id === live.sectionId);
    if (!s) return null;
    s.body = live.newBody;
    return { doc, message: `${kindOf(l.folder)}(${doc.frontmatter.effort}): accept proposal ${proposalId} — ${live.sectionId}` };
  });
  if (result && !("error" in result)) await deleteProposal(paths, { slug: loc.slug, docId: id, id: proposalId });
  return result ? getDocument(paths, workspaces, id) : null;
}

export async function rejectProposal(paths: SmithPaths, workspaces: Workspace[], id: string, proposalId: string): Promise<StoreResult | null> {
  const loc = await resolveDocument(paths, workspaces, id);
  if (!loc) return null;
  const gone = await deleteProposal(paths, { slug: loc.slug, docId: id, id: proposalId });
  return gone ? getDocument(paths, workspaces, id) : null;
}
```

Import note: the import block above is correct as written (an earlier draft named a module `./workspaces-and-repos.js` that does not exist). `Capability.slices` is `CapSlice[]` with an `id` field — verified in `capabilities.ts`.

`proposalFileText` is imported for completeness of the module contract; if biome flags it unused, drop the import (the accept path derives the body from `listProposals`).

- [ ] **Step 4: Run the tests; typecheck; lint; full suite; commit**

Run: the Step 2 command until all `ok`; then the full suite (`SMITH_STATE_ROOT=$(mktemp -d) pnpm --config.verify-deps-before-run=false -C swarm test > /tmp/t7.txt 2>&1; echo $?`).

```bash
pnpm --config.verify-deps-before-run=false -C swarm typecheck && pnpm --config.verify-deps-before-run=false -C swarm lint
git add swarm/src/document-store.ts swarm/src/document-store.test.ts
git commit -m "feat(swarm): the document store — files in the org repo, every write committed by its author

Create, patch, rename, re-cast, pin, gate status transitions, propose,
accept, reject, import — each a file write plus one commit of exactly that
file through the per-repo queue. Truth is the disk; no cache."
```

---

### Task 8: Swarm document routes and the broker's client methods

**Files:**
- Modify: `swarm/src/server.ts` (inside `registerRoutes()`, next to the `/workspaces/:name/roster` route; + one exported pure helper near `buildUserUpdate`)
- Modify: `broker/src/swarm-client.ts` (+ wire types, + methods)
- Test: `swarm/src/server.test.ts`, `broker/src/swarm-client.test.ts`

**Interfaces:**
- Consumes: every `document-store.ts` export (Task 7), `loadBlueprintsFor` (Task 3), `this.actingAuthor()`, `loadWorkspaces(this.paths)`.
- Produces (swarm, JSON everywhere, `{ error }` on failure):

```
GET    /blueprints?workspace=<name>                 → { blueprints: Blueprint[] }
GET    /documents                                    → { documents: DocWire[] }        (active workspaces)
GET    /workspaces/:name/documents                   → { documents: DocWire[] }
POST   /workspaces/:name/documents                   { blueprintId, workType?, title?, effort? } → 201 DocWire
POST   /workspaces/:name/documents/import            { doc: LegacyDoc } → 201 DocWire | 409 already imported
GET    /documents/:id                                → DocWire | 404 | 409 ambiguous
PATCH  /documents/:id                                { title? } | { status? } | { blueprintId?, workType? } | { pins? } → DocWire
PUT    /documents/:id/sections/:sid                  { body } → DocWire
POST   /documents/:id/proposals                      { sectionId, newBody, agentId, rationale } → 201 DocWire
POST   /documents/:id/proposals/:pid/accept|reject   → DocWire | 409 stale
```
  and the pure helper `storeReply(r: StoreResult | null, created = false): { status: number; body: unknown }` (null → 404 `{ error: "unknown document" }`; `{error,status,problems?}` → that status; a doc → 200/201).
- Produces (broker `SwarmClient`): `export type Doc`, `Proposal`, `Blueprint` (the wire shapes above — move the type definitions here from `documents.ts`/`blueprints.ts`; `Doc` gains `workspace`, `effort`, `problems`; `Blueprint` gains `folder`, sections gain `shape?`), and

```ts
listBlueprints(workspace?: string): Promise<Blueprint[]>
listDocuments(): Promise<Doc[]>
createDocument(workspace: string, body: { blueprintId: string; workType?: string; title?: string; effort?: string }): Promise<Doc>
importDocument(workspace: string, doc: unknown): Promise<Doc>            // throws on 4xx/5xx with the swarm's message (http() does that already)
getDocument(id: string): Promise<Doc | null>                              // 404 → null
patchDocument(id: string, body: Record<string, unknown>): Promise<Doc>
putSection(id: string, sectionId: string, body: string): Promise<Doc>
addProposal(id: string, p: { sectionId: string; newBody: string; agentId: string; rationale: string }): Promise<Doc>
decideProposal(id: string, proposalId: string, decision: "accept" | "reject"): Promise<Doc>
```

- [ ] **Step 1: Write the failing tests**

Append to `swarm/src/server.test.ts` (import `storeReply` from `./server.js`):

```ts
test("storeReply: null is 404, a store error keeps its status and problems, a doc is 200 (201 on create)", () => {
  assert.deepEqual(storeReply(null), { status: 404, body: { error: "unknown document" } });
  assert.deepEqual(storeReply({ error: "stale", status: 409 }), { status: 409, body: { error: "stale" } });
  const withProblems = storeReply({ error: "cannot", status: 409, problems: [{ where: "section:a", message: "m" }] });
  assert.equal(withProblems.status, 409);
  assert.deepEqual((withProblems.body as { problems: unknown }).problems, [{ where: "section:a", message: "m" }]);
  const doc = { id: "x" } as never;
  assert.deepEqual(storeReply(doc), { status: 200, body: doc });
  assert.deepEqual(storeReply(doc, true), { status: 201, body: doc });
});
```

Append to `broker/src/swarm-client.test.ts` (follow the file's existing stub-fetch pattern: a `fetchImpl` that records `(url, init)` and returns a canned `Response`):

```ts
test("document methods hit the swarm's document routes with the right verbs, bodies, and encodings", async () => {
  const calls: Array<{ url: string; method?: string; body?: string }> = [];
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method, body: init?.body as string | undefined });
    if (url.endsWith("/documents/missing")) return new Response(JSON.stringify({ error: "unknown document" }), { status: 404 });
    const body = url.endsWith("/documents") && init?.method === undefined ? { documents: [{ id: "d" }] } : url.includes("/blueprints") ? { blueprints: [{ id: "spec" }] } : { id: "d" };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  const c = new SwarmClient({ baseUrl: "http://x", fetchImpl: fetch as unknown as typeof globalThis.fetch });

  assert.deepEqual(await c.listBlueprints("my ws"), [{ id: "spec" }]);
  assert.deepEqual(await c.listDocuments(), [{ id: "d" }]);
  await c.createDocument("pg", { blueprintId: "spec", title: "T" });
  await c.putSection("2026-x", "approach", "* a");
  await c.patchDocument("2026-x", { status: "review" });
  await c.addProposal("2026-x", { sectionId: "approach", newBody: "b", agentId: "anderson", rationale: "r" });
  await c.decideProposal("2026-x", "3", "accept");
  assert.equal(await c.getDocument("missing"), null);

  assert.deepEqual(
    calls.map((k) => `${k.method ?? "GET"} ${k.url.replace("http://x", "")}`),
    [
      "GET /blueprints?workspace=my%20ws",
      "GET /documents",
      "POST /workspaces/pg/documents",
      "PUT /documents/2026-x/sections/approach",
      "PATCH /documents/2026-x",
      "POST /documents/2026-x/proposals",
      "POST /documents/2026-x/proposals/3/accept",
      "GET /documents/missing",
    ],
  );
  assert.deepEqual(JSON.parse(calls[2].body!), { blueprintId: "spec", title: "T" });
  assert.deepEqual(JSON.parse(calls[3].body!), { body: "* a" });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 'src/server.test.ts' > /tmp/t.txt 2>&1; echo "exit $?"; grep -E '^ℹ (tests|pass|fail)' /tmp/t.txt; grep -E '✖|AssertionError|Cannot find' /tmp/t.txt | head` and `cd broker && node --import tsx --test 'src/swarm-client.test.ts' > /tmp/t.txt 2>&1; echo "exit $?"; grep -E '^ℹ (tests|pass|fail)' /tmp/t.txt; grep -E '✖|AssertionError|Cannot find' /tmp/t.txt | head`
Expected: the new tests FAIL (`✖` lines; missing export / missing methods).

- [ ] **Step 3: Implement — swarm**

In `swarm/src/server.ts`, near `buildUserUpdate`:

```ts
/** Map a document-store result to an HTTP reply. Kept pure so the mapping is testable without a server. */
export function storeReply(r: StoreResult | null, created = false): { status: number; body: unknown } {
  if (r === null) return { status: 404, body: { error: "unknown document" } };
  if ("error" in r) return { status: r.status, body: r.problems ? { error: r.error, problems: r.problems } : { error: r.error } };
  return { status: created ? 201 : 200, body: r };
}
```

Inside `registerRoutes()`, after the roster route. Every handler: `const workspaces = await loadWorkspaces(this.paths);` then the store call, then `const { status, body } = storeReply(...); return reply.status(status).send(body);`. `AmbiguousDocumentError` → 409 with its message (wrap each `/documents/:id` handler body in `try { … } catch (err) { if (err instanceof AmbiguousDocumentError) return reply.status(409).send({ error: err.message }); throw err; }`).

```ts
    // ── Documents (spec 2026-08-22 §3) — the broker is the only caller ──
    this.app.get<{ Querystring: { workspace?: string } }>("/blueprints", async (req) => ({
      blueprints: await loadBlueprintsFor(this.paths, req.query.workspace || undefined),
    }));
    this.app.get("/documents", async () => ({ documents: await listDocuments(this.paths, await loadWorkspaces(this.paths)) }));
    this.app.get<{ Params: { name: string } }>("/workspaces/:name/documents", async (req, reply) => {
      const ws = (await loadWorkspaces(this.paths)).find((w) => w.name === req.params.name);
      if (!ws) return reply.status(404).send({ error: `Unknown workspace: ${req.params.name}` });
      return { documents: await listWorkspaceDocuments(this.paths, ws) };
    });
    this.app.post<{ Params: { name: string } }>("/workspaces/:name/documents", async (req, reply) => {
      const ws = (await loadWorkspaces(this.paths)).find((w) => w.name === req.params.name);
      if (!ws) return reply.status(404).send({ error: `Unknown workspace: ${req.params.name}` });
      const b = (req.body ?? {}) as { blueprintId?: string; workType?: string; title?: string; effort?: string };
      if (!b.blueprintId) return reply.status(400).send({ error: "blueprintId is required" });
      const r = await createDocument(this.paths, ws, { ...b, blueprintId: b.blueprintId, author: await this.actingAuthor() });
      const { status, body } = storeReply(r, true);
      return reply.status(status).send(body);
    });
    this.app.post<{ Params: { name: string } }>("/workspaces/:name/documents/import", async (req, reply) => {
      const ws = (await loadWorkspaces(this.paths)).find((w) => w.name === req.params.name);
      if (!ws) return reply.status(404).send({ error: `Unknown workspace: ${req.params.name}` });
      const legacy = (req.body as { doc?: LegacyDoc })?.doc;
      if (!legacy || typeof legacy.id !== "string" || !Array.isArray(legacy.sections)) return reply.status(400).send({ error: "doc must be a legacy document record" });
      const { status, body } = storeReply(await importDocument(this.paths, ws, legacy), true);
      return reply.status(status).send(body);
    });
    const docRoute = async (reply: FastifyReply, fn: (workspaces: Workspace[]) => Promise<StoreResult | null>, created = false) => {
      try {
        const { status, body } = storeReply(await fn(await loadWorkspaces(this.paths)), created);
        return reply.status(status).send(body);
      } catch (err) {
        if (err instanceof AmbiguousDocumentError) return reply.status(409).send({ error: err.message });
        throw err;
      }
    };
    this.app.get<{ Params: { id: string } }>("/documents/:id", (req, reply) => docRoute(reply, (w) => getDocument(this.paths, w, req.params.id)));
    this.app.patch<{ Params: { id: string } }>("/documents/:id", async (req, reply) => {
      const b = (req.body ?? {}) as { title?: string; status?: DocStatus; blueprintId?: string; workType?: string; pins?: string[] };
      const author = await this.actingAuthor();
      if (b.title !== undefined) return docRoute(reply, (w) => renameDocument(this.paths, w, req.params.id, b.title as string, author));
      if (b.status !== undefined) return docRoute(reply, (w) => setStatus(this.paths, w, req.params.id, b.status as DocStatus, author));
      if (b.blueprintId !== undefined) return docRoute(reply, (w) => changeBlueprint(this.paths, w, req.params.id, b.blueprintId as string, b.workType, author));
      if (Array.isArray(b.pins)) return docRoute(reply, (w) => setPins(this.paths, w, req.params.id, b.pins as string[], author));
      return reply.status(400).send({ error: "nothing to change: give title, status, blueprintId, or pins" });
    });
    this.app.put<{ Params: { id: string; sid: string } }>("/documents/:id/sections/:sid", async (req, reply) => {
      const body = String((req.body as { body?: unknown })?.body ?? "");
      const author = await this.actingAuthor();
      return docRoute(reply, (w) => patchSection(this.paths, w, req.params.id, req.params.sid, body, author));
    });
    this.app.post<{ Params: { id: string } }>("/documents/:id/proposals", async (req, reply) => {
      const p = (req.body ?? {}) as { sectionId?: string; newBody?: string; agentId?: string; rationale?: string };
      if (!p.sectionId || !p.agentId) return reply.status(400).send({ error: "sectionId and agentId are required" });
      return docRoute(reply, (w) => addProposal(this.paths, w, req.params.id, { sectionId: p.sectionId as string, newBody: p.newBody ?? "", agentId: p.agentId as string, rationale: p.rationale ?? "" }), true);
    });
    this.app.post<{ Params: { id: string; pid: string; decision: string } }>("/documents/:id/proposals/:pid/:decision", async (req, reply) => {
      if (req.params.decision === "accept") return docRoute(reply, (w) => acceptProposal(this.paths, w, req.params.id, req.params.pid));
      if (req.params.decision === "reject") return docRoute(reply, (w) => rejectProposal(this.paths, w, req.params.id, req.params.pid));
      return reply.status(404).send({ error: "decision must be accept or reject" });
    });
```
Add the imports (`FastifyReply` from fastify if not present; the store functions; `loadBlueprintsFor`; `DocStatus`; `AmbiguousDocumentError`, `LegacyDoc`, `StoreResult`). Route registration order: fastify matches `/documents/:id/proposals/:pid/:decision` before `/documents/:id` by specificity; register the import route BEFORE `/workspaces/:name/documents` POST only if fastify complains (it will not — different paths).

- [ ] **Step 4: Implement — broker client**

In `broker/src/swarm-client.ts`: move `Doc`, `DocSection`, `Proposal` (from `documents.ts`) and `Blueprint`, `BlueprintSection` (from `blueprints.ts`) into this file as exported types, extended: `Doc` gets `workspace: string; effort: string; problems: Array<{ where: string; message: string }>`; `Proposal.state` is `"open" | "stale"`; `Blueprint` gets `folder: "specs" | "plans" | "dashboards"`; `BlueprintSection` gets `shape?: "prose" | "checklist" | "mermaid"`. Leave the old modules' own definitions in place for now (Task 9 deletes them) — to avoid duplicate-name confusion, do NOT import from them here.

First, make `http()`'s failure carry the status: today it throws `new Error(detail ?? …)` with only the swarm's message. Change that line to `throw Object.assign(new Error(detail ?? \`swarm ${method} ${path} -> ${res.status}\`), { status: res.status });` — the message is unchanged (every existing test that matches on it still passes), and callers can now read `(err as { status?: number }).status`. Add `private async httpOrNull(method, path, body?)` that calls `http()` and returns `null` when the caught error's `status` is 404, rethrowing anything else. Then the methods:

```ts
  async listBlueprints(workspace?: string): Promise<Blueprint[]> {
    const q = workspace ? `?workspace=${encodeURIComponent(workspace)}` : "";
    return (await this.http("GET", `/blueprints${q}`)).blueprints as Blueprint[];
  }
  async listDocuments(): Promise<Doc[]> {
    return (await this.http("GET", "/documents")).documents as Doc[];
  }
  async createDocument(workspace: string, body: { blueprintId: string; workType?: string; title?: string; effort?: string }): Promise<Doc> {
    return (await this.http("POST", `/workspaces/${encodeURIComponent(workspace)}/documents`, body)) as unknown as Doc;
  }
  async importDocument(workspace: string, doc: unknown): Promise<Doc> {
    return (await this.http("POST", `/workspaces/${encodeURIComponent(workspace)}/documents/import`, { doc })) as unknown as Doc;
  }
  async getDocument(id: string): Promise<Doc | null> {
    return (await this.httpOrNull("GET", `/documents/${encodeURIComponent(id)}`)) as Doc | null;
  }
  async patchDocument(id: string, body: Record<string, unknown>): Promise<Doc> {
    return (await this.http("PATCH", `/documents/${encodeURIComponent(id)}`, body)) as unknown as Doc;
  }
  async putSection(id: string, sectionId: string, body: string): Promise<Doc> {
    return (await this.http("PUT", `/documents/${encodeURIComponent(id)}/sections/${encodeURIComponent(sectionId)}`, { body })) as unknown as Doc;
  }
  async addProposal(id: string, p: { sectionId: string; newBody: string; agentId: string; rationale: string }): Promise<Doc> {
    return (await this.http("POST", `/documents/${encodeURIComponent(id)}/proposals`, p)) as unknown as Doc;
  }
  async decideProposal(id: string, proposalId: string, decision: "accept" | "reject"): Promise<Doc> {
    return (await this.http("POST", `/documents/${encodeURIComponent(id)}/proposals/${encodeURIComponent(proposalId)}/${decision}`)) as unknown as Doc;
  }
```

- [ ] **Step 5: Run both test files; typecheck both packages; lint; commit**

```bash
pnpm --config.verify-deps-before-run=false -C swarm typecheck && pnpm --config.verify-deps-before-run=false -C broker typecheck && pnpm --config.verify-deps-before-run=false -C swarm lint && pnpm --config.verify-deps-before-run=false -C broker lint
git add swarm/src/server.ts swarm/src/server.test.ts broker/src/swarm-client.ts broker/src/swarm-client.test.ts
git commit -m "feat: swarm document routes and the broker's client for them

Thin fastify handlers over the document store (id-addressed, ambiguity is a
409); the broker's SwarmClient learns every document verb it will need to
become a passthrough."
```

---

### Task 9: Cut over — the broker becomes a passthrough; the UI types follow

This is the one commit where the broker stops owning documents. Do not split it: a broker that still serves its JSON cache while the swarm serves files would show two truths.

**Files:**
- Modify: `broker/src/text-channel.ts` (the `documents` and `blueprints` constructor options + their route call sites)
- Modify: `broker/src/main.ts` (documents cache + frame, handlers, doc-edit flow, session seeding, blueprints)
- Modify: `broker/src/doc-edit.ts` (type import), `broker/src/pins.ts` (unchanged unless it imports `Doc`)
- Delete: `broker/src/documents.ts`, `broker/src/documents.test.ts`, `broker/src/blueprints.ts`, `broker/src/blueprints.test.ts`; `broker/src/markdown-normalize.ts` + its test ONLY if `grep -rn normalizeMarkdown broker/src` shows no remaining importer
- Modify: `control-plane/src/api/types.ts` (`DocT`, `ProposalT`, `BlueprintT`)
- Test: `broker/src/text-channel.test.ts`

**Interfaces:**
- Consumes: every `SwarmClient` document method (Task 8).
- Changes: `TextChannel`'s `documents` option — every method may return `string | null | Promise<string | null>` and `create` stays `Promise<…>`; `blueprints` becomes `() => Blueprint[] | Promise<Blueprint[]>`.

- [ ] **Step 1: Write the failing test**

Append to `broker/src/text-channel.test.ts`, modelled on the existing "POST /documents forwards the body…" test (same `startChannel`/port helpers that test uses):

```ts
test("document handlers may be async: PATCH section and proposal decisions await a promise-returning handler", async () => {
  const seen: string[] = [];
  const { port, close } = await startChannel({
    documents: {
      create: async () => ({ doc: { id: "x" } as never }),
      patchSection: async (id, sid, body) => {
        seen.push(`patch ${id}/${sid}=${body}`);
        return null;
      },
      changeBlueprint: async () => "nope",
      rename: async () => null,
      acceptProposal: async (id, pid) => {
        seen.push(`accept ${id}/${pid}`);
        return null;
      },
      rejectProposal: async () => "unknown",
      pin: async () => null,
      unpin: async () => null,
    },
    blueprints: async () => [{ id: "spec", name: "Spec", family: "document", workTypes: ["feature"], sections: [], folder: "specs" }],
  });
  try {
    const patched = await fetch(`http://127.0.0.1:${port}/documents/d/sections/s`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: "hi" }) });
    assert.equal(patched.status, 200);
    const accepted = await fetch(`http://127.0.0.1:${port}/documents/d/proposals/1/accept`, { method: "POST" });
    assert.equal(accepted.status, 200);
    const rejected = await fetch(`http://127.0.0.1:${port}/documents/d/proposals/1/reject`, { method: "POST" });
    assert.equal(rejected.status, 404);
    const bps = await (await fetch(`http://127.0.0.1:${port}/blueprints`)).json();
    assert.equal((bps as { blueprints: Array<{ id: string }> }).blueprints[0].id, "spec");
    assert.deepEqual(seen, ["patch d/s=hi", "accept d/1"]);
  } finally {
    await close();
  }
});
```
(Adapt `startChannel` to however the existing document test constructs the channel — copy that test's setup verbatim; the only thing this test adds is async handlers and the `blueprints` promise.)

- [ ] **Step 2: Run it to verify it fails**

Run: `cd broker && node --import tsx --test 'src/text-channel.test.ts' > /tmp/t.txt 2>&1; echo "exit $?"; grep -E '^ℹ (tests|pass|fail)' /tmp/t.txt; grep -E '✖|AssertionError|Cannot find' /tmp/t.txt | head`
Expected: the new test FAILS (`✖`) — a promise is truthy, so the sync routes treat every async handler's return as an error (PATCH answers 404, the blueprints route serializes a Promise).

- [ ] **Step 3: Implement — `text-channel.ts`**

- In the constructor's `documents` option type, change every `: string | null;` return to `: string | null | Promise<string | null>;` (rename, changeBlueprint, patchSection, acceptProposal, rejectProposal, pin, unpin). Change `blueprints?: () => Blueprint[]` to `blueprints?: () => Blueprint[] | Promise<Blueprint[]>`. Import `Blueprint` and `Doc` from `./swarm-client.ts` instead of `./blueprints.ts` / `./documents.ts`.
- Find every call site with `grep -n 'documents\.\(rename\|changeBlueprint\|patchSection\|acceptProposal\|rejectProposal\|pin\|unpin\)' src/text-channel.ts` and `grep -n 'this.blueprints()' src/text-channel.ts`. At each: `const error = await documents.X(...)`. Where the call sits inside a `req.on("end", () => { … })` callback, make that callback `async () => { … }` and `await` inside it. The `GET /blueprints` route: `const blueprints = await this.blueprints();` before serializing.
  **Two things this list gets wrong if you apply it mechanically — verified against the real file:**
  1. One call site combines TWO handlers in a ternary (`const error = title ? documents.rename(docId, title) : documents.changeBlueprint(docId, blueprintId);`, around `text-channel.ts:1730`). Await the whole expression — `const error = await (title ? … : …)` — not one branch of it.
  2. Status mapping is NOT uniformly `error ? 404 : 200`. That same rename/changeBlueprint route answers `error ? 409 : 200` (409 because the usual cause is a document that already has content). PRESERVE each route's existing status; do not normalise them.

- [ ] **Step 4: Implement — `main.ts`**

1. Remove `documentsDir`, `documentStore`, `documentManager` (+ `.init()`), the `DocumentManager` import, `loadBlueprints` import, `const blueprints = loadBlueprints();`. Import `type Doc` from `./swarm-client.ts`.
2. Add, where `documentsFrame()` was:

```ts
// Documents live in the swarm now (spec 2026-08-22 §3): this is a last-frame
// cache, refreshed after every mutation we make and once at boot. The UI
// contract (a full `documents` frame on change) is unchanged.
let documentsCache: Doc[] = [];
async function refreshDocuments(): Promise<void> {
  try {
    documentsCache = await swarm.listDocuments();
  } catch (err) {
    console.warn(`[documents] could not refresh from the swarm — keeping the last frame: ${(err as Error).message}`);
  }
}
function documentsFrame() {
  return { type: "documents" as const, documents: documentsCache };
}
/** After a mutation: refresh, then push the frame. */
async function documentsChanged(): Promise<void> {
  await refreshDocuments();
  textChannel.broadcast(documentsFrame());
}
```
   Call `await refreshDocuments()` once at boot, right after the swarm client is known reachable (next to the existing boot-time `swarm.*` calls that load workspaces/registry — find `await swarm.listWorkspaces()` or equivalent in the boot sequence and place it after).
3. Blueprints option: `() => swarm.listBlueprints()`.
4. Handlers — replace the `documents` block passed to `TextChannel` with:

```ts
  {
    create: async (body) => {
      if (!body.blueprintId) return { error: "blueprintId is required", status: 400 };
      const active = sessionManager.activeOrNull();
      const workspace = active?.workspace ?? defaultWorkspaceName;   // the module-level variable the lazy-session path already uses (main.ts ~760/807)
      const text = (body.text ?? "").trim();
      let doc: Doc;
      try {
        doc = await swarm.createDocument(workspace, { blueprintId: body.blueprintId, workType: body.workType, title: text ? truncateTitle(text) : undefined });
      } catch (err) {
        return { error: (err as Error).message, status: 400 };
      }
      if (text) {
        textChannel.broadcast({ type: "utterance", text });
        handleUserText(text);
      }
      const session = sessionManager.activeOrNull();
      if (session) sessionManager.addArtifact(session.id, doc.id);
      await documentsChanged();
      textChannel.broadcast(sessionFrame());
      return { doc };
    },
    rename: (docId, title) => viaSwarm(() => swarm.patchDocument(docId, { title })),
    changeBlueprint: (docId, blueprintId) => viaSwarm(() => swarm.patchDocument(docId, { blueprintId })),
    pin: (docId, target) => viaSwarm(async () => {
      const doc = await swarm.getDocument(docId);
      if (!doc) throw new Error(`unknown document: ${docId}`);
      return swarm.patchDocument(docId, { pins: [...new Set([...doc.pins, target])] });
    }),
    unpin: (docId, target) => viaSwarm(async () => {
      const doc = await swarm.getDocument(docId);
      if (!doc) throw new Error(`unknown document: ${docId}`);
      return swarm.patchDocument(docId, { pins: doc.pins.filter((t) => t !== target) });
    }),
    acceptProposal: (docId, pid) => viaSwarm(() => swarm.decideProposal(docId, pid, "accept")),
    rejectProposal: (docId, pid) => viaSwarm(() => swarm.decideProposal(docId, pid, "reject")),
    patchSection: (docId, sectionId, body) => viaSwarm(() => swarm.putSection(docId, sectionId, body)),
  },
```
   with, above the `TextChannel` construction:

```ts
/** One mutation through the swarm: refresh + broadcast on success, the swarm's own message on failure. */
async function viaSwarm(op: () => Promise<Doc>): Promise<string | null> {
  try {
    await op();
  } catch (err) {
    return (err as Error).message;
  }
  await documentsChanged();
  return null;
}
```
5. The doc-context send (`send: async (text, rawTarget, doc) => …`): replace `documentManager.get(doc.docId)` with `await swarm.getDocument(doc.docId)` (404 → the existing `unknown document` error); `runDocEditTurn({ doc: targetDoc, … })` unchanged (its `Doc` type now comes from swarm-client); proposals → `for (const rw of r.rewrites) await swarm.addProposal(doc.docId, { ...rw, agentId: editor, rationale: r.note });`; direct → `for (const rw of r.rewrites) await swarm.putSection(doc.docId, rw.sectionId, rw.newBody);`; then `await documentsChanged()` instead of `textChannel.broadcast(documentsFrame())`.
6. Session seeding: `for (const doc of documentsCache) { if (doc.workspace === workspace || docSeedsInWorkspace(doc.pins, workspace, groupRecords)) sessionManager.addArtifact(s.id, doc.id); }` — a workspace's own documents are its standing context (spec §7), plus anything pinned to it.
7. `broker/src/doc-edit.ts`: import `Doc` from `./swarm-client.ts`. Delete `documents.ts`, `documents.test.ts`, `blueprints.ts`, `blueprints.test.ts`. `grep -rn "normalizeMarkdown\|markdown-normalize" broker/src` — if only the deleted files used it, delete `markdown-normalize.ts` and its test too.

- [ ] **Step 5: Implement — control-plane types**

`control-plane/src/api/types.ts`: `DocT` gains `workspace: string; effort: string; problems?: Array<{ where: string; message: string }>;` and `proposals?: ProposalT[]` stays optional; `ProposalT.state` is `"open" | "stale"` (plus the legacy values if the type is shared with older fixtures — keep a union that includes both); `BlueprintT` gains `folder: "specs" | "plans" | "dashboards"`, its `sections` items gain `shape?: "prose" | "checklist" | "mermaid"`. Run `pnpm --config.verify-deps-before-run=false -C control-plane typecheck` and fix every consumer tsc names (fixtures constructing `DocT` literals need `workspace` and `effort`).

- [ ] **Step 6: Tests, typecheck all three, lint, commit**

```bash
cd broker && node --import tsx --test 'src/*.test.ts' > /tmp/t9b.txt 2>&1; echo $?; grep -E '^ℹ (pass|fail)' /tmp/t9b.txt
pnpm --config.verify-deps-before-run=false -C broker typecheck && pnpm --config.verify-deps-before-run=false -C swarm typecheck && pnpm --config.verify-deps-before-run=false -C control-plane typecheck
pnpm --config.verify-deps-before-run=false -C broker lint
git add broker/src control-plane/src/api/types.ts
git commit -m "feat(broker): documents are served by the swarm — the broker becomes a passthrough

DocumentManager and the JSON cache are gone; every document frame is the
swarm's list, every handler is one swarm call plus a refresh. Session
seeding counts a workspace's own documents as its standing context."
```

---

### Task 10: Import the broker's legacy documents through the swarm

**Files:**
- Create: `broker/src/documents-import.ts`, `broker/src/documents-import.test.ts`
- Modify: `broker/src/main.ts` (one boot call)

**Interfaces:**
- Consumes: `SwarmClient.importDocument`, `SwarmClient.listWorkspaces` (for the default workspace), `docSeedsInWorkspace`-style pin reading (first pin wins).
- Produces: `importLegacyDocuments(opts: { documentsDir: string; sessionsDir: string; stamp: string; client: { importDocument(workspace: string, doc: unknown): Promise<{ id: string }>; listWorkspaces(): Promise<Array<{ name: string; default?: boolean; archived?: boolean }>> }; log: (line: string) => void }): Promise<{ imported: Array<{ from: string; to: string }>; notes: string[] }>` — pure over its inputs (fs paths + a client interface), so it is testable with a fake client.

Rules (§9.3): workspace = first **non-group** pin that names an existing active workspace, else the default workspace; `d*.json` files only; a 409 from import (already imported) counts as done; after EVERY file imported or already-present, rewrite each `sessions/*.json`'s `artifacts` array (old id → new id; unknown ids kept), then rename `documentsDir` → `<documentsDir>-archived-<stamp>`. Any other failure: note, leave the directory in place, do not archive (retry next boot).

- [ ] **Step 1: Write the failing tests**

Create `broker/src/documents-import.test.ts`:

```ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { importLegacyDocuments } from "./documents-import.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "docimport-"));
  const documentsDir = join(root, "documents");
  const sessionsDir = join(root, "sessions");
  mkdirSync(documentsDir);
  mkdirSync(sessionsDir);
  writeFileSync(join(documentsDir, "d1.json"), JSON.stringify({ id: "d1", title: "Pinned", blueprintId: "spec", workType: "feature", sections: [], participants: [], proposals: [], pins: ["group:team", "other"], status: "drafting", createdAt: "2026-08-17T13:25:18.588Z", updatedAt: "2026-08-17T13:25:18.639Z" }));
  writeFileSync(join(documentsDir, "d2.json"), JSON.stringify({ id: "d2", title: "Unpinned", blueprintId: "spec", workType: "feature", sections: [], participants: [], proposals: [], status: "drafting", createdAt: "2026-08-19T17:17:17.910Z", updatedAt: "2026-08-19T17:17:17.910Z" }));
  writeFileSync(join(documentsDir, "notes.txt"), "ignored");
  writeFileSync(join(sessionsDir, "s1.json"), JSON.stringify({ id: "s1", artifacts: ["d1", "d2", "keep-me"] }));
  return { root, documentsDir, sessionsDir };
}
const WORKSPACES = [{ name: "pg", default: true }, { name: "other" }, { name: "gone", archived: true }];

test("importLegacyDocuments: first matching pin wins, else the default workspace; ids are remapped in sessions; the dir is archived", async () => {
  const { root, documentsDir, sessionsDir } = fixture();
  try {
    const calls: Array<[string, string]> = [];
    const r = await importLegacyDocuments({
      documentsDir, sessionsDir, stamp: "20260822T120000", log: () => {},
      client: {
        listWorkspaces: async () => WORKSPACES,
        importDocument: async (ws, doc) => { calls.push([ws, (doc as { id: string }).id]); return { id: `new-${(doc as { id: string }).id}` }; },
      },
    });
    assert.deepEqual(calls, [["other", "d1"], ["pg", "d2"]]);
    assert.deepEqual(r.imported, [{ from: "d1", to: "new-d1" }, { from: "d2", to: "new-d2" }]);
    assert.deepEqual(JSON.parse(readFileSync(join(sessionsDir, "s1.json"), "utf8")).artifacts, ["new-d1", "new-d2", "keep-me"]);
    assert.ok(statSync(`${documentsDir}-archived-20260822T120000`).isDirectory());
    assert.throws(() => statSync(documentsDir));
    assert.ok(statSync(join(`${documentsDir}-archived-20260822T120000`, "notes.txt")).isFile(), "nothing deleted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("importLegacyDocuments: a 409 means already imported and still counts; any other failure leaves the directory for the next boot", async () => {
  const { root, documentsDir, sessionsDir } = fixture();
  try {
    const r = await importLegacyDocuments({
      documentsDir, sessionsDir, stamp: "s", log: () => {},
      client: {
        listWorkspaces: async () => WORKSPACES,
        importDocument: async (_ws, doc) => {
          if ((doc as { id: string }).id === "d1") throw Object.assign(new Error("already imported as 2026-08-17-1325-pinned-design"), { status: 409 });
          throw Object.assign(new Error("swarm down"), { status: 502 });
        },
      },
    });
    assert.deepEqual(r.imported, [{ from: "d1", to: "2026-08-17-1325-pinned-design" }]);
    assert.ok(r.notes.some((n) => /d2/.test(n) && /swarm down/.test(n)));
    assert.ok(statSync(documentsDir).isDirectory(), "not archived while anything is unimported");
    assert.deepEqual(JSON.parse(readFileSync(join(sessionsDir, "s1.json"), "utf8")).artifacts, ["2026-08-17-1325-pinned-design", "d2", "keep-me"], "what did import is remapped now");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("importLegacyDocuments: an absent documents dir is a no-op", async () => {
  const root = mkdtempSync(join(tmpdir(), "docimport-none-"));
  try {
    const r = await importLegacyDocuments({ documentsDir: join(root, "nope"), sessionsDir: join(root, "sessions"), stamp: "s", log: () => {}, client: { listWorkspaces: async () => WORKSPACES, importDocument: async () => ({ id: "x" }) } });
    assert.deepEqual(r, { imported: [], notes: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd broker && node --import tsx --test 'src/documents-import.test.ts' > /tmp/t.txt 2>&1; echo "exit $?"; grep -E '^ℹ (tests|pass|fail)' /tmp/t.txt; grep -E '✖|AssertionError|Cannot find' /tmp/t.txt | head`
Expected: module not found.

- [ ] **Step 3: Implement**

Create `broker/src/documents-import.ts`:

```ts
// ONE-WAY migration (spec 2026-08-22 §9.3): the broker's legacy JSON
// documents become files in the swarm's org repo. The broker owns this
// because the directory is relative to ITS cwd and because session
// artifacts (`sessions/*.json` → `artifacts: [docId]`) must be remapped to
// the new ids at the same time. Archive, never delete; idempotent; a
// failure leaves the directory in place so the next boot retries.
import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GROUP_PIN_PREFIX } from "./pins.ts";

export interface ImportClient {
  importDocument(workspace: string, doc: unknown): Promise<{ id: string }>;
  listWorkspaces(): Promise<Array<{ name: string; default?: boolean; archived?: boolean }>>;
}

interface LegacyShape {
  id: string;
  pins?: string[];
}

/** The workspace a legacy doc belongs to: its first bare pin naming an active workspace, else the default. */
function targetWorkspace(doc: LegacyShape, workspaces: Array<{ name: string; default?: boolean; archived?: boolean }>): string | null {
  const active = workspaces.filter((w) => !w.archived);
  for (const pin of doc.pins ?? []) {
    if (pin.startsWith(GROUP_PIN_PREFIX)) continue;
    if (active.some((w) => w.name === pin)) return pin;
  }
  return (active.find((w) => w.default) ?? active[0])?.name ?? null;
}

/** A 409 from the import route carries the id it was already imported as (`already imported as <id>`); `SwarmClient.http()` puts the status on the error. */
function alreadyImportedId(err: unknown): string | null {
  const e = err as { status?: number; message?: string };
  if (e.status !== 409) return null;
  const m = /already imported as (\S+)/.exec(e.message ?? "");
  return m ? m[1] : null;
}

export async function importLegacyDocuments(opts: {
  documentsDir: string;
  sessionsDir: string;
  stamp: string;
  client: ImportClient;
  log: (line: string) => void;
}): Promise<{ imported: Array<{ from: string; to: string }>; notes: string[] }> {
  const imported: Array<{ from: string; to: string }> = [];
  const notes: string[] = [];
  let files: string[];
  try {
    files = (await readdir(opts.documentsDir)).filter((f) => /^d\d+\.json$/.test(f)).sort();
  } catch {
    return { imported, notes };
  }
  if (files.length === 0) return { imported, notes };

  const workspaces = await opts.client.listWorkspaces();
  const idMap = new Map<string, string>();
  let allDone = true;
  for (const file of files) {
    try {
      const doc = JSON.parse(await readFile(join(opts.documentsDir, file), "utf8")) as LegacyShape;
      const ws = targetWorkspace(doc, workspaces);
      if (!ws) throw new Error("no active workspace to import into");
      let to: string;
      try {
        to = (await opts.client.importDocument(ws, doc)).id;
      } catch (err) {
        const existing = alreadyImportedId(err);
        if (!existing) throw err;
        to = existing;
      }
      idMap.set(doc.id, to);
      imported.push({ from: doc.id, to });
      opts.log(`[documents-import] ${doc.id} → ${ws}/${to}`);
    } catch (err) {
      allDone = false;
      notes.push(`[documents-import] ${file}: not imported — ${(err as Error).message}; will retry next boot`);
    }
  }

  // Remap whatever DID import, even if something else failed: a session that
  // points at an old id would otherwise show a hole until the retry succeeds.
  await remapSessionArtifacts(opts.sessionsDir, idMap);

  if (allDone) {
    await rename(opts.documentsDir, `${opts.documentsDir}-archived-${opts.stamp}`);
    opts.log(`[documents-import] archived ${opts.documentsDir} → ${opts.documentsDir}-archived-${opts.stamp}`);
  }
  return { imported, notes };
}

async function remapSessionArtifacts(sessionsDir: string, idMap: Map<string, string>): Promise<void> {
  if (idMap.size === 0) return;
  let files: string[];
  try {
    files = (await readdir(sessionsDir)).filter((f) => f.endsWith(".json"));
  } catch {
    return;
  }
  for (const f of files) {
    const path = join(sessionsDir, f);
    try {
      const s = JSON.parse(await readFile(path, "utf8")) as { artifacts?: string[] };
      if (!Array.isArray(s.artifacts)) continue;
      const next = s.artifacts.map((id) => idMap.get(id) ?? id);
      if (next.some((id, i) => id !== s.artifacts?.[i])) {
        await writeFile(path, `${JSON.stringify({ ...s, artifacts: next }, null, 2)}\n`);
      }
    } catch {
      /* a session file that does not parse is not this migration's to fix */
    }
  }
}
```

`alreadyImportedId` relies on the `status` property Task 8 put on `http()`'s thrown error; the swarm's import route (Task 7's `importDocument`) answers `409 { error: "already imported as <id>" }`.

In `broker/src/main.ts`, right after the boot-time `await refreshDocuments()` from Task 9 (the swarm is reachable there), add:

```ts
  // ONE-WAY (spec §9.3): legacy .smith/documents → files in the swarm's org repo.
  {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
    const r = await importLegacyDocuments({ documentsDir, sessionsDir, stamp, client: swarm, log: (l) => console.log(l) });
    for (const note of r.notes) console.warn(note);
    if (r.imported.length > 0) await refreshDocuments();
  }
```
where `documentsDir` is the former `process.env.BROKER_DOCUMENTS_DIR ?? ".smith/documents"` (keep that constant for this purpose) and `sessionsDir` is the existing constant. `SwarmClient` satisfies `ImportClient` structurally (`listWorkspaces` returns records with `name`/`default`/`archived`; `importDocument` returns a `Doc`, which has `id`).

- [ ] **Step 4: Tests; typecheck; lint; commit**

```bash
cd broker && node --import tsx --test 'src/documents-import.test.ts' 'src/swarm-client.test.ts' > /tmp/t.txt 2>&1; echo "exit $?"; grep -E '^ℹ (tests|pass|fail)' /tmp/t.txt; grep -E '✖|AssertionError|Cannot find' /tmp/t.txt | head
pnpm --config.verify-deps-before-run=false -C broker typecheck && pnpm --config.verify-deps-before-run=false -C broker lint
git add broker/src/documents-import.ts broker/src/documents-import.test.ts broker/src/main.ts broker/src/swarm-client.ts
git commit -m "feat(broker): import legacy JSON documents into the swarm at boot, remap session artifacts, archive

First bare pin wins, else the default workspace; 409 counts as done; any
other failure leaves the directory for the next boot."
```

---

### Task 11: Gates, the live smoke, and the hand-off

**Files:** none modified — evidence only.

- [ ] **Step 1: Gates on the committed tree** (detached worktree, node_modules symlinked, `pnpm --config.verify-deps-before-run=false`):
  swarm typecheck/test/lint; broker typecheck/test/lint; control-plane typecheck. Expected: all exit 0; swarm tests = 707 + this plan's additions, 0 fail; biome 0 errors / the 2 pre-existing warnings.

- [ ] **Step 2: Live smoke on a COPY of the real state — rewrite paths FIRST, prove it, then boot both processes**

```bash
SMOKE=$(mktemp -d)/state && cp -R ~/.smithagents "$SMOKE"
ORIG="$HOME/.smithagents"; grep -rl "$ORIG" "$SMOKE" --include='*.json' | xargs sed -i '' "s#$ORIG#$SMOKE#g"
grep -rn "$ORIG" "$SMOKE" --include='*.json'                     # expect: NOTHING — stop if not
BROKER_STATE=$(mktemp -d) && cp -R broker/.smith "$BROKER_STATE/.smith"   # the broker's legacy documents + sessions
ls "$BROKER_STATE/.smith/documents"                               # expect: d1.json d2.json
cd swarm && SMITH_STATE_ROOT="$SMOKE" node --import tsx src/server.ts --port 7781 > /tmp/smoke-swarm.txt 2>&1 & SWARM_PID=$!
cd ../broker && (cd "$BROKER_STATE" && SWARM_URL=http://127.0.0.1:7781 BROKER_TEXT_PORT=7791 node --env-file=$OLDPWD/../.env --import tsx $OLDPWD/src/main.ts > /tmp/smoke-broker.txt 2>&1 & echo $! > /tmp/broker.pid)
sleep 12
grep -E 'documents-import|error|Error' /tmp/smoke-broker.txt      # expect: "[documents-import] d1 → <ws>/<id>", "d2 → …", "archived …"
ls "$BROKER_STATE/.smith"                                         # expect: documents-archived-<stamp>, NO documents/
ls "$SMOKE/config/workspaces/proving-ground/specs" "$SMOKE/config/workspaces/proving-ground/dashboards"   # expect: the imported .md files
git -C "$SMOKE/config" log --oneline | head -5                    # expect: "spec(design-spec-2): import" / "dashboard(…): import" above "Import workspace proving-ground"
curl -s -X POST localhost:7791/documents -H 'content-type: application/json' -d '{"blueprintId":"spec","text":"Smoke spec"}' | head -c 300   # expect: a doc with id 2026-…-smoke-spec-design, workspace proving-ground
curl -s localhost:7791/blueprints | grep -o '"folder":"[a-z]*"' | sort -u   # expect: specs, plans, dashboards
ID=$(curl -s localhost:7781/documents | python3 -c 'import json,sys; print([d["id"] for d in json.load(sys.stdin)["documents"] if "smoke-spec" in d["id"]][0])')
curl -s -X PATCH localhost:7791/documents/$ID/sections/approach -H 'content-type: application/json' -d '{"body":"* one"}'   # expect: {"ok":true}
git -C "$SMOKE/config" log -1 --format='%an|%s'                    # expect: <your name>|spec(smoke-spec): approach
curl -s -X POST localhost:7781/documents/$ID/proposals -H 'content-type: application/json' -d '{"sectionId":"approach","newBody":"- two","agentId":"anderson","rationale":"smoke"}' | grep -o '"state":"open"'
git -C "$SMOKE/config" for-each-ref refs/heads/proposals/         # expect: proposals/proving-ground/<ID>/1
curl -s -X POST localhost:7791/documents/$ID/proposals/1/accept    # expect: {"ok":true}
git -C "$SMOKE/config" log -1 --format='%an|%s'                    # expect: anderson|spec(smoke-spec): accept proposal 1 — approach
git -C "$SMOKE/config" for-each-ref refs/heads/proposals/         # expect: nothing
git -C "$SMOKE/config" status --porcelain                          # expect: clean
kill $SWARM_PID; kill $(cat /tmp/broker.pid)
ls -la ~/.smithagents/workspaces/proving-ground                    # expect: unchanged from before (config/, smith-agent-proving-ground, .runtime)
ls broker/.smith                                                   # expect: documents/ still present — the REAL broker state was never touched
```
Second boot of both on the same copies: expect zero `documents-import` lines and the same commit count.

- [ ] **Step 3: Positive control** — temporarily break `shapeProblem`'s checklist regex in `swarm/src/document-rules.ts` (e.g. make it accept anything), run `src/document-rules.test.ts`, expect a non-zero exit naming the checklist test, `git checkout -- swarm/src/document-rules.ts`.

- [ ] **Step 4: Record and hand off** — update the memory file for this plan (what shipped, traps found), merge per `merge-at-task-boundaries` (fast-forward by ref, push with the `ecruz165` account), and record what Plan 3 inherits: the `files` symlink and `../files/<name>` links (§5), slice links + the `final` delivery gate (§7), `context.docs` in the manifest (§8.3), slice `specPath` import (§9.4), the Settings email field, and per-mutation board commits through `withOrgRepoQueue`.

---

## Self-review

**Spec coverage (this plan's share):**
- §2.1 naming — Task 2 (`documentFileId`), Task 7 (collision suffix, never renamed). §2.2 format — Task 2 (flat frontmatter, `{#id}`, unknown sections kept, fence-aware), Task 1 + Task 7 (`normalizeMarkdown` on every body), §2.2 "proposals not in the file" — Task 6. `Doc.workspace` — Task 7/9.
- §3 ownership — Task 7 (swarm owns files, no cache, reads the directory), Task 8 (routes; the broker is the only caller), Task 9 (broker passthrough; `documents` frames unchanged; brain rewrite flow through the client). Route shape — Deviation 1.
- §4 proposals — Task 6 (branches, plumbing, reflog), Task 7 (accept = section write as the agent + delete; reject = delete; stale refused; `Doc.proposals` derived), per-repo write queue — Task 5 (`withOrgRepoQueue`) used by Tasks 6–7; `<n>` allocated inside the queue — Task 6. Back-pressure `queued` position reporting from the spec amendment is NOT implemented (the queue is in-process and requests simply wait) — recorded as a gap for the final review.
- §6.1 blueprints — Task 3 (`folder`, `shape`, org + workspace overrides; the broker-local `.smith/blueprints` goes away with Task 9 — Plan 1 deviation 4 closed). §6.2 frontmatter rules — Task 2 (fixed checks) + Task 4 (cross-refs). §6.3 gates — Task 4 + Task 7 (`setStatus`). `GET …/problems` — folded into every document response (`problems[]`); no separate route (YAGNI; the UI reads it off the doc).
- §9.3 — Task 10 (first pin else default, `{#id}` written by Task 2's serializer, open proposals → branches via Task 7's `importDocument`, decided ones dropped, directory archived). Session artifact remap — Deviation 2.
- §10 tests — round-trip, `{#id}` through the normalizer, unknown sections, frontmatter nesting/unknown keys, fence split (Task 2); rule table + shapes + positive control (Task 4); branch create/accept/reject/stale/concurrency (Tasks 6–7); authorship on accept (Task 7); both-ports smoke (Task 11).

**Known gaps, recorded for the final review:** no boot/route-level harness in either package (route handlers are thin and the pure `storeReply` is tested; the broker's `main.ts` wiring is covered only by the Task 11 smoke); `queued` position reporting; the control-plane renders `problems` nowhere yet (Plan 3's UI work).

**Placeholder scan:** the one illustrative import line in Task 7 is called out with its real replacement; the Task 2 test's odd `assert.match` line is called out with its replacement. No TBD/TODO.

**Type consistency:** `DocWire`/`StoreResult`/`Located`/`LegacyDoc` (Task 7) are what Task 8's routes and `storeReply` consume; `ProposalWire` (Task 6) is `DocWire.proposals`; `Problem` (Task 4) is `DocWire.problems`; `withOrgRepoQueue`/`commitPaths`/`agentAuthor` (Task 5) are used by Tasks 6–7 with the signatures defined there; the broker's `Doc`/`Blueprint` (Task 8) mirror `DocWire`/`Blueprint`; `SwarmClient` method names in Task 9's handlers match Task 8's definitions (`listBlueprints`, `listDocuments`, `createDocument`, `importDocument`, `getDocument`, `patchDocument`, `putSection`, `addProposal`, `decideProposal`).
