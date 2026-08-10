import { Markdown } from "@heroui-pro/react/markdown";
import type { DocSectionT } from "../../api/types";
import { SectionEditor } from "./SectionEditor";

interface SectionCardProps {
  section: DocSectionT;
  /** Author guidance from the blueprint, shown as ghost text in an empty section. */
  hint?: string;
  editing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  /** Blur commits — a document has no save button. */
  onSave: (body: string) => void;
}

/**
 * One section of the page. Read mode renders markdown; clicking the prose puts a
 * cursor in it at the same size and position, so nothing jumps. There is no edit
 * button and no save button: blur commits, Escape abandons (spec 2026-08-10 —
 * "editing should feel like editing a document, not filling a form").
 */
export function SectionCard({ section, hint, editing, onEdit, onCancel, onSave }: SectionCardProps) {
  return (
    <section className="doc-section" aria-label={section.heading}>
      <h3 className="doc-section__heading">{section.heading}</h3>
      {editing ? (
        <SectionEditor
          body={section.body}
          ariaLabel={section.heading}
          placeholder={hint}
          onCommit={onSave}
          onAbandon={onCancel}
        />
      ) : (
        // The whole prose block is the affordance — a11y still needs a name and a
        // keyboard path, which is what the role and handlers below provide.
        // biome-ignore lint/a11y/useSemanticElements: a button would inherit button typography and semantics; this is a text region you place a cursor in
        <div
          className={`doc-section__body${section.body ? "" : " doc-section__body--empty"}`}
          role="button"
          tabIndex={0}
          aria-label={`edit ${section.heading}`}
          onClick={onEdit}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onEdit();
            }
          }}
        >
          {section.body ? <Markdown>{section.body}</Markdown> : <p className="doc-section__hint">{hint}</p>}
        </div>
      )}
    </section>
  );
}
