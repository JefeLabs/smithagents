import { ArrowRight } from "lucide-react";
import { useState } from "react";
import { DASH_SCOPES, DASH_SUGGESTIONS, type SavedDashboard } from "../../data/dashboards";

interface DashboardAskProps {
  scope: string;
  saved: SavedDashboard[];
  scopeHint: string;
  onScope: (scope: string) => void;
  /** Submit the typed draft; "" lets the stage fall back to the first suggestion. */
  onSubmit: (query: string) => void;
}

export function DashboardAsk({ scope, saved, scopeHint, onScope, onSubmit }: DashboardAskProps) {
  // The draft is local: the stage only cares at submit time, and a keystroke
  // re-render of the whole stage would be noise.
  const [draft, setDraft] = useState("");
  return (
    <div className="dash-ask">
      <div className="dash-ask__inner">
        <div className="dash-ask__heading">what do you want to know?</div>
        <p className="dash-ask__sub">
          ask in plain language. the agent reads your workspaces and composes a dashboard of KPIs, charts and tables
          to answer it.
        </p>

        <div className="dash-ask__scopes" role="radiogroup" aria-label="Scope">
          <span className="dash-ask__label">SCOPE</span>
          {DASH_SCOPES.map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={s === scope}
              className={`dash-chip ${s === scope ? "dash-chip--active" : ""}`}
              onClick={() => onScope(s)}
            >
              {s}
            </button>
          ))}
        </div>

        <div className="dash-ask__box">
          <textarea
            rows={2}
            value={draft}
            aria-label="Dashboard question"
            placeholder="e.g. where is delivery slipping across the release group this quarter?"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSubmit(draft.trim());
              }
            }}
          />
          <div className="dash-ask__boxrow">
            <span className="dash-ask__hint">{scopeHint}</span>
            <button type="button" className="dash-btn dash-btn--primary" onClick={() => onSubmit(draft.trim())}>
              compose <ArrowRight size={13} aria-hidden="true" />
            </button>
          </div>
        </div>

        <div className="dash-ask__label">TRY</div>
        <div className="dash-ask__suggestions">
          {DASH_SUGGESTIONS.map((q) => (
            <button key={q} type="button" className="dash-ask__suggestion" onClick={() => onSubmit(q)}>
              {q}
            </button>
          ))}
        </div>

        <div className="dash-ask__label">SAVED</div>
        <div className="dash-ask__saved">
          {saved.map((d) => (
            <button key={d.id} type="button" className="dash-saved-card" onClick={() => onSubmit(d.title)}>
              <span className="dash-saved-card__title">{d.title}</span>
              <span className="dash-saved-card__meta">{d.meta}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
