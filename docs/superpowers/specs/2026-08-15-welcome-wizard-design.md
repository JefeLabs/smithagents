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

So the central screen of local-mode setup is **subscription triage**, not
installation. That is also the product's sharpest opening argument: *you are
already paying for several models; this is the thing that makes them argue with
each other.* No competitor whose product assumes one model can say it.

## Design principle: show the tradeoff, let them choose

The audience above changes what good onboarding looks like. A power user does not
need protecting from a decision — they need accurate information and the ability
to act on it. Every screen here follows from that, and the rule resolved four
separate questions during design:

- **Subscription triage** shows the real failure reason — "signed in as the wrong
  account", "workspace deactivated" — instead of a flat "unavailable". A vague
  status is useless to someone who could fix it in thirty seconds.
- **Configure Anderson** states measured latencies, so a slow default is a choice
  rather than a discovery made during a 29-second silence.
- **Hosted appears disabled** with "coming soon" rather than being hidden,
  because a missing option reads as a missing capability.
- **PR publishing is named as coming**, not implied as working, because a promise
  broken on the first task costs more than a feature deferred honestly.

The inverse — hiding a tradeoff to keep a flow smooth — optimises for the first
five minutes at the expense of every day after. This audience will read the
numbers and choose accordingly, and choosing well is exactly what they came for.

## Scope: v1 builds the local path; hosted is visible but disabled

**The hosted branch is designed below and deferred — but it still appears in the
UI, disabled, labelled "coming soon".** Showing it costs almost nothing and buys
two things: the user learns the local requirement is temporary rather than the
product's permanent shape, and the fork screen gets built now, so shipping hosted
later means enabling an option instead of inserting a step into a flow people
have already learned.

A disabled control that someone actively wants is a frustration unless it names
the way forward, so it never appears alone:

```
  ◉ Local — use your own subscriptions
  ○ Hosted — we run it for you            [ Coming soon ]
      no CLI to install, works on any device
      → notify me                          smithagents.com
```

The "notify me" link goes to `smithagents.com`, which is already owned — so the
disabled option still converts interest instead of discarding it.

**Hosted was the rescue for a user with nothing installed, and in v1 there is no
rescue.** That makes the subscriptions step load-bearing rather than convenient:
install a CLI or paste an API key, and nothing else gets you past it. Its
guide-and-validate behaviour is the whole safety net in v1.

Mobile and tablet are out of scope for the same reason — they have no local path
to offer, so they wait for hosted.

## Flow

```
  ── preflight: one screen, no step indicator ──
  What's your name?     → the greeting; creates the user record
  Voice mode?           → if yes, deepgram + elevenlabs become REQUIRED below
  Local or Cloud?       → selects which sequence follows
                          cloud visible but disabled — "coming soon"

  ── setup: the sequence the answers above selected ──
  Subscriptions         guide and validate; cannot continue until
                        a subscription or an API key works
                        + deepgram and elevenlabs, iff voice was chosen
  Configure Anderson    "Anderson needs a brain — choose from your
                        installed provider tools"
  Share your location?  → if yes, browser geolocation. Needs NO keys.
                          Then: topics of interest.
  Local workspace       what is it for — documents and/or coding?
                        version control and PR publishing?
                        GitHub required if coding OR version control

  ── the app works from here ──
  Integrations    optional
  Build a crew    optional
```

### Revision, 2026-08-17: preflight, and intent before requirements

The flow above replaces a flat list of peer steps. The correction, and why:

**Preflight is one screen, not steps.** Its three questions are *intent* — they
decide what the rest of setup must satisfy, so none of them belongs in a step
indicator, which would claim to know the sequence before the answer that picks
it. The name is asked because it produces the greeting; a wizard that collects
a name and never says it has taken something for nothing.

