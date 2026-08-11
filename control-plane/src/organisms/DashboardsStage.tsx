import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import {
  DASH_SAVED,
  DASH_STEPS,
  DASH_SUGGESTIONS,
  type SavedDashboard,
  savedMeta,
  scopeHint,
} from "../data/dashboards";
import { DashboardAsk } from "./dashboards/DashboardAsk";
import { DashboardBoard } from "./dashboards/DashboardBoard";
import { DashboardComposing } from "./dashboards/DashboardComposing";

type DashView = "ask" | "composing" | "board";
const STEP_MS = 620;

/**
 * The dashboards mock — spec 2026-08-10-dashboards-mock-design.md. Entirely
 * client-side: the state machine below is the whole "backend", and
 * data/dashboards.ts is the whole "payload". Router-free like every organism.
 */
export function DashboardsStage({ shelf }: { shelf?: ReactNode } = {}) {
  const [view, setView] = useState<DashView>("ask");
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("all workspaces");
  const [step, setStep] = useState(0);
  const [saved, setSaved] = useState<SavedDashboard[]>(DASH_SAVED);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const savedSeq = useRef(0);

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

  // The interval only counts; the view flip lives here so the tick stays pure.
  useEffect(() => {
    if (view === "composing" && step >= DASH_STEPS.length) {
      stop();
      setView("board");
    }
  }, [view, step, stop]);

  return (
    <section className="stage dashboards-stage" aria-label="Dashboards">
      {shelf}
      <header className="dashboards-stage__bar">
        <div className="dashboards-stage__title">dashboards</div>
        <span className="dashboards-stage__badge">AGENT COMPOSED</span>
        <div className="spacer" />
        {view === "board" && (
          <div className="dashboards-stage__actions">
            <button
              type="button"
              className="dash-btn"
              onClick={() => {
                stop();
                setQuery("");
                setStep(0);
                setView("ask");
              }}
            >
              new question
            </button>
            <button
              type="button"
              className="dash-btn dash-btn--primary"
              onClick={() =>
                setSaved((s) => [...s, { id: `saved-${savedSeq.current++}`, title: query, meta: savedMeta(scope) }])
              }
            >
              save dashboard
            </button>
          </div>
        )}
      </header>
      {view === "ask" && (
        <DashboardAsk scope={scope} saved={saved} onScope={setScope} onSubmit={submit} />
      )}
      {view === "composing" && <DashboardComposing query={query} scopeHint={scopeHint(scope)} step={step} />}
      {view === "board" && <DashboardBoard query={query} scopeHint={scopeHint(scope)} onFollowup={submit} />}
    </section>
  );
}
