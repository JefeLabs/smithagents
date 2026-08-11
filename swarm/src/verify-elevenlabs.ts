// Live check for an ElevenLabs API key (spec §1): GET /v1/voices with xi-api-key.
// Probes voices_read — the permission the app actually exercises (voice list + TTS
// casting) — so a minimally-scoped TTS key verifies. /v1/user would demand
// user_read, which nothing at runtime needs.
import type { VerifyResult } from "./verify-github.js";

export async function verifyElevenlabs(apiKey: string, fetchImpl: typeof fetch = fetch): Promise<VerifyResult> {
  try {
    const res = await fetchImpl("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": apiKey } });
    const body = (await res.json().catch(() => ({}))) as {
      voices?: unknown[];
      detail?: { status?: string; message?: string };
    };
    // missing_permissions only comes back for a key ElevenLabs recognized — the key
    // is authentic (TTS may work fine), it just can't list voices. Valid, with caveat.
    if (res.status === 401 && body.detail?.status === "missing_permissions") {
      return {
        ok: true,
        detail: 'Key valid — restricted scope: voice list blocked, grant "Voices: Read" to enable voice casting',
      };
    }
    if (!res.ok) return { ok: false, detail: `ElevenLabs ${res.status}: ${body.detail?.message ?? "unauthorized"}` };
    const n = body.voices?.length ?? 0;
    return { ok: true, detail: `Key valid — ${n} voice${n === 1 ? "" : "s"}` };
  } catch (err) {
    return { ok: false, detail: `Could not reach ElevenLabs: ${err instanceof Error ? err.message : String(err)}` };
  }
}
