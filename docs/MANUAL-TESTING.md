# smithagents — Manual Testing Guide

Hands-on verification for every feature in [FEATURES.md](./FEATURES.md).

**Common setup (assumed by every test unless it says otherwise):**

```bash
# 1. orchestrator            # 2. broker                  # 3. the app
cd swarm && npm run serve    cd broker && npm run serve   cd control-plane && pnpm tauri dev
```

Root `.env` populated per the README. At least one workspace registered and
at least one agent on the roster. "The app" below means the Tauri window or
the same UI in a browser at `http://localhost:1420`.

---

## Text meeting loop

1. Type a greeting addressed to one agent ("Ignacio, ¿qué lo que?").
2. **Expected:** only Ignacio answers, speaker-prefixed, in persona. Address
   "team" → every agent replies in turn, each in their own voice/style.
3. Ask an agent about another agent's domain. **Expected:** they defer or
   redirect per etiquette rather than answering for the colleague.

## Per-agent voices

1. Sound toggle on. Trigger replies from two different agents in one turn.
2. **Expected:** two distinct ElevenLabs voices; playback serialized (never
   overlapping); an ~850ms beat when the speaker changes. If the ElevenLabs
   plan gates a library voice, a premade stand-in plays instead of silence.

## Push-to-talk

1. Hold the mic button; speak a request; release.
2. **Expected:** your words appear as an utterance in the transcript
   (Deepgram STT), then the crew answers exactly as if typed.

## Raise hand

1. Address a question to agent A whose answer touches agent B's domain.
2. **Expected:** B may show a ✋ badge instead of interrupting. Click B's
   circle → B takes the floor and the hand lowers.

## Crew memory

