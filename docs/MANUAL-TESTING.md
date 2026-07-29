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
turn queue) and verify the fix once landed. Requires a live meeting bridge
(see [LiveKit meeting](#livekit-meeting)) — without one, speech never
blocks and there is nothing to stall.

1. Temp fault injection — first line of `speak()` in `broker/src/main.ts`:
   `if (process.env.SMITH_TTS_HANG_MS) await new Promise((r) => setTimeout(r, Number(process.env.SMITH_TTS_HANG_MS)));`
2. Restart broker with `SMITH_TTS_HANG_MS=120000`; open a meeting; then
   @mention the crew in Discord.
3. **Pre-fix expected (the risk):** the reply's speech chunk hangs; a
   second Discord message AND a Tauri message both freeze until the delay
   elapses — the whole turn queue is parked.
4. **Post-fix expected (bounded TTS timeout):** the hung call aborts after
   its bound with a readable log line; the messages from step 3 answer
   within seconds; only one audio chunk is lost.
5. Revert the patch (or keep it env-gated as a chaos knob).

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
