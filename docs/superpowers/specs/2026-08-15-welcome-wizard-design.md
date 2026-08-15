# Welcome Wizard — Design

**Status:** design, awaiting review
**Date:** 2026-08-15

## Goal

A first-run experience that takes someone from a cold install to a working
Anderson, without a wall and without a shopping list of credentials.

## Who this is for, and why it changes the design

**The target user is a super user with several AI subscriptions already paid
for.** That single fact reshapes onboarding.

The conventional assumption — a new user has nothing and must be walked through
installing something — is wrong here. They have the binaries. What they do not
have is an accurate picture of which of their subscriptions actually work right
now. Measured on the author's own machine, 2026-08-15:

| CLI | Family | Reality |
|---|---|---|
| `claude` | Anthropic | working |
| `agy` | Google | working |
| `copilot` | GitHub | binary present, **signed in as the wrong account**, org policy blocks it |
| `codex` | OpenAI | binary present, **workspace deactivated** (402) |
| `opencode` | — | present, unprobed |

Five installed, two usable, and the two failures had completely different causes
— neither of which was "not installed", and one of which was misdiagnosed as an
entitlement problem before the identity file was read.

So the central screen of this wizard is **subscription triage**, not
installation. That is also the product's sharpest opening argument: *you are
already paying for several models; this is the thing that makes them argue with
each other.* No competitor whose product assumes one model can say it.

## Flow

```
1. What should we call you?      required   ← probe starts here, in the background
2. Your subscriptions            required   — triage: what you have, what's broken, why
3. Local or hosted?              required   — the fork, made with the inventory in hand
4. Your first workspace          required   — where work lives
   ══ the app works from here ══
5. Voice mode?                   optional   — deepgram + elevenlabs
6. Location?                     optional   — powers the weather line in the digest
7. Connect your tools            optional   — atlassian, github, datadog, snyk
   ── finish ── Anderson is here. You can add a crew → [Agents]
```

Three ordering rules produced this shape:

**The probe starts during step 1.** Typing a name is dead time; PATH detection
and auth probes run behind it, so step 2 is already populated on arrival instead
of showing a spinner.

**Triage precedes the fork.** The local-versus-hosted choice is only meaningful
once the user knows what local is worth. Asked first, it is a choice between two
abstractions thirty seconds into the product; asked after triage, it is a choice
between a concrete inventory ("claude ✓, agy ✓ — two model families") and an
alternative. It also puts hosted in front of the person whose screen came back
all warnings at exactly the moment their problem became real, which converts far
better than offering it before they knew they had one.

The cost — someone who already intends to go hosted sits through a local
inventory — is paid down with a persistent "use the hosted version instead"
affordance on the triage screen, not by reordering.

**Every required step precedes every optional one.** A user who abandons the
wizard after step 4 still has a working app: a name, a brain, and somewhere to
put work. Optional steps are pure upside, so nothing is lost by quitting among
them. This is the "get going faster" principle applied to ordering.

**First run is detected by the absence of a user record.** After a reset,
`swarm/.smith/users/` is empty; that is the sentinel. No new flag.

**The wizard is re-runnable from Settings.** Without this, testing it means
destroying an install, which is exactly what happened while designing it.

### Step 1 — Name (required)

Creates the user record, which also clears the first-run sentinel. Nothing else
in the wizard can persist until this exists.

### Step 2 — Your subscriptions (required)

The screen that earns the wizard. Built entirely on the existing registry:
`cli-tools.ts` already distinguishes `detected` (binary on PATH) from `authOk`
(driver auth probe), carries a human `detail`, exposes `gateReason()`, and
re-probes via `sweepCliTools()`.

```
Your subscriptions
  claude    Anthropic   ✓ working
  agy       Google      ✓ working
  copilot   GitHub      ⚠ signed in as edwin-skoolscout — org policy blocks it
                          → copilot login                      [re-check]
  codex     OpenAI      ⚠ workspace deactivated — billing      [re-check]
  opencode  —           · not detected                          [how to install]

  Your council spans 2 model families.
```

Three requirements fall out of the table above:

- **Name the right problem.** "Not installed", "wrong account", and "billing
  dead" need different guidance. Collapsing them into "unavailable" reproduces
  the misdiagnosis this design was written after.
- **Hand over the exact command** with a copy button, then re-probe on demand.
  Actually *running* installers is deliberately out of scope for v1 — it means
  owning cross-platform package management and every failure mode of someone
  else's installer, for an audience that mostly already has the binaries.
- **Prove it live.** A green row is not proof. Completing the step runs one real
  turn against the selected engine. Detection has been wrong twice in one day;
  a probe that never runs looks exactly like a passing one.

### Step 3 — Local or hosted (required)

Made with the inventory from step 2 in hand, so it is a choice between
something concrete and an alternative rather than between two abstractions.

