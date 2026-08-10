import { Resizable } from "@heroui-pro/react/resizable";
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
  /** The docked chat column — composed by the route, the stage stays router- and store-free. */
  chat: ReactNode;
}

/** The pair/mob surface: document center, chat right (spec 2026-08-10, phase 1 = solo). */
export function DocumentStage({
  doc,
  onSaveSection,
  blueprints,
  onChangeBlueprint,
  onRename,
  chat,
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
      <Resizable className="document-stage__split">
        <Resizable.Panel defaultSize={70} minSize={45} className="document-stage__doc">
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
              {doc.sections.map((s) => (
                <SectionCard
                  key={editingId === s.id ? `${s.id}-editing` : s.id}
                  section={s}
                  hint={hintFor(s.id)}
                  editing={editingId === s.id}
                  onEdit={() => {
                    setSaveError(null);
                    setEditingId(s.id);
                  }}
                  onCancel={() => setEditingId(null)}
                  onSave={(body) => void save(s.id, body)}
                />
              ))}
            </div>
          </motion.div>
        </Resizable.Panel>
        <Resizable.Handle />
        <Resizable.Panel defaultSize={30} minSize={20} className="document-stage__chat">
          <motion.div
            className="document-stage__dock-rise"
            initial={reduceMotion ? false : { opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.25, ease: "easeOut" }}
          >
            {chat}
          </motion.div>
        </Resizable.Panel>
      </Resizable>
    </section>
  );
}
