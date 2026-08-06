import { X } from "lucide-react";
import { useEffect, useState } from "react";
import type { ConnectorInstanceRecord, ConnectorVendorMeta } from "../../hooks/useBrokerChat";
import { ConnectorFormModal } from "./ConnectorFormModal";

interface IntegrationsGroupProps {
  listVendors: () => Promise<ConnectorVendorMeta[]>;
  listConnectors: () => Promise<ConnectorInstanceRecord[]>;
  // useBrokerChat's real addConnector/updateConnector resolve the full saved record (plus an
  // optional error), not just `{ error? }` — typed as Partial here so this component can drop
  // the saved instance straight into local state and avoid depending on a subsequent
  // listConnectors() round-trip to reflect the change.
  addConnector: (body: {
    vendorId: string;
    label: string;
    fields: Record<string, string>;
  }) => Promise<Partial<ConnectorInstanceRecord> & { error?: string }>;
  updateConnector: (
    id: string,
    body: { label?: string; fields?: Record<string, string> },
  ) => Promise<Partial<ConnectorInstanceRecord> & { error?: string }>;
  deleteConnector: (id: string) => Promise<{ ok?: boolean; error?: string }>;
  verifyConnector: (
    id: string,
    extra?: Record<string, string>,
  ) => Promise<{ ok?: boolean; detail?: string; error?: string }>;
}

/** Card grid, one per registered vendor — a vendor's saved instances list inline, "+ add another" opens the generic connect form. */
export function IntegrationsGroup({
  listVendors,
  listConnectors,
  addConnector,
  updateConnector,
  deleteConnector,
  verifyConnector,
}: IntegrationsGroupProps) {
  const [vendors, setVendors] = useState<ConnectorVendorMeta[]>([]);
  const [connectors, setConnectors] = useState<ConnectorInstanceRecord[]>([]);
  const [formVendor, setFormVendor] = useState<ConnectorVendorMeta | null>(null);
  const [formExisting, setFormExisting] = useState<ConnectorInstanceRecord | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-once load, same convention as ChannelsGroup's own mount effect
  useEffect(() => {
    void listVendors().then(setVendors, (err: unknown) => setLoadError(`Could not load vendors — ${String(err)}`));
    void listConnectors().then(setConnectors, (err: unknown) =>
      setLoadError(`Could not load connectors — ${String(err)}`),
    );
  }, []);

  const openConnect = (vendor: ConnectorVendorMeta, existing?: ConnectorInstanceRecord) => {
    setFormVendor(vendor);
    setFormExisting(existing);
  };

  const closeForm = () => {
    setFormVendor(null);
    setFormExisting(undefined);
  };

  const handleSave = async (body: { vendorId: string; label: string; fields: Record<string, string> }) => {
    const result = formExisting
      ? await updateConnector(formExisting.id, { label: body.label, fields: body.fields })
      : await addConnector(body);
    // Merge the saved record straight into local state so it shows up immediately — no
    // reliance on re-fetching listConnectors() to reflect a change that just happened.
    if (!result.error && result.id) {
      const saved: ConnectorInstanceRecord = {
        id: result.id,
        vendorId: result.vendorId ?? body.vendorId,
        label: result.label ?? body.label,
        // Never fall back to the raw submitted `body.fields` — those can carry plaintext
        // secrets straight from the form. The real backend always echoes a redacted `fields`
        // back, so this path is unreachable today; an empty object is the safe fallback if a
        // future response shape ever omits it, not a plaintext round-trip into client state.
        fields: result.fields ?? {},
      };
      setConnectors((cs) =>
        cs.some((c) => c.id === saved.id) ? cs.map((c) => (c.id === saved.id ? saved : c)) : [...cs, saved],
      );
    }
    return result;
  };

  const handleRemove = async (id: string) => {
    const result = await deleteConnector(id);
    if (result.error) {
      setRemoveError(result.error);
      return;
    }
    setRemoveError(null);
    setConnectors((cs) => cs.filter((c) => c.id !== id));
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
        onVerify={formExisting ? (extra) => verifyConnector(formExisting.id, extra) : undefined}
      />
    </>
  );
}
