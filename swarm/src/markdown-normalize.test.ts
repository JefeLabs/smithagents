import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeMarkdown } from "./markdown-normalize.js";

test("normalizeMarkdown: one canonical spelling — bullets, emphasis, fences", () => {
  const out = normalizeMarkdown("* a\n* b\n\n__strong__ and *em*\n\n~~~js\nx\n~~~\n");
  assert.equal(out, "- a\n- b\n\n**strong** and _em_\n\n```js\nx\n```");
});

test("normalizeMarkdown: equivalent spellings converge; setext headings become ATX", () => {
  assert.equal(normalizeMarkdown("*em* and __strong__"), normalizeMarkdown("_em_ and **strong**"));
  assert.equal(normalizeMarkdown("Title\n=====\n"), "# Title");
  assert.equal(normalizeMarkdown("Subtitle\n--------\n"), "## Subtitle");
  assert.equal(normalizeMarkdown("* one\n* two"), normalizeMarkdown("- one\n- two"));
});

test("normalizeMarkdown: normalizing twice changes nothing", () => {
  // Idempotence is what makes the canonical form canonical: without it every
  // save rewrites the file and every document shows a diff it did not earn.
  for (const input of [
    "# Heading\n\n*   loose    spacing\n*   here\n",
    "- [ ] todo\n- [x] done",
    "| a | b |\n| - | - |\n| 1 | 2 |",
    "Title\n=====\n\n~~~js\nx\n~~~\n",
    "## What this is {#overview}\n\nbody",
  ]) {
    const once = normalizeMarkdown(input);
    assert.equal(normalizeMarkdown(once), once, `not idempotent for ${JSON.stringify(input)}`);
  }
});

test("normalizeMarkdown: gfm survives — task lists and tables are not mangled away", () => {
  // LOAD-BEARING. `shapeProblem`'s `checklist` arm requires `- [ ]` lines to
  // survive this function, so every `tasks` section of every plan depends on
  // remark-gfm still being in the pipeline. Without this test, dropping the
  // plugin (or changing the stringify options) would fail every checklist
  // shape in the product and no test would notice (final-review Minor 4).
  assert.equal(normalizeMarkdown("- [ ] todo\n- [x] done"), "- [ ] todo\n- [x] done");
  assert.equal(normalizeMarkdown("* [ ] todo"), "- [ ] todo", "a star checklist normalizes to a dash checklist");
  assert.equal(normalizeMarkdown("- [ ] a\n  - [ ] b"), "- [ ] a\n  - [ ] b", "nested task lists survive too");
  const table = normalizeMarkdown("| a | b |\n| - | - |\n| 1 | 2 |");
  assert.match(table, /^\| a\s*\| b\s*\|$/m);
  assert.match(table, /^\| 1\s*\| 2\s*\|$/m);
  assert.match(normalizeMarkdown("~~struck~~"), /~~struck~~/, "strikethrough is gfm too");
});

test("normalizeMarkdown: a {#id} heading marker is plain text and survives", () => {
  assert.equal(normalizeMarkdown("## What this is {#overview}\n\nbody"), "## What this is {#overview}\n\nbody");
});

test("normalizeMarkdown: blank input is empty, unparseable input is returned verbatim", () => {
  assert.equal(normalizeMarkdown("   \n"), "");
  assert.equal(normalizeMarkdown("   \n  "), "");
  // The catch branch's contract: whatever happens, the user's words come back
  // as a string and are never dropped on the floor.
  const weird = "<<<not really markdown>>>";
  assert.equal(typeof normalizeMarkdown(weird), "string");
  assert.match(normalizeMarkdown(weird), /not really markdown/);
});
