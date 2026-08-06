import { ArrowLeft, Blocks, MessageSquare, Palette, Settings as SettingsIcon } from "lucide-react";
import { useState } from "react";
import type {
  ChannelsRecord,
  ConnectorInstanceRecord,
  ConnectorVendorMeta,
  WorkspaceRecord,
} from "../hooks/useBrokerChat";
import type { ThemeId } from "../hooks/useTheme";
import { ChannelsGroup } from "./settings/ChannelsGroup";
import { GeneralGroup, type ResetScope } from "./settings/GeneralGroup";
import { IntegrationsGroup } from "./settings/IntegrationsGroup";
import { ThemesGroup } from "./settings/ThemesGroup";

export type SettingsGroupId = "general" | "integrations" | "channels" | "themes";

interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
  onReset: (scope: ResetScope) => Promise<{ ok?: boolean; error?: string; swarm?: unknown }>;
  theme: ThemeId;
  onThemeChange: (theme: ThemeId) => void;
  initialGroup?: SettingsGroupId;
  listConnectorVendors?: () => Promise<ConnectorVendorMeta[]>;
  listMyConnectors?: () => Promise<ConnectorInstanceRecord[]>;
  addConnector?: (body: {
    vendorId: string;
    label: string;
    fields: Record<string, string>;
  }) => Promise<{ error?: string }>;
  updateConnector?: (
    id: string,
    body: { label?: string; fields?: Record<string, string> },
  ) => Promise<{ error?: string }>;
  deleteConnector?: (id: string) => Promise<{ ok?: boolean; error?: string }>;
  verifyConnector?: (
    id: string,
    extra?: Record<string, string>,
  ) => Promise<{ ok?: boolean; detail?: string; error?: string }>;
  listWorkspaceRecords?: () => Promise<WorkspaceRecord[]>;
  getWorkspaceChannels?: (name: string) => Promise<ChannelsRecord>;
  saveWorkspaceChannels?: (
    name: string,
    body: { discord?: { botToken: string; textChannels: string[]; voiceChannels: string[] } },
  ) => Promise<ChannelsRecord & { error?: string }>;
  verifyWorkspaceDiscord?: (name: string) => Promise<{ ok?: boolean; detail?: string; error?: string }>;
}

const GROUPS: Array<{ id: SettingsGroupId; label: string; icon: typeof SettingsIcon }> = [
  { id: "general", label: "General", icon: SettingsIcon },
  { id: "integrations", label: "Integrations", icon: Blocks },
  { id: "channels", label: "Channels", icon: MessageSquare },
  { id: "themes", label: "Themes", icon: Palette },
];

/** Full-screen settings: General / Integrations / Channels / Themes. Replaces the old small anchored popover. */
export function SettingsPanel({
  open,
  onClose,
  onReset,
  theme,
  onThemeChange,
  initialGroup = "general",
  listConnectorVendors,
  listMyConnectors,
  addConnector,
  updateConnector,
  deleteConnector,
  verifyConnector,
  listWorkspaceRecords,
  getWorkspaceChannels,
  saveWorkspaceChannels,
  verifyWorkspaceDiscord,
}: SettingsPanelProps) {
  const [active, setActive] = useState<SettingsGroupId>(initialGroup);

  if (!open) return null;

  return (
    <div className="settings-screen" role="dialog" aria-modal="true" aria-label="Settings">
      <nav className="settings-screen__nav">
        <button type="button" className="settings-screen__back" onClick={onClose}>
          <ArrowLeft size={13} strokeWidth={2} /> back to app
        </button>
        {GROUPS.map((g) => (
          <button
            key={g.id}
            type="button"
            className={`settings-screen__group${active === g.id ? " is-active" : ""}`}
            onClick={() => setActive(g.id)}
            aria-pressed={active === g.id}
          >
            <g.icon size={14} strokeWidth={2} /> {g.label}
          </button>
        ))}
      </nav>
      <div className="settings-screen__content">
        {active === "general" && <GeneralGroup onReset={onReset} />}
        {active === "themes" && <ThemesGroup theme={theme} onThemeChange={onThemeChange} />}
        {active === "integrations" &&
          (listConnectorVendors &&
          listMyConnectors &&
          addConnector &&
          updateConnector &&
          deleteConnector &&
          verifyConnector ? (
            <IntegrationsGroup
              listVendors={listConnectorVendors}
              listConnectors={listMyConnectors}
              addConnector={addConnector}
              updateConnector={updateConnector}
              deleteConnector={deleteConnector}
              verifyConnector={verifyConnector}
            />
          ) : (
            <p className="wizard__hint">Integrations — not wired up yet.</p>
          ))}
        {active === "channels" &&
          (listWorkspaceRecords && getWorkspaceChannels && saveWorkspaceChannels && verifyWorkspaceDiscord ? (
            <ChannelsGroup
              listWorkspaces={listWorkspaceRecords}
              getChannels={getWorkspaceChannels}
              saveChannels={saveWorkspaceChannels}
              verifyDiscord={verifyWorkspaceDiscord}
            />
          ) : (
            <p className="wizard__hint">Channels — not wired up yet.</p>
          ))}
      </div>
    </div>
  );
}
