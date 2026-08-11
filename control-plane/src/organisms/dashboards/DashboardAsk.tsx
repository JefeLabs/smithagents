import { DASH_SCOPES, DASH_SUGGESTIONS, type SavedDashboard } from "../../data/dashboards";

interface DashboardAskProps {
  scope: string;
  saved: SavedDashboard[];
  onScope: (scope: string) => void;
  /** Compose from a suggestion or a saved dashboard — free-typed asks go through the shared center dock (spec v3). */
  onSubmit: (query: string) => void;
}

export function DashboardAsk({ scope, saved, onScope, onSubmit }: DashboardAskProps) {
  return (
    <div className="dash-ask">
      <div className="dash-ask__inner">
        <div className="dash-ask__heading">what do you want to know?</div>
        <p className="dash-ask__sub">
          ask in plain language. the agent reads your workspaces and composes a dashboard of KPIs, charts and tables to
          answer it.
        </p>

        <div className="dash-ask__scopes" role="radiogroup" aria-label="Scope">
          <span className="dash-ask__label">SCOPE</span>
          {DASH_SCOPES.map((s) => (
            // biome-ignore lint/a11y/useSemanticElements: chip-styled radiogroup — a native input can't carry the pill styling, and role="radio"+aria-checked is the equivalent ARIA pattern
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
