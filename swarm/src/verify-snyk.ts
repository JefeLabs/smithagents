// swarm/src/verify-snyk.ts
// Live check for a Snyk API token via the REST API's /self ("who am I") route.
// version is computed as today's date per Snyk's own guidance (the docs'
// stated "recommended" version lags behind what the API actually serves) —
// auth is checked before version parsing, so a validity check doesn't
// actually depend on getting the version string exactly right, but a real
// successful call benefits from a current one. See docs.snyk.io/developer-tools/snyk-api/.
export interface VerifyResult {
  ok: boolean;
  detail: string;
}

const REGION_HOSTS: Record<string, string> = {
  'us-01': 'api.snyk.io',
  'us-02': 'api.us.snyk.io',
  'eu-01': 'api.eu.snyk.io',
  'au-01': 'api.au.snyk.io',
};

export async function verifySnyk(
  region: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<VerifyResult> {
  const host = REGION_HOSTS[region] ?? REGION_HOSTS['us-01'];
  const version = new Date().toISOString().slice(0, 10);
  try {
    const res = await fetchImpl(`https://${host}/rest/self?version=${version}`, {
      headers: { authorization: `token ${token}`, 'content-type': 'application/vnd.api+json' },
    });
    const body = (await res.json().catch(() => ({}))) as {
      data?: { type?: string };
      errors?: Array<{ detail?: string }>;
    };
    if (!res.ok) return { ok: false, detail: `Snyk ${res.status}: ${body.errors?.[0]?.detail ?? 'unauthorized'}` };
    return { ok: true, detail: `Snyk: authenticated as ${body.data?.type ?? 'user'}` };
  } catch (err) {
    return { ok: false, detail: `Could not reach Snyk: ${err instanceof Error ? err.message : String(err)}` };
  }
}
