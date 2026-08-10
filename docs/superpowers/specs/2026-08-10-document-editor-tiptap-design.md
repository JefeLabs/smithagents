# The Document Editor — Tiptap with markdown as the wire format

**Date:** 2026-08-10 (evening)
**Status:** Approved design, ready for planning
**Builds on:** `2026-08-10-session-artifacts-design.md` (documents, blueprints,
sections, the page). Replaces only the *editing mechanism* inside a section —
the store, routes, shelf, and stage layout are unchanged.

## The decision

Sections are edited with **HeroUI Pro's `RichTextEditor` (Tiptap/ProseMirror)**,
and **markdown remains the stored model**. Every write is normalized by one
broker-side function so that text from a human editor, an agent, or a seeded
blueprint is byte-comparable.

Rejected alternatives and why:

- **Keep the plain textarea (today).** Correct and cheap, but it will never be
  a real work surface — no tables, no slash menu, no checklists, and formatting
  only appears on blur.
- **CodeMirror 6 + `lang-markdown`.** Keeps markdown literal with live styling
  (Obsidian-ish), no serialization seam at all. Lighter and safer, but it is a
  *source* editor forever: no structural editing, no embeds, no custom nodes for
  the diagram blueprints the artifacts spec anticipates.
- **Store Tiptap JSON instead of markdown.** Kills the round-trip problem, but
  breaks the thing the whole feature rests on: agents author markdown, and
  phase 3 proposes changes as markdown text.

## Why the round-trip is acceptable

`RichTextEditor` is JSON-first (`value`/`onValueChange` speak `JSONContent`),
so markdown must be serialized in and out. Round-tripping normalizes prose:
`*em*` becomes `_em_`, setext headings become ATX, list bullets unify, hard
breaks may change. That is only *churn* if some writes skip the serializer.

**The rule that makes it safe: every body write is normalized, from every
source.** Normalization lives in the broker — one function, applied in
`patchSection`, in blueprint instantiation, and (phase 3) on proposal ingestion.
Then human edits and agent text converge on the same spelling of the same
markdown, diffs stay meaningful, and the one-time normalization happens at the
boundary rather than on every keystroke.

## Architecture

**One editor per *focused* section — never per document, never all at once.**

- A section not being edited renders through the existing `Markdown` component,
  exactly as today.
- Clicking a section mounts a `RichTextEditor` for that section alone, seeded
  from its markdown, focused at the click. Blur serializes back to markdown and
  saves (the existing blur-commits behavior, unchanged).
- At most one editor instance is mounted at a time, which bounds the cost of
  ProseMirror on a long document and preserves everything the section model
  gives us: section-scoped `PATCH`, section-scoped phase-3 proposals, and the
  blueprint's headings as document structure rather than editor content.

A single whole-document editor is explicitly rejected: it dissolves the section
boundaries the blueprint model and the proposal protocol both depend on.

**The serialization seam** is one module, `control-plane/src/lib/doc-markdown.ts`:
`toEditor(markdown): JSONContent` and `fromEditor(json): string`. Nothing else
in the app calls the serializer. If `tiptap-markdown` proves unfit, this module
is the only thing that changes.

**Normalization** is one broker function, `broker/src/markdown-normalize.ts`:
`normalizeMarkdown(text): string`, implemented with remark (parse → stringify
with pinned options; the packages are already in the tree via the 1b markdown
peers). It is applied in `DocumentManager.patchSection` and anywhere else a body
enters the store. It never runs in the client — one implementation, every source.

## Facts established (do not re-derive)

- Pro's editor requires eight peers at `>=3.23.6`, **all optional** so nothing is
  installed today: `@tiptap/core`, `@tiptap/pm`, `@tiptap/react`,
  `@tiptap/starter-kit`, `@tiptap/extensions`, `@tiptap/extension-link`,
  `@tiptap/extension-underline`, `@tiptap/suggestion`.
- It is a **subpath import**: `@heroui-pro/react/rich-text-editor`. The barrel
  does not export it — the same shape as `Markdown` in phase 1b, which failed at
  build rather than typecheck when its peers were missing. This phase gets the
  same canary treatment.