**Adaptive local vs hosted.** Probe before asking. Working CLI found → local
preselected, hosted offered as the alternative. Nothing working → lead with
hosted, which works instantly, and offer guided local setup second. Developers
with a working setup are never nagged; everyone else gets the path that works.

The hosted path is largely built: `control-plane/src/lib/cloud.ts`,
`LoginScreen.tsx`, and a full broker passkey stack (`/auth/register/options`,
`/auth/register/verify`, `/auth/login/options`, `/auth/login/verify`,
`/auth/me`, `/auth/logout`, `/auth/invites`). For this audience hosted is rarely
"I have nothing" — it is "use my crew from my phone, or a teammate's machine".

### Step 4 — Your first workspace (required)

Boards, sessions, and documents all hang off a workspace; without one there is
nowhere to put anything. Reuses the shipped new-workspace flow.

### Step 5 — Voice mode (optional)

Assign the `deepgram` (STT) and `elevenlabs` (TTS) connectors. Voice Mode may
only be enabled while **both** slots are filled — the existing invariant. Skipping
leaves voice off and everything else working.

### Step 6 — Location (optional)

Feeds `feeds/weather.ts` (`weatherLine`, `weatherUrl`), which supplies the
weather line in Anderson's morning digest (`BrainTurn.digest`). Needs `lat,lon`,
so browser geolocation fits. **Name the payoff in the UI** — a permission prompt
with a stated reason converts far better than a bare one.

Timezone is **detected, never asked**. The agenda's midnight sweep is per-user
and date-keyed (`agendaSweptDay`), so a wrong zone sweeps plates at the wrong
hour. Show what was detected and let it be corrected.

### Step 7 — Connect your tools (optional)

A skippable menu over the six vendors in `connectors.ts` — atlassian, github,
datadog, snyk, elevenlabs, deepgram. Deliberately **last**: asking for API
credentials before the user has seen anything work is the highest-friction ask at
the moment of lowest trust. Equally reachable from Settings afterwards.

### Finish — Anderson, and the crew you could have

A fresh install ships **Anderson only**, matching existing seeding
(`broker/.smith/identity.json`, tracked in git). The wizard does not create a
crew: it is a longer decision than onboarding should carry, and Anderson alone is
genuinely useful.

The reasoning is deliberate and worth stating, because it should govern later
additions to this flow too: **get the user going faster, and leave them something
to explore.** Onboarding earns its keep by reaching a working Anderson in as few
decisions as possible. Everything discovered afterwards — a crew, a council
spanning model families, connectors — is depth the user goes looking for once
they already have something working. A wizard that front-loads all of it trades
a fast start for a long form, and loses both.

But the council pitch must not vanish. Step 2 states the payoff ("your council
spans 2 model families") and the finish screen carries the pointer to Agents.
The promise lands; the work is deferred.

When a crew is created later, **engines spread across the working families** —
left alone, people put everyone on one CLI, and a council sharing one model is
one mind in hats. See the council turn design (2026-08-15).

## Reuse over rebuild

Step 2 is useful long after onboarding — the author's own copilot and codex
problems are still unfixed. It should be a **permanent Settings screen that the
wizard borrows**, not wizard-only UI. The same is true of steps 4, 5 and 6, all
of which already have Settings homes.

## Error handling

- **Every step is resumable.** A user who quits at step 3 returns to step 3, not
  to the beginning. The user record from step 1 is the anchor.
- **Optional steps never block.** Skipping voice, location, or connectors must
  leave a fully working app.
- **A failed probe is informative, never fatal.** A CLI that errors reports its
  reason and offers a re-check; it never strands the wizard.
- **Hosted login failure falls back to local**, and vice versa. Neither path may
  be a one-way door.

## Testing

Unit: first-run detection, step gating, resume-from-step, timezone detection,
`gateReason` rendering per failure class (missing / unauthenticated / billing).

**Live smoke, mandatory.** The reset performed while writing this design is the
fixture: wipe state, launch, and walk the wizard end to end against real
services. Three defects shipped this session with green suites, and the day's
Gemini adapter passed ten unit tests while being broken for multi-round tool
turns. Green tests do not prove reachability.

## Open questions

- Should step 2 offer to run installers in v1, or stay copy-a-command? (Scoped
  out above; the audience mostly has the binaries.)
- Should the wizard offer to import an existing repo as the first workspace, or
  only create an empty one?

**Settled during design:** where the local/hosted fork belongs. It was
considered immediately after the name and placed after subscription triage
instead, so the choice is made against a concrete inventory rather than in the
abstract, and hosted reaches the user whose triage came back all warnings at the
moment the problem became real. The cost — a hosted-bound user sitting through a
local inventory — is paid down with an escape affordance on the triage screen.
