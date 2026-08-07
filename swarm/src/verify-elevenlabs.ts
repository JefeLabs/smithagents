// Live check for an ElevenLabs API key (spec §1): GET /v1/voices with xi-api-key.
// Probes voices_read — the permission the app actually exercises (voice list + TTS
// casting) — so a minimally-scoped TTS key verifies. /v1/user would demand
// user_read, which nothing at runtime needs.
import type { VerifyResult } from './verify-github.js';

export async function verifyElevenlabs(apiKey: string, fetchImpl: typeof fetch = fetch): Promise<VerifyResult> {
  try {
    const res = await fetchImpl('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': apiKey } });
    const body = (await res.json().catch(() => ({}))) as { voices?: unknown[]; detail?: { message?: string } };
    if (!res.ok) return { ok: false, detail: `ElevenLabs ${res.status}: ${body.detail?.message ?? 'unauthorized'}` };
    const n = body.voices?.length ?? 0;
    return { ok: true, detail: `Key valid — ${n} voice${n === 1 ? '' : 's'}` };
  } catch (err) {
    return { ok: false, detail: `Could not reach ElevenLabs: ${err instanceof Error ? err.message : String(err)}` };
  }
}
