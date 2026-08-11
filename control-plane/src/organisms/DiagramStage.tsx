import { useState } from "react";
import type { BlueprintT, DocT } from "../api/types";
import { MermaidBlock } from "../molecules/MermaidBlock";

export interface DiagramStageProps {
  /** A family:diagram document — its first section body is Mermaid text. */
  doc: DocT;
  /** Diagram blueprints only (the route filters); the type switch above the canvas. */
  blueprints?: BlueprintT[];
  /** Re-cast this diagram under another diagram blueprint. Offered only while empty. */
  onChangeBlueprint?: (blueprintId: string) => Promise<{ error?: string }>;
  /** Persist the edited Mermaid source. Commits on blur. */
  onSaveSection: (sectionId: string, body: string) => Promise<{ error?: string }>;
}

/**
 * The diagram surface: a full-bleed Mermaid canvas over an editable source
 * panel, with a same-family type switch. Deliberately chat-free — the app
 * shell owns the one persistent composer that docks beside every stage.
 */
export function DiagramStage({ doc, blueprints, onChangeBlueprint, onSaveSection }: DiagramStageProps) {
  const section = doc.sections[0];
  const [source, setSource] = useState(section?.body ?? "");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // A diagram with words pins its blueprint — the diagram blueprints share no
  // section ids, so re-casting drawn work would throw it away.
  const locked = doc.sections.some((s) => s.body.trim() !== "");

  const commit = async () => {
    if (!section) return;
    setSaveError(null);
    const r = await onSaveSection(section.id, source);
    if (r.error) {
      setSaveError(r.error);
      return;
    }
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1600);
  };

  return (
    <section className="stage diagram-stage" aria-label="Diagram">
      {onChangeBlueprint && blueprints && blueprints.length > 1 && (
        // biome-ignore lint/a11y/useSemanticElements: a toolbar-style toggle set above the canvas, not a form fieldset
        <div className="diagram-stage__types" role="group" aria-label="diagram type">
          {blueprints.map((b) => (
            <button
              key={b.id}
              type="button"
              className={`diagram-stage__type${b.id === doc.blueprintId ? " diagram-stage__type--on" : ""}`}
              aria-pressed={b.id === doc.blueprintId}
              disabled={locked && b.id !== doc.blueprintId}
              title={locked && b.id !== doc.blueprintId ? "this diagram already has content" : undefined}
              onClick={() => {
                if (b.id === doc.blueprintId) return;
                setSaveError(null);
                void onChangeBlueprint(b.id).then((r) => {
                  if (r.error) setSaveError(r.error);
                });
              }}
            >
              {b.name}
            </button>
          ))}
        </div>
      )}
      {saveError && (
        <p className="diagram-stage__error" role="status">
          {saveError}
        </p>
      )}
      <div className="diagram-stage__canvas">
        <MermaidBlock code={source} />
      </div>
      <textarea
        className="diagram-stage__source"
        aria-label="Mermaid source"
        value={source}
        spellCheck={false}
        onChange={(e) => setSource(e.target.value)}
        onBlur={() => void commit()}
      />
      {saved && <em className="diagram-stage__saved">saved</em>}
    </section>
  );
}
