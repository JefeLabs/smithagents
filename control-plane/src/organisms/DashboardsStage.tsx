import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { DASH_STEPS, DASH_SUGGESTIONS, type SavedDashboard, scopeHint } from "../data/dashboards";
import { DashboardAsk } from "./dashboards/DashboardAsk";
import { DashboardComposing } from "./dashboards/DashboardComposing";

type DashView = "ask" | "composing";
const STEP_MS = 620;

interface DashboardsStageProps {
  shelf?: ReactNode;
  /**
   * The compose walk finished — a dashboard was PRESENTED, so it becomes a
   * document (spec 2026-08-11): the route creates it and navigates to its
   * canvas. The stage never shows a board of its own anymore.
   */
  onPresent?: (question: string, scope: string) => void;
  /** Pinned dashboard docs, listed under SAVED — the route derives them. */
  savedDocs?: SavedDashboard[];
  /** Open a saved (pinned) dashboard's document. */
  onOpenSaved?: (docId: string) => void;
}

/**
 * The dashboards LAUNCHER — ask + compose walk. A composed dashboard is a
 * document (`/dashboard/$docId`); this stage hands off via `onPresent` the
 * moment the walk completes. Router-free like every organism.
 */
export function DashboardsStage({ shelf, onPresent, savedDocs, onOpenSaved }: DashboardsStageProps = {}) {
  const [view, setView] = useState<DashView>("ask");
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("all workspaces");
  const [step, setStep] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stop = useCallback(() => {
    if (timer.current !== null) {
      clearInterval(timer.current);
      timer.current = null;
    }
  }, []);
  useEffect(() => stop, [stop]);

  const submit = useCallback(
    (q: string) => {
      stop(); // a re-submit restarts the walk cleanly, never double-fires
      setQuery(q || DASH_SUGGESTIONS[0]);
      setStep(0);
      setView("composing");
      timer.current = setInterval(() => setStep((s) => s + 1), STEP_MS);
    },
    [stop],
  );

  // The interval only counts; the handoff lives here so the tick stays pure.
  useEffect(() => {
    if (view === "composing" && step >= DASH_STEPS.length) {
      stop();
      setView("ask");
      onPresent?.(query || DASH_SUGGESTIONS[0], scope);
    }
  }, [view, step, stop, onPresent, query, scope]);

  return (
    <section className="stage dashboards-stage" aria-label="Dashboards">
      {shelf}
      <header className="dashboards-stage__bar">
        <div className="dashboards-stage__title">dashboards</div>
        <span className="dashboards-stage__badge">AGENT COMPOSED</span>
        <div className="spacer" />
      </header>
      {view === "ask" && (
        <DashboardAsk
          scope={scope}
          saved={savedDocs ?? []}
          onScope={setScope}
          onSubmit={submit}
          onOpenSaved={onOpenSaved}
        />
      )}
      {view === "composing" && <DashboardComposing query={query} scopeHint={scopeHint(scope)} step={step} />}
    </section>
  );
}
