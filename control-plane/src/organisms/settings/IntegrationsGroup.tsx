import { X } from "lucide-react";
import { useState } from "react";
import type { ConnectorInstanceRecord, ConnectorVendorMeta } from "../../api/types";
import {
  useAddConnector,
  useConnectorVendors,
  useDeleteConnector,
  useMyConnectors,
  useUpdateConnector,
  useVerifyConnector,
  useVoiceSettings,
} from "../../queries/http";
import { ConnectorFormModal } from "./ConnectorFormModal";

/** Card grid, one per registered vendor — a vendor's saved instances list inline, "+ add another" opens the generic connect form. */
export function IntegrationsGroup() {
  const { data: vendors = [], error: vendorsError } = useConnectorVendors();
  const { data: connectors = [], error: connectorsError } = useMyConnectors();
  const { data: voice } = useVoiceSettings();
  const addConnector = useAddConnector();
  const updateConnector = useUpdateConnector();
  const deleteConnector = useDeleteConnector();
  const verifyConnector = useVerifyConnector();

  const [formVendor, setFormVendor] = useState<ConnectorVendorMeta | null>(null);
  const [formExisting, setFormExisting] = useState<ConnectorInstanceRecord | undefined>(undefined);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const loadError = vendorsError
    ? `Could not load vendors — ${String(vendorsError)}`
    : connectorsError
      ? `Could not load connectors — ${String(connectorsError)}`
      : null;

  const openConnect = (vendor: ConnectorVendorMeta, existing?: ConnectorInstanceRecord) => {
    setFormVendor(vendor);
    setFormExisting(existing);
  };

  const closeForm = () => {
    setFormVendor(null);
    setFormExisting(undefined);
  };

  const handleSave = async (body: { vendorId: string; label: string; fields: Record<string, string> }) => {
    // Both mutations invalidate `qk.myConnectors` on success, so the new/updated instance
    // reflects here via the shared query cache — no local merge to hand-roll.
    return formExisting
      ? await updateConnector.mutateAsync({ id: formExisting.id, body: { label: body.label, fields: body.fields } })
      : await addConnector.mutateAsync(body);
  };

  const handleRemove = async (id: string) => {
    if (voice) {
      const uses = [
        voice.stt?.instanceId === id && "speech-to-text",
        voice.tts?.instanceId === id && "text-to-speech",
      ].filter(Boolean);
      if (uses.length > 0 && !window.confirm(`Deleting this key also turns off ${uses.join(" and ")}. Continue?`)) {
        return;
      }
    }
    const result = await deleteConnector.mutateAsync(id);
    if (result.error) {
      setRemoveError(result.error);
      return;
    }
    setRemoveError(null);
  };

  // Mirrors server.ts's redactConnector key-naming (has<Field>) so a saved secret's presence
  // flag can be looked up here without re-deriving the convention differently on each side.
  const hasFieldKey = (key: string) => `has${key.charAt(0).toUpperCase()}${key.slice(1)}`;

  // "Connected" means verify would actually succeed on credential-completeness grounds: every
  // secret field the vendor declares is present, not just any one of them (some(v === true)
  // would call a Datadog connector "connected" with an apiKey but no appKey).
  const isConnected = (vendor: ConnectorVendorMeta, inst: ConnectorInstanceRecord): boolean => {
    const secretFields = vendor.fields.filter((f) => f.secret);
    if (secretFields.length === 0) return false;
    return secretFields.every((f) => inst.fields[hasFieldKey(f.key)] === true);
  };

  return (
    <>
      <h1>integrations</h1>
      {loadError && <p className="wizard__error">{loadError}</p>}
      {removeError && <p className="wizard__error">{removeError}</p>}
      <div className="connector-grid">
        {vendors.map((vendor) => {
          const instances = connectors.filter((c) => c.vendorId === vendor.id);
          return (
            <div key={vendor.id} className="connector-card">
              <div className="connector-card__head">
                <b>{vendor.label}</b>
                <em>{vendor.description}</em>
              </div>
              {instances.map((inst) => (
                <div key={inst.id} className="connector-instance">
                  <span
                    className={`connector-status ${isConnected(vendor, inst) ? "connector-status--connected" : "connector-status--unconnected"}`}
                  >
                    {isConnected(vendor, inst) ? "connected" : "not connected"}
                  </span>
                  <span>{inst.label}</span>
                  <button type="button" className="settings-btn" onClick={() => openConnect(vendor, inst)}>
                    edit
                  </button>
                  <button
                    type="button"
                    className="repo-row__remove"
                    onClick={() => void handleRemove(inst.id)}
                    aria-label={`Remove ${inst.label}`}
                  >
                    <X size={12} strokeWidth={2} />
                  </button>
                </div>
              ))}
              <button type="button" className="settings-btn settings-btn--wide" onClick={() => openConnect(vendor)}>
                {instances.length > 0 ? "+ add another" : `Connect ${vendor.label}`}
              </button>
            </div>
          );
        })}
      </div>
      <ConnectorFormModal
        open={formVendor !== null}
        vendor={formVendor}
        existing={formExisting}
        onClose={closeForm}
        onSave={handleSave}
        onVerify={formExisting ? (extra) => verifyConnector.mutateAsync({ id: formExisting.id, extra }) : undefined}
      />
    </>
  );
}