- API: `value`/`defaultValue: JSONContent`, `onValueChange(value, details)`
  where details carry HTML, text, `isEmpty`, character and word counts;
  `extensions` and `editorOptions` pass through to Tiptap; `useRichTextEditor()`
  exposes the raw editor. Compound parts: `Shell`, `Content`, `Toolbar`,
  `ToggleButton`, `ActionButton`, `CommandButton`, `BubbleMenu`, `FloatingMenu`,
  `SuggestionMenu`, `LinkPopover`, `CharacterCount`, `Footer`.
- `tiptap-markdown@0.9.0` peers `@tiptap/core ^3.0.1` (compatible with the >=3.23.6
  Pro wants). **Last published ~11 months before this spec** — see Risks.

## UI inside a focused section

Minimal chrome, because the page is the point:

- No always-on toolbar. Selecting text raises `BubbleMenu` (bold, italic, code,
  link); an empty line raises `FloatingMenu` (heading, list, quote).
- `SuggestionMenu` on `/` offers the block types the blueprint's prose actually
  needs: heading, bulleted list, numbered list, checklist, quote, code block.
- No `CharacterCount`, no `Footer` — a spec is not a tweet.
- The editor surface must inherit the page's typography (`.doc-section__body`
  metrics) so that focusing a section does not reflow it. Pro's own
  `.rich-text-editor__*` chrome is countered in `overrides.css` under
  `@layer overrides`, never inline.

## Risks

1. **`tiptap-markdown` staleness (~11 months).** Mitigation: the serializer is
   isolated behind `doc-markdown.ts`, and a fallback exists — remark's mdast can
   be mapped to ProseMirror JSON by hand for the node set a spec actually uses
   (paragraph, heading, list, listItem, code, blockquote, emphasis, strong, link,
   inlineCode). The plan's first task proves the round trip before anything
   depends on it; if the library fails that gate, the hand-rolled mapping is the
   documented fallback rather than a surprise.
2. **Lossy constructs.** Reference links, raw HTML blocks, footnotes and table
   alignment are the usual casualties. The plan's round-trip task enumerates what
   survives, and anything that does not is recorded as a known limitation rather
   than discovered by a user losing work.
3. **Bundle.** Tiptap + ProseMirror is roughly 150–250 KB min. The bundle is
   already 2,060 KB raw / 638 KB gzip with the code-splitting flag open since
   phase 1b. **The document route becomes the first lazily-loaded chunk** —
   `React.lazy` on `DocumentStage`, so chat-only sessions never pay for the
   editor. This is a required part of this work, not a follow-up.
4. **Pro wraps its own StarterKit.** If the markdown extension cannot be injected
   through the `extensions` prop, the whole approach fails. The canary task
   proves injection works before any UI is built.

## Testing

- **Canary (first task):** the subpath import resolves with the peers installed,
  a `RichTextEditor` mounts in jsdom (expect the same `window.matchMedia`-class
  shims phase 1b needed), and a custom extension passed via `extensions` is
  actually present on the editor instance.
- **Round-trip property tests** over `doc-markdown.ts`: for a corpus of the
  constructs a spec uses, `fromEditor(toEditor(md))` equals `normalizeMarkdown(md)`;
  and it is idempotent on a second pass. This is the test that decides whether
  `tiptap-markdown` stays.
- **Normalization** (broker): `patchSection` stores normalized text regardless of
  input spelling; two equivalent spellings converge byte-for-byte.
- **Section editing** (control-plane): only the focused section mounts an editor;
  blur still commits and Escape still abandons; the unfocused sections still
  render through `Markdown`; the page does not reflow on focus (measured, not
  eyeballed).
- **Lazy route:** the document chunk is separate in `dist`, and the chat route
  does not request it.
- Real-browser pass: type `**bold**` and watch it render live; slash menu;
  bubble menu on selection; a long document stays responsive.

## Non-goals

- Collaborative cursors / Yjs (phase 2's participants may revisit).
- Tables, embeds, and images beyond what StarterKit provides.
- A single whole-document editor.
- Changing phase 3's protocol: **proposals stay markdown text over normalized
  bodies.** ProseMirror steps as a proposal format is explicitly not adopted.
- Migrating already-stored documents: normalization applies on next write, and
  stored text stays valid markdown either way.
