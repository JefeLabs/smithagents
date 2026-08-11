/**
 * The ONE markdown normalizer (spec 2026-08-10, document editor). Every body
 * that enters the store passes through here — human edits round-tripped by the
 * Tiptap editor, agent-authored text, and (phase 3) proposals. Without a single
 * spelling, a diff between an agent's markdown and an editor's markdown is
 * mostly formatting noise.
 */
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { unified } from "unified";

// Pinned deliberately: these choices ARE the canonical form. Changing one
// rewrites every document on its next save.
const processor = unified().use(remarkParse).use(remarkGfm).use(remarkStringify, {
  bullet: "-",
  emphasis: "_",
  strong: "*",
  fence: "`",
  fences: true,
  listItemIndent: "one",
  rule: "-",
});

export function normalizeMarkdown(text: string): string {
  if (!text.trim()) return "";
  try {
    return String(processor.processSync(text)).trimEnd();
  } catch {
    // A body we cannot parse is still the user's words — store it verbatim
    // rather than dropping it on the floor.
    return text;
  }
}