1. Tell the crew a durable fact ("remember: staging deploys are frozen on
   Fridays"). Create a **new session** (left rail → sessions → new).
2. Ask a question that needs the fact. **Expected:** the crew recalls it in
   the fresh session — memory crosses sessions, transcript does not.

## Host identity (Anderson)

1. Say "Hey Anderson, who's free?" **Expected:** his tile (above the crew
   grid, visually separated) shows the listening ring while you speak; ONLY
   Anderson answers, roster-aware, in his own voice — not the fallback.
2. Create a **new session**. **Expected:** exactly one spoken roster-aware
   greeting from Anderson. Switch back to an older session: silence.
3. Say "Hey team". **Expected:** the crew replies; Anderson stays quiet.
4. Ask Wilkin something in his own domain. **Expected:** Wilkin answers;
   Anderson never butts in (deference is the load-bearing rule).
5. Rename or restyle the host: edit `broker/.smith/identity.json`, restart
   the broker. **Expected:** the new name is addressable and on the tile —
   identity is data, not code.

## Blocked audio recovery

1. Quit and reopen the Tauri app; **without clicking anything**, wait for a
   broker reply (e.g. have someone else / curl trigger an utterance).
2. **Expected:** if the webview blocks autoplay, a pill appears — "audio is
   blocked — click anywhere to enable sound" — instead of silent loss.
3. Click anywhere. **Expected:** the held replies play in order; the pill
   disappears; later replies play normally.

## Roster edit mode

1. Long-press (3s) any roster circle. **Expected:** jiggle mode; "done"
   replaces the rail label; busy agents don't jiggle (locked).
2. Drag to reorder — order survives app reload (localStorage).
3. Drag one solo agent onto another. **Expected:** they form a squad
   (delta, epsilon, …) rendered as one circle with a group badge; tap the
   squad to expand members; drag a member out to free them.
4. **Expected:** squad addressing follows etiquette — the squad speaks
   through its leader.

## Avatar states

1. Address an agent — **listening pulse** while they're spoken to.
2. Delegate work — **glowing ring** while their task runs.
3. Squad with 2+ members — **group badge**. Raised hand — **✋ badge**.

## Agent creation

1. Roster → "+". Walk the wizard: stereotype, job role, engine (CLI +
   model), voice (catalog needs `voices_read` on the ElevenLabs key),
   reactions, quick answers — or use the one-call AI generation.
2. **Expected:** the new agent joins the roster, is greeted in the meeting,
   and `swarm/.smith/agents/<id>.json` exists with everything you chose.
3. Invalid inputs (bad model id, unknown CLI) → readable 400 copy inline.

## Voice agent creation

1. Say "Anderson, create an architect agent — grumpy veteran."
2. **Expected:** Anderson pitches a complete draft aloud (name, role,
   flavor) and asks whether to add them. NOTHING is persisted yet.
3. Say yes ("dale" / "add him"). **Expected:** the agent joins the roster,
   `swarm/.smith/agents/<id>.json` exists (engine claude/claude-opus,
   fallback voice until cast in the wizard).
4. Repeat with a decline. **Expected:** draft discarded, no file, no roster
   change. A second draft before answering replaces the first.

## Agent editing

1. Edit mode → tap a **solo, idle** agent. **Expected:** the wizard reopens
   pre-filled; save persists (check the JSON file); the meeting continues.
2. Try editing an agent mid-task. **Expected:** locked in the UI; a direct
   `PUT /agents/:id` while busy → 409 "is working — cancel their task or
   session first" (server-side lock).

## Agent removal

1. Create a throwaway agent; **without letting it speak or work**, edit
   mode → ✕ on its circle. **Expected:** confirm sheet says "has never
   worked or spoken — this removes them permanently"; confirm → circle
   gone, JSON file deleted.
2. ✕ on an agent that HAS spoken. **Expected:** sheet says "has history
   (has spoken in a session) — they will be archived"; confirm → circle
   gone, JSON file remains with `"archived": true`; old transcript still
   renders their lines; delegating to them → "…is archived".
3. Create a new agent reusing the archived name. **Expected:** readable
   409 — archived ids are reserved.
4. Kill the broker mid-confirm (chaos): the sheet surfaces the error
   inline and stays open — no silent failure.

## Sessions

1. Sessions panel → new session (pick a workspace). Chat; switch back to
   the old session. **Expected:** transcript AND the brain's memory swap
   wholesale; reload the app → active session's transcript replays.

## Workspace management

1. Sessions panel → "manage workspaces…". Create one pointing at a real
   git repo path. **Expected:** appears in the list; file lands in
   `swarm/.smith/workspaces/`; new-session buttons offer it.
2. Non-git path → inline verbatim error ("…is not a git repository").
3. Default rules: set a new default — old default clears atomically.
   Remove the default while others exist → readable 409 "set another
   default first".
4. Remove an unused workspace → deleted (file gone). Remove one that has
   sessions → archived (`"archived": true`), and it disappears from the
   new-session picker and the brain's delegation list without a restart.
5. Name field is disabled when editing (the name is the file key).

## Workspace filter

1. With 2+ workspaces, open the sessions panel. **Expected:** chip row
   (`all` + one per workspace) filters the session list. Remove the
   filtered workspace → filter resets itself, never a stuck empty list.

## Delegation

1. Ask for real work naming the repo if not the session default ("Ignacio,
   add a README badge in smithagents").
2. **Expected:** the addressed agent acknowledges in persona; their ring
   glows; a worktree appears under `swarm/.smith/worktrees/<taskId>` on
   branch `smith/<taskId>`; on completion the agent announces it in the
   meeting and a **draft PR** exists on GitHub with the work committed.

## Supervision

1. While a task runs, click the glowing circle. **Expected:** live
   terminal output; send a steering instruction — it reaches the CLI
   (visible in the output); cancel kills the run and frees the agent.

## Warm sessions

1. Start a conversational session with an agent (warm session). Restart
   the swarm server (`tmux` session survives).
2. **Expected:** boot reconciliation adopts the live session (log line);
   sending a follow-up turn through the adopted handle still works.
   Record-less `smith-warm-*` tmux sessions are *reported, never killed*.

## Engine model

1. Create/edit an agent with a specific `engine.cli` + `engine.model`.
   Delegate work; inspect the tmux command of the run.
2. **Expected:** the exact CLI with the exact `--model` flag; a blank or
   `default` model emits no flag; the persona file is materialized into
   the task worktree.

## Discord adapter

Setup: bot created with **Message Content intent**, invited with Read/Send
+ **Manage Webhooks**; `DISCORD_TOKEN` + `DISCORD_CHANNELS` in root `.env`;
broker restarted (boot log: `[discord] crew attending N channel(s)`).

1. @mention the bot in an allowlisted channel with a question for Ignacio.
   **Expected:** Ignacio replies **under his own name** (webhook identity);
   the exchange also appears in the app transcript (utterance + reply).
2. `@everyone` / a role ping / a message without the mention → **silence**.
3. A message in a non-allowlisted channel → silence.
4. Remove `"discord"` from an agent's `channels` array + broker restart →
   that agent's lines no longer post to Discord (designation).
5. Two rapid @mentions back-to-back. **Expected:** each reply lands under
   the message that asked — never crossed, never dropped (turn-scoped
   origins).

## Discord voice

**No live Discord verification was possible while building this feature** —
it requires minted per-agent Discord applications and a real voice channel,
neither of which exist in this environment. Everything below is the
operator runbook; the live pass is Edwin's to run.

### Per-agent app setup

One-time, per agent that should get its own voice presence:

1. https://discord.com/developers/applications → New Application, named and
   avatared as the agent (e.g. "Ignacio").
2. Bot tab → Add Bot. Copy the token.
3. OAuth2 → URL Generator → scope `bot`, permissions **Connect** + **Speak**
   (no text permissions needed — this bot only ever joins voice). Open the
   generated invite URL, add it to the server.
4. Root `.env`: `DISCORD_TOKEN_<AGENTID>=<token>`, where `<AGENTID>` is the
   agent's id uppercased with hyphens mapped to underscores (`ignacio` →
   `DISCORD_TOKEN_IGNACIO`, `luz-maria` → `DISCORD_TOKEN_LUZ_MARIA`).
   Restart the broker.
5. The agent's `swarm/.smith/agents/<id>.json` needs `"discord-voice"` in
   its `channels` array — that's designation; the token itself never goes
   in that file (tokens are secrets, agent JSONs are public).

**The ear** is the existing `DISCORD_TOKEN` bot (the same one the Discord
text adapter uses, or a bare one if voice is the only Discord surface in
play) — no new Discord application, no new token, nothing to add to
`.env` beyond `DISCORD_VOICE_CHANNELS` itself. It does need the **Connect**
permission on its existing server invite, because it physically joins the
allowlisted voice channel to receive per-user audio — the `GuildVoiceStates`
gateway intent is already wired in code (`broker/src/main.ts`) with nothing
to toggle in the Developer Portal, but that intent alone doesn't grant
Connect. If the original text-adapter invite was Read/Send + Manage
Webhooks only, add Connect via the server's bot-role permissions (or
re-invite with the added scope) before testing voice.

