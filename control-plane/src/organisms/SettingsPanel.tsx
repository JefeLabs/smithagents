import {
  ArrowLeft,
  Blocks,
  Container,
  KeyRound,
  MessageSquare,
  Mic,
  Palette,
  Settings as SettingsIcon,
  Terminal,
} from "lucide-react";
import { useEffect, useState } from "react";
import type {
  ApiKeyListing,
  ChannelsRecord,
  CliToolListing,
  ConnectorInstanceRecord,
  ConnectorVendorMeta,
  VoiceSettingsRecord,
  WorkspaceRecord,
} from "../api/types";
import type { ThemeId } from "../hooks/useTheme";
import { ApiKeysGroup } from "./settings/ApiKeysGroup";
import { ChannelsGroup } from "./settings/ChannelsGroup";
import { CliToolsGroup } from "./settings/CliToolsGroup";
import { ContainersGroup } from "./settings/ContainersGroup";
import { GeneralGroup, type ResetScope } from "./settings/GeneralGroup";
import { IntegrationsGroup } from "./settings/IntegrationsGroup";
import { ThemesGroup } from "./settings/ThemesGroup";
import { VoiceGroup } from "./settings/VoiceGroup";

export type SettingsGroupId =
  | "general"
  | "integrations"
  | "voice"
  | "cli-tools"
  | "api-keys"
  | "channels"
  | "containers"
  | "themes";

interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
  onReset: (scope: ResetScope) => Promise<{ ok?: boolean; error?: string; swarm?: unknown }>;
  theme: ThemeId;
  onThemeChange: (theme: ThemeId) => void;
  initialGroup?: SettingsGroupId;
  listConnectorVendors?: () => Promise<ConnectorVendorMeta[]>;
  listMyConnectors?: () => Promise<ConnectorInstanceRecord[]>;
  getVoiceSettings?: () => Promise<VoiceSettingsRecord>;
  saveVoiceSettings?: (body: {
    stt: { instanceId: string } | null;
    tts: { instanceId: string } | null;
    hideInactive: boolean;
  }) => Promise<VoiceSettingsRecord & { error?: string }>;
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
  listCliTools?: () => Promise<CliToolListing[]>;
  refreshCliTools?: (tool?: string) => Promise<CliToolListing[]>;
  setCliToolEnabled?: (id: string, enabled: boolean) => Promise<CliToolListing[] | { error: string }>;
  listApiKeys?: () => Promise<ApiKeyListing[]>;
  saveApiKey?: (id: string, key: string) => Promise<ApiKeyListing[] | { error: string }>;
  verifyApiKey?: (id: string) => Promise<ApiKeyListing[] | { error: string }>;
  deleteApiKey?: (id: string) => Promise<ApiKeyListing[] | { error: string }>;
  listWorkspaceRecords?: () => Promise<WorkspaceRecord[]>;
  getWorkspaceChannels?: (name: string) => Promise<ChannelsRecord>;
  saveWorkspaceChannels?: (
    name: string,
    body: { discord?: { botToken: string; textChannels: string[]; voiceChannels: string[] } },
  ) => Promise<ChannelsRecord & { error?: string }>;
  verifyWorkspaceDiscord?: (name: string) => Promise<{ ok?: boolean; detail?: string; error?: string }>;
  getContainers?: () => Promise<{ docker: { enabled: boolean } }>;
  setDockerEnabled?: (enabled: boolean) => Promise<{ docker: { enabled: boolean } }>;
  verifyContainers?: () => Promise<{ ok: boolean; detail: string }>;
}

