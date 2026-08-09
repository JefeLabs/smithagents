import { Field } from "../atoms/Field";
import { SegmentedControl } from "../atoms/SegmentedControl";

export type DiscordMode = "webhook" | "bot";

interface DiscordIdentityPanelProps {
  mode: DiscordMode;
  onModeChange: (mode: DiscordMode) => void;
  hidden?: boolean;
}

export function DiscordIdentityPanel({ mode, onModeChange, hidden = false }: DiscordIdentityPanelProps) {
  return (
    <div className={hidden ? "field sm-hidden" : "field"}>
      {/* biome-ignore lint/a11y/noLabelWithoutControl: artifact-faithful markup — this label captions the whole segmented group (.field > label styling) */}
      <label>Discord identity — how it appears on the server</label>
      <SegmentedControl
        ariaLabel="Discord identity mode"
        options={[
          { id: "webhook", label: "Webhook identity" },
          { id: "bot", label: "Dedicated bot" },
        ]}
        selected={mode}
        onSelect={(id) => onModeChange(id as DiscordMode)}
      />
      <div className="discord-panel">
        <div className={mode === "webhook" ? "" : "sm-hidden"}>
          <p className="note">
            <b>Distinct sender — no token.</b> Posts as this agent’s name &amp; avatar in every channel, seen by
            everyone. Rides the shared bot’s <em>Manage&nbsp;Webhooks</em> permission. No presence in the member list.
          </p>
        </div>
        <div className={mode === "bot" ? "" : "sm-hidden"}>
          <p className="note">
            <b>A real member.</b> Appears in the member list with presence and can join voice — needs its own bot token.
          </p>
          <Field label="Bot token" htmlFor="agToken" style={{ marginTop: 12 }}>
            <input id="agToken" type="password" placeholder="paste the agent’s bot token" autoComplete="off" />
          </Field>
          <label className="check">
            <input type="checkbox" defaultChecked /> Enable the <b>MESSAGE_CONTENT</b> intent
          </label>
          <Field label="Guild ID" htmlFor="agGuild" style={{ marginTop: 12 }}>
            <input id="agGuild" type="text" placeholder="defaults to GUILD_ID from .env" />
          </Field>
        </div>
      </div>
    </div>
  );
}
