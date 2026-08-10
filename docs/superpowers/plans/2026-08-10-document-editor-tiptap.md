# Document Editor (Tiptap) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Claimed by:** unclaimed — claim this header before executing

**Goal:** Edit document sections with HeroUI Pro's Tiptap `RichTextEditor` while markdown stays the stored model, normalized once in the broker so every source spells it the same way.

**Architecture:** The broker gains one `normalizeMarkdown()` applied to every body write. The control-plane gains one serialization seam (`doc-markdown.ts`) and a `SectionEditor` that mounts **only for the focused section**; unfocused sections keep rendering through `Markdown`. The document route becomes the app's first lazily-loaded chunk so chat-only sessions never download ProseMirror.

**Tech Stack:** Broker: Node ≥24, tsx, `node:test`, npm — **new deps** `unified`, `remark-parse`, `remark-stringify`, `remark-gfm`. Control-plane: React 19, `@heroui-pro/react/rich-text-editor`, vitest, pnpm — **new deps** the eight `@tiptap/*` peers plus `tiptap-markdown`.

**Spec:** `docs/superpowers/specs/2026-08-10-document-editor-tiptap-design.md`

## Global Constraints

- **Base:** branch `document-editor` off `develop` (≥ `ce37823`), isolated worktree `.worktrees/document-editor`. `.worktrees/` is gitignored.
- Broker = npm (`npm run typecheck && npm test` from `broker/`; targeted `node --import tsx --test src/<f>.test.ts`). Control-plane = pnpm (`pnpm typecheck && pnpm lint && pnpm test` from `control-plane/`). Never cross them. Read exit codes after a redirect, never after a pipe.
- **SPEC CORRECTION (verified 2026-08-10):** the spec says remark "packages are already in the tree" — that is true of `control-plane`, NOT `broker`. The broker's dependencies are `@anthropic-ai/sdk, @deepgram/sdk, @discordjs/opus, @discordjs/voice, @google/genai, @livekit/rtc-node, @smithagents/voice, discord.js, livekit-server-sdk, prism-media, sharp, sodium-native, ws`. Task 1 adds the four remark packages there.
- **Markdown is the stored model.** Nothing outside `doc-markdown.ts` calls a serializer; nothing outside `markdown-normalize.ts` normalizes. Phase-3 proposals stay markdown text — ProseMirror steps are not adopted.
- **Only the focused section mounts an editor.** No whole-document editor. Section-scoped `PATCH` and section-scoped proposals must keep working.
- Pro's editor is a **subpath import** (`@heroui-pro/react/rich-text-editor`) whose eight `@tiptap/*` peers are declared **optional** at `>=3.23.6` — nothing is installed today, and a missing peer fails at BUILD, not typecheck (the phase-1b `Markdown` lesson). Task 2 is the gate.
- Pro-default CSS conflicts go in `control-plane/src/styles/overrides.css` under `@layer overrides`; new styles go in `documents.css`. `components.css` is frozen. Never inline `style={{}}`.
- `onPress`/`isDisabled` on HeroUI components. Organisms stay router-free; no route loaders.
- Blur commits, Escape abandons, no save button — the behavior shipped in `ce361d2` must survive this change unchanged.
- Commit messages lowercase-descriptive; each commit lists exactly its task's files.

---

## File Structure

| Path | Responsibility |
|---|---|
| `broker/src/markdown-normalize.ts` (new) | `normalizeMarkdown(text)` — the ONE normalizer, every source |
| `broker/src/documents.ts` (modify) | `patchSection` normalizes before storing |
| `broker/package.json` (modify) | `unified`, `remark-parse`, `remark-stringify`, `remark-gfm` |
| `control-plane/package.json` (modify) | eight `@tiptap/*` peers + `tiptap-markdown` |
| `control-plane/src/molecules/EditorCanary.tsx` (+test, new, deleted in Task 5) | Proves the subpath import, the peers, and `extensions` injection |
| `control-plane/src/lib/doc-markdown.ts` (+test, new) | `toEditor` / `fromEditor` — the ONLY serialization seam |
| `control-plane/src/organisms/document/SectionEditor.tsx` (+test, new) | One focused section's Tiptap surface, minimal chrome |
| `control-plane/src/organisms/document/SectionCard.tsx` (modify) | Swaps the textarea for `SectionEditor` in edit mode |
| `control-plane/src/router.tsx` (modify) | `DocumentStage` becomes `React.lazy` — the first split chunk |
| `control-plane/src/styles/documents.css`, `overrides.css` (modify) | Editor typography parity; counter Pro's editor chrome |

