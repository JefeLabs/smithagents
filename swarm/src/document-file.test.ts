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

/** A minimal valid document, frontmatter fixed, sections/title supplied — for round-trip and fix-verification tests that don't need FILE's full shape. */
function minimalDoc(sectionsMd: string, title = "T"): string {
  return `---
title: ${title}
blueprint: spec
workType: feature
status: drafting
effort: t
createdAt: 2026-01-01T00:00:00.000Z
updatedAt: 2026-01-01T00:00:00.000Z
---

${sectionsMd}`;
}

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

test("parseFrontmatter: nesting is reported against the key whose line opened it, once per block — not the last well-formed key, not once per indented line", () => {
  // I2/M5: `slices:` opens the nested block (its rest is empty and it is a
  // list key, so it does not itself fail); `workType` is well-formed and
  // must never be blamed; the two indented lines must yield ONE problem.
  const { values, problems } = parseFrontmatter("title: t\nworkType: feature\nslices:\n  - a\n  - b\nbogus: 1");
  assert.equal(values.title, "t");
  assert.equal(values.workType, "feature");
  assert.deepEqual(
    problems.filter((p) => p.message === "nested values are not supported"),
    [{ where: "frontmatter.slices", message: "nested values are not supported" }],
  );
  assert.ok(
    !problems.some((p) => p.where === "frontmatter.workType"),
    `an unrelated well-formed key must not be blamed: ${JSON.stringify(problems)}`,
  );
  assert.ok(problems.some((p) => p.where === "frontmatter.bogus" && /unknown/.test(p.message)));
});

test("parseFrontmatter: an unknown key with an underscore is named, not swallowed by the catch-all line message", () => {
  const { problems } = parseFrontmatter("work_type: feature");
  assert.ok(
    problems.some((p) => p.where === "frontmatter.work_type" && /unknown/.test(p.message)),
    JSON.stringify(problems),
  );
});

test("parseFrontmatter: '#' inside a scalar value is ordinary text, not a comment — the frontmatter block is delimited, there is no ambiguity", () => {
  const { values, problems } = parseFrontmatter("title: Fixes issue #42");
  assert.deepEqual(problems, []);
  assert.equal(values.title, "Fixes issue #42");
});