**Voice moved forward, and it gates.** Voice mode needs the `deepgram` (STT)
and `elevenlabs` (TTS) connectors. Asked at the end, it stranded the
Subscriptions step with an incomplete picture of its own requirements. Asked in
preflight it costs one radio and no credentials, and Subscriptions then knows
its full requirement set. **Choosing voice makes those two connectors
required** — the alternative, offering voice and then letting setup finish
without the two things voice cannot run without, is the "disabled control
someone actually wants" frustration this spec already rejects, one level up.

**Location moved forward, and it needs no keys.** Verified against the
implementations, not assumed:

| Source | Credential |
|---|---|
| `feeds/weather.ts` | **none** — Open-Meteo: "no key, no account, no quota worth worrying about". `lat,lon` only |
| `feeds/rss.ts` | **none** — news, blogs, government notices, YouTube, GitHub releases |
| `feeds/discovery.ts` | **none** — dispatches a CLI agent, which Subscriptions already guarantees |
| `feeds/topics.ts`, `feeds/interests.ts` | **none** — a topic is configuration; sources hang off it |
| `feeds/x.ts` | **an API key** — the only one, and it already degrades: no key returns `skipped` with a reason |
| `feeds/jira-poll.ts` | the existing atlassian connector (Integrations owns it) |

So this step asks for **permission and topics**, not credentials. `Location
(optional)` below still describes the payoff correctly — that section stands,
only its position and its "collect keys" implication change.

**Naming, fixed.** Two labels had drifted from this spec and would have
collided with later steps:
- The local/cloud fork was titled **"Location"**, which is a *different* step —
  the geolocation one above.
- *Configure Anderson* was titled **"Brain"**. This spec's name wins.

**"Cloud" in the UI, `hosted` on the wire.** The user-facing word is Cloud;
the stored `Setup["mode"]` value stays `"hosted"`, matching this spec's prose
and `control-plane/src/lib/cloud.ts`. Deliberate and recorded here so it is not
mistaken for the same drift as the two above. No migration is owed: the cloud
option has never been selectable, so no stored record can hold it.

**Every required step precedes every optional one.** Someone who abandons the
wizard after the workspace step still has a working app: a name, a brain, and
somewhere to put work. Everything after is upside, so quitting among the optional
steps costs nothing.

**First run is detected by the absence of a user record.** After a reset,
`swarm/.smith/users/` is empty; that is the sentinel, and no new flag is needed.

**The wizard is re-runnable from Settings.** Without this, testing it means
destroying an install — which is exactly what happened while designing it.

## The local branch

### Name

Creates the user record, which also clears the first-run sentinel — first run is
the **absence of a user record**, so no new flag is needed. Nothing else can
persist until this exists, so it goes first.

The CLI probe starts here, in the background. Typing a name is dead time; PATH
detection and auth probes run behind it so the next screen arrives populated
rather than spinning.

### Subscriptions — guide and validate

Built on the existing registry: `cli-tools.ts` separates `detected` (binary on
PATH) from `authOk` (driver auth probe), carries a human `detail`, exposes
`gateReason()`, and re-probes through `sweepCliTools()`.

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

**Nothing working is a stop, but never a dead end.** The user cannot continue
until something validates, and two routes are offered:

```
    → Install a subscription   claude · agy · codex · copilot   [copy command] [re-check]
    → Paste an API key         anthropic · gemini               [paste] [verify]
```

Three requirements:

- **Name the right problem.** "Not installed", "wrong account" and "billing
  dead" need different guidance. Collapsing them into "unavailable" reproduces a
  misdiagnosis made while writing this design.
- **Hand over the exact command**, then re-probe on demand. Running installers is
  out of scope for v1 — it means owning cross-platform package management for an
  audience that mostly has the binaries already.
- **Validate live.** A green row is not proof; the step completes on one real
  turn. Detection was wrong twice in one day during design.

### Configure Anderson

