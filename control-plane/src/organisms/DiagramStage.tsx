import { type ReactNode, useState } from "react";
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
  /** The session's staged-artifacts shelf, absolutely positioned over the stage's left edge. Built by the route. */
  shelf?: ReactNode;
  /** The workspace pin toggle, built by the route (spec: pin model v2). */
  pinControl?: ReactNode;
}

/**
 * The diagram surface: a full-bleed Mermaid canvas over an editable source
 * panel, with a same-family type switch. Deliberately chat-free — the app
 * shell owns the one persistent composer that docks beside every stage.
 */
export function DiagramStage({
  doc,
  blueprints,
  onChangeBlueprint,
  onSaveSection,
  shelf,
  pinControl,
}: DiagramStageProps) {
  const section = doc.sections[0];
  const [source, setSource] = useState(section?.body ?? "");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [view, setView] = useState<"canvas" | "markdown">("canvas");
  const [copied, setCopied] = useState(false);

  const fenced = `\`\`\`mermaid\n${source}\n\`\`\``;
  const copyMarkdown = () => {
    void navigator.clipboard.writeText(fenced).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    });
  };
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
      {shelf}
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
      {/* biome-ignore lint/a11y/useSemanticElements: a toolbar-style view toggle, not a form fieldset */}
      <div className="diagram-stage__views" role="group" aria-label="diagram view">
        <button
          type="button"
          className={`diagram-stage__type${view === "canvas" ? " diagram-stage__type--on" : ""}`}
          aria-pressed={view === "canvas"}
          onClick={() => setView("canvas")}
        >
          Canvas
        </button>
        <button
          type="button"
          className={`diagram-stage__type${view === "markdown" ? " diagram-stage__type--on" : ""}`}
          aria-pressed={view === "markdown"}
          onClick={() => setView("markdown")}
        >
          Markdown
        </button>
        {pinControl}
      </div>
      {view === "canvas" ? (
        // Canvas stands alone — the source lives on the Markdown tab.
        <div className="diagram-stage__canvas">
          <MermaidBlock code={source} />
        </div>
      ) : (
        // The markdown view is still the EDITOR — same source, same
        // blur-commit — plus a one-click copy of the fenced form.
        <div className="diagram-stage__markdown">
          <button
            type="button"
            className="diagram-stage__copy"
            aria-label="Copy Mermaid markdown"
            onClick={copyMarkdown}
          >
            copy
          </button>
          <textarea
            aria-label="Mermaid source"
            value={source}
            spellCheck={false}
            onChange={(e) => setSource(e.target.value)}
            onBlur={() => void commit()}
          />
        </div>
      )}
      {saved && <em className="diagram-stage__saved">saved</em>}
      {copied && <em className="diagram-stage__saved">copied</em>}
    </section>
  );
}
