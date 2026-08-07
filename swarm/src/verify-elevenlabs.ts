// Live check for an ElevenLabs API key (spec §1): GET /v1/user with xi-api-key.
import type { VerifyResult } from './verify-github.js';

export async function verifyElevenlabs(apiKey: string, fetchImpl: typeof fetch = fetch): Promise<VerifyResult> {
  try {
    const res = await fetchImpl('https://api.elevenlabs.io/v1/user', { headers: { 'xi-api-key': apiKey } });
    const body = (await res.json().catch(() => ({}))) as { subscription?: { tier?: string }; detail?: { message?: string } };
    if (!res.ok) return { ok: false, detail: `ElevenLabs ${res.status}: ${body.detail?.message ?? 'unauthorized'}` };
    return { ok: true, detail: body.subscription?.tier ? `Key valid — ${body.subscription.tier} plan` : 'Key valid' };
  } catch (err) {
    return { ok: false, detail: `Could not reach ElevenLabs: ${err instanceof Error ? err.message : String(err)}` };
  }
}
