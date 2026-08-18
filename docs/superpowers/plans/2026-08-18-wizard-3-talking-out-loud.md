# Wizard Plan 3 — Talking out loud

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The wizard's Step 3 — *"Would you like to talk to me out loud?"* — with the hosted path (Deepgram listens, ElevenLabs speaks) fully working, a real voice preview, and on-device honestly named as coming.

**Architecture:** A `WizardVoiceStep` after the roles step. Hosted setup reuses the shipped connector machinery (create + live verify) and assigns the `stt`/`tts` slots via the already-proxied `PUT /me/voice`. The one net-new surface is a broker preview endpoint reusing the existing `speak()` pipeline. On-device renders disabled with the way forward named — the download subsystem is its own later plan, shared with Plan 5's embeddings.

**Spec:** `docs/superpowers/specs/2026-08-18-welcome-wizard-local-setup.md`, Step 3.
**Roadmap:** `docs/superpowers/plans/2026-08-18-wizard-sequence-roadmap.md`

---

## What is already true — measured, not assumed

| Claim | Reality |
|---|---|
| Slot model | `VoiceSettings { stt?: {instanceId}, tts?: {instanceId}, enabled? }` (`swarm/src/users.ts:18-25`). **`enabled` may only be true while BOTH slots are assigned** — the invariant is enforced on load (`:140`) |
| Save path | `GET/PUT /me/voice` exists on swarm (`server.ts:2397,2402`) **and is already proxied** by the broker (`text-channel.ts:1077,1082`). No new passthrough needed for it |
| Connectors | deepgram + elevenlabs vendors with **live verification** (`swarm/src/verify-deepgram.ts`, `verify-elevenlabs.ts`), managed via the existing connectors endpoints the Settings VoiceGroup already uses |
| TTS pipeline | broker `speak()` (`main.ts:281`) — `currentTts()`, per-speaker cast (`elevenVoiceFor`), 402-fallback to `PREMADE_STANDINS`, timeouts, audio as `{type:"audio", mime, dataB64}` frames |
| On-device | **Nothing.** `LocalVoiceProvider` is a TTS-only shell needing an external Piper/MLX binary (not installed, no installer); **no local STT exists anywhere in the repo** |
| Preview | **No endpoint.** Net-new |
| This machine | `connectors: []` — no deepgram or elevenlabs credential stored. The live walk exercises the empty and refusal paths honestly |
| `Setup.voice` | `voice?: boolean` still on both types, currently written by skip defaults only |

### Ruling from the user (supersedes the spec's "On-device is preselected")

**Hosted ships now; on-device is named as coming.** No local STT exists and the
local TTS binary is neither installed nor installable from here — preselecting
it would preselect a thing that cannot work. On-device renders as a disabled
option that names the way forward ("needs a small download — coming soon"),
exactly the treatment Cloud gets at the gate. The download subsystem is its own
later plan, built once for Piper AND Plan 5's embeddings.

## Global Constraints

- **The spec's copy IS the design** — first person, asking not instructing:
  "Would you like to talk to me out loud?" / "Yes, let's talk" / "Not right
  now" / "How should I listen and speak?" / "How should I sound?" /
  "▶ Say something".
- **pnpm, never npm.** `pnpm --filter control-plane test -- <name>` does NOT
  filter — `pnpm exec vitest run <name>` cwd `control-plane/`. swarm/broker are
  the node runner (`pnpm test`).
- **Baselines on `1363205`:** control-plane **1099 pass / 2 fail (1101)** (the
  two fail in isolation — `MapStage` pan-mode-toggle, `HomePage`
  composer-backs-out; neither is yours); swarm **662/0**; broker **678/0**;
  `tsc` 10 (cp) / 12 (swarm, pre-existing) / 0 (broker); biome **1 info**.
- **`brokerFetch` never throws on a non-2xx** — reject = network (stay
  optimistic), resolved `{error}` = firm no (roll back, show the sentence).
  Map errors to human sentences: the walk already found raw "Failed to fetch"
  leaking on the roles path; do not add another instance.
- **Setup MERGES.** Answer changes send explicit values — `voice: false` when
  declined, never an omission. `skipDefault()` never returns `{}`; `skipLabel`
  never the bare word "Skip".
- **Obey `WizardSaveState`**; every control that can start a write is inert
  while one is in flight; no guard outlives its write.
- **Never a dead end.** "Not right now" must always be selectable — a user who
  chose voice and cannot verify keys retreats by answering No, not by being
  trapped. The both-slots gate applies only while "yes" is the answer.
- **Questions are `<h2>`; no `<h1>` on setup steps.** Quiet interactive
  controls take `--text-2` (≥4.5:1), never `--text-dim`. New surfaces inside
  the panel use `--surface-raised` (panel and sticky footer move together).
- **tsx does not hot-reload** — the broker (and swarm, if touched) needs a
  restart for new routes; verify on BOTH ports where a route is proxied.
  Broker restart: `tmux kill-session -t smith-broker` then
  `tmux new-session -d -s smith-broker -c <repo>/broker 'node --env-file=../.env --import tsx src/main.ts'`.
  Swarm runs supervised in tmux `smith-swarm`.
- **First-run technique:** `PUT setup.step` — never move the record file.
- **529 protocol:** write your report file INCREMENTALLY. If your session dies
  you will be resumed by message with your context intact.
- **jsdom has no layout and no audio.** The preview's actual sound and the
  step's geometry need the walk.