---

### Task 1: The broker normalizer

**Files:**
- Create: `broker/src/markdown-normalize.ts`
- Modify: `broker/package.json`, `broker/src/documents.ts`
- Test: `broker/src/markdown-normalize.test.ts`, `broker/src/documents.test.ts`

**Interfaces:**
- Produces: `normalizeMarkdown(text: string): string` — collapses equivalent markdown spellings to one canonical form, returns `""` for blank input, and returns the input unchanged if parsing throws. `DocumentManager.patchSection` stores normalized text. Task 3's round-trip tests assert against this same canonical form conceptually (they run in the control-plane and cannot import it — they encode the same options).

- [ ] **Step 1: Install the remark packages**

Run (from `broker/`): `npm install unified remark-parse remark-stringify remark-gfm`

Record the four resolved versions in the Step 6 commit message. These are ESM-only and load fine under `tsx`.

- [ ] **Step 2: Write the failing test**

```ts
// broker/src/markdown-normalize.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeMarkdown } from './markdown-normalize.ts';

test('equivalent spellings converge on one form', () => {
  assert.equal(normalizeMarkdown('*em* and __strong__'), normalizeMarkdown('_em_ and **strong**'));
});

test('setext headings become ATX; bullets unify', () => {
  assert.equal(normalizeMarkdown('Title\n=====\n'), '# Title');
  assert.equal(normalizeMarkdown('* one\n* two'), normalizeMarkdown('- one\n- two'));
});

test('normalizing twice changes nothing', () => {
  const once = normalizeMarkdown('# Heading\n\n*   loose    spacing\n*   here\n');
  assert.equal(normalizeMarkdown(once), once);
});

test('gfm survives — tables and task lists are not mangled away', () => {
  const table = normalizeMarkdown('| a | b |\n| - | - |\n| 1 | 2 |');
  assert.match(table, /\| a\s*\| b\s*\|/);
  assert.match(normalizeMarkdown('- [ ] todo'), /- \[ \] todo/);
});

test('blank input is empty; unparseable input is returned as-is rather than lost', () => {
  assert.equal(normalizeMarkdown('   \n  '), '');
  const weird = '<<<not really markdown>>>';
  assert.equal(typeof normalizeMarkdown(weird), 'string');
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `node --import tsx --test src/markdown-normalize.test.ts`
Expected: FAIL — cannot find module `./markdown-normalize.ts`.

- [ ] **Step 4: Write the implementation**

```ts
// broker/src/markdown-normalize.ts
/**
 * The ONE markdown normalizer (spec 2026-08-10, document editor). Every body
 * that enters the store passes through here — human edits round-tripped by the
 * Tiptap editor, agent-authored text, and (phase 3) proposals. Without a single
 * spelling, a diff between an agent's markdown and an editor's markdown is
 * mostly formatting noise.
 */
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import { unified } from 'unified';

// Pinned deliberately: these choices ARE the canonical form. Changing one
// rewrites every document on its next save.
const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkStringify, {
    bullet: '-',
    emphasis: '_',
    strong: '*',
    fence: '`',
    fences: true,
    listItemIndent: 'one',
    rule: '-',
  });