Which engine backs the brain — a subscription or a key. Separate from the step
above on purpose: that one asks *what is available*, this one asks *what Anderson
should use*. They are not the same choice, and today they diverge in practice —
this install runs Anderson on a Gemini **key** while its coding agents run on the
`claude` **subscription**.

Defaults to the strongest validated option so the step can be a confirmation
rather than a decision.

### Create a local workspace

Two questions, because they have different consequences:

```
  What is this workspace for?        Version control?
    ☑ Documents & design               ☐ Track changes and publish PRs
    ☐ Coding                              requires GitHub
```

**GitHub is required if coding OR version control is selected** — and only then.
Neither selected means no repo, no remote, and no GitHub prompt.

Neither selected means no repo, no remote, and no GitHub prompt — a documents-only
workspace is a complete workspace, not a degraded one, because the design side
touches no git at all. Coding, by contrast, requires an agent **CLI**: the
dispatcher has no `api` branch, so a task spawns a CLI into a worktree or it does
not run. Both facts, and the `assertContext` relaxation they require, are
specified in
[Repo-less contexts](2026-08-15-repo-less-contexts-design.md).

**PR publishing does not exist yet.** There is no push, no `gh pr create`, and no
use of the pulls API anywhere in `swarm/` or `broker/`; `dispatcher.ts:327`
appends *"Do not push"* to every task prompt. The checkbox may be offered and
stored as intent, but the copy must not promise behaviour that will not happen on
the first task. Building it should be a per-workspace opt-in, and it is what
finally justifies collecting GitHub here.

### What kind of work do you do? (optional, one question)

The board vocabulary that ships is **product-development shaped**, and it is
specific enough to feel wrong for other work:

- `plan`: queue → **spec** → **tech-design** → **decomposed** → ready
- `deliver`: queue → ready → in-progress → review → verify → **merged**

"Tech design", "decomposed" and above all **"Merged"** are software words. The
*skeleton* — Ideate → Plan → Deliver → Release, with React and Maintain alongside
— generalises well to most knowledge work. The vocabulary does not, and there are
**no column CRUD routes**, so a user cannot currently fix it themselves.

The vocabulary is product-development shaped — `plan` runs spec / tech-design /
decomposed, and `deliver` ends at **Merged**, a git word — and there are no
column CRUD routes, so a user cannot fix it. The skeleton (Ideate, Plan, Deliver,
Release, React, Maintain) generalises to most knowledge work; only the words do
not.

The wizard contributes one optional question, defaulting to product/software so
that skipping it reproduces today's behaviour exactly. Column ids, the migration,
and the vocabulary-as-data requirement are specified in
[Domain-neutral boards](2026-08-15-domain-neutral-boards-design.md).

### The fork, when hosted is enabled

The screen already exists from v1; hosted stops being disabled. Detection then
sets the default rather than the position — a working CLI preselects local,
nothing working preselects hosted.

```
  We found Claude and Antigravity here.     We didn't find any AI CLIs.
  ◉ Local — use your own subscriptions      ◉ Hosted — works right now
  ○ Hosted — nothing to install             ○ Local — install one, or use an API key
```

### Platform, when it returns

Desktop offers both paths; mobile and tablet default to hosted with no local
option shown, since a phone cannot spawn a CLI into a git worktree.


### Bring a key, or subscribe

```
    → I have an API key      anthropic · gemini        [paste] [verify]
    → Just subscribe         we run it for you
```

**Subscribing is a planned product, on the `smithagents.com` domain — but it is
not in this wizard.** Hosted registration is invite-gated today:
`/auth/register/options` returns 400 without a `code`, and codes come from
`auth.mintInvite()`. There is no open sign-up and no billing anywhere in the repo.

The wizard does not need to wait for either. **"Just subscribe" opens
`smithagents.com` and the wizard waits.** Sign-up and payment live on the site,
where they belong; the user returns with credentials and signs in here. That
makes the button real in v1 with no billing code in the app, and it does not
change when self-serve registration ships — the destination simply gains a
checkout.

