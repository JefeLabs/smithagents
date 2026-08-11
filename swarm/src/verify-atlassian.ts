// Live check for an Atlassian (Jira/Confluence) site + credential pairing.
// No workspace/user storage here — callers resolve those and hand in plain
// values, so this stays a pure, injectable-fetch HTTP client (design §2).
export interface VerifyResult {
  ok: boolean;
  detail: string;
}

export async function verifyAtlassian(
  siteUrl: string,
  email: string,
  apiToken: string,
  opts?: { confluenceSpaceKey?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<VerifyResult> {
  const base = siteUrl.replace(/\/$/, "");
  const auth = `Basic ${Buffer.from(`${email}:${apiToken}`).toString("base64")}`;
  try {
    const res = await fetchImpl(`${base}/rest/api/3/myself`, { headers: { authorization: auth } });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}) as { message?: string });
      return { ok: false, detail: `Jira ${res.status}: ${(body as { message?: string }).message ?? res.statusText}` };
    }
    if (!opts?.confluenceSpaceKey) return { ok: true, detail: "Jira: authenticated" };
    const spaceRes = await fetchImpl(`${base}/wiki/rest/api/space/${encodeURIComponent(opts.confluenceSpaceKey)}`, {
      headers: { authorization: auth },
    });
    if (!spaceRes.ok) {
      return { ok: false, detail: `Confluence space "${opts.confluenceSpaceKey}" not reachable: ${spaceRes.status}` };
    }
    return { ok: true, detail: "Jira + Confluence: authenticated" };
  } catch (err) {
    return { ok: false, detail: `Could not reach ${base}: ${err instanceof Error ? err.message : String(err)}` };
  }
}
