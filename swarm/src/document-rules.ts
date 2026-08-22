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
    problems.push({
      where: "frontmatter.blueprint",
      message: `document says "${doc.frontmatter.blueprint}" but is being checked against "${bp.id}"`,
    });
  }
  if (!bp.workTypes.includes(doc.frontmatter.workType)) {
    problems.push({ where: "frontmatter.workType", message: `must be one of ${bp.workTypes.join(", ")}` });
    return problems;
  }
  const present = new Map(doc.sections.map((s) => [s.id, s]));
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