export function normalizeMarkdown(text: string): string {
  if (!text.trim()) return '';
  try {
    return String(processor.processSync(text)).trimEnd();
  } catch {
    // A body we cannot parse is still the user's words — store it verbatim
    // rather than dropping it on the floor.
    return text;
  }
}
```

- [ ] **Step 5: Wire it into the store, with a test**

In `broker/src/documents.ts`: `import { normalizeMarkdown } from './markdown-normalize.ts';` and in `patchSection`, replace `section.body = body;` with `section.body = normalizeMarkdown(body);`.

Append to `broker/src/documents.test.ts` (its existing `manager()` helper and `BP` fixture are already in the file):

```ts
test('patchSection stores normalized markdown, whatever spelling arrived', () => {
  const { m } = manager();
  const doc = m.create(BP, 'feature', 'T')!;
  m.patchSection(doc.id, 'overview', '*em* and __strong__');
  const stored = m.get(doc.id)?.sections.find((s) => s.id === 'overview')?.body;
  m.patchSection(doc.id, 'overview', '_em_ and **strong**');
  assert.equal(m.get(doc.id)?.sections.find((s) => s.id === 'overview')?.body, stored);
});
```

- [ ] **Step 6: Run gates, commit**

Run: `node --import tsx --test src/markdown-normalize.test.ts src/documents.test.ts` → PASS. Then `npm run typecheck && npm test`.

```bash
git add package.json package-lock.json src/markdown-normalize.ts src/markdown-normalize.test.ts src/documents.ts src/documents.test.ts
git commit -m "feat: one normalizer for every markdown that enters the store"
```

---

### Task 2: The Tiptap canary — the gate

**Files:**
- Modify: `control-plane/package.json`
- Create: `control-plane/src/molecules/EditorCanary.tsx`, `control-plane/src/molecules/EditorCanary.test.tsx`

**Interfaces:**
- Produces: proof that `@heroui-pro/react/rich-text-editor` resolves with its peers installed AND that a custom extension passed through the `extensions` prop reaches the editor instance. Task 3 and Task 4 depend on both facts. **If the extension cannot be injected, STOP and report — the spec's whole approach rests on it.**

- [ ] **Step 1: Install the peers**

Run (from `control-plane/`):

```bash
pnpm add @tiptap/core @tiptap/pm @tiptap/react @tiptap/starter-kit @tiptap/extensions @tiptap/extension-link @tiptap/extension-underline @tiptap/suggestion tiptap-markdown
```

All eight `@tiptap/*` are declared optional peers of `@heroui-pro/react` at `>=3.23.6`; `tiptap-markdown@0.9.0` peers `@tiptap/core ^3.0.1`. If pnpm resolves any `@tiptap/*` below 3.23.6, pin it explicitly and say so in the report. Record resolved versions in the Step 6 commit message.

- [ ] **Step 2: Write the failing canary test**

```tsx
// control-plane/src/molecules/EditorCanary.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EditorCanary } from "./EditorCanary";

describe("EditorCanary", () => {
  // Proves three things before anything depends on them: the subpath import
  // resolves, the optional @tiptap/* peers are installed, and a custom
  // extension reaches the editor through Pro's `extensions` prop — which is
  // how the markdown serializer will be registered in Task 3.
  it("mounts the Pro editor and registers a custom extension", async () => {
    render(<EditorCanary />);
    expect(await screen.findByTestId("canary-extension-present")).toHaveTextContent("yes");
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `pnpm vitest run src/molecules/EditorCanary.test.tsx`
Expected: FAIL — cannot resolve `./EditorCanary`.

- [ ] **Step 4: Write the canary**

```tsx
// control-plane/src/molecules/EditorCanary.tsx
import { Extension } from "@tiptap/core";
import { RichTextEditor, useRichTextEditor } from "@heroui-pro/react/rich-text-editor";

/** A marker extension with no behaviour — its only job is to be found again. */
const CanaryMark = Extension.create({ name: "smithCanary" });

function Probe() {
  const { editor } = useRichTextEditor();
  const present = editor?.extensionManager.extensions.some((e) => e.name === "smithCanary");
  return <span data-testid="canary-extension-present">{present ? "yes" : "no"}</span>;
}

/**
 * Temporary. Proves `@heroui-pro/react/rich-text-editor`, its optional
 * @tiptap/* peers, and custom-extension injection all work before Transcript…
 * er, before the document editor depends on them. Deleted in Task 5, exactly
 * as phase 1b's markdown canary was.
 */
