// Broker voice capability snapshot from GET /agents (the `voice` sibling,
// spec §4). Unknown/unreachable → enabled: gate only on confirmed negatives,
// same rule as useCliToolHealth.
import { useCallback, useEffect, useState } from "react";

const BASE = "127.0.0.1:7790";
const ENABLED = { stt: true, tts: true };

export function useVoiceStatus(): { voice: { stt: boolean; tts: boolean }; refresh: () => void } {
  const [voice, setVoice] = useState(ENABLED);
  const refresh = useCallback(() => {
    void fetch(`http://${BASE}/agents`)
      .then((r) => r.json())
      .then((body: { voice?: { stt: boolean; tts: boolean } }) => setVoice(body.voice ?? ENABLED))
      .catch(() => setVoice(ENABLED));
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);
  return { voice, refresh };
}
