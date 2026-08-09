// Broker voice capability snapshot from GET /agents (the `voice` sibling,
// spec §4). Unknown/unreachable → enabled: gate only on confirmed negatives,
// same rule as computeEngineWarnings.
import { useAgentRecords } from "../queries/http";

const ENABLED = { stt: true, tts: true };

/**
 * A selector over the shared agent-records query, not a fetch of its own —
 * which is what makes it safe to call from more than one place at once. The
 * refresh callback it used to expose is gone with it: invalidating
 * `qk.agentRecords` updates every caller, so no component has to hold a
 * refresh handle for another one's benefit.
 */
export function useVoiceStatus(): { voice: { stt: boolean; tts: boolean } } {
  const { data } = useAgentRecords();
  // Covers both "not answered yet" and "answered without a voice sibling" —
  // neither is a confirmed negative, so neither may gate the mic.
  return { voice: data?.voice ?? ENABLED };
}