> ### ⚠ Decide the passkey domain before the first real user registers
>
> `auth.rpId` is commented **"the tenant domain — fixed for life"**, and it
> defaults to `localhost` with `webOrigin` defaulting to
> `http://localhost:1420`. WebAuthn credentials are bound to the rpID that
> created them: passkeys registered under one rpID cannot be used under another,
> and there is no migration. Whatever `smithagents.com` strategy is chosen — apex
> versus a subdomain per tenant — must be settled **before** the first hosted
> registration, or those users are stranded. This is the highest-consequence,
> lowest-effort decision in the hosted path, and it is invisible until it is too
> late to change.

The rest of the hosted path is built: `control-plane/src/lib/cloud.ts`,
`LoginScreen.tsx`, and the broker's passkey stack (`/auth/register/options`,
`/auth/register/verify`, `/auth/login/options`, `/auth/login/verify`,
`/auth/me`, `/auth/logout`).

### Create or join a workspace

```
    → Create a cloud workspace
    → Join a team workspace          [invite code]
```

Joining is the invite flow that already exists: someone mints a code, the new
member registers with it. This is also the only way in today, which makes the
distinction above less of a fork than it appears until open sign-up lands.

## Both paths converge

A user who stops here has a working app: a name, a brain, and somewhere to put
work. **Every required step precedes every optional one**, so quitting among
these costs nothing.

The 2026-08-17 revision moved two of the sections below earlier in the flow, so
"everything below is optional" no longer describes this list as written. What
survives that move is the *invariant*, which is the part that mattered:
Integrations and Build a crew remain optional and skippable; Location remains
refusable; and voice is optional in the only sense that counts — nobody is
made to answer yes. Each section below is annotated with where it now sits.

### Voice mode — asked in preflight, satisfied in Subscriptions

**Superseded as an optional trailing step by the 2026-08-17 revision above.**
The *question* moved to preflight; the *credentials* are collected in
Subscriptions alongside the coding subscription.

Assign the `deepgram` (STT) and `elevenlabs` (TTS) connectors. Voice Mode may only
be enabled while **both** slots are filled — the existing invariant. That
invariant is exactly why the question moved: it means voice has a hard,
knowable requirement, and a requirement is worth knowing before the screen that
collects requirements rather than after it.

Answering **no** in preflight leaves voice off and everything else working,
which is the old "skipping" behaviour. Answering **yes** makes both connectors
required — see the revision note for why offering voice and then permitting a
finish without it is the frustration this spec already rejects.

### Location — asked after Configure Anderson

**Repositioned by the 2026-08-17 revision above**, and it needs no API keys;
see the credential table there. The payoff argument below is unchanged and is
the reason the step exists.

Feeds `feeds/weather.ts` (`weatherLine`, `weatherUrl`), which supplies the weather
line in Anderson's morning digest (`BrainTurn.digest`). Needs `lat,lon`, so
browser geolocation fits. **Name the payoff in the UI** — a permission prompt with
a stated reason converts far better than a bare one.

Timezone is **detected, never asked**. The agenda's midnight sweep is per-user and
date-keyed (`agendaSweptDay`), so a wrong zone sweeps plates at the wrong hour.

### Integrations (optional)

A skippable menu over the six vendors in `connectors.ts` — atlassian, github,
datadog, snyk, elevenlabs, deepgram. Deliberately late: asking for API credentials
before the user has seen anything work is the highest-friction ask at the moment
of lowest trust. Equally reachable from Settings afterwards.

### Build a crew (optional)

A fresh install ships **Anderson only** — that is the existing seeding
(`broker/.smith/identity.json`, tracked in git), and it is deliberate: get the
user going faster, and leave them something to explore. Crew building is offered
last and is genuinely skippable.

When taken, **engines spread across the working families**. Left alone people put
everyone on one CLI, and a council sharing one model is one mind in hats — see the
council turn design (2026-08-15). This is where the "your council spans 2 model
families" line from the subscriptions screen finally cashes out.

