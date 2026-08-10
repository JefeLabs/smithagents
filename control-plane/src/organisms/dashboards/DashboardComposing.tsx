import { DASH_STEPS } from "../../data/dashboards";

interface DashboardComposingProps {
  query: string;
  scopeHint: string;
  /** Index of the step currently running; steps below it render as done. */
  step: number;
}

/** The fake agent at work — four steps and a sweep. Stateless: the stage's interval drives `step`. */
export function DashboardComposing({ query, scopeHint, step }: DashboardComposingProps) {
  return (
    <div className="dash-composing">
      <div className="dash-composing__inner">
        <div className="dash-composing__query">{query}</div>
        <div className="dash-composing__hint">{scopeHint}</div>
        <ol className="dash-composing__steps">
          {DASH_STEPS.map((label, i) => (
            <li
              key={label}
              className={`dash-composing__step ${
                i < step ? "dash-composing__step--done" : i === step ? "dash-composing__step--active" : ""
              }`}
            >
              <span className="dash-composing__dot" aria-hidden="true" />
              {label}
            </li>
          ))}
        </ol>
        <div className="dash-composing__track" role="progressbar" aria-label="composing dashboard">
          <div className="dash-composing__sweep" />
        </div>
      </div>
    </div>
  );
}