const SECTIONS: Array<{
  heading: string;
  groups: Array<{ id: SettingsGroupId; label: string; icon: typeof SettingsIcon }>;
}> = [
  {
    heading: "App",
    groups: [
      { id: "general", label: "General", icon: SettingsIcon },
      { id: "themes", label: "Themes", icon: Palette },
    ],
  },
  {
    heading: "Agents",
    groups: [
      { id: "cli-tools", label: "CLI Tools", icon: Terminal },
      { id: "api-keys", label: "API Keys", icon: KeyRound },
    ],
  },
  {
    heading: "Workspace",
    groups: [
      { id: "integrations", label: "Integrations", icon: Blocks },
      { id: "voice", label: "Voice", icon: Mic },
      { id: "channels", label: "Channels", icon: MessageSquare },
      { id: "containers", label: "Containers", icon: Container },
    ],
  },
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
  getVoiceSettings,
  saveVoiceSettings,
  addConnector,
  updateConnector,
  deleteConnector,
  verifyConnector,
  listCliTools,
  refreshCliTools,
  setCliToolEnabled,
  listApiKeys,
  saveApiKey,
  verifyApiKey,
  deleteApiKey,
  listWorkspaceRecords,
  getWorkspaceChannels,
  saveWorkspaceChannels,
  verifyWorkspaceDiscord,
  getContainers,
  setDockerEnabled,
  verifyContainers,
}: SettingsPanelProps) {
  const [active, setActive] = useState<SettingsGroupId>(initialGroup);

  // HomePage.tsx keeps this component always mounted (`if (!open) return null` below just
  // skips rendering, same convention as every other overlay) and reuses the same instance
  // across opens — so `useState(initialGroup)` alone only ever sees the FIRST open's value.
  // Resync `active` to whatever group this particular open was asked for (avatar ->
  // integrations, rail settings button -> general) every time it transitions to open.
  useEffect(() => {
    if (open) setActive(initialGroup);
  }, [open, initialGroup]);

  if (!open) return null;

  return (
    <div className="settings-screen" role="dialog" aria-modal="true" aria-label="Settings">
      <nav className="settings-screen__nav">
        <button type="button" className="settings-screen__back" onClick={onClose}>
          <ArrowLeft size={13} strokeWidth={2} /> back to app
        </button>
        {SECTIONS.map((s) => (
          <div key={s.heading} className="settings-screen__section">
            <span className="settings-screen__heading">{s.heading}</span>
            {s.groups.map((g) => (
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
          </div>
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
              getVoice={getVoiceSettings}
              addConnector={addConnector}
              updateConnector={updateConnector}
              deleteConnector={deleteConnector}
              verifyConnector={verifyConnector}
            />
          ) : (
            <p className="wizard__hint">Integrations — not wired up yet.</p>
          ))}
        {active === "voice" &&
          (getVoiceSettings && saveVoiceSettings && listConnectorVendors && listMyConnectors ? (
            <VoiceGroup
              getVoice={getVoiceSettings}
              saveVoice={saveVoiceSettings}
              listVendors={listConnectorVendors}
              listConnectors={listMyConnectors}
            />
          ) : (
            <p className="wizard__hint">Voice — not wired up yet.</p>
          ))}
        {active === "cli-tools" &&
          (listCliTools && refreshCliTools && setCliToolEnabled ? (
            <CliToolsGroup
              listCliTools={listCliTools}
              refreshCliTools={refreshCliTools}
              setCliToolEnabled={setCliToolEnabled}
            />
          ) : (
            <p className="wizard__hint">CLI Tools — not wired up yet.</p>
          ))}
        {active === "api-keys" &&
          (listApiKeys && saveApiKey && verifyApiKey && deleteApiKey ? (
            <ApiKeysGroup
              listApiKeys={listApiKeys}
              saveApiKey={saveApiKey}
              verifyApiKey={verifyApiKey}
              deleteApiKey={deleteApiKey}
            />
          ) : (
            <p className="wizard__hint">API Keys — not wired up yet.</p>
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
        {active === "containers" &&
          (getContainers && setDockerEnabled && verifyContainers ? (
            <ContainersGroup
              getContainers={getContainers}
              setDockerEnabled={setDockerEnabled}
              verifyContainers={verifyContainers}
            />
          ) : (
            <p className="wizard__hint">Containers — not wired up yet.</p>
          ))}
      </div>
    </div>
  );
}