### Auto-join walkthrough

Setup: `DISCORD_VOICE_CHANNELS=<channel id>` in root `.env`, `DISCORD_TOKEN`
set, system `ffmpeg` on `PATH`. Restart the broker — boot log:
`[discord-voice] ear starting — N channel(s) allowlisted`, followed by one
line naming which designated agents have their own mouth (`agent mouths
(own bot token): ...`) and which are degraded (`agents degraded (share the
ear): ...`).

1. Join the allowlisted voice channel as a human.
2. **Expected:** the ear bot joins, then every `discord-voice`-designated
   agent with a token joins under its own name/avatar — the crew appears as
   real members in the channel's member list. Log: `[discord-voice] joined
   <channelId> — ear + N agent mouth(es)`.
3. Speak, addressing Ignacio by name. **Expected:** only Ignacio answers
   (meeting etiquette, unchanged); Discord's native speaking indicator
   lights under **his** member entry while his own ElevenLabs voice plays
   through his own bot connection — not the ear's.
4. Ask something that touches Wilkin's domain without addressing him.
   **Expected:** he holds per etiquette (raises a hand — ✋ in the app
   roster — rather than speaking), same rule as any text/Tauri meeting.
5. Check the app (Tauri transcript). **Expected:** the whole exchange lands
   there too — VC turns carry no channel origin, so they flow through the
   same free `onSpeechText` path as any meeting.
6. Leave the voice channel (last human out). **Expected:** the ear and
   every agent mouth leave immediately; log: `[discord-voice] left
   <channelId>`; the channel empties.

### Degradation check

1. Remove one designated agent's `DISCORD_TOKEN_<AGENTID>` from `.env` (or
   never set it) and restart the broker.
2. **Expected:** boot log lists that agent under `agents degraded (share
   the ear)` instead of `agent mouths`; a join-time log line
   (`[discord-voice] <agentId> has no bot token — speaking through the ear
   (degraded)`) fires once, not per utterance. In the channel that agent
   has no member presence of its own — its lines play through the ear
   bot's connection instead. Etiquette and the app transcript are
   otherwise unaffected.

### Mutual exclusion (single active audio surface)

1. Open a LiveKit meeting first (see [LiveKit meeting](#livekit-meeting)),
   then join an allowlisted Discord voice channel as a human.
   **Expected:** the VC join is declined, not queued — log:
   `[discord-voice] attach declined (a meeting is active or joining) — will
   retry on the next presence event`. The crew does not appear in the VC.
   Leaving and rejoining after the meeting closes retries successfully on
   its own (no restart needed — presence events retry automatically).
2. Reverse the order: join the Discord VC first, then try opening a
   LiveKit meeting. **Expected:** the meeting is declined instead — log:
   `[meetings] declined — a Discord voice session is live`. First come
   wins, either direction.

### Watch items (live audio only)

Things reviewers verified by code inspection across the fix rounds — only
a real call can confirm them:

- **Long uninterrupted turns vs. the 120s idle bound.** Playback batches an
  agent's speech into one continuous segment, closing only on a 400ms
  silence gap or a persona switch — a genuinely gapless multi-minute answer
  could in principle outrun `realGateway()`'s `entersState(..., Idle,
  120_000)` wait. Watch for an unusually long uninterrupted reply near the
  two-minute mark.
- **Channel-switch behavior isn't atomic.** If the crew is joined to
  channel A and presence moves it to channel B, `joinAll` leaves A fully
  before joining B; if joining B then fails, the surface ends up connected
  to neither. Watch a live channel switch and confirm it either completes
  cleanly or fails visibly (log line), never silently stranding the crew.
- **Chunk-seam audio quality.** TTS bytes are batched per segment and
  transcoded through ffmpeg + an Opus encoder once per segment, not once
  per chunk — listen across a multi-sentence reply for any audible seam or
  glitch where one `publishPcm` call's bytes meet the next inside the same
  segment.
- **The Opus encoder has no dedicated error listener of its own.** Errors
  on the upstream PCM input or the ffmpeg stage cascade forward via
  `.destroy(err)`, but an error originating in the encoder stage itself
  relies on whatever consumes the returned stream (`realGateway()`'s
  `createAudioResource`/`AudioPlayer` pipeline) to handle it. Watch for a
  clean "one segment lost, queue moves on" failure rather than an uncaught
  crash if TTS audio ever glitches mid-segment.
- **`AfterSilence` receive-window tuning (1000ms).** Each human speaker's
  audio subscription on the ear ends after 1s of silence and reopens fresh
  on their next speaking-start — a judgment call, not a spec'd value. It
  only affects how often a fresh Opus subscription/decoder spins up per
  speaker (Deepgram's own endpointing decides utterance boundaries), so a
  wrong value shouldn't affect correctness, but listen for choppy or
  dropped words right at natural pauses.
- **Dual gateway sessions under one token.** With both the Discord text
  adapter and Discord voice enabled under the same bare `DISCORD_TOKEN`,
  two separate discord.js gateway sessions run concurrently under that
  token (Discord permits this; untested here). Watch for anything unusual
  in the bot's Discord-side presence/status if both surfaces are live at
  once.

## All-local invariant

1. Comment out `DISCORD_TOKEN` in `.env`; restart the broker.
2. **Expected:** boot log says nothing about Discord; every local feature
   behaves exactly as before. Token set but `DISCORD_CHANNELS` empty →
   one readable boot warning ("the crew would attend nowhere"), broker
   continues normally.

## LiveKit meeting

Setup: `livekit-server --dev` (port 7880; dev keys already in `.env`).

1. `curl -X POST 127.0.0.1:7777/meetings -H 'content-type: application/json' -d '{"agent":"ignacio"}'`
2. **Expected:** broker's poll joins the room (log). Join the room with a
   LiveKit client using the returned token → speak → the crew hears (STT)
   and answers in per-agent TTS audio in the room. Close the meeting →
   broker leaves and resumes polling. (In-app meeting UX is not built yet
   — this validates the plumbing.)

## TTS stall chaos

Purpose: demonstrate the known follow-up (unbounded TTS latency inside the
turn queue) and verify the fix (`speak()` now bounds every TTS request with
`AbortSignal.timeout(TTS_TIMEOUT_MS)`). Requires a live meeting bridge
(see [LiveKit meeting](#livekit-meeting)) — without one, speech never
blocks and there is nothing to stall.

1. Temp fault injection — first line of `speak()` in `broker/src/main.ts`:
   `if (process.env.SMITH_TTS_HANG_MS) await new Promise((r) => setTimeout(r, Number(process.env.SMITH_TTS_HANG_MS)));`
2. Restart broker with `SMITH_TTS_HANG_MS=120000` and a short
   `TTS_TIMEOUT_MS=5000` (so the bound below doesn't take the full 30s
   default); open a meeting; then @mention the crew in Discord.
3. **Without the fault injection reverted, pre-fix behavior (the risk) would
   look like:** the reply's speech chunk hangs; a second Discord message AND
   a Tauri message both freeze until the delay elapses — the whole turn
   queue is parked.
4. **Actual (bounded TTS timeout) expected:** ~5s after the mention, the
   broker logs `[broker] speech chunk failed: Error: TTS timed out after
   5000ms — skipping this chunk`; the messages from step 3 answer within
   seconds; only one audio chunk is lost.
5. Revert the fault injection (or keep it env-gated as a chaos knob).

## Settings reset

1. Settings panel → reset, tier by tier. **Expected:** runtime reset
   clears live state; worktrees tier prunes `swarm/.smith/worktrees`;
   agents tier archives the roster wholesale (timestamped `*-archived-*`
   files) and the app returns to first-run.

## Theme

1. Toggle the theme in settings. **Expected:** immediate, persists across
   reload.

## Platforms

1. Desktop: `pnpm tauri dev` opens the native window.
2. Browser: `pnpm dev` → `http://localhost:1420` — full functionality
   (roster edit, sheets, workspace manager all work; verified 2026-07-28).
