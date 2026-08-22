/**
 * The ONE markdown normalizer — moved from the broker (spec 2026-08-22 §2.2): every body that enters a document file passes through here.
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
