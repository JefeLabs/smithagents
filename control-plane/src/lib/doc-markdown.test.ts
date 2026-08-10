import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it } from "vitest";
import { fromEditor, markdownExtensions, toEditor } from "./doc-markdown";

/** A headless editor with exactly the extensions the app registers. */
function roundTrip(markdown: string): string {
  const editor = new Editor({ extensions: [StarterKit, ...markdownExtensions], content: toEditor(markdown) });
  const out = fromEditor(editor);
  editor.destroy();
  return out;
}

describe("doc-markdown round trip", () => {
  // The corpus a spec or plan actually uses. Anything here that does not survive
  // is a blocker for the whole approach, not a curiosity.
  const CASES: Array<[string, string]> = [
    ["paragraph", "Plain words in a paragraph."],
    ["emphasis", "Some _em_ and *strong* together."],
    ["heading", "## What this is"],
    ["bullets", "- one\n- two"],
    ["ordered", "1. first\n2. second"],
    ["inline code", "Run `pnpm test` first."],
    ["fenced code", "```ts\nconst x = 1;\n```"],
    ["quote", "> a quoted line"],
    ["link", "See [the spec](https://example.com/spec)."],
  ];

  for (const [name, md] of CASES) {
    it(`survives: ${name}`, () => {
      const once = roundTrip(md);
      expect(once.trim()).not.toBe("");
      // Idempotence is the real property: a second pass must change nothing,
      // or every save would rewrite the document a little differently.
      expect(roundTrip(once).trim()).toBe(once.trim());
    });
  }

  it("keeps the words even when it changes the spelling", () => {
    expect(roundTrip("Some **strong** text")).toContain("strong");
    expect(roundTrip("- a\n- b")).toContain("a");
  });

  it("an empty document serializes to an empty string, not a stray newline", () => {
    expect(roundTrip("").trim()).toBe("");
  });
});
