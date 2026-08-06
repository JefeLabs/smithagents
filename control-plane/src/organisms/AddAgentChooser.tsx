import { Play } from "lucide-react";
import type { CSSProperties } from "react";

/** A premade card from the catalog — a complete character, joinable in one click. */
export interface PresetCard {
  id: string;
  name: string;
  gender: string;
  role: string;
  jobRole: string;
  stereotype: string;
  language: string;
  hook: string;
  backstory: string;
  persona: { style: string };
  reactions?: Record<string, string[]>;
  quickAnswers?: Record<string, string>;
  voiceId: string;
  ring: string;
  avatar: string;
  engine: { cli: string; model: string };
}

interface AddAgentChooserProps {
  presets: PresetCard[];
  /** Agent ids already on the roster — those cards badge "On the team" and can't re-join. */
  takenIds: Set<string>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** The 12th card: straight into the blank wizard. */
  onCustom: () => void;
  onPreview: (voiceId: string) => void;
  stereotypeLabels: Record<string, string>;
  /** Broker host:port for portrait URLs. */
  base: string;
  /** A join is in flight — the blank-wizard path is disabled so it can't be entered mid-request. */
  busy: boolean;
  /** CLI ids the tool registry marked inactive — cards whose engine.cli is in this set warn and can still be selected for Customize, just not joined as-is. */
  inactiveClis: Set<string>;
}

/** The 12-card grid: 11 premade characters + Create custom. */
export function AddAgentChooser({
  presets,
  takenIds,
  selectedId,
  onSelect,
  onCustom,
  onPreview,
  stereotypeLabels,
  base,
  busy,
  inactiveClis,
}: AddAgentChooserProps) {
  return (
    <div className="preset-grid">
      {presets.map((p) => {
        const taken = takenIds.has(p.id);
        const cliInactive = !taken && inactiveClis.has(p.engine.cli);
        return (
          <div
            key={p.id}
            className={`preset-card${selectedId === p.id ? " is-picked" : ""}${taken ? " is-taken" : ""}`}
          >
            <button
              type="button"
              className="preset-card__pick"
              onClick={() => onSelect(selectedId === p.id ? null : p.id)}
              disabled={taken}
            >
              <img
                className="preset-card__portrait"
                src={`http://${base}/avatars/${p.avatar}`}
                alt=""
                style={{ "--ring": p.ring } as CSSProperties}
                onError={(e) => {
                  (e.target as HTMLImageElement).style.visibility = "hidden";
                }}
              />
              <b>{p.name}</b>
              <span className="preset-card__role">{p.role}</span>
              <span className="preset-card__stereo">{stereotypeLabels[p.stereotype] ?? p.stereotype}</span>
              <span className="preset-card__hook">{p.hook}</span>
              {taken && <span className="preset-card__taken">On the team</span>}
              {cliInactive && <span className="preset-card__warn">CLI unavailable</span>}
            </button>
            {p.voiceId && !taken && (
              <button
                type="button"
                className="voice-row__play preset-card__play"
                onClick={() => onPreview(p.voiceId)}
                aria-label={`Preview ${p.name}'s voice`}
              >
                <Play size={12} strokeWidth={2} />
              </button>
            )}
          </div>
        );
      })}
      <button type="button" className="preset-card preset-card--custom" onClick={onCustom} disabled={busy}>
        <b>Create custom</b>
        <span className="preset-card__hook">Build your own teammate — persona, voice, and an AI-painted portrait.</span>
      </button>
    </div>
  );
}
