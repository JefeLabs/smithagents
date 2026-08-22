// The document file (spec 2026-08-22 §2): flat frontmatter + one `##` per
// section, each heading carrying its stable id as `{#id}`. Pure: no fs, no
// git — the store (document-store.ts) reads and writes, this module only
// understands the text. Kept deliberately small: the frontmatter grammar is
// a flat subset (scalars and [a, b] lists, no nesting) because a parser
// would be more surface than the data.

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
  /** `""` marks the preamble (text before the first heading — no `## ` line is written for it). Otherwise must match `SECTION_ID_RE`. */
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

/** A section id must match this to be written; the empty string is reserved for the preamble. */
const SECTION_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * A total, local slugifier for section headings and the `effort` slug:
 * always returns a string matching `SECTION_ID_RE`, never throws. Not
 * `capabilities.ts`'s `slugify`, which throws on anything that doesn't
 * already reduce to a usable id — non-Latin text, an emoji-led heading,
 * plain English prose over 64 chars are all ordinary in a model-authored
 * document, and one bad heading must not break parsing the rest of the
 * file, let alone a caller listing a whole workspace's documents. `index`
 * seeds the fallback (`section-<index>`) when the text carries no usable
 * `[a-z0-9]` characters at all.
 */
function sectionSlug(text: string, index: number): string {
  let s = text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (s.length > 64) s = s.slice(0, 64).replace(/-+$/g, "");
  return s || `section-${index}`;
}

/**
 * The total slugger, for callers that have no section index — a document's
 * `effort`, a title. Never throws and always returns a value matching
 * SECTION_ID_RE (unlike capabilities.ts's slugify, which throws): an input
 * that reduces to nothing yields `section-0`, so callers need no fallback.
 */
export function slugify(text: string): string {
  return sectionSlug(text, 0);
}

/**
 * `key: scalar` and `key: [a, b]` only. Anything else is a problem that
 * names the key, so a hand edit that drifts into YAML proper is refused by
 * name rather than silently misread. `#` is ordinary text in a value — the
 * frontmatter block is delimited by `---`, so there is no comment syntax to
 * disambiguate and nothing to refuse.
 */
