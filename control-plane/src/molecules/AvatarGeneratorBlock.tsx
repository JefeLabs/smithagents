import { RefreshCw, Sparkles } from "lucide-react";
import type { CSSProperties } from "react";
import { useState } from "react";

interface AvatarGeneratorBlockProps {
  /** Broker host:port. */
  base: string;
  /** catalog.avatarGen — false renders nothing (no Gemini key on the broker). */
  enabled: boolean;
  name: string;
  gender: string;
  role: string;
  backstory: string;
  stereotype?: string;
  ring?: string;
  /** Current portrait: a data URI fresh from Gemini, or a server URL (preset art / editing). */
  value?: string;
  onGenerated: (dataUri: string) => void;
}

/**
 * Generate/reroll a portrait for the agent being written. Preview-only by
 * design: the base64 lives in wizard state and is submitted with the agent,
 * so a reroll never leaves an orphaned file anywhere.
 */
export function AvatarGeneratorBlock({
  base,
  enabled,
  name,
  gender,
  role,
  backstory,
  stereotype,
  ring,
  value,
  onGenerated,
}: AvatarGeneratorBlockProps) {
  const [genBusy, setGenBusy] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);

  if (!enabled) return null;

  const generate = async () => {
    setGenBusy(true);
    setGenError(null);
    const res = (await fetch(`http://${base}/avatars/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, gender, role, backstory, stereotype }),
    })
      .then((r) => r.json())
      .catch((err: unknown) => ({ error: String(err) }))) as { imageData?: string; error?: string };
    setGenBusy(false);
    if (res.error || !res.imageData) {
      setGenError(res.error ?? "generation failed — try again");
      return;
    }
    onGenerated(`data:image/png;base64,${res.imageData}`);
  };

  return (
    <div className="avatar-gen">
      <span className="avatar-gen__preview" style={{ "--ring": ring } as CSSProperties}>
        {value ? <img src={value} alt="" /> : <b>{name[0]?.toUpperCase() ?? "?"}</b>}
      </span>
      <button type="button" className="settings-btn" onClick={() => void generate()} disabled={genBusy}>
        {value ? <RefreshCw size={12} strokeWidth={2} /> : <Sparkles size={12} strokeWidth={2} />}{" "}
        {genBusy ? "painting the portrait…" : value ? "reroll the portrait" : "generate a portrait"}
      </button>
      {genError && <p className="wizard__error">{genError}</p>}
    </div>
  );
}