export function EditorCanary() {
  return (
    <RichTextEditor extensions={[CanaryMark]}>
      <RichTextEditor.Shell>
        <RichTextEditor.Content />
        <Probe />
      </RichTextEditor.Shell>
    </RichTextEditor>
  );
}
```

- [ ] **Step 5: Run it, and deal with jsdom honestly**

Run: `pnpm vitest run src/molecules/EditorCanary.test.tsx`
Expected: PASS.

ProseMirror touches DOM APIs jsdom implements thinly. If it throws, add shims to `src/test/setup.ts` in the file's established `vi.hoisted` idiom (phase 1b added `matchMedia`, `Element.prototype.scrollTo` and `setPointerCapture` the same way) — likely candidates are `document.createRange`, `Range.prototype.getClientRects`, and `Element.prototype.getClientRects`. Each shim needs the comment style already in that file: the gap, the component that hits it, the failure mode.

**If the editor cannot be mounted in jsdom after those shims:** keep the canary as a build+typecheck proof (`pnpm build` must succeed with the import present), assert the extension registration in a real browser instead, and SAY SO PLAINLY in the report — do not delete the assertion and call it passing.

- [ ] **Step 6: Full gate, commit**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
Record the bundle size delta against 2,060.05 kB raw / 638.22 kB gzip — Task 6 makes it a separate chunk, so this number is the "before".

```bash
git add package.json pnpm-lock.yaml src/molecules/EditorCanary.tsx src/molecules/EditorCanary.test.tsx src/test/setup.ts
git commit -m "feat: canary the tiptap peers and prove extensions inject"
```

---

### Task 3: The serialization seam

**Files:**
- Create: `control-plane/src/lib/doc-markdown.ts`, `control-plane/src/lib/doc-markdown.test.ts`

**Interfaces:**
- Consumes: `tiptap-markdown` and the peers (Task 2).
- Produces: `markdownExtensions: Extensions` (the Tiptap extension array Task 4 passes to `RichTextEditor`, including `Markdown` configured for our canonical form), `toEditor(markdown: string): string` (what to hand the editor as its initial content — `tiptap-markdown` accepts a markdown string as content), and `fromEditor(editor: Editor): string` (markdown out). **These three names are the only serialization API in the app.**

- [ ] **Step 1: Write the failing round-trip tests**

```ts
// control-plane/src/lib/doc-markdown.test.ts
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
```

- [ ] **Step 2: Run to confirm it fails**

Run: `pnpm vitest run src/lib/doc-markdown.test.ts`
Expected: FAIL — cannot resolve `./doc-markdown`.

- [ ] **Step 3: Write the seam**

```ts
// control-plane/src/lib/doc-markdown.ts
import type { Editor, Extensions } from "@tiptap/core";
import { Markdown } from "tiptap-markdown";

