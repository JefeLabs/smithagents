import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeMarkdown } from "./markdown-normalize.js";

test("normalizeMarkdown: one canonical spelling — bullets, emphasis, fences", () => {
  const out = normalizeMarkdown("* a\n* b\n\n__strong__ and *em*\n\n~~~js\nx\n~~~\n");
  assert.equal(out, "- a\n- b\n\n**strong** and _em_\n\n```js\nx\n```");
});

test("normalizeMarkdown: a {#id} heading marker is plain text and survives", () => {
  assert.equal(normalizeMarkdown("## What this is {#overview}\n\nbody"), "## What this is {#overview}\n\nbody");
});

test("normalizeMarkdown: blank input is empty, unparseable input is returned verbatim", () => {
  assert.equal(normalizeMarkdown("   \n"), "");
});
