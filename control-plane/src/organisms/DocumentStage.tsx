import { motion, useReducedMotion } from "motion/react";
import { type ReactNode, useState } from "react";
import type { BlueprintT, DocT } from "../api/types";
import { SectionCard } from "./document/SectionCard";

interface DocumentStageProps {
  doc: DocT;
  onSaveSection: (sectionId: string, body: string) => Promise<{ error?: string }>;
  /** Every blueprint the broker offers — the type switch above the document. */
  blueprints?: BlueprintT[];
  /** Re-cast this document under another blueprint. Only offered while it is still empty. */
  onChangeBlueprint?: (blueprintId: string) => Promise<{ error?: string }>;
  /** Rename the page. The H1 commits on blur, like every other line here. */
  onRename?: (title: string) => Promise<{ error?: string }>;
  /** The session's staged-artifacts shelf, absolutely positioned over the stage's left edge. Built by the route. */
  shelf?: ReactNode;
  /** Aim the next dock send at a section — the route wires this to the composer's target chip. */
  onAimSection?: (sectionId: string, heading: string) => void;
  /** The currently aimed section — outlined so the prompt's target area is visible. */
  aimedSectionId?: string;
  /** Sticky-note decisions (spec: dock-sends-edit-artifact). Resolve to the broker's refusal text or null. */
  onAcceptProposal?: (proposalId: string) => Promise<string | null>;
  onRejectProposal?: (proposalId: string) => Promise<string | null>;
}

/**
 * The document surface: the page, full-width. Chat is NOT here — the shell's one
 * persistent ChatDock docks beside every stage (dock variant on /doc), so the
 * document stage stays router- and store-free and carries only the page.
 */
export function DocumentStage({
  doc,
  onSaveSection,
  blueprints,
  onChangeBlueprint,
  onRename,
  shelf,
  onAimSection,
  aimedSectionId,
  onAcceptProposal,
  onRejectProposal,
}: DocumentStageProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  // The quiet confirmation that replaces a save button.
  const [saved, setSaved] = useState(false);
  const [titleDraft, setTitleDraft] = useState(doc.title);
  // Written work pins the blueprint — see the switch below.
  const locked = doc.sections.some((s) => s.body.trim() !== "");
  const reduceMotion = useReducedMotion();
  // Blueprint hints become the ghost text of an empty section.
  const hintFor = (sectionId: string) =>
    blueprints?.find((b) => b.id === doc.blueprintId)?.sections?.find((x) => x.id === sectionId)?.hint;

  const save = async (sectionId: string, body: string) => {
    setSaveError(null);
    const r = await onSaveSection(sectionId, body);
    if (r.error) {
      setSaveError(r.error);
      return; // stay in edit mode; the draft lives in the still-mounted card
    }
    setEditingId(null);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1600);
  };

  return (
    <section className="stage document-stage" aria-label="Document">
      {shelf}
      <div className="document-stage__doc">
        <motion.div
          className="document-stage__rise"
          initial={reduceMotion ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25, ease: "easeOut" }}
        >
          <header className="document-stage__bar">
            {onRename ? (
              <input
                className="document-stage__title"
                aria-label="Document title"
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={() => {
                  const next = titleDraft.trim();
                  if (!next || next === doc.title) {
                    setTitleDraft(doc.title); // a blank title is not a rename
                    return;
                  }
                  void onRename(next).then((r) => {
                    if (r.error) {
                      setSaveError(r.error);
                      setTitleDraft(doc.title);
                    }
                  });
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                  if (e.key === "Escape") {
                    setTitleDraft(doc.title);
                    e.currentTarget.blur();
                  }
                }}
              />
            ) : (
              <h1 className="document-stage__title">{doc.title}</h1>
            )}
            <span className="document-stage__meta">
              {doc.workType} · {doc.status}
              {saved && <em className="document-stage__saved">saved</em>}
            </span>
          </header>
          {onChangeBlueprint && blueprints && blueprints.length > 1 && (
            // The type switch sits ON the document, not in the composer: this is
            // where you see what the blueprint gave you and can still change your
            // mind. It locks the moment the document has words — the blueprints
            // share no section ids, so re-casting written work would destroy it.
            // biome-ignore lint/a11y/useSemanticElements: a toolbar-style toggle set above the page, not a form fieldset
            <div className="document-stage__types" role="group" aria-label="document type">
              {blueprints.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  className={`document-stage__type${b.id === doc.blueprintId ? " document-stage__type--on" : ""}`}
                  aria-pressed={b.id === doc.blueprintId}
                  disabled={locked && b.id !== doc.blueprintId}
                  title={locked && b.id !== doc.blueprintId ? "this document already has content" : undefined}
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
            <p className="document-stage__error" role="status">
              {saveError}
            </p>
          )}
          <div className="document-stage__sections">
            {doc.sections.map((s) => {
              const open = (doc.proposals ?? []).filter((p) => p.sectionId === s.id && p.state === "open");
              return (
                <div key={s.id} className="document-stage__section-slot">
                  {open.length > 0 && (
                    // Several agents on one section pile up rather than burying the
                    // prose — hover or keyboard focus fans the stack out.
                    // biome-ignore lint/a11y/useSemanticElements: a labelled pile of notes; role="group" names the count for AT and tests
                    <div
                      className="sticky-stack"
                      role="group"
                      data-count={open.length}
                      aria-label={`${open.length} suggestion${open.length === 1 ? "" : "s"} on ${s.heading}`}
                    >
                      {open.map((p) => (
                        // biome-ignore lint/a11y/useSemanticElements: a labelled sticky note, not flowing prose — role="note" names it for AT and tests
                        <aside
                          key={p.id}
                          className="sticky-note"
                          role="note"
                          aria-label={`suggestion from ${p.agentId}`}
                        >
                          <span className="sticky-note__agent">{p.agentId}</span>
                          <span className="sticky-note__rationale">{p.rationale}</span>
                          <p className="sticky-note__preview">{p.newBody.slice(0, 240)}</p>
                          <div className="sticky-note__actions">
                            <button
                              type="button"
                              onClick={() => {
                                setSaveError(null);
                                void onAcceptProposal?.(p.id).then((e) => e && setSaveError(e));
                              }}
                            >
                              Accept
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setSaveError(null);
                                void onRejectProposal?.(p.id).then((e) => e && setSaveError(e));
                              }}
                            >
                              Dismiss
                            </button>
                          </div>
                        </aside>
                      ))}
                    </div>
                  )}
                  <SectionCard
                    key={editingId === s.id ? `${s.id}-editing` : s.id}
                    section={s}
                    hint={hintFor(s.id)}
                    onAim={onAimSection ? () => onAimSection(s.id, s.heading) : undefined}
                    aimed={s.id === aimedSectionId}
                    editing={editingId === s.id}
                    onEdit={() => {
                      setSaveError(null);
                      setEditingId(s.id);
                    }}
                    onCancel={() => setEditingId(null)}
                    onSave={(body) => void save(s.id, body)}
                  />
                </div>
              );
            })}
          </div>
        </motion.div>
      </div>
    </section>
  );
}
