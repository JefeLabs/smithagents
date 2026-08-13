import { type ReactNode, useState } from "react";
import type { DocT, GroupT } from "../api/types";
import { useRangeBounds } from "../hooks/useRangeBounds";
import { summarizeBoards } from "../lib/boardSummary";
import { type DashSpec, parseDashSpec, parseScopeName } from "../lib/dashboardSpec";
import { formatBounds } from "../lib/dateRange";
import { useGroups } from "../queries/pushed";
import { useBoards } from "../queries/work";
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

const NO_GROUPS: GroupT[] = [];

/**
 * A presented dashboard IS a document (spec 2026-08-11), and since the
 * real-dashboards spec (2026-08-13) a HYBRID one: the stats half (KPIs,
 * charts, table) is computed LIVE from the boards in the doc's scope × the
 * CURRENT date range — switch the range and the numbers move — while the
 * prose half (`summary`, `texts`) still comes from the persisted spec fence,
 * where chat and agent edits land. The fence's own stats are ignored here;
 * they only matter to the ask-screen mock.
 */
export function DashboardDocStage({ doc, onRename, pinControl, shelf }: DashboardDocStageProps) {
  const [titleDraft, setTitleDraft] = useState(doc.title);
  const [saveError, setSaveError] = useState<string | null>(null);
  const boardsQuery = useBoards();
  const { data: groups = NO_GROUPS } = useGroups();
  const rangeBounds = useRangeBounds();
  const question = doc.sections.find((s) => s.id === "question")?.body ?? "";
  const specBody = doc.sections.find((s) => s.id === "spec")?.body ?? "";
  const fence = parseDashSpec(specBody);

  // The doc's WHERE: a group name expands to its member workspaces (live, so
  // membership edits follow); anything else is taken as one workspace's name;
  // "all workspaces"/absent = null (every workspace).
  const scopeName = parseScopeName(question);
  const scopeWorkspaces =
    scopeName === null ? null : (groups.find((g) => g.name === scopeName)?.expansion ?? [scopeName]);
  // Boards still loading → zeroed stats rather than a blank stage; the frame
  // lands and the numbers fill in.
  const boards = boardsQuery.data?.boards ?? [];
  const live = summarizeBoards(boards, scopeWorkspaces, rangeBounds, new Date());
  const spec: DashSpec = {
    summary: fence?.summary ?? "",
    texts: fence?.texts,
    kpis: live.kpis,
    charts: [
      {
        kind: "line",
        title: "activity over the window",
        data: { labels: live.line.labels, series: [{ name: "touched", values: live.line.values }] },
      },
      {
        kind: "bars",
        title: "where work is sitting",
        data: {
          labels: live.bars.map((b) => b.label),
          series: [{ name: "cards", values: live.bars.map((b) => b.value) }],
        },
      },
    ],
    table: live.table,
  };
  const scopeHint = `${scopeName ?? "all workspaces"}${rangeBounds ? ` · ${formatBounds(rangeBounds, new Date())}` : ""}`;

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
      {/* Stats render regardless of the fence — it only carries prose now.
          A present-but-unparseable fence still gets called out with its
          source below (never silently dropped words). */}
      <DashboardBoard spec={spec} query={question || doc.title} scopeHint={scopeHint} onFollowup={() => {}} />
      {!fence && specBody.trim() !== "" && (
        <div className="dashboard-doc__fallback">
          <p role="status">spec didn’t parse — showing source</p>
          <pre>{specBody}</pre>
        </div>
      )}
    </section>
  );
}
