import type { MouseEvent } from "react";
import { useEffect, useState } from "react";
import type { ConnectorInstanceRecord, ConnectorVendorMeta } from "../../api/types";

interface ConnectorFormModalProps {
  open: boolean;
  vendor: ConnectorVendorMeta | null;
  /** Present when editing/re-checking an already-saved instance; absent for a brand-new one. */
  existing?: ConnectorInstanceRecord;
  onClose: () => void;
  onSave: (body: { vendorId: string; label: string; fields: Record<string, string> }) => Promise<{ error?: string }>;
  onVerify?: (extra: Record<string, string>) => Promise<{ ok?: boolean; detail?: string; error?: string }>;
}

/** Generic per-vendor connect form: one input per vendor.fields, driven entirely by the registry — no vendor-specific JSX. */
export function ConnectorFormModal({ open, vendor, existing, onClose, onSave, onVerify }: ConnectorFormModalProps) {
  const [label, setLabel] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [extra, setExtra] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; detail: string } | null>(null);
  const [testing, setTesting] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: only re-seed when the modal opens on a (possibly different) vendor/instance
  useEffect(() => {
    if (!open) return;
    setLabel(existing?.label ?? "");
    // Secrets never round-trip — always start blank, same discipline as ChannelsGroup's
    // botToken. But a controlled <select> (Datadog's site, Snyk's region) can't render
    // "blank": it always resolves to its first option, so blanking those too would silently
    // display the wrong saved value on every edit-open. Seed non-secret fields from the saved
    // instance instead; only secrets start blank.
    setFields(
      existing
        ? Object.fromEntries(
            (vendor?.fields ?? []).filter((f) => !f.secret).map((f) => [f.key, String(existing.fields[f.key] ?? "")]),
          )
        : {},
    );
    setExtra({});
    setError(null);
    setTestResult(null);
  }, [open, vendor?.id, existing?.id]);

  if (!open || !vendor) return null;

  const submit = async () => {
    setBusy(true);
    setError(null);
    const result = await onSave({ vendorId: vendor.id, label: label.trim(), fields }).catch(
      (err: unknown): { error?: string } => ({
        error: String(err),
      }),
    );
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    onClose();
  };

  const runVerify = async () => {
    if (!onVerify) return;
    setTesting(true);
    const r = await onVerify(extra);
    setTesting(false);
    setTestResult({ ok: Boolean(r.ok), detail: r.detail ?? r.error ?? "unknown" });
  };

  const onScrimClick = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: click-outside dismiss, same pattern as WorkspaceManagerModal
    <div
      className="scrim"
      data-open="true"
      role="dialog"
      aria-modal="true"
      aria-label={`Connect ${vendor.label}`}
      onClick={onScrimClick}
    >
      <section className="account-panel">
        <header className="workspace-manager__head">
          <h2>
            {existing ? `edit ${vendor.label.toLowerCase()} connection` : `connect ${vendor.label.toLowerCase()}`}
          </h2>
        </header>
        <div className="account-panel__form">
          <label>
            Label
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Label (e.g. personal, acme-corp)"
            />
          </label>
          {vendor.fields.map((f) => (
            // biome-ignore lint/a11y/noLabelWithoutControl: control is the select/input rendered by the ternary below
            <label key={f.key}>
              {f.label}
              {f.type === "select" ? (
                <select
                  value={fields[f.key] ?? f.options?.[0]?.value ?? ""}
                  onChange={(e) => setFields((s) => ({ ...s, [f.key]: e.target.value }))}
                >
                  {f.options?.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type={f.secret ? "password" : "text"}
                  value={fields[f.key] ?? ""}
                  onChange={(e) => setFields((s) => ({ ...s, [f.key]: e.target.value }))}
                  placeholder={f.label}
                />
              )}
            </label>
          ))}

          {vendor.verifyExtraFields.length > 0 && (
            <>
              <span className="wizard__hint">Used only to test this connection — not saved</span>
              {vendor.verifyExtraFields.map((f) => (
                <input
                  key={f.key}
                  value={extra[f.key] ?? ""}
                  onChange={(e) => setExtra((s) => ({ ...s, [f.key]: e.target.value }))}
                  placeholder={f.label}
                />
              ))}
            </>
          )}

          {existing && onVerify && (
            <button type="button" className="settings-btn" onClick={() => void runVerify()} disabled={testing}>
              {testing ? "testing…" : "Re-check"}
            </button>
          )}
          {testResult && <p className={testResult.ok ? "wizard__hint" : "wizard__error"}>{testResult.detail}</p>}

          {error && <p className="wizard__error">{error}</p>}

          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="settings-btn" onClick={onClose} disabled={busy}>
              cancel
            </button>
            <button
              type="button"
              className="settings-btn settings-btn--primary settings-btn--wide"
              onClick={() => void submit()}
              disabled={busy || !label.trim()}
            >
              {busy ? "saving…" : existing ? "save changes" : "connect"}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
