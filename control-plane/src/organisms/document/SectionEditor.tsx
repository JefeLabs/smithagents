import { RichTextEditor, useRichTextEditor } from "@heroui-pro/react/rich-text-editor";
import { useEffect } from "react";
import { fromEditor, markdownExtensions, toEditor } from "../../lib/doc-markdown";

interface SectionEditorProps {
  body: string;
  /** Accessible name — the section's heading, so tests and AT find it by name. */
  ariaLabel: string;
  placeholder?: string;
  /** Blur commits. There is no save button anywhere on this page. */
  onCommit: (markdown: string) => void;
  onAbandon: () => void;
}

/** Focus, blur and Escape all need the live editor, which only exists inside the provider. */
function Behaviour({
  ariaLabel,
  onCommit,
  onAbandon,
}: Pick<SectionEditorProps, "ariaLabel" | "onCommit" | "onAbandon">) {
  const { editor } = useRichTextEditor();

  useEffect(() => {
    if (!editor) return;
    editor.commands.focus("end");
    const el = editor.view.dom as HTMLElement;
    // ProseMirror ships a bare contenteditable div. `contenteditable` alone does
    // not confer a role in the ARIA-in-HTML mapping, so assistive tech (and
    // role-based queries) see nothing without these three attributes.
    el.setAttribute("role", "textbox");
    el.setAttribute("aria-multiline", "true");
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
      // tiptap-markdown parses a markdown string as content; Pro types the prop
      // as Tiptap JSON. This is the one place that cast is allowed to live.
      defaultValue={toEditor(body) as never}
      extensions={markdownExtensions}
      placeholder={placeholder}
    >
      <RichTextEditor.Shell>
        <RichTextEditor.Content />
        {/* Chrome appears only when asked for: a selection raises formatting, an
            empty line offers block types. */}
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
