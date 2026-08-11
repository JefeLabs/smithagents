import { type ReactNode, useState } from "react";
import type { DocT } from "../api/types";
import { parseDashSpec } from "../lib/dashboardSpec";
import { DashboardBoard } from "./dashboards/DashboardBoard";

interface DashboardDocStageProps {
  /** A family:dashboard document — `question` + `spec` sections. */
  doc: DocT;
  /** Rename the dashboard. Commits on blur, like every title here. */
  onRename?: (title: string) => Promise<{ error?: string }>;
  /** The workspace pin toggle, built by the route (spec: pin model v2). */
  pinControl?: ReactNode;
  /** The session's staged-artifacts shelf. Built by the route. */
  shelf?: ReactNode;
}

/**
 * A presented dashboard IS a document (spec 2026-08-11): this canvas renders
 * its spec section through the dashboard presentation, with the question as
 * the subheader. An unparseable spec shows its raw source and says so — the
 * MermaidBlock rule: never blank.
 */
export function DashboardDocStage({ doc, onRename, pinControl, shelf }: DashboardDocStageProps) {
  const [titleDraft, setTitleDraft] = useState(doc.title);
  const [saveError, setSaveError] = useState<string | null>(null);
  const question = doc.sections.find((s) => s.id === "question")?.body ?? "";
  const specBody = doc.sections.find((s) => s.id === "spec")?.body ?? "";
  const spec = parseDashSpec(specBody);

  return (
    <section className="stage dashboards-stage" aria-label="Dashboard">
      {shelf}
      <header className="dashboards-stage__bar">
        {onRename ? (
          <input
            className="dashboard-doc__title"
            aria-label="Dashboard title"
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={() => {
              const next = titleDraft.trim();
              if (!next || next === doc.title) {
                setTitleDraft(doc.title);
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
          <div className="dashboards-stage__title">{doc.title}</div>
        )}
        {pinControl}
      </header>
      {saveError && (
        <p className="document-stage__error" role="status">
          {saveError}
        </p>
      )}
      {spec ? (
        <DashboardBoard spec={spec} query={question || doc.title} scopeHint="" onFollowup={() => {}} />
      ) : (
        <div className="dashboard-doc__fallback">
          <p role="status">spec didn’t parse — showing source</p>
          <pre>{specBody || "(empty spec section)"}</pre>
        </div>
      )}
    </section>
  );
}
