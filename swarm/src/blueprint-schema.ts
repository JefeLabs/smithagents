// The document schema (spec 2026-08-22 §6.1) — pure: no fs, no git, no
// child_process, directly or transitively. `blueprints.ts` re-exports
// everything here so no existing importer changes; `document-rules.ts`
// imports straight from this module so the rules engine's own module graph
// never reaches node:fs or node:child_process (the file-loading machinery
// blueprints.ts needs for `loadBlueprintsFor` lives only in blueprints.ts).

export type SectionShape = "prose" | "checklist" | "mermaid";
export type BlueprintFolder = "specs" | "plans" | "dashboards";

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

export function activeSections(bp: Blueprint, workType: string): BlueprintSection[] {
  return bp.sections.filter((s) => !s.when || s.when.workType.includes(workType));
}