/**
 * The ONE serialization seam (spec 2026-08-10). Pro's RichTextEditor is
 * JSON-first; the document's model is markdown. Everything crosses here, so if
 * `tiptap-markdown` ever proves unfit, this file is the only thing that changes.
 *
 * The options mirror the broker's normalizer (`markdown-normalize.ts`): the same
 * bullet, the same emphasis marker, fenced code. Drift between the two shows up
 * as a document that rewrites itself on every save.
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
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run src/lib/doc-markdown.test.ts`
Expected: PASS.

**If a corpus case fails to round-trip:** that case is the spec's Risk 1 arriving. Record exactly which constructs fail in the report, then STOP and escalate rather than deleting the case — the spec's documented fallback (a hand-rolled mdast↔ProseMirror mapping) is a decision for the human partner, not a silent substitution.

- [ ] **Step 5: Full gate, commit**

Run: `pnpm typecheck && pnpm lint && pnpm test`

```bash
git add src/lib/doc-markdown.ts src/lib/doc-markdown.test.ts
git commit -m "feat: one seam between markdown and the editor, proven by round trip"
```

---

### Task 4: `SectionEditor`

**Files:**
- Create: `control-plane/src/organisms/document/SectionEditor.tsx`, `control-plane/src/organisms/document/SectionEditor.test.tsx`
- Modify: `control-plane/src/styles/documents.css`, `control-plane/src/styles/overrides.css`

**Interfaces:**
- Consumes: `markdownExtensions`, `toEditor`, `fromEditor` (Task 3).
- Produces: `SectionEditor({ body, ariaLabel, placeholder, onCommit, onAbandon }: { body: string; ariaLabel: string; placeholder?: string; onCommit: (markdown: string) => void; onAbandon: () => void })`. Behavior contract Task 5 relies on: mounts focused at the end of the text; **blur commits** the current markdown via `onCommit`; **Escape calls `onAbandon`** without committing; renders a `BubbleMenu` on selection and a `FloatingMenu` on an empty line; registers `/` as a `SuggestionMenu` trigger.

- [ ] **Step 1: Write the failing test**

```tsx
// control-plane/src/organisms/document/SectionEditor.test.tsx
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SectionEditor } from "./SectionEditor";

describe("SectionEditor", () => {
  afterEach(() => cleanup());

  it("shows the section's markdown as rendered text, not as source", async () => {
    render(
      <SectionEditor body="It **does** the thing." ariaLabel="What this is" onCommit={vi.fn()} onAbandon={vi.fn()} />,
    );
    // The words survive; the asterisks do not — that is the whole point of WYSIWYG.
    const surface = await screen.findByRole("textbox", { name: "What this is" });
    expect(surface.textContent).toContain("does");
    expect(surface.textContent).not.toContain("**");
  });

  it("blur commits markdown", async () => {
    const onCommit = vi.fn();
    render(<SectionEditor body="Words." ariaLabel="What this is" onCommit={onCommit} onAbandon={vi.fn()} />);
    const surface = await screen.findByRole("textbox", { name: "What this is" });
    fireEvent.blur(surface);
    await waitFor(() => expect(onCommit).toHaveBeenCalled());
    expect(typeof onCommit.mock.calls[0][0]).toBe("string");
  });

  it("Escape abandons without committing", async () => {
    const onCommit = vi.fn();
    const onAbandon = vi.fn();
    render(<SectionEditor body="Words." ariaLabel="What this is" onCommit={onCommit} onAbandon={onAbandon} />);
    const surface = await screen.findByRole("textbox", { name: "What this is" });
    fireEvent.keyDown(surface, { key: "Escape" });
    expect(onAbandon).toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });
});
```

If jsdom could not mount the editor in Task 2, these three tests are equally impossible — in that case implement the component, verify all three behaviors in the real browser during Task 7, and state in the report that the unit tests were replaced by a browser walk. Do not ship green tests that assert nothing.

- [ ] **Step 2: Confirm failure, then write the component**

Run: `pnpm vitest run src/organisms/document/SectionEditor.test.tsx` → FAIL (unresolved import).

```tsx
// control-plane/src/organisms/document/SectionEditor.tsx
import { RichTextEditor, useRichTextEditor } from "@heroui-pro/react/rich-text-editor";
import { useEffect } from "react";
import { fromEditor, markdownExtensions, toEditor } from "../../lib/doc-markdown";

interface SectionEditorProps {
  body: string;
  /** Accessible name — the section's heading, so tests and AT find it by name. */
  ariaLabel: string;
  placeholder?: string;
  /** Blur commits. There is no save button anywhere in this page. */
  onCommit: (markdown: string) => void;
  onAbandon: () => void;
}

/** Focus, blur and Escape all need the live editor, which only exists inside the provider. */
function Behaviour({ ariaLabel, onCommit, onAbandon }: Pick<SectionEditorProps, "ariaLabel" | "onCommit" | "onAbandon">) {
  const { editor } = useRichTextEditor();

  useEffect(() => {
    if (!editor) return;
    editor.commands.focus("end");
    const el = editor.view.dom as HTMLElement;
    el.setAttribute("aria-label", ariaLabel);
    const onBlur = () => onCommit(fromEditor(editor));
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onAbandon();
      }
    };
    el.addEventListener("blur", onBlur);
    el.addEventListener("keydown", onKey);
    return () => {
      el.removeEventListener("blur", onBlur);
      el.removeEventListener("keydown", onKey);
    };
  }, [editor, ariaLabel, onCommit, onAbandon]);

  return null;
}

/**
 * One section's editing surface. Mounted ONLY for the focused section (spec
 * 2026-08-10): a document of twenty sections must not carry twenty ProseMirror
 * instances, and the section is also the unit a phase-3 proposal addresses.
 */
