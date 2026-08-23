// Blueprints — the document schema (spec 2026-08-22 §6.1). Data, never a
// hardcoded enum: defaults here, org-wide files in <orgRepo>/blueprints/,
// per-workspace overrides in workspaces/<slug>/blueprints/, merged by id.
// `folder` says where a blueprint's documents live; `shape` is the closed
// set of per-section checks the rules module can enforce.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  activeSections,
  type Blueprint,
  type BlueprintFolder,
  type BlueprintSection,
  type SectionShape,
} from "./blueprint-schema.js";
import type { SmithPaths } from "./paths.js";
import { configDirForName, slugForDir } from "./workspaces.js";

// Re-exported so no existing importer of blueprints.js has to change —
// the types and activeSections now live in the pure blueprint-schema.ts
// (document-rules.ts imports straight from there instead, so its module
// graph never reaches the fs/child_process this file needs below).
export type { Blueprint, BlueprintFolder, BlueprintSection, SectionShape };
export { activeSections };

const SHAPES = new Set<string>(["prose", "checklist", "mermaid"]);
const FOLDERS = new Set<string>(["specs", "plans", "dashboards"]);
/**
 * The only section id a document file can carry — it is written into the
 * heading as `{#id}` and `serializeDocumentFile` THROWS on anything else.
 * Kept as a literal rather than imported from document-file.ts so this module
 * stays free of that dependency; the two must not drift.
 */
const SECTION_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

export const DEFAULT_BLUEPRINTS: Blueprint[] = [
  {
    id: "spec",
    name: "Design Spec",
    family: "document",
    workTypes: ["feature", "bugfix", "integration"],
    folder: "specs",
    sections: [
      { id: "overview", heading: "What this is", hint: "Two paragraphs, plain language.", required: true },
      {
        id: "repro",
        heading: "Reproduction",
        hint: "Exact steps, expected vs actual.",
        when: { workType: ["bugfix"] },
      },
      {
        id: "ui-refs",
        heading: "Design refs",
        hint: "Links or descriptions of the target look.",
        when: { workType: ["feature"] },
      },
      {
        id: "contracts",
        heading: "External contracts",
        hint: "APIs, events, schemas this touches.",
        when: { workType: ["integration"] },
      },
      { id: "approach", heading: "Approach", hint: "How it works, at the level a reviewer needs." },
      { id: "non-goals", heading: "Non-goals", hint: "What this deliberately does not do.", required: true },
      { id: "testing", heading: "Testing", hint: "How we will know it works." },
    ],
  },
  {
    id: "implementation-plan",
    name: "Implementation Plan",
    family: "document",
    workTypes: ["feature", "bugfix", "integration"],
    folder: "plans",
    sections: [
      { id: "goal", heading: "Goal", hint: "One sentence.", required: true },
      { id: "constraints", heading: "Global constraints", hint: "What binds every task." },
      {
        id: "tasks",
        heading: "Tasks",
        hint: "Bite-sized, each with its own test cycle.",
        required: true,
        shape: "checklist",
      },
      { id: "risks", heading: "Risks", hint: "What could go sideways and the early signal for each." },
      { id: "verification", heading: "Verification", hint: "The gates that must be green before merge." },
    ],
  },
  {
    id: "er",
    name: "Database design",
    family: "diagram",
    workTypes: ["feature", "bugfix", "integration"],
    folder: "specs",
    sections: [
      {
        id: "diagram",
        heading: "Diagram",
        hint: "A Mermaid entity-relationship diagram.",
        starter: "```mermaid\nerDiagram\n  CUSTOMER ||--o{ ORDER : places\n  ORDER ||--|{ LINE_ITEM : contains\n```",
        shape: "mermaid",
      },
    ],
  },
  {
    id: "sequence",
    name: "Sequence diagram",
    family: "diagram",
    workTypes: ["feature", "bugfix", "integration"],
    folder: "specs",
    sections: [
      {
        id: "diagram",
        heading: "Diagram",
        hint: "A Mermaid sequence diagram.",
        starter: "```mermaid\nsequenceDiagram\n  Client->>Server: request\n  Server-->>Client: response\n```",
        shape: "mermaid",
      },
    ],
  },
  {
    // A presented dashboard IS a document (spec 2026-08-11): the question
    // records the ask, the spec holds the fenced JSON the canvas renders.
    // No starters — the compose flow writes both sections at birth.
    id: "dashboard",
    name: "Dashboard",
    family: "dashboard",
    workTypes: ["insight"],
    folder: "dashboards",
    sections: [
      { id: "question", heading: "Question", hint: "What you asked, and its scope." },
      { id: "spec", heading: "Spec", hint: "The composed dashboard, as fenced JSON." },
    ],
  },
];

/**
 * A user file must carry id/workTypes/sections; family defaults to document,
 * folder to specs; an invalid folder or shape rejects the WHOLE file rather
 * than coercing it.
 *
 * The id, the workTypes entries and the section ids are checked for the same
 * reason: each is written verbatim into a document's frontmatter or heading,
 * and `serializeDocumentFile` THROWS on an empty required scalar or a section
 * id that is not `SECTION_ID_RE`. Rejecting here keeps that config out of the
 * system entirely — otherwise an ordinary edit to a §6.1 blueprint file turns
 * the create route into an unhandled 500 (task-7 review, I1).
 */
function validUserBlueprint(raw: unknown): Blueprint | null {
  const b = raw as Partial<Blueprint> | null;
  if (!b || typeof b.id !== "string" || !Array.isArray(b.workTypes) || !Array.isArray(b.sections)) return null;
  if (b.id.trim() === "") return null;
  if (b.workTypes.some((w) => typeof w !== "string" || w.trim() === "")) return null;
  const folder = b.folder ?? "specs";
  if (!FOLDERS.has(folder)) return null;
  for (const s of b.sections) {
    if (typeof s?.id !== "string" || typeof s?.heading !== "string") return null;
    if (!SECTION_ID_RE.test(s.id)) return null;
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

/**
 * Resolution: workspace over org over defaults (spec §6.1). A workspaceName
 * that slugs to nothing (e.g. "!!!") has no config subtree — configDirForName
 * would throw; loadWorkspaces (workspaces.ts:298-304) already established the
 * precedent for this exact input class: skip rather than take the whole read
 * down, so this degrades to org+defaults instead of rejecting the caller.
 */
export async function loadBlueprintsFor(paths: SmithPaths, workspaceName?: string): Promise<Blueprint[]> {
  const byId = new Map<string, Blueprint>(DEFAULT_BLUEPRINTS.map((b) => [b.id, b]));
  await readBlueprintDir(join(paths.orgRepo, "blueprints"), byId);
  if (workspaceName && slugForDir(workspaceName)) {
    await readBlueprintDir(join(configDirForName(paths, workspaceName), "blueprints"), byId);
  }
  return [...byId.values()];
}

/** Sections active for a work type, with starter bodies; null = workType not declared by the blueprint. */
export function instantiateSections(
  bp: Blueprint,
  workType: string,
): Array<{ id: string; heading: string; body: string }> | null {
  if (!bp.workTypes.includes(workType)) return null;
  return activeSections(bp, workType).map((s) => ({ id: s.id, heading: s.heading, body: s.starter ?? "" }));
}