test("parseDocumentFile: a required key that is present but rejected is reported once — not also as missing", () => {
  const text =
    "---\ntitle:\nblueprint: spec\nworkType: feature\nstatus: drafting\neffort: e\ncreatedAt: 2026-01-01T00:00:00.000Z\nupdatedAt: 2026-01-01T00:00:00.000Z\n---\n\n## A {#a}\n";
  const { doc, problems } = parseDocumentFile(text);
  assert.equal(doc, null);
  const titleProblems = problems.filter((p) => p.where === "frontmatter.title");
  assert.deepEqual(titleProblems, [{ where: "frontmatter.title", message: "nested values are not supported" }]);
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

test("splitSections: text before the first heading is a preamble section with id ''", () => {
  const s = splitSections("intro\n\n## A {#a}\n\nx");
  assert.deepEqual(
    s.map((x) => x.id),
    ["", "a"],
  );
});

test("splitSections: a heading whose text would slugify to 'preamble' is an ordinary section, never confused with the preamble sentinel", () => {
  const s = splitSections("## Overview {#overview}\n\na\n\n## Preamble\n\nb\n\n## Later {#later}\n\nc\n");
  assert.deepEqual(
    s.map((x) => [x.id, x.heading]),
    [
      ["overview", "Overview"],
      ["preamble", "Preamble"],
      ["later", "Later"],
    ],
  );
});

test("parseDocumentFile + serializeDocumentFile: a literal '## Preamble' heading survives a round trip intact", () => {
  const text = minimalDoc("## Overview {#overview}\n\na\n\n## Preamble\n\nb\n\n## Later {#later}\n\nc\n");
  const first = parseDocumentFile(text);
  assert.ok(first.doc, JSON.stringify(first.problems));
  assert.deepEqual(
    first.doc.sections.map((s) => s.id),
    ["overview", "preamble", "later"],
  );
  const again = parseDocumentFile(serializeDocumentFile(first.doc));
  assert.deepEqual(again.doc, first.doc);
});

test("parseDocumentFile + serializeDocumentFile: a title containing '#' round-trips instead of locking the document out", () => {
  const text = minimalDoc("## A {#a}\n\nbody\n", "Fixes issue #42");
  const first = parseDocumentFile(text);
  assert.ok(first.doc, JSON.stringify(first.problems));
  assert.equal(first.doc.frontmatter.title, "Fixes issue #42");
  const again = parseDocumentFile(serializeDocumentFile(first.doc));
  assert.deepEqual(again.doc, first.doc);
});

test("splitSections: a heading that would break capabilities.ts's slugify (long, non-Latin, symbols-only) never throws and gets a total fallback id", () => {
  const long =
    "A fairly long heading that describes what this section is really about and keeps going past sixty four characters easily";
  const s = splitSections(`## ${long}\n\nbody\n\n## 日本語\n\nmore\n\n## !!!\n\nlast`);
  assert.equal(s.length, 3);
  assert.match(s[0].id, /^[a-z0-9][a-z0-9-]*$/);
  assert.ok(s[0].id.length <= 64, `id must be capped at 64 chars: ${s[0].id}`);
  assert.equal(s[1].id, "section-1", "a heading with no usable characters falls back to section-<index>");
  assert.equal(s[2].id, "section-2");
});

test("splitSections: two computed ids that collide after 64-char truncation are de-duplicated", () => {
  const a = "a".repeat(70);
  const b = "a".repeat(90);
  const s = splitSections(`## ${a}\n\nx\n\n## ${b}\n\ny`);
  assert.equal(s[0].id, "a".repeat(64));
  assert.equal(s[1].id, `${"a".repeat(64)}-2`);
});

test("splitSections: a closing fence must be at least as long as its opener (CommonMark) — a shorter run inside stays body", () => {
  const s = splitSections("## a\n\n````\n```\n## inside\n```\n````\n\n## b\n\nlast");
  assert.deepEqual(
    s.map((x) => x.id),
    ["a", "b"],
  );
  assert.match(s[0].body, /## inside/, "the shorter fence must not have closed the outer one");
  assert.equal(s[1].body, "last");
});

test("serializeDocumentFile: refuses a section id that does not match the canonical id shape", () => {
  assert.throws(
    () =>
      serializeDocumentFile({
        frontmatter: {
          title: "T",
          blueprint: "spec",
          workType: "feature",
          status: "drafting",
          effort: "t",
          slices: [],
          participants: [],
          pins: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        sections: [{ id: "Open Questions", heading: "Q", body: "x" }],
      }),
    /Open Questions/,
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

test("documentFileId: an unslugifiable effort degrades to section-0 instead of throwing", () => {
  assert.equal(documentFileId("2026-08-22T16:12:00.000Z", "!!!", "er"), "2026-08-22-1612-section-0");
  assert.equal(documentFileId("2026-08-22T16:12:00.000Z", "", "er"), "2026-08-22-1612-section-0");
});

test("documentFileId: an invalid createdAt throws naming the value, rather than minting a NaN filename", () => {
  assert.throws(() => documentFileId("not-a-date", "effort", "spec"), /not-a-date/);
});

test("round trip: parse(serialize(parse(x))) equals parse(x) across a range of section shapes", () => {
  const cases: Record<string, string> = {
    "unmarked heading": minimalDoc("## Approach\n\nsome body\n"),
    "empty section body": minimalDoc("## A {#a}\n"),
    "no sections at all": minimalDoc(""),
    "heading over 64 chars": minimalDoc(`## ${"A".repeat(70)}\n\nbody\n`),
  };
  for (const [label, text] of Object.entries(cases)) {
    const first = parseDocumentFile(text);
    assert.ok(first.doc, `${label}: expected a doc, got problems ${JSON.stringify(first.problems)}`);
    const again = parseDocumentFile(serializeDocumentFile(first.doc));
    assert.deepEqual(again.doc, first.doc, label);
  }
});
