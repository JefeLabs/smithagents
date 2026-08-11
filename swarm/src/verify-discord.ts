// Live check for a Discord bot token — same shape as verify-github.ts's
// verifyGithubToken: plain fetch, no discord.js dependency needed here
// (swarm has none; that's a broker-only dependency). Wraps the fetch in
// try/catch from the start — this codebase already had to retrofit that
// once for verify-atlassian.ts/verify-github.ts, no reason to ship the same
// gap here.
export interface VerifyResult {
  ok: boolean;
  detail: string;
}

const DISCORD_API = "https://discord.com/api/v10";

export async function verifyDiscordToken(token: string, fetchImpl: typeof fetch = fetch): Promise<VerifyResult> {
  try {
    const res = await fetchImpl(`${DISCORD_API}/users/@me`, { headers: { authorization: `Bot ${token}` } });
    const body = (await res.json().catch(() => ({}))) as { username?: string; message?: string };
    if (!res.ok) return { ok: false, detail: `Discord ${res.status}: ${body.message ?? "unauthorized"}` };
    return { ok: true, detail: `Bot authenticated as ${body.username}` };
  } catch (err) {
    return { ok: false, detail: `Could not reach Discord: ${err instanceof Error ? err.message : String(err)}` };
  }
}
