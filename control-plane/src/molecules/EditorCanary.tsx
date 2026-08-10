import { RichTextEditor, useRichTextEditor } from "@heroui-pro/react/rich-text-editor";
import { Extension } from "@tiptap/core";

/** A marker extension with no behaviour — its only job is to be found again. */
const CanaryMark = Extension.create({ name: "smithCanary" });

function Probe() {
  const { editor } = useRichTextEditor();
  const present = editor?.extensionManager.extensions.some((e) => e.name === "smithCanary");
  return <span data-testid="canary-extension-present">{present ? "yes" : "no"}</span>;
}

/**
 * Temporary. Proves `@heroui-pro/react/rich-text-editor`, its optional @tiptap/*
 * peers, and custom-extension injection all work before the document editor
 * depends on them. Deleted in Task 5, exactly as phase 1b's markdown canary was.
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