export function parseFrontmatter(block: string): {
  values: Record<string, string | string[]>;
  problems: ParseProblem[];
} {
  const values: Record<string, string | string[]> = {};
  const problems: ParseProblem[] = [];
  let lastSeenKey: string | undefined;
  let inNestedBlock = false;
  for (const raw of block.split("\n")) {
    if (!raw.trim()) {
      inNestedBlock = false;
      continue;
    }
    if (/^\s/.test(raw)) {
      // One problem per nested block, not one per indented line, and
      // attributed to the key whose line opened it — even a key that was
      // itself rejected (unknown, malformed) — never to some unrelated key
      // that happened to parse cleanly earlier.
      if (!inNestedBlock) {
        problems.push({ where: `frontmatter.${lastSeenKey ?? "?"}`, message: "nested values are not supported" });
        inNestedBlock = true;
      }
      continue;
    }
    inNestedBlock = false;
    const m = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(raw);
    if (!m) {
      problems.push({ where: "frontmatter", message: `cannot read line: ${raw}` });
      continue;
    }
    const [, key, rest] = m;
    lastSeenKey = key;
    if (!FRONTMATTER_KEYS.includes(key)) {
      problems.push({ where: `frontmatter.${key}`, message: "unknown key" });
      continue;
    }
    if (rest === "" && !LIST_KEYS.has(key)) {
      problems.push({ where: `frontmatter.${key}`, message: "nested values are not supported" });
      inNestedBlock = true;
      continue;
    }
    if (LIST_KEYS.has(key)) {
      const list = /^\[(.*)\]$/.exec(rest.trim());
      if (!list) {
        problems.push({ where: `frontmatter.${key}`, message: "must be a list like [a, b]" });
        continue;
      }
      // Split on every comma — list elements (agent ids, slice ids) never
      // contain one, so this is not a real quoting gap for today's data.
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

/**
 * Split a markdown body into sections at top-level `## ` headings, fence-aware:
 * a `##` inside a ``` or ~~~ block is body. A closing fence must be at least
 * as long as its opener (CommonMark) — a shorter run of the same character
 * inside a longer fence is content, not a close. An unclosed fence swallows
 * every following heading into the current section's body; nothing is lost
 * (the text round-trips verbatim) but no problem is reported for it — a
 * `problems` channel for this function is a later task's design call.
 * A heading's `{#id}` marker is the section id; a heading without one gets a
 * total, local slug (`sectionSlug`), de-duplicated against ids already used
 * in this document by appending `-2`, `-3`, … Text before the first heading
 * is kept as a section with id `""` (kept, so nothing a hand editor writes
 * above the first heading is dropped) — never the string `"preamble"`,
 * which is an ordinary id an actual `## Preamble` heading can take.
 */
export function splitSections(markdown: string): DocSection[] {
  const out: DocSection[] = [];
  const usedIds = new Set<string>();
  let current: DocSection | null = null;
  const preamble: string[] = [];
  let fence: string | null = null;
  let fenceLen = 0;
  let headingIndex = 0;
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  for (const line of lines) {
    const fenceMatch = /^(```+|~~~+)/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      const len = fenceMatch[1].length;
      if (!fence) {
        fence = marker;
        fenceLen = len;
      } else if (marker === fence && len >= fenceLen) {
        fence = null;
        fenceLen = 0;
      }
    }
    const heading = !fence && /^## (.*?)(?:\s*\{#([a-z0-9][a-z0-9-]*)\})?\s*$/.exec(line);
    if (heading) {
      if (current) out.push(finish(current));
      const text = heading[1].trim();
      let id = heading[2];
      if (!id) {
        id = sectionSlug(text, headingIndex);
        if (usedIds.has(id)) {
          let n = 2;
          while (usedIds.has(`${id}-${n}`)) n++;
          id = `${id}-${n}`;
        }
      }
      usedIds.add(id);
      headingIndex++;
      current = { id, heading: text, body: "" };
      continue;
    }
    if (current) current.body += `${line}\n`;
    else preamble.push(line);
  }
  if (current) out.push(finish(current));
  const pre = preamble.join("\n").trim();
  if (pre) out.unshift({ id: "", heading: "", body: pre });
  return out;
}

function finish(s: DocSection): DocSection {
  return { ...s, body: s.body.trim() };
}

/** `{ doc, problems }` — `doc` is null when the frontmatter is missing or fails its fixed checks. Total: never throws. */
export function parseDocumentFile(text: string): { doc: ParsedDocument | null; problems: ParseProblem[] } {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text.replace(/\r\n/g, "\n"));
  if (!m)
    return { doc: null, problems: [{ where: "frontmatter", message: "no frontmatter block at the top of the file" }] };
  const { values, problems } = parseFrontmatter(m[1]);
  // A key already carrying a problem (unknown, nested, malformed list) must
  // not also be reported "required" — it was seen, just rejected for a
  // different reason, and "required" would be a lie next to that problem.
  const problemKeys = new Set(
    problems.map((p) => (p.where.startsWith("frontmatter.") ? p.where.slice("frontmatter.".length) : undefined)),
  );
  for (const key of REQUIRED_KEYS) {
    if (!(key in values) && !problemKeys.has(key)) problems.push({ where: `frontmatter.${key}`, message: "required" });
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

/**
 * The canonical file: keys in FRONTMATTER_KEYS order (absent optionals
 * omitted), then `## Heading {#id}` + body per section. An empty or
 * whitespace-only scalar is refused the same way a bad section id is: an
 * OPTIONAL scalar (`spec`) is dropped exactly like `undefined` — a caller
 * clearing it with `""` gets the same result as clearing it with
 * `undefined` — but a REQUIRED scalar (title, blueprint, workType, status,
 * effort, createdAt, updatedAt) throws naming the key, because `key: `
 * would re-parse as `doc: null`: serialize must never emit frontmatter that
 * `parseDocumentFile` then refuses.
 * Throws if a section's id is not `""` (preamble) and does not match
 * `SECTION_ID_RE` — nothing on the parse path can produce such an id, but a
 * caller constructing a `DocSection` by hand could, and writing it would
 * silently corrupt the heading on the next read.
 */
export function serializeDocumentFile(doc: ParsedDocument): string {
  const fm = doc.frontmatter;
  const lines: string[] = ["---"];
  for (const key of FRONTMATTER_KEYS) {
    const v = (fm as unknown as Record<string, unknown>)[key];
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      lines.push(`${key}: [${v.join(", ")}]`);
      continue;
    }
    const scalar = v as string;
    if (scalar.trim() === "") {
      if (REQUIRED_KEYS.includes(key)) {
        throw new Error(`serializeDocumentFile: required key "${key}" is empty`);
      }
      continue;
    }
    lines.push(`${key}: ${scalar}`);
  }
  lines.push("---", "");
  for (const s of doc.sections) {
    if (s.id === "") {
      lines.push(s.body, "");
      continue;
    }
    if (!SECTION_ID_RE.test(s.id)) {
      throw new Error(`serializeDocumentFile: section id ${JSON.stringify(s.id)} does not match ${SECTION_ID_RE}`);
    }
    lines.push(`## ${s.heading} {#${s.id}}`, "");
    if (s.body) lines.push(s.body, "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * `{YYYY-MM-DD-HHMM}-{effort}[-design]`, UTC (spec §2.1). The id is minted
 * once and never renamed (§2.1), so an invalid `createdAt` must fail loudly
 * here rather than mint `NaN-NaN-NaN-NaNNaN-…` as a permanent filename. An
 * unslugifiable `effort` does not throw: it degrades to `section-0` via the
 * same total slugger sections use, at a fixed index since there is only one
 * effort per document id.
 */
export function documentFileId(createdAt: string, effort: string, blueprintId: string): string {
  const d = new Date(createdAt);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`documentFileId: createdAt ${JSON.stringify(createdAt)} is not a valid date`);
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
  const slug = sectionSlug(effort, 0);
  return `${stamp}-${slug}${blueprintId === "spec" ? "-design" : ""}`;
}
