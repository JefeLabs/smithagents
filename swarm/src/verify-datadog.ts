// swarm/src/verify-datadog.ts
// Live check for a DataDog API key + Application key pair. /api/v2/validate_keys
// is the only DataDog endpoint that validates both together (the app key has no
// standalone validation endpoint) — see docs.datadoghq.com/api/latest/key-management/.
export interface VerifyResult {
  ok: boolean;
  detail: string;
}

const SITE_HOSTS: Record<string, string> = {
  us1: 'api.datadoghq.com',
  us3: 'api.us3.datadoghq.com',
  us5: 'api.us5.datadoghq.com',
  eu1: 'api.datadoghq.eu',
  ap1: 'api.ap1.datadoghq.com',
  ap2: 'api.ap2.datadoghq.com',
  uk1: 'api.uk1.datadoghq.com',
  us1fed: 'api.ddog-gov.com',
  us2fed: 'api.us2.ddog-gov.com',
};

export async function verifyDatadog(
  site: string,
  apiKey: string,
  appKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<VerifyResult> {
  const host = SITE_HOSTS[site] ?? SITE_HOSTS.us1;
  try {
    const res = await fetchImpl(`https://${host}/api/v2/validate_keys`, {
      headers: { 'DD-API-KEY': apiKey, 'DD-APPLICATION-KEY': appKey },
    });
    const body = (await res.json().catch(() => ({}))) as { status?: string; errors?: string[] };
    if (!res.ok) return { ok: false, detail: `DataDog ${res.status}: ${body.errors?.join(', ') ?? 'unauthorized'}` };
    return { ok: true, detail: 'DataDog: API key + app key authenticated' };
  } catch (err) {
    return { ok: false, detail: `Could not reach DataDog: ${err instanceof Error ? err.message : String(err)}` };
  }
}
