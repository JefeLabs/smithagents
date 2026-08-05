# Workspace Channels (Discord Text + Voice) — Design

**Date:** 2026-08-05
**Status:** Approved (Edwin, 2026-08-05)
**Scope:** Move Discord bot token + channel definitions (text and voice) out of
`.env`, boot-time, global config into per-workspace, UI-editable config — with the
broker connecting to a workspace's Discord bot only while that workspace's session
is active.

## Goal

Today, `DISCORD_TOKEN`/`DISCORD_CHANNELS`/`DISCORD_VOICE_CHANNELS` are `.env`
variables read once at broker boot: one bot, one channel allowlist, for the whole
deployment, regardless of which workspace's session happens to be active. This spec
makes channel configuration workspace-owned and UI-editable, the same way Jira/
Confluence/GitHub connections already are — but channels are a different kind of
thing from connectors (a connector is somewhere the agent reaches *out* to for work;
a channel is a surface where the *meeting itself* is present), so this gets its own
data model and its own UI area, not a fieldset bolted onto the workspace connector
form.

## Settled decisions

- **Channels are workspace-owned, not global and not personal.** Each workspace can
  point at its own Discord bot and channel set — the same isolation principle
  already applied to GitHub connections (per-repo, since a workspace's repos can
  span orgs), extended here to "workspaces should own distinct channels to avoid
  crossing concerns and set context" (Edwin, 2026-08-05). A Discord bot token has no
  "requesting user's own token" equivalent the way Jira/GitHub credentials do — bots
  are Discord's own sanctioned mechanism for automated posting, not a personal login
  being delegated — so the privilege-ceiling reasoning that put Jira/GitHub
  credentials on `User` doesn't apply here. The token is legitimately workspace
  infrastructure.
- **Own dedicated UI area, not inside the workspace connector form.** Channels and
  connectors are conceptually distinct even though both are workspace-scoped config
  with a credential — surfaced as separate modals with separate entry points, not
  one form with more fieldsets.
- **The tracked/untracked split still holds, just along a different axis.**
  `Workspace` records are git-tracked (`swarm/.smith/workspaces/*.json`); a bot
  token can never live as a field there. Channel config — including the token —
  lives in a separate, untracked, per-workspace companion file, keyed by the same
  workspace name. This is the same invariant as the credentials work
  (`docs/superpowers/specs/2026-08-04-workspace-connections-design.md`), applied to
  "which file is allowed to hold this," not "which entity is allowed to hold this."
- **Broker connects to a workspace's Discord bot only while that workspace's
  session is active.** Sessions are already workspace-scoped with one active at a
  time; Discord presence follows the same rule the Tauri surface already follows
  implicitly — "where the conversation currently is." Switching sessions tears down
  the previous workspace's Discord connection (if any) and boots the new
  workspace's (if configured). This is a new lifecycle hook — today's Discord setup
  is a one-shot, unconditional boot in `main.ts`.
- **Both text and voice channels, in one spec.** Mirrors the existing
  `DISCORD_CHANNELS`/`DISCORD_VOICE_CHANNELS` split. The connection-lifecycle rule
  applies identically to both; there's no reason to phase them separately.
- **Everything else about Discord stays exactly as it is.** Mention-gated etiquette,
  per-agent webhook identity, the voice audio pipeline (`discord-audio.ts`,
  `discord-voice.ts`) — none of it changes. This spec only changes *which* bot/
  channels those systems are pointed at and *when* that connection exists.

## 1. Data model

`swarm/.smith/channels/<workspace-name>.json` (untracked — holds the bot token):

```ts
export interface WorkspaceChannels {
  discord?: {
    botToken: string;              // secret
    textChannels: string[];        // Discord channel IDs
    voiceChannels: string[];       // Discord channel IDs
  };
}
```

Keyed by workspace name (same key `swarm/.smith/workspaces/<name>.json` uses),
loaded/saved the same structural way as `users.ts` — `loadChannelsFor(name)`,
`saveChannels(name, channels)` — untracked for the same reason `swarm/.smith/users/`
is: the existing blanket `swarm/.smith/*` `.gitignore` rule already covers it, no
tracking override is added.

**API responses never round-trip the token.** `GET` returns `hasDiscordToken:
boolean` in place of `botToken`; `PUT` only touches the token when the caller
explicitly supplies a new one (same partial-update-preserves-existing pattern
already fixed once for `PUT /me` — apply it correctly here from the start, not as a
follow-up fix).

## 2. Connection lifecycle

- **On session activate:** resolve the newly-active workspace's channel config. If
  it has a `discord` block, tear down any currently-running Discord adapter (from
  the previous workspace, if different and if one exists) and boot a fresh
  `discord.js` `Client` against the new bot token + channel set. If the new
  workspace has no Discord config, tear down the old connection (if any) and leave
  the crew unreachable on Discord for this session — same as today's behavior when
  `DISCORD_TOKEN` is unset, just now decided per-workspace instead of per-deployment.
- **On session deactivate/switch:** tear down before the next activation's boot —
  never more than one live Discord client at a time.
- **`SurfacePolicyPopover`'s `discordConfigured` check** (currently `Boolean(
  process.env.DISCORD_TOKEN)`, global) becomes "does the active workspace have
  Discord configured" — a swap of the check's source, not a rewrite of the popover.
- **Reconnect cost is real and worth stating plainly:** switching workspaces now
  triggers a Discord Gateway reconnect (sub-second, but not instant) when either the
  old or new workspace has Discord configured. No mitigation proposed here beyond
  naming it — it's an acceptable cost of the isolation Edwin asked for.

## 3. UI

**New `ChannelsManagerModal`**, triggered by a "manage channels…" entry placed next
to the existing "manage workspaces…" link in `SessionsPanel`'s footer — discoverable
in the same area workspace actions already live, without being nested inside the
workspace connector form.

Layout mirrors `WorkspaceManagerModal`'s shape (familiar UX for workspace-scoped
data): left column picks a workspace, right column is that workspace's channel
form — bot token (password-style input, redacted on read), text channel ID rows
(add/remove, matching the existing repo-row pattern), voice channel ID rows (same,
separate list), and a **"Test connection"** button scoped to *token validity only*
for v1 (confirms the token authenticates against Discord's API) — a full channel
browser/picker is a real feature on its own, not v1 scope.

## 4. API (swarm + broker proxy)

Same three-layer shape as the connectors work:

- **Swarm:** `GET/PUT /workspaces/:name/channels` (redacted on read, partial-update
  correct on write), `POST /workspaces/:name/channels/verify-discord`.
- **Broker proxy:** thin passthrough methods on `SwarmClient`, local routes on
  `text-channel.ts` — **with the origin-allowlist treatment already applied to the
  `/me` and verify-connector routes applied here from the start.** These routes
  touch a live bot token; there's no reason to ship them open and fix it later the
  way the `/me` routes were.

## Out of scope (recorded)

- Full Discord channel browser/picker in the Test-connection flow (list the bot's
  reachable servers/channels instead of just confirming the token authenticates).
- Slack or any other channel provider (per `channel-adapters-direction`, Slack is a
  plausible future provider — this spec is Discord-specific; a second provider
  would extend this data model, not redesign it, but that extension isn't designed
  here).
- Per-channel agent presence granularity (today's `SurfacePolicyPopover` sets modes
  per surface *type* — discord text vs. discord voice — not per specific channel
  ID; this spec doesn't change that granularity, only which channel IDs count as
  "the discord surface" for a workspace).
- Multiple simultaneous Discord connections (one per configured workspace,
  regardless of active session) — explicitly rejected in favor of
  connects-only-when-active.
