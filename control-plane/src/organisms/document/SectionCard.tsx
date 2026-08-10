import { Markdown } from "@heroui-pro/react/markdown";
import { useState } from "react";
import type { DocSectionT } from "../../api/types";

interface SectionCardProps {
  section: DocSectionT;
  editing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSave: (body: string) => void;
}

/** One blueprint section: markdown in read mode, a plain textarea in edit mode
 *  (spec: per-section markdown IS the editor — proposals diff cleanly over text). */
export function SectionCard({ section, editing, onEdit, onCancel, onSave }: SectionCardProps) {
  const [draft, setDraft] = useState(section.body);
  if (!editing) {
    return (
      <section className="doc-section" aria-label={section.heading}>
        <header className="doc-section__head">
          <h3 className="doc-section__heading">{section.heading}</h3>
          <button type="button" className="doc-section__edit" aria-label={`edit ${section.heading}`} onClick={onEdit}>
            edit
          </button>
        </header>
        {section.body ? (
          <Markdown>{section.body}</Markdown>
        ) : (
          <p className="doc-section__empty">empty — press edit to write this section</p>
        )}
      </section>
    );
  }
  return (
    <section className="doc-section doc-section--editing" aria-label={section.heading}>
      <header className="doc-section__head">
        <h3 className="doc-section__heading">{section.heading}</h3>
      </header>
      <textarea
        aria-label={section.heading}
        className="doc-section__editor"
        rows={8}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
      <div className="doc-section__actions">
        <button type="button" className="doc-section__cancel" onClick={onCancel}>
          cancel
        </button>
        <button type="button" className="doc-section__save" onClick={() => onSave(draft)}>
          save
        </button>
      </div>
    </section>
  );
}
