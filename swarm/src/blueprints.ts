// Blueprints — the document schema (spec 2026-08-22 §6.1). Data, never a
// hardcoded enum: defaults here, org-wide files in <orgRepo>/blueprints/,
// per-workspace overrides in workspaces/<slug>/blueprints/, merged by id.
// `folder` says where a blueprint's documents live; `shape` is the closed
// set of per-section checks the rules module can enforce.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SmithPaths } from "./paths.js";
import { configDirForName, slugForDir } from "./workspaces.js";

export type SectionShape = "prose" | "checklist" | "mermaid";
export type BlueprintFolder = "specs" | "plans" | "dashboards";
const SHAPES = new Set<string>(["prose", "checklist", "mermaid"]);
const FOLDERS = new Set<string>(["specs", "plans", "dashboards"]);

export interface BlueprintSection {
  id: string;
  heading: string;
  /** Author guidance shown as the empty-section placeholder. */
  hint?: string;
  /** Seed body a fresh document opens with (e.g. a starter Mermaid block). Absent = empty. */
  starter?: string;
  /** Absent = always present. */
  when?: { workType: string[] };
  required?: boolean;
  /** Closed set; absent = prose. A regex field was rejected on purpose — a rule nobody can read back is not a rule. */
  shape?: SectionShape;
}

export interface Blueprint {
  id: string;
  name: string;
  /** Render family — prose documents, Mermaid diagrams, or spec-driven dashboards. The composer groups by it. */
  family: "document" | "diagram" | "dashboard";
  workTypes: string[];
  sections: BlueprintSection[];
  /** Which workspace folder this blueprint's documents live in. */
  folder: BlueprintFolder;
}

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

export function activeSections(bp: Blueprint, workType: string): BlueprintSection[] {
  return bp.sections.filter((s) => !s.when || s.when.workType.includes(workType));
}

/** Sections active for a work type, with starter bodies; null = workType not declared by the blueprint. */
export function instantiateSections(
  bp: Blueprint,
  workType: string,
): Array<{ id: string; heading: string; body: string }> | null {
  if (!bp.workTypes.includes(workType)) return null;
  return activeSections(bp, workType).map((s) => ({ id: s.id, heading: s.heading, body: s.starter ?? "" }));
}
