// Live check for a Deepgram API key (spec §1): GET /v1/projects with Token auth.
import type { VerifyResult } from './verify-github.js';

export async function verifyDeepgram(apiKey: string, fetchImpl: typeof fetch = fetch): Promise<VerifyResult> {
  try {
    const res = await fetchImpl('https://api.deepgram.com/v1/projects', { headers: { authorization: `Token ${apiKey}` } });
    const body = (await res.json().catch(() => ({}))) as { projects?: unknown[]; err_msg?: string };
    if (!res.ok) return { ok: false, detail: `Deepgram ${res.status}: ${body.err_msg ?? 'unauthorized'}` };
    const n = body.projects?.length ?? 0;
    return { ok: true, detail: `Key valid — ${n} project${n === 1 ? '' : 's'}` };
  } catch (err) {
    return { ok: false, detail: `Could not reach Deepgram: ${err instanceof Error ? err.message : String(err)}` };
  }
}