export function SectionEditor({ body, ariaLabel, placeholder, onCommit, onAbandon }: SectionEditorProps) {
  return (
    <RichTextEditor
      className="doc-section__editor"
      defaultValue={toEditor(body) as never}
      extensions={markdownExtensions}
      placeholder={placeholder}
    >
      <RichTextEditor.Shell>
        <RichTextEditor.Content />
        {/* Chrome appears only when it is asked for: selection raises formatting,
            an empty line offers block types, "/" opens the rest. */}
        <RichTextEditor.BubbleMenu>
          <RichTextEditor.ToggleButton command="bold" tooltip="Bold" />
          <RichTextEditor.ToggleButton command="italic" tooltip="Italic" />
          <RichTextEditor.ToggleButton command="code" tooltip="Code" />
          <RichTextEditor.LinkPopover>
            <RichTextEditor.LinkPopover.Trigger />
            <RichTextEditor.LinkPopover.Content>
              <RichTextEditor.LinkPopover.Input />
              <RichTextEditor.LinkPopover.Actions>
                <RichTextEditor.LinkPopover.UnsetButton />
                <RichTextEditor.LinkPopover.ApplyButton />
              </RichTextEditor.LinkPopover.Actions>
            </RichTextEditor.LinkPopover.Content>
          </RichTextEditor.LinkPopover>
        </RichTextEditor.BubbleMenu>
        <RichTextEditor.FloatingMenu>
          <RichTextEditor.ToggleButton command="heading-2" tooltip="Heading" />
          <RichTextEditor.ToggleButton command="bulletList" tooltip="List" />
          <RichTextEditor.ToggleButton command="blockquote" tooltip="Quote" />
        </RichTextEditor.FloatingMenu>
        <Behaviour ariaLabel={ariaLabel} onCommit={onCommit} onAbandon={onAbandon} />
      </RichTextEditor.Shell>
    </RichTextEditor>
  );
}
```

`defaultValue` is typed `JSONContent`; `tiptap-markdown` accepts a markdown string as content, which is why `toEditor`'s string is cast at that one call site. If the cast is avoidable with the installed types, remove it and say so; if it is not, this is the single place it is allowed.

The `/` slash menu is deliberately NOT wired in this task — `SuggestionMenu` needs an item list, and adding it here would mix two review surfaces. It lands in Task 7's follow-up list only if the browser pass shows the floating menu is not enough.

- [ ] **Step 3: Typography parity — the editor must not reflow the page**

Pro's editor ships its own surface chrome. Add to `overrides.css`, under the existing `@layer overrides` block, with a comment naming what each rule counters:

```css
/* The section editor is not a form field: Pro's shell paints a bordered card and
   its ProseMirror host sets its own type scale. The page's prose metrics must
   win, or focusing a section visibly reflows the document. */
