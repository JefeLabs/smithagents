import type { MouseEvent } from "react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
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

interface ConnectorFormValues {
  label: string;
  fields: Record<string, string>;
  /** Verify-only inputs — a separate branch so they can never leak into the saved `fields`. */
  extra: Record<string, string>;
}

/** Generic per-vendor connect form: one input per vendor.fields, driven entirely by the registry — no vendor-specific JSX. */
export function ConnectorFormModal({ open, vendor, existing, onClose, onSave, onVerify }: ConnectorFormModalProps) {
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; detail: string } | null>(null);
  const [testing, setTesting] = useState(false);

  // mode: "onChange" because the save button gates on isValid — under RHF's default
  // onSubmit mode isValid stays false until the first submit, which would disable
  // the only button that can produce one.
  const {
    register,
    handleSubmit,
    reset,
    getValues,
    formState: { isValid, isSubmitting },
  } = useForm<ConnectorFormValues>({
    mode: "onChange",
    defaultValues: { label: "", fields: {}, extra: {} },
  });

  // This modal never unmounts — IntegrationsGroup renders it with an `open` prop — so
  // reopening on a different vendor/instance has to re-seed explicitly; useForm's
  // per-mount defaults never run again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only re-seed when the modal opens on a (possibly different) vendor/instance
  useEffect(() => {
    if (!open) return;
    reset({
      label: existing?.label ?? "",
      // Secrets never round-trip — always start blank, same discipline as ChannelsGroup's
      // botToken. But a <select> (Datadog's site, Snyk's region) can't render "blank": it
      // always resolves to its first option, so blanking those too would silently display
      // the wrong saved value on every edit-open. Seed non-secret fields from the saved
      // instance instead; only secrets start blank.
      fields: existing
        ? Object.fromEntries(
            (vendor?.fields ?? []).filter((f) => !f.secret).map((f) => [f.key, String(existing.fields[f.key] ?? "")]),
          )
        : {},
      extra: {},
    });
    setError(null);
    setTestResult(null);
  }, [open, vendor?.id, existing?.id]);

  if (!open || !vendor) return null;

  const submit = handleSubmit(async (values) => {
    setError(null);
    const result = await onSave({
      vendorId: vendor.id,
      label: values.label.trim(),
      fields: values.fields,
    }).catch((err: unknown): { error?: string } => ({
      error: String(err),
    }));
    if (result.error) {
      setError(result.error);
      return;
    }
    onClose();
  });

  const runVerify = async () => {
    if (!onVerify) return;
    setTesting(true);
    const r = await onVerify(getValues("extra"));
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
            {/* `required` would accept whitespace; the gate this replaces was `!label.trim()`. */}
            <input
              {...register("label", { validate: (v) => v.trim().length > 0 })}
              placeholder="Label (e.g. personal, acme-corp)"
            />
          </label>
          {vendor.fields.map((f) => (
            // biome-ignore lint/a11y/noLabelWithoutControl: control is the select/input rendered by the ternary below
            <label key={f.key}>
              {f.label}
              {f.type === "select" ? (
                <select {...register(`fields.${f.key}`)}>
                  {f.options?.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input {...register(`fields.${f.key}`)} type={f.secret ? "password" : "text"} placeholder={f.label} />
              )}
            </label>
          ))}

          {vendor.verifyExtraFields.length > 0 && (
            <>
              <span className="wizard__hint">Used only to test this connection — not saved</span>
              {vendor.verifyExtraFields.map((f) => (
                <input key={f.key} {...register(`extra.${f.key}`)} placeholder={f.label} />
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
            <button type="button" className="settings-btn" onClick={onClose} disabled={isSubmitting}>
              cancel
            </button>
            <button
              type="button"
              className="settings-btn settings-btn--primary settings-btn--wide"
              onClick={() => void submit()}
              disabled={isSubmitting || !isValid}
            >
              {isSubmitting ? "saving…" : existing ? "save changes" : "connect"}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
