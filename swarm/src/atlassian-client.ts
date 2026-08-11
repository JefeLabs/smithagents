// Jira ticket lookup + Confluence doc search — the read-only surface broker's
// meeting brain calls through (design §4, deviation note in the plan header:
// this client lives in swarm, not broker, so broker never sees a raw token).
export interface TicketResult {
  key: string;
  summary: string;
  status: string;
  url: string;
}

export interface DocResult {
  title: string;
  excerpt: string;
  url: string;
}

function basicAuth(email: string, apiToken: string): string {
  return `Basic ${Buffer.from(`${email}:${apiToken}`).toString("base64")}`;
}

export async function lookupTicket(
  siteUrl: string,
  email: string,
  apiToken: string,
  ticketKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; ticket?: TicketResult; detail?: string }> {
  const base = siteUrl.replace(/\/$/, "");
  try {
    const res = await fetchImpl(`${base}/rest/api/3/issue/${encodeURIComponent(ticketKey)}?fields=summary,status`, {
      headers: { authorization: basicAuth(email, apiToken) },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { errorMessages?: string[] };
      return { ok: false, detail: `Jira ${res.status}: ${body.errorMessages?.[0] ?? res.statusText}` };
    }
    const data = (await res.json()) as { key: string; fields: { summary: string; status: { name: string } } };
    return {
      ok: true,
      ticket: {
        key: data.key,
        summary: data.fields.summary,
        status: data.fields.status.name,
        url: `${base}/browse/${data.key}`,
      },
    };
  } catch (err) {
    return { ok: false, detail: `Could not reach Jira: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function searchDocs(
  siteUrl: string,
  email: string,
  apiToken: string,
  query: string,
  opts?: { spaceKeys?: string[] },
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; docs?: DocResult[]; detail?: string }> {
  const base = siteUrl.replace(/\/$/, "");
  try {
    const spaceClause = opts?.spaceKeys?.length
      ? ` and space in (${opts.spaceKeys.map((k) => `"${k}"`).join(",")})`
      : "";
    const cql = `text ~ "${query.replace(/"/g, '\\"')}"${spaceClause}`;
    const res = await fetchImpl(`${base}/wiki/rest/api/content/search?cql=${encodeURIComponent(cql)}&limit=5`, {
      headers: { authorization: basicAuth(email, apiToken) },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      return { ok: false, detail: `Confluence ${res.status}: ${body.message ?? res.statusText}` };
    }
    const data = (await res.json()) as { results: Array<{ title: string; _links: { webui: string } }> };
    return {
      ok: true,
      docs: data.results.map((r) => ({ title: r.title, excerpt: "", url: `${base}/wiki${r._links.webui}` })),
    };
  } catch (err) {
    return { ok: false, detail: `Could not reach Confluence: ${err instanceof Error ? err.message : String(err)}` };
  }
}
