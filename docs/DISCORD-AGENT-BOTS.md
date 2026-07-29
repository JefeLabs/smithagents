# Creating Per-Agent Discord Bot Tokens

Each agent that should appear in a voice channel **as its own member** — own
name, own avatar, Discord's speaking indicator lighting under *its* circle —
needs its own Discord **application** with its own bot token. One bot identity
can only hold one voice presence per guild, so the ear's `DISCORD_TOKEN` can
never double as an agent's mouth: renaming env lines does not create
identities; applications do.

Until an agent has a token, it **degrades gracefully**: its lines play through
the ear bot (one shared member), announced at broker boot as
`agents degraded (share the ear): …`. You can mint the apps one at a time and
watch each agent upgrade from "degraded" to a real member.

This guide creates tokens for:

```bash
DISCORD_TOKEN_IGNACIO=
DISCORD_TOKEN_WILKIN=
```

The env-name rule: `DISCORD_TOKEN_<AGENTID>` — the agent's id from
`swarm/.smith/agents/<id>.json`, **uppercased, with dashes replaced by
underscores** (`ignacio` → `DISCORD_TOKEN_IGNACIO`, `luz-maria` →
`DISCORD_TOKEN_LUZ_MARIA`).

## Per agent (~3 minutes each)

Repeat everything below once for Ignacio, once for Wilkin.

### 1. Create the application

1. Open the [Discord Developer Portal](https://discord.com/developers/applications)
   (log in as the account that owns your guild's other bots).
2. **New Application** → name it after the agent (`Ignacio`) → Create.
3. On the **General Information** page, upload the agent's avatar as the App
   Icon (this is the face that shows in the voice channel's member list).

### 2. Configure the bot

1. Left sidebar → **Bot**.
2. Set the bot's **username** to the agent's name and upload the same avatar
   if it didn't inherit.
3. **No privileged intents needed** — voice-only bots don't read messages, so
   leave Message Content / Presence / Server Members OFF. (Only the ear bot —
   your existing `DISCORD_TOKEN` — needs Message Content, and it already has
   it.)
4. **Reset Token** → copy the token now (Discord shows it once). This is the
   value for `DISCORD_TOKEN_<AGENTID>`.

### 3. Invite it to your guild

1. Left sidebar → **OAuth2** (URL Generator).
2. Scopes: **bot**.
3. Bot permissions: **Connect** and **Speak** — nothing else.
4. Open the generated URL, pick your guild, authorize.
5. The agent now appears in your guild's member list (offline until the
   broker logs it in).

### 4. Wire the token

In the repo-root `.env` (git-ignored — tokens never go anywhere else, and
never into `swarm/.smith/agents/*.json`, which is public):

```bash
DISCORD_TOKEN_IGNACIO=<Ignacio's bot token>
DISCORD_TOKEN_WILKIN=<Wilkin's bot token>
```

Two sanity rules that have already bitten once:
- exactly one `=` per line (a `KEY==value` typo makes the value start with
  `=` and the login fails);
- the agent tokens must be **different tokens from each other and from the
  ear's `DISCORD_TOKEN`** — identical values mean you pasted the wrong one.

### 5. Restart the broker and verify

Env is read at boot, so restart the broker (it runs in tmux session
`smith-broker`). The boot log tells you exactly what it found:

```
[discord-voice] ear starting — 4 channel(s) allowlisted
[discord-voice] agent mouths (own bot token): ignacio, wilkin
[discord-voice] agents degraded (share the ear): (none)
```

An agent still listed as degraded means its env var name doesn't match the
id-mapping rule, the token is invalid, or the bot wasn't invited with
Connect + Speak — the boot/join logs name the failure readably.

### 6. The payoff check

Join an allowlisted voice channel (`DISCORD_VOICE_CHANNELS`). Expected: the
ear **and** each tokened agent join as separate members within a moment.
Address Ignacio — **his** member's speaking indicator lights while his
ElevenLabs voice answers. This per-member presence is the one behavior no
automated test could verify — it's the first thing to confirm.

## Prerequisites recap (already true if the text adapter works)

- `DISCORD_TOKEN` (the ear) set; its bot is in the guild.
- `DISCORD_VOICE_CHANNELS` set (comma-separated VC ids; empty = voice off).
- `ffmpeg` on PATH (checked at boot; missing = voice disabled with one log line).
- Each voice agent's `channels` array includes `"discord-voice"`.

Full walkthrough with expected behaviors and watch items:
[MANUAL-TESTING.md → Discord voice](./MANUAL-TESTING.md#discord-voice).
