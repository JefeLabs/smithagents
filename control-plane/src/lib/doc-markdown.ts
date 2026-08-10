import type { Editor, Extensions } from "@tiptap/core";
import { Markdown } from "tiptap-markdown";

/**
 * The ONE serialization seam (spec 2026-08-10). Pro's RichTextEditor is
 * JSON-first; the document's model is markdown. Everything crosses here, so if
 * `tiptap-markdown` ever proves unfit, this file is the only thing that changes.
 *
 * The options mirror the broker's normalizer (`markdown-normalize.ts`): the same
 * bullet, fenced code, no HTML. Drift between the two shows up as a document
 * that rewrites itself on every save.
 */
export const markdownExtensions: Extensions = [
  Markdown.configure({
    html: false, // our documents are markdown, not HTML smuggled through markdown
    bulletListMarker: "-",
    linkify: false, // bare URLs stay bare — the author decides what is a link
    breaks: false,
    transformPastedText: true,
    transformCopiedText: true,
  }),
];

/** What to hand the editor as initial content — tiptap-markdown parses a string. */
export function toEditor(markdown: string): string {
  return markdown;
}

/** Markdown out of a live editor instance. */
export function fromEditor(editor: Editor): string {
  const storage = (editor.storage as { markdown?: { getMarkdown(): string } }).markdown;
  return (storage?.getMarkdown() ?? editor.getText()).trimEnd();
}
