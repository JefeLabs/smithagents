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
  assert.doesNotMatch(out, /^spec:/m, "absent optional keys are not written");
});

test("parseFrontmatter: flat subset only — nesting, comments, unknown keys are reported by name", () => {
  const { values, problems } = parseFrontmatter(
    "title: x\nslices: [a, b]\nnested:\n  k: v\nstatus: draft # no\nbogus: 1",
  );
  assert.equal(values.title, "x");
  assert.deepEqual(values.slices, ["a", "b"]);
  assert.ok(
    problems.some((p) => p.where === "frontmatter.nested"),
    JSON.stringify(problems),
  );
  assert.ok(problems.some((p) => p.where === "frontmatter.status" && /comment/.test(p.message)));
  assert.ok(problems.some((p) => p.where === "frontmatter.bogus" && /unknown/.test(p.message)));
});

test("parseDocumentFile: a missing required key and a bad status are problems, not crashes", () => {
  const { doc, problems } = parseDocumentFile(
    "---\ntitle: t\nblueprint: spec\nworkType: feature\nstatus: done\n---\n\n## A {#a}\n",
  );
  assert.equal(doc, null, "a file that fails frontmatter validation yields no doc");
  assert.ok(problems.some((p) => p.where === "frontmatter.status"));
  assert.ok(problems.some((p) => p.where === "frontmatter.effort"));
});

test("parseDocumentFile: no frontmatter at all is a single problem", () => {
  const { doc, problems } = parseDocumentFile("## A {#a}\n\nbody");
  assert.equal(doc, null);
  assert.deepEqual(
    problems.map((p) => p.where),
    ["frontmatter"],
  );
});

test("splitSections: text before the first heading is a preamble section with id 'preamble'", () => {
  const s = splitSections("intro\n\n## A {#a}\n\nx");
  assert.deepEqual(
    s.map((x) => x.id),
    ["preamble", "a"],
  );
});

test("documentFileId: UTC minute + effort, -design only for spec", () => {
  assert.equal(
    documentFileId("2026-08-22T15:30:45.000Z", "instance-provisioning", "spec"),
    "2026-08-22-1530-instance-provisioning-design",
  );
  assert.equal(
    documentFileId("2026-08-22T16:12:00.000Z", "instance-provisioning", "implementation-plan"),
    "2026-08-22-1612-instance-provisioning",
  );
  assert.equal(documentFileId("2026-08-22T16:12:00.000Z", "Weird Effort!!", "er"), "2026-08-22-1612-weird-effort");
});