## The happy path, walked against a real machine

Traced step by step on the author's own install (claude and agy working, Anderson
on a Gemini key, a coding workspace with version control) — the setup v1 must be
able to reproduce.

| Step | Answer | API behind it | |
|---|---|---|---|
| Name | Edwin | `PUT /me` — `buildUserUpdate(existing, …)` creates when absent | ✓ |
| Local or hosted | Local | UI only | ✓ |
| Subscriptions | claude ✓, agy ✓ | `GET /cli-tools`, `POST /cli-tools/refresh` | ✓ |
| Paste a key instead | anthropic · google · openai | `saveAndVerifyKey`, `verifyStoredKey` | ✓ |
| **Configure Anderson** | CLI default (key = optional upgrade) | **none** | **✗** |
| Local workspace | coding + version control | `POST /workspaces`, `POST /me/connectors` | ✓ |
| Voice mode | deepgram + elevenlabs | `PUT /me/voice`, `POST /me/connectors` | ✓ |
| Integrations | atlassian, github | `POST /me/connectors` | ✓ |
| Build a crew | spread across claude/agy | `POST /agents` | ✓ |

**Exactly one step has nothing behind it, and the wizard cannot ship without it.**

### The blocker, in one line

`SMITH_BRAIN_PROVIDER` is read once at boot (`config.ts:74`, consumed
`main.ts:110`) with no route and no per-user storage, so configuring Anderson
means editing `.env` and restarting the broker — which is how this install was
set up by hand while writing this spec. A wizard cannot do that.

Engine kinds, measured latencies, frontier defaults and the streaming/tool-call
trade are specified in
[Brain engine selection](2026-08-15-brain-engine-selection-design.md).

### Prerequisites, each specced separately

**Two of these outrank the wizard itself.** The wizard assumes a person opens an
application and it works; today that person cannot exist, because a packaged app
starts no services and the broker will not boot without `.env`.

| # | Spec | Blocks |
|---|---|---|
| 0a | [Packaged runtime](2026-08-15-packaged-runtime-design.md) | any user who has not cloned the repo |
| 0b | [Env-free runtime](2026-08-15-env-free-runtime-design.md) | any user without a hand-written `.env` |


Three swarm/broker changes the wizard only consumes. Each is independently
testable and independently shippable, and none is wizard work:

| # | Spec | Blocks | Why first |
|---|---|---|---|
| 1 | [Brain engine selection](2026-08-15-brain-engine-selection-design.md) | *Configure Anderson* | the brain engine is boot-time config with no route; without it the step cannot exist at all |
| 2 | [Domain-neutral boards](2026-08-15-domain-neutral-boards-design.md) | *what kind of work* | column ids are software words; the id migration is free **only** while the install has zero cards |
| 3 | [Repo-less contexts](2026-08-15-repo-less-contexts-design.md) | documents-only workspace | `assertContext` demands `repos.length > 0` |

Priority is 1, then 2, then 3. **1** blocks the reference happy path outright.
**2** is second not by importance but by timing — its migration cost rises the
moment anyone creates a card. **3** blocks only the design-only branch, which the
reference user does not take.

Everything else the wizard needs already exists, confirmed by route inspection
rather than assumed: `PUT /me` (creates the user when absent), `GET /cli-tools`
and `POST /cli-tools/refresh`, `saveAndVerifyKey` / `verifyStoredKey` for
anthropic · google · openai, `POST /workspaces`, `POST /me/connectors`,
`PUT /me/voice`, and `POST /agents`.

## Reuse over rebuild

The subscriptions screen is useful long after onboarding — the author's own copilot and codex
problems are still unfixed. It should be a **permanent Settings screen that the
wizard borrows**, not wizard-only UI. The same is true of steps 4, 5 and 6, all
of which already have Settings homes.