.doc-section__editor .rich-text-editor__shell {
  border: none;
  background: transparent;
  border-radius: 0;
  padding: 0;
}
.doc-section__editor .rich-text-editor__content,
.doc-section__editor .rich-text-editor__prosemirror {
  padding: 0;
  font-family: inherit;
  font-size: 15px;
  line-height: 1.65;
  color: var(--text);
}
.doc-section__editor .rich-text-editor__prosemirror:focus {
  outline: none;
}
```

And in `documents.css`, replace the old textarea rule's selector body so the class still carries the focused-section tint:

```css
.doc-section__editor {
  margin: 0 -8px;
  padding: 2px 8px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--accent) 7%, transparent);
}
```

(Delete the textarea-specific declarations — `resize`, `overflow`, `min-height`, `width`, `::placeholder` — that no longer have a textarea to style.)

- [ ] **Step 4: Run the tests, full gate, commit**

Run: `pnpm vitest run src/organisms/document/SectionEditor.test.tsx` then `pnpm typecheck && pnpm lint && pnpm test`.

```bash
git add src/organisms/document/SectionEditor.tsx src/organisms/document/SectionEditor.test.tsx src/styles/documents.css src/styles/overrides.css
git commit -m "feat: a section edits as rich text, still speaking markdown"
```

---

### Task 5: `SectionCard` adopts the editor; canary dies

**Files:**
- Modify: `control-plane/src/organisms/document/SectionCard.tsx`, `control-plane/src/organisms/document/SectionCard.test.tsx`
- Delete: `control-plane/src/molecules/EditorCanary.tsx`, `control-plane/src/molecules/EditorCanary.test.tsx`

**Interfaces:**
- Consumes: `SectionEditor` (Task 4).
- Produces: `SectionCard` with its existing props unchanged (`section`, `hint`, `editing`, `onEdit`, `onCancel`, `onSave`) — `DocumentStage` is not modified in this task.

- [ ] **Step 1: Update the tests to the new edit surface**

In `SectionCard.test.tsx`, the read-mode tests stay byte-identical. The two edit-mode tests move from the textarea to the editor surface: the accessible name is unchanged (`/what this is/i`), so only the mechanics change — `fireEvent.blur(surface)` still commits, `fireEvent.keyDown(surface, { key: "Escape" })` still abandons. Update the assertion that reads `.value` (a textarea property) to read `textContent`, and drop the "seeds the raw body" expectation of literal `**` — rendered text is the point now:

```tsx
  it("edit mode renders the body as rich text and commits on blur", async () => {
    const onSave = vi.fn();
    render(<SectionCard section={SECTION} editing onEdit={vi.fn()} onCancel={vi.fn()} onSave={onSave} />);
    const surface = await screen.findByRole("textbox", { name: /what this is/i });
    expect(surface.textContent).toContain("does");
    expect(screen.queryByRole("button", { name: /^save$/i })).toBeNull();
    fireEvent.blur(surface);
    await waitFor(() => expect(onSave).toHaveBeenCalled());
  });
```

- [ ] **Step 2: Swap the textarea for the editor**

In `SectionCard.tsx`, replace the entire `<textarea …/>` branch with:

```tsx
        <SectionEditor
          body={section.body}
          ariaLabel={section.heading}
          placeholder={hint}
          onCommit={onSave}
          onAbandon={onCancel}
        />
```

Delete the now-unused `draft` state, the `useEffect` that reseeded it, the `ref`, and the auto-height effect — the editor owns its own content and sizing. Keep the read-mode branch, the hint ghost text, and the click/keyboard affordance exactly as they are.

- [ ] **Step 3: Delete the canary**

```bash
git rm src/molecules/EditorCanary.tsx src/molecules/EditorCanary.test.tsx
```

Run: `grep -rn "EditorCanary" src` → no output.

- [ ] **Step 4: Run the document suites, full gate, commit**

Run: `pnpm vitest run src/organisms/document/SectionCard.test.tsx src/organisms/DocumentStage.test.tsx` → PASS (DocumentStage's blur-commits and Escape-abandons tests must pass UNCHANGED — they are the contract this task must not break). Then `pnpm typecheck && pnpm lint && pnpm test`.

```bash
git add src/organisms/document/SectionCard.tsx src/organisms/document/SectionCard.test.tsx
git commit -m "feat: the page edits as rich text — canary retired"
```

---

### Task 6: The document route becomes the first lazy chunk

**Files:**
- Modify: `control-plane/src/router.tsx`
- Test: `control-plane/src/router.test.tsx`

**Interfaces:**
- Produces: `DocumentStage` imported via `React.lazy` and rendered inside a `<Suspense fallback={null}>`, so the chat routes never download ProseMirror. Route behavior (status gate, unknown-doc redirect) is unchanged.

- [ ] **Step 1: Make it lazy**

In `router.tsx`, replace `import { DocumentStage } from "./organisms/DocumentStage";` with:

```tsx
// The document stage carries Tiptap/ProseMirror; a chat-only session should not
// download an editor it never opens. This is the app's first split chunk.
const DocumentStage = lazy(() => import("./organisms/DocumentStage").then((m) => ({ default: m.DocumentStage })));
```

(`import { lazy, Suspense } from "react";` at the top.) In `DocRoute`, wrap the returned stage:

```tsx
  return (
    <Suspense fallback={null}>
      <DocumentStage
        …existing props unchanged…
      />
    </Suspense>
  );
