// Rules and validation (spec 2026-08-22 §6). Pure: no fs, no git, no
// child_process — directly or transitively. The cross-document facts come
// in as resolvers, so every rule is testable against literal documents (the
// provisioning.ts discipline). Rules BITE at status transitions only;
// writes always succeed and report problems. Types and `activeSections`
// come from blueprint-schema.ts rather than blueprints.ts — the latter
// pulls in node:fs/promises and (via workspaces.ts) node:child_process for
// its file-loading duties, which this module must never reach.
import { activeSections, type Blueprint, type SectionShape } from "./blueprint-schema.js";
import { DOC_STATUSES, type DocSection, type DocStatus, type ParsedDocument } from "./document-file.js";

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
        if (!/^\s*- \[[ xX]\](?:\s|$)/.test(line)) return `line ${i + 1} is not a checklist item (- [ ] …)`;
      }
      return null;
    }
    case "mermaid": {
      // Up to 3 leading spaces on the fence — CommonMark permits it, and
      // document-file.ts's own fence detection already tolerates it.
      const openFence = /^ {0,3}```mermaid\s*$/gm;
      const fences = body.match(openFence) ?? [];
      if (fences.length === 0) {
        if (/^ {0,3}```mermaid\S/m.test(body)) {
          return 'the mermaid fence must be "```mermaid" alone on its line — no info string after it';
        }
        return "must be one fenced mermaid block (```mermaid … ```)";
      }
      if (fences.length > 1) return "must be exactly one fenced mermaid block";
      const block = /^ {0,3}```mermaid\s*\n[\s\S]*?\n {0,3}```\s*$/m;
      if (!block.test(body)) return 'the mermaid fence is opened but never closed with a matching "```"';
      const outside = body.replace(block, "").trim();
      return outside ? "nothing may sit outside the mermaid block" : null;
    }
    default:
      return null;
  }
}

/**
 * First-wins over `doc.sections` by id: a hand-edited file can carry the
 * same explicit `{#id}` marker twice (document-file.ts only de-duplicates
 * *auto*-slugged ids — an explicit marker written twice survives verbatim).
 * Reading order — the first occurrence — is what a human editing the file
 * sees, so that copy is the one every rule below checks. The duplicate
 * itself is reported by `structuralProblems`, so which copy happens to be
 * valid never decides whether the document can reach `final`: a document
 * with a duplicated id always refuses, in either order.
 */
function presentSections(doc: ParsedDocument): { present: Map<string, DocSection>; duplicateIds: string[] } {
  const present = new Map<string, DocSection>();
  const duplicateIds: string[] = [];
  for (const s of doc.sections) {
    if (present.has(s.id)) {
      if (!duplicateIds.includes(s.id)) duplicateIds.push(s.id);
    } else {
      present.set(s.id, s);
    }
  }
  return { present, duplicateIds };
}

/** Blueprint/workType agree, every section the blueprint activates is present, and each NON-EMPTY present section's shape holds. */
export function structuralProblems(bp: Blueprint, doc: ParsedDocument): Problem[] {
  const problems: Problem[] = [];
  if (doc.frontmatter.blueprint !== bp.id) {
    problems.push({
      where: "frontmatter.blueprint",
      message: `document says "${doc.frontmatter.blueprint}" but is being checked against "${bp.id}"`,
    });
  }
  if (!bp.workTypes.includes(doc.frontmatter.workType)) {
    problems.push({ where: "frontmatter.workType", message: `must be one of ${bp.workTypes.join(", ")}` });
    return problems;
  }
  const { present, duplicateIds } = presentSections(doc);
  for (const id of duplicateIds) {
    problems.push({ where: `section:${id}`, message: "duplicate section id — only the first occurrence is checked" });
  }
  for (const s of activeSections(bp, doc.frontmatter.workType)) {
    const have = present.get(s.id);
    if (!have) {
      problems.push({
        where: `section:${s.id}`,
        message: `missing — the "${s.heading}" section is part of this blueprint`,
      });
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
    if (!(await r.sliceExists(id)))
      problems.push({ where: "frontmatter.slices", message: `slice "${id}" does not resolve` });
  }
  if (doc.frontmatter.spec !== undefined) {
    if (bp.folder !== "plans") problems.push({ where: "frontmatter.spec", message: "only a plan names a spec" });
    else if ((await r.specStatus(doc.frontmatter.spec)) === null) {
      problems.push({
        where: "frontmatter.spec",
        message: `spec "${doc.frontmatter.spec}" not found in this workspace`,
      });
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
export async function transitionProblems(
  bp: Blueprint,
  doc: ParsedDocument,
  to: DocStatus,
  r: RuleResolvers,
): Promise<Problem[]> {
  if (!DOC_STATUSES.includes(to))
    return [{ where: "frontmatter.status", message: `must be one of ${DOC_STATUSES.join(" | ")}` }];
  if (to === "drafting") return [];
  const problems = await validateDocument(bp, doc, r);
  if (to === "final") {
    const { present } = presentSections(doc);
    for (const s of activeSections(bp, doc.frontmatter.workType)) {
      if (!s.required) continue;
      const have = present.get(s.id);
      // A MISSING required section is already reported above by
      // structuralProblems ("missing — … is part of this blueprint"); only
      // a PRESENT-but-empty section gets this distinct "must not be empty"
      // problem, so one cause never produces two problems in the list.
      if (have && !have.body.trim()) {
        problems.push({ where: `section:${s.id}`, message: `required — "${s.heading}" must not be empty to be final` });
      }
    }
    // A plan naming no `spec` is legal — §6.2 makes `spec` optional and
    // §6.3 never requires a plan to link one, so a standalone plan with no
    // spec is allowed to reach final. The delivery gate (spec §7) keys off
    // the SPEC document's own status, not the plan's, so this check applies
    // only when the plan HAS linked a spec; omitting `spec` is not a way to
    // dodge a gate that never applied to it.
    if (bp.folder === "plans" && doc.frontmatter.spec !== undefined) {
      const status = await r.specStatus(doc.frontmatter.spec);
      if (status !== null && status !== "final") {
        problems.push({ where: "frontmatter.spec", message: `spec "${doc.frontmatter.spec}" is ${status}, not final` });
      }
    }
  }
  return problems;
}
