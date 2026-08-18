# Welcome Wizard — the new sequence, plan split

**Spec:** `docs/superpowers/specs/2026-08-18-welcome-wizard-local-setup.md`

Six plans. **Each leaves a working, walkable wizard** — none depends on a later
one to be shippable, and each replaces something rather than half-building the
next thing.

The ordering rule: the shell first, because every step hangs off it; then the
steps in the order the user meets them, because a half-migrated sequence is
harder to reason about than a fully-migrated prefix.

---

## Plan 1 — The gate, Anderson's voice, and the shell rules

Replaces preflight with the **gate**, and installs the four rules the rest of
the sequence assumes.

- Anderson introduces himself; first-person copy throughout; `{name}` threading.
- Gate: *"What shall I call you?"* + *"Where would you like me to live?"*,
  unnumbered, **no progress bar**.
- Collapses to the persistent, clickable **chip** — with its clear-semantics:
  keeps name, small talk, current events, memory, permissions; **clears** brain
  source, models, voice backend, **and says so specifically**; switches
  silently before the provider step.
- **Skip with a stated default** on every step after the gate, and
  **`Step n of 6`** honesty.
- **`Just pick sensible things for me`** — the mechanism, which applies every
  registered step default at once. Later plans register their own defaults into
  it; this plan proves it with the two steps that exist today.

**Leaves working:** the gate, the chip, skip/progress/re-run — with today's
Subscriptions and Anderson steps still behind them, re-worded to Anderson's
voice.

---

## Plan 2 — Step 1 *Where I think* · Step 2 *What I think with*

The two steps that replace today's Subscriptions + Anderson. Planned together
because Step 2's dropdowns are a view over exactly what Step 1 configured;
splitting them would ship a role-picker with one source in it.

- Step 1: multi-select over **logins (pre-checked from the probe)**, **your own
  API keys** (inline, live verification), **models on your machine** (runtime
  check for Ollama / LM Studio).
- Step 2: **main brain · quick little things · fallback**, every dropdown
  mixing all configured sources rather than grouping by origin; local picks show
  size with inline download progress; RAM-aware advice.

**Rests on:** `BrainEngine.kind: "cli" | "local" | "api"` — already the shipped
type — and `broker/src/local-brain.ts`, already an OpenAI-compatible brain for
LM Studio/Ollama.

**Net-new:** local-server runtime detection, model listing/size/download
progress, RAM detection, and a third *fallback* role.

---

## Plan 3 — Step 3 *Talking out loud*

- *"Would you like to talk to me out loud?"*; on **yes**, on-device vs hosted,
  with **on-device preselected** because it matches the gate's promise.
- Hosted expands to Deepgram (listen) + ElevenLabs (speak).
- *"How should I sound?"* with a real **`▶ Say something`** preview.

**Rests on:** `voice/src/providers/local-voice-provider.ts`, the deepgram and
elevenlabs connectors with verification, and `voiceId` on the voice config.

**Net-new:** the voice chooser and the preview round trip.

---

## Plan 4 — Step 4 *How I talk*

- *"Should I make small talk?"* — two stated behaviours, not a toggle label.
- *"Should I keep up with what's happening in the world?"* → search provider
  (**Brave**) plus its key.

**Net-new:** the whole web-search provider. Nothing in the repo does this today.

---

## Plan 5 — Step 5 *Remembering, and what I may do*

The largest plan, and **two subsystems rather than one screen**.

- **Conversation memory**, and the embeddings fork: *a login genuinely cannot do
  embeddings*, so a login-only user meets a real requirement here and is offered
  a **small download** rather than being pushed into buying a key. This fork is
  what makes the login-only path honest.
- **The permissions matrix** — read files · run commands · browse the web, each
  *ask first / go ahead / never* — plus the storage path.

**Net-new:** both. Recommend splitting into 5a (memory + embeddings) and 5b
(permissions) if 5a's scope grows once its own spec exists.

---

## Plan 6 — Step 6 *Before we start*

- Editable summary; **every line jumps back to its step**.
- **Receipts, not restatements.** Each tick is something actually exercised —
  a real login check, a real question answered with a measured latency, a real
  voice tried.

**The risk this plan carries:** receipts are the easiest thing in the whole
sequence to fake, and faking them is worse than omitting them. A static
"✓ I checked my login — it works" is a lie the user eventually catches. Every
tick must be produced by an operation that ran.

---

## What the sequence drops

**The workspace step**, deliberately — see the spec. Setup ends at *Before we
start*; a workspace is created from the app when there is something to put in
it, which repo-less contexts already allow.

## Carried debt to fold in, not to forget

- **The wizard ignores the saved theme** — `useTheme()` runs only in `HomePage`,
  a child of `WizardGate`, so it never mounts while the wizard is up. Every
  wizard screen renders light on a machine set to midnight. **Fix in Plan 1**,
  since Plan 1 owns the shell.
- **Settings → Containers CSS regression** — `.connector-card label` reaches
  `ContainersGroup`'s Docker checkbox. Independent of the wizard; fix separately.
- **`MapStage.test.tsx` is load-fragile** — two tests fail transiently under
  full-suite load. Every plan here adds tests and makes it surface more often.