---

## File Structure

- `broker/src/main.ts`, `broker/src/text-channel.ts` — **modify.**
  `GET /voice/options` (the curated voice list) and `POST /voice/preview`
  (synthesize one line, return audio). Broker-native — TTS lives here; no
  swarm hop.
- `broker/src/voice-preview.test.ts` — **create.**
- `control-plane/src/organisms/WizardVoiceStep.tsx` + test — **create.**
- `control-plane/src/queries/http.ts`, `keys.ts` — **modify.** Hooks for
  voice options/preview/settings.
- `control-plane/src/lib/wizardSteps.ts` + test — **modify.** `voice` step
  after `roles`; skip default `{voice: false}`.
- `control-plane/src/organisms/WizardGate.tsx` + test — **modify.** Render it.

---

### Task 1: The broker can say something on demand

**Files:** `broker/src/main.ts`, `broker/src/text-channel.ts`,
`broker/src/voice-preview.test.ts` (+ any module the arms need).

**Interfaces produced:**
- `GET /voice/options` → `{ options: [{ id, label }] }` — the curated "How
  should I sound?" list, derived from the existing cast/stand-ins data, not a
  second hardcoded list.
- `POST /voice/preview` body `{ voiceId: string, text?: string }` → on
  success `{ mime: "audio/…", dataB64 }`; with no TTS configured a **resolved
  `{error}` carrying a human sentence** ("I don't have a voice yet — paste an
  ElevenLabs key and I'll try again"), never a bare 500.

Reuse `speak()`'s machinery — `currentTts()`, the timeout guard, the 402
stand-in fallback. Do not build a second ElevenLabs client. Default preview
text is Anderson's own line (pick one short sentence in his voice and keep it
in one constant).

- [ ] Tests first, red, then implement. Cover: options derived (not
  duplicated); preview success shape; the no-TTS refusal is a RESOLVED
  human-sentence error; a provider throw surfaces as `{error}`, not a hang.
- [ ] **Live:** restart the broker; `curl` both routes. With no key on this
  machine, `POST /voice/preview` must answer the refusal sentence — that IS
  the expected live result; say so rather than inventing a success.
- [ ] Commit: `feat(broker): a voice options list, and a preview that can say something`

### Task 2: The step — *Talking out loud*

**Files:** `control-plane/src/organisms/WizardVoiceStep.tsx` + test;
`queries/http.ts`, `keys.ts`.

Copy per the spec + ruling. Requirements, all load-bearing:
- "Not right now" is the default answer and always selectable (the retreat).
- On yes: **on-device disabled** with both native `disabled` and
  `aria-disabled` (the react-aria hand-authored-radio pattern from the gate —
  move that reasoning, don't re-derive it), copy naming the way forward.
  **Hosted preselected.**
- Hosted expands to the two key fields with **live verification through the
  existing connector machinery** — reuse, don't reimplement. Assign both
  slots via `PUT /me/voice { stt, tts, enabled: true }` only when both
  connectors verify (the invariant).
- "How should I sound?" renders `GET /voice/options`; **▶ Say something**
  plays the preview (`Audio` from the base64) and surfaces the refusal
  sentence inline when it fails. The button is inert while a preview is in
  flight.
- Continue with "yes" gates on both slots verified; Continue with "not right
  now" always enabled and emits `{ setup: { voice: false } }` explicitly.
- [ ] Tests first (state what wrong implementation would also pass each);
  mutation-check the gate and the explicit-false emission. Commit.

### Task 3: Into the sequence

**Files:** `wizardSteps.ts` + test, `WizardGate.tsx` + test.

- `voice` after `roles` (the user's ruling: voice is secondary to the brain).
  Local sequence: `sources, roles, voice` — progress honestly `Step n of 3`.
- Registry entry: `skipLabel` stating the default ("Skip — I'll stay
  text-only"), `skipDefault: () => ({ voice: false })`.
- "Just pick sensible things for me" picks up the new default automatically
  (it composes from the registry — verify with the existing pattern, and
  account for the test-count delta).
- [ ] Tests first; check `resumeStep` handles a record already carrying
  `voice` from the preflight era. Commit.

### Task 4: Walk it

**No key exists on this machine**, so the honest walk is: the No path
end-to-end (record shows explicit `voice: false`); the Yes path up to the
gate (Continue correctly blocked with unverified slots, "Not right now"
still selectable — THE no-dead-end proof); the preview refusal sentence
rendered inline; on-device visibly disabled with its copy; themes (midnight
minimum, sand if time); `Step n of 3` everywhere; reload resume mid-step.
Use `PUT setup.step`, never move the record. Write the report incrementally.
If a real ElevenLabs key becomes available, the full preview is a bonus, not
a requirement — say which ran.

---

## Self-Review

Spec coverage: the three questions, hosted path, preview, on-device named as
coming (ruling), Skip default, sequence position — Tasks 1-4. Deliberately
out: on-device (later plan, shared download subsystem), any STT beyond
Deepgram, voice cloning. Type consistency: `/voice/options` and
`/voice/preview` shapes produced in Task 1 are consumed by Task 2's hooks;
the `voice` step id added in Task 3 is rendered by the same task's host
change. Known risk: Task 2 gating on "both connectors verify" must read the
CONNECTOR verification state, not merely "a key was typed" — a stored-but-
unverified key counting as verified is the discriminating case; pin it.