```

- [ ] **Step 2: Keep the router tests honest**

The existing `/doc/$docId` tests now resolve asynchronously. Where a test asserts the Document region synchronously, switch to `await screen.findByRole("region", { name: "Document" })` (several already do). Run: `pnpm vitest run src/router.test.tsx` → PASS, no test deleted.

- [ ] **Step 3: Prove the chunk exists**

Run: `pnpm build`, then:

```bash
ls -la dist/assets | sort -k5 -n | tail -6
```

Expected: a `DocumentStage-*.js` chunk separate from `index-*.js`, and the main `index-*.js` **smaller than Task 2's recorded figure**. Record both numbers in the report. If the chunk did not split (a static import elsewhere pulls it back in), find that import — `grep -rn "DocumentStage" src` — and fix it; do not report a split that did not happen.

- [ ] **Step 4: Full gate, commit**

Run: `pnpm typecheck && pnpm lint && pnpm test`

```bash
git add src/router.tsx src/router.test.tsx
git commit -m "perf: the editor ships only to the page that uses it"
```

---

### Task 7: Verification and the live walk

**Files:** none — this task gates the branch.

- [ ] **Step 1: Both packages' gates**

Broker (from `broker/`): `npm run typecheck && npm test`.
Control-plane: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.
Record: broker test count; control-plane test count; main-chunk and document-chunk sizes vs the 2,060.05 kB / 638.22 kB baseline.

- [ ] **Step 2: Live walk**

Isolated broker on 7791 with `/tmp` state dirs (`BROKER_TEXT_PORT=7791 BROKER_SESSIONS_DIR=/tmp/de-sessions BROKER_DOCUMENTS_DIR=/tmp/de-docs npm run serve`, `--env-file` pointing at the repo-root `.env`); dev server on 1421 from the worktree; the live broker (7790) and Tauri pair (1420) are NOT touched. The browser talks to 7790 unless a `VITE_BROKER_BASE` override exists — check, and if it does not, drive document mutations with `curl` (no Origin header) and use the browser for reads, exactly as the last two phases did. Say which route you took.

Walk, reporting each as exercised or not:
1. Create a document, land on the page, click a section — the text does **not** reflow when the editor mounts (compare a screenshot before and after focus).
2. Type `**bold**` and watch it render live as bold. Type `- ` at the start of a line and watch a list begin.
3. Select a word — the bubble menu appears; make it italic.
4. Blur — the whisper says saved. Reload the page: the formatting persisted and the stored markdown is normalized (check the JSON under `/tmp/de-docs`).
5. Escape mid-edit — the section reverts to what the document says.
6. A long section (paste ~500 words) stays responsive while typing.

- [ ] **Step 3: Report**

Test counts, gate statuses, both bundle numbers, the round-trip corpus result from Task 3, every walk step's verdict, and any jsdom substitutions made in Tasks 2/4 — plainly, including anything that could not be exercised.

---

## Self-Review (done at plan time)

- **Spec coverage:** normalizer + one-place rule ✔ (T1), peers/subpath/extensions gate ✔ (T2), single serialization seam + round-trip corpus ✔ (T3), per-focused-section editor with minimal chrome + typography parity ✔ (T4), blur/Escape/no-save-button preserved ✔ (T4/T5), canary deleted ✔ (T5), lazy document route ✔ (T6), risks surfaced as gates rather than hopes ✔ (T2 stop-condition, T3 escalation, T6 chunk proof), live walk ✔ (T7). Slash menu deliberately deferred with a stated reason. Collaborative editing, tables/embeds, whole-document editor: non-goals, absent.
- **Spec correction carried into Global Constraints:** the broker had no remark packages; T1 installs them.
- **Type consistency:** `normalizeMarkdown(text): string` (T1) used only in the broker; `markdownExtensions`/`toEditor`/`fromEditor` (T3) consumed only by `SectionEditor` (T4); `SectionEditor`'s prop names match `SectionCard`'s call site (T5); `DocumentStage`'s props are untouched by T6.
- **Placeholder scan:** none. Each jsdom-risk step carries an explicit, honest fallback rather than "handle errors appropriately".
