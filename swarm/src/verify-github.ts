// Live checks for a GitHub token — generic (account-only, no repo context
// needed) and repo-specific (confirms access to one owner/repo).
export interface VerifyResult {
  ok: boolean;
  detail: string;
}

const GITHUB_API = "https://api.github.com";

export async function verifyGithubToken(token: string, fetchImpl: typeof fetch = fetch): Promise<VerifyResult> {
  try {
    const res = await fetchImpl(`${GITHUB_API}/user`, { headers: { authorization: `Bearer ${token}` } });
    const body = (await res.json().catch(() => ({}))) as { login?: string; message?: string };
    if (!res.ok) return { ok: false, detail: `GitHub ${res.status}: ${body.message ?? "unauthorized"}` };
    return { ok: true, detail: `Authenticated as ${body.login}` };
  } catch (err) {
    return { ok: false, detail: `Could not reach GitHub: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function verifyGithubRepo(
  owner: string,
  repo: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<VerifyResult> {
  try {
    const res = await fetchImpl(`${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    if (!res.ok)
      return { ok: false, detail: `GitHub ${res.status}: ${body.message ?? `no access to ${owner}/${repo}`}` };
    return { ok: true, detail: `Access confirmed to ${owner}/${repo}` };
  } catch (err) {
    return { ok: false, detail: `Could not reach GitHub: ${err instanceof Error ? err.message : String(err)}` };
  }
}
