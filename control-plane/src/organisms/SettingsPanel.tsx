import { ArrowLeft, Blocks, MessageSquare, Palette, Settings as SettingsIcon } from "lucide-react";
import { useState } from "react";
import type { ThemeId } from "../hooks/useTheme";
import { GeneralGroup, type ResetScope } from "./settings/GeneralGroup";
import { ThemesGroup } from "./settings/ThemesGroup";
// IntegrationsGroup/ChannelsGroup: wired in Tasks 11-13. Import + render them
// the same way once those files exist — do not stub with placeholder JSX,
// this task ends with General/Themes fully working and Integrations/Channels
// left as the NEXT task's job, not a fake placeholder shipped in between.

export type SettingsGroupId = "general" | "integrations" | "channels" | "themes";

interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
  onReset: (scope: ResetScope) => Promise<{ ok?: boolean; error?: string; swarm?: unknown }>;
  theme: ThemeId;
  onThemeChange: (theme: ThemeId) => void;
  initialGroup?: SettingsGroupId;
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
        {active === "integrations" && <p className="wizard__hint">Integrations — coming in the next task.</p>}
        {active === "channels" && <p className="wizard__hint">Channels — coming in the next task.</p>}
      </div>
    </div>
  );
}