3. iOS: the Tauri iOS target builds (needs Xcode.app; mic plist present).

## Spanglish STT (2026-07-29)

- Broker up with no DEEPGRAM_LANGUAGE set; join a VC with the crew.
- Speak pure English → transcript quality unchanged; agent turn-taking timing feels the same.
- Speak pure Spanish → transcribed correctly (not English-mangled).
- Code-switch mid-sentence ("Ignacio, revisa el broker and ship it") → both halves correct.
- Watch for etiquette regressions: agents interrupting early/late means multi's endpointing
  behaves differently — if so, tune `endpointing` via a follow-up, don't revert the language.
- Repeat one Spanish utterance over the in-app PTT mic (same factory, second path).
- Set DEEPGRAM_LANGUAGE=en, restart, confirm English-only behavior returns (the escape hatch works).

## Surface presence modes (2026-07-29)

- Hover an agent's avatar (desktop) → popover lists Tauri app / Discord text / Discord voice with modes.
- Long-press the avatar (touch) → same popover.
- With the crew in a VC: flip an agent's Discord voice to **disabled** → their bot leaves the VC member list within a beat; others stay.
- Flip it back to **autojoin** while the crew is still in the VC → the bot rejoins.
- Set an agent to **on request**, have the crew join a VC → that agent stays out; press **Join now** → they join.
- Press **Join now** when the crew is NOT in a VC → inline "the crew isn't in a voice channel yet" error, button still enabled.
- Everyone leaves the VC and a human rejoins → the on-request agent stays out (admission cleared), autojoin agents return.
- Restart the broker mid-admission → the admitted on-request agent does not auto-return.
- Unset DISCORD_TOKEN and restart → both Discord rows render grayed with the "not configured" note.
- Hand-edit an agent file back to the legacy array form → behavior matches the pre-feature suite (text delivered, voice only when designated).
