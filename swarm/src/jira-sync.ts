// Jira sync for work boards — three verbs only (search, import-merge,
// transition), matching the spec's v1 scope. Pure injectable-fetch HTTP
// client in the style of atlassian-client.ts: no storage access here;
// routes resolve credentials via the connector registry and hand in plain
// values. Push is best-effort by design — a failed transition marks the
// card, never blocks the human's move.
import { addCard, type WorkBoard } from './work-items.js';

const auth = (email: string, apiToken: string) => `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`;

export async function searchIssues(
  siteUrl: string,
  email: string,
  apiToken: string,
  jql: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Array<{ key: string; summary: string; url: string }>> {
  const base = siteUrl.replace(/\/$/, '');
  const res = await fetchImpl(`${base}/rest/api/3/search?jql=${encodeURIComponent(jql)}&fields=summary&maxResults=100`, {
    headers: { authorization: auth(email, apiToken) },
  });
  if (!res.ok) throw new Error(`Jira search failed: ${res.status}`);
  const body = (await res.json()) as { issues?: Array<{ key: string; fields?: { summary?: string } }> };
  return (body.issues ?? []).map((i) => ({ key: i.key, summary: i.fields?.summary ?? i.key, url: `${base}/browse/${i.key}` }));
}

/** Merge issues into the board: unseen keys become leftmost-column cards, known keys refresh title only. Never moves a card. */
export function importIssues(
  board: WorkBoard,
  issues: Array<{ key: string; summary: string; url: string }>,
): { created: number; updated: number } {
  let created = 0;
  let updated = 0;
  for (const issue of issues) {
    const existing = board.cards.find((c) => c.jira?.key === issue.key);
    if (existing) {
      existing.title = issue.summary;
      existing.updatedAt = new Date().toISOString();
      updated += 1;
    } else {
      const card = addCard(board, { title: issue.summary });
      card.jira = { key: issue.key, url: issue.url };
      created += 1;
    }
  }
  return { created, updated };
}

export async function transitionIssue(
  siteUrl: string,
  email: string,
  apiToken: string,
  key: string,
  targetStatusName: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const base = siteUrl.replace(/\/$/, '');
  const headers = { authorization: auth(email, apiToken), 'content-type': 'application/json' };
  const listRes = await fetchImpl(`${base}/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, { headers });
  if (!listRes.ok) throw new Error(`Jira transitions fetch failed: ${listRes.status}`);
  const body = (await listRes.json()) as { transitions?: Array<{ id: string; to?: { name?: string } }> };
  const hit = (body.transitions ?? []).find((t) => t.to?.name?.toLowerCase() === targetStatusName.toLowerCase());
  if (!hit) throw new Error(`no transition to "${targetStatusName}" available on ${key}`);
  const postRes = await fetchImpl(`${base}/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ transition: { id: hit.id } }),
  });
  if (!postRes.ok) throw new Error(`Jira transition failed: ${postRes.status}`);
}
