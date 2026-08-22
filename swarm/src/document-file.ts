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
  const preamble: string[] = [];
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
  if (!m)
    return { doc: null, problems: [{ where: "frontmatter", message: "no frontmatter block at the top of the file" }] };
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
  const slug = slugify(effort) || "document";
  return `${stamp}-${slug}${blueprintId === "spec" ? "-design" : ""}`;
}