## Live-verified bug the wizard will hit immediately

**Creating a workspace or an agent does not push an updated frame.** Verified
2026-08-15 against running services: after `POST /workspaces` and `POST /agents`,
the broker's `GET /workspaces` returned the new workspace correctly, but the
WebSocket **session frame still carried `workspaces: []`** and the roster frame
still listed only the seeded squads. The control-plane reads both from the socket
(`queries/pushed.ts` — `useWorkspaces` is `skipToken` with `staleTime: Infinity`,
push-only by design), so the UI showed an empty workspace picker and an empty
crew rail. **Restarting the broker fixed both**, confirming the mirror is built at
boot and never refreshed.

This lands squarely on the wizard: a user who completes setup — naming
themselves, creating their first workspace, picking a crew — would finish into an
app that shows none of it, with a restart as the only remedy. That is the worst
possible first impression, and it is invisible to any test that talks to HTTP
routes rather than watching the socket.

The fix belongs with whoever owns the broker's mirror: workspace and agent
mutations must re-broadcast the session and roster frames, the same way board and
document mutations already push their own.

## Error handling

- **Every step is resumable.** A user who quits mid-wizard returns to the step
  they left, not to the beginning. The user record from the name step is the
  anchor, and the local/hosted choice is remembered with it.
- **Optional steps never block.** Skipping voice, location, or connectors must
  leave a fully working app.
- **A failed probe is informative, never fatal.** A CLI that errors reports its
  reason and offers a re-check; it never strands the wizard.
- **Hosted login failure falls back to local**, and vice versa. Neither path may
  be a one-way door.

## Testing

Unit: first-run detection, platform gating (mobile/tablet never sees local),
step gating, resume-from-step, timezone detection,
`gateReason` rendering per failure class (missing / unauthenticated / billing).

**Live smoke, mandatory.** The reset performed while writing this design is the
fixture: wipe state, launch, and walk the wizard end to end against real
services. Three defects shipped this session with green suites, and the day's
Gemini adapter passed ten unit tests while being broken for multi-round tool
turns. Green tests do not prove reachability.

## Open questions

- Should the subscriptions step offer to run installers in v1, or stay copy-a-command? (Scoped
  out above; the audience mostly has the binaries.)
- For the repo path in a coding workspace, is choosing an existing local clone enough, or
  should the wizard also offer `git init` on a new folder?
- **Agents opening PRs does not exist** (no push, no `gh pr create`; the task
  prompt says "Do not push"). It is named as coming in step 5 copy. When it is
  built it should be a per-workspace opt-in, not a new default, since pushing
  from an agent worktree is a real behaviour change — and it is what finally
  justifies collecting GitHub in the workspace step.
- **Passkey rpID must be chosen before any hosted user registers** — it is
  "fixed for life" and defaults to `localhost`. Apex `smithagents.com`, or a
  subdomain per tenant? Credentials cannot be migrated between rpIDs.
- Does relaxing `repos.length > 0` belong in this plan, or as its own change
  landed first? It touches the swarm validator and every repo-reading caller,
  so it is arguably a prerequisite rather than wizard work.

**Settled during design:** the local/hosted fork sits second, right after the
name, with detection setting its default rather than its position. Earlier drafts
placed it after subscription triage.

**Superseded:** where the local/hosted fork belongs. It was first
placed after subscription triage, on the reasoning that the choice needs a
concrete inventory behind it. That was wrong: detection can set the fork's
*default and summary* without spending a whole screen on it, and triage is
local-mode content that a hosted-bound user should never have to walk through.
The fork sits at step 2, and nothing detected makes hosted the default.

## Out of scope

The hosted branch beyond a disabled "coming soon" control, mobile and tablet
surfaces, running installers on the user's behalf, billing or self-serve
sign-up (it links out to `smithagents.com`), crew *composition* beyond offering
the step, and the three prerequisite changes, each of which is specced
separately.
