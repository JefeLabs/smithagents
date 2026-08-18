import type { ReactNode } from "react";

export interface ConnectorCardProps {
  label: string;
  /** Optional subtitle beside the label — CliToolsGroup's `note` is genuinely
      optional (omitted when falsy); ApiKeysGroup's `description` is always
      present in practice, so passing it here renders the same `<em>` either
      way. */
  note?: string;
  pill: { label: string; cls: string };
  /** The status line under the pill — callers compute the exact same string
      they always have (version/id plus an optional ` — {detail}` suffix). */
  line: string;
  lastCheckedAt?: string | null;
  /** Everything below the standard head/status/last-checked block — the
      per-screen part (guidance, an input, action buttons). The ONLY part
      that ever differed between CliToolsGroup and ApiKeysGroup. */
  children?: ReactNode;
}

/**
 * The card both Settings groups (CliToolsGroup, ApiKeysGroup) already
 * rendered inline, byte-identically — extracted so the subscriptions wizard
 * step can reuse the CARD without dragging in either screen's page chrome
 * (heading, refresh-all button, section framing), which reads wrong inside a
 * wizard step. See `.connector-card`/`.connector-instance` etc. in
 * components.css for the styling this markup is keyed to.
 */
export function ConnectorCard({ label, note, pill, line, lastCheckedAt, children }: ConnectorCardProps) {
  return (
    <div className="connector-card">
      <div className="connector-card__head">
        <b>{label}</b>
        {note && <em>{note}</em>}
      </div>
      <div className="connector-instance">
        <span className={`connector-status ${pill.cls}`}>{pill.label}</span>
        <span>{line}</span>
      </div>
      {lastCheckedAt && <p className="wizard__hint">last checked {new Date(lastCheckedAt).toLocaleString()}</p>}
      {children}
    </div>
  );
}
