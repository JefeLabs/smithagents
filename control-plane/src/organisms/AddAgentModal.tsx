import type { CSSProperties, MouseEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { Chip } from "../atoms/Chip";
import { Field } from "../atoms/Field";
import { DiscordIdentityPanel, type DiscordMode } from "../molecules/DiscordIdentityPanel";

interface AddAgentModalProps {
  open: boolean;
  onClose: () => void;
  onCreate: (name: string, role: string) => void;
}

const CHANNELS = [
  { id: "discord", label: "Discord" },
  { id: "web", label: "Web widget" },
  { id: "tauri", label: "Tauri" },
];

export function AddAgentModal({ open, onClose, onCreate }: AddAgentModalProps) {
  const [name, setName] = useState("Vera");
  const [role, setRole] = useState("Release Marshal");
  const [channels, setChannels] = useState<Record<string, boolean>>({ discord: true, web: false, tauri: false });
  const [mode, setMode] = useState<DiscordMode>("webhook");
  const [directives, setDirectives] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    nameRef.current?.focus();
    nameRef.current?.select();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const onScrimClick = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose();
  };

  const initial = name.trim()[0]?.toUpperCase() ?? "?";

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: artifact-faithful scrim — click-outside dismiss; the keyboard path is the global Escape handler bound while open
    <div
      className="scrim"
      data-open={open ? "true" : "false"}
      role="dialog"
      aria-modal="true"
      aria-labelledby="modalTitle"
      onClick={onScrimClick}
    >
      <div className="modal">
        <h2 id="modalTitle">New agent</h2>
        <p className="sub">Give the agent an identity and pick where it shows up.</p>

        <div className="id-head">
          <div className="id-avatar" style={{ "--ring": "var(--accent)" } as CSSProperties}>
            {initial}
          </div>
          <Field label="Name" htmlFor="agName" style={{ flex: 1, margin: 0 }}>
            <input
              id="agName"
              ref={nameRef}
              type="text"
              placeholder="e.g. Manuel"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
        </div>

        <Field label="Role" htmlFor="agRole">
          <input
            id="agRole"
            type="text"
            placeholder="e.g. Architect"
            value={role}
            onChange={(e) => setRole(e.target.value)}
          />
        </Field>

        <Field label="Channels">
          <div className="chips">
            {CHANNELS.map((channel) => (
              <Chip
                key={channel.id}
                label={channel.label}
                pressed={channels[channel.id] ?? false}
                onToggle={() => setChannels((c) => ({ ...c, [channel.id]: !c[channel.id] }))}
              />
            ))}
          </div>
        </Field>

        <DiscordIdentityPanel mode={mode} onModeChange={setMode} hidden={!channels.discord} />

        <Field
          label={
            <>
              Directives{" "}
              <span style={{ textTransform: "none", letterSpacing: 0, color: "var(--text-dim)" }}>
                — system prompt, optional
              </span>
            </>
          }
          htmlFor="agDir"
        >
          <textarea
            id="agDir"
            placeholder="How this agent behaves — its domain, tone, and hard constraints…"
            value={directives}
            onChange={(e) => setDirectives(e.target.value)}
          />
        </Field>

        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => onCreate(name.trim() || "Agent", role.trim() || "Agent")}
          >
            Create agent
          </button>
        </div>
      </div>
    </div>
  );
}
