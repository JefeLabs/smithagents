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
  Name                  ← CLI probe starts here, in the background
  Local or Hosted?      hosted visible but disabled — "coming soon"

  Subscriptions         guide and validate; cannot continue until
                        a subscription or an API key works
  Configure Anderson    use a subscription, or a key
  Local workspace       what is it for — documents and/or coding?
                        version control and PR publishing?
                        GitHub required if coding OR version control

  ── the app works from here ──
  Voice mode      optional
  Location        optional
  Integrations    optional
  Build a crew    optional
```

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

Two facts make this safe, both verified rather than assumed:

- **Coding requires a CLI; an API key cannot substitute.** The dispatcher has no
  `api` branch — `ApiRuntime` is referenced only by its own file and
  `server.ts`'s `/api-agents` routes, never by dispatch — so a coding task
  spawns a CLI into a worktree or it does not run.
- **Documents need no git whatsoever.** Documents live in
  `BROKER_DOCUMENTS_DIR ?? ".smith/documents"`, `documents.ts` and `doc-edit.ts`
  contain zero git references, and `CliResearch` spawns with no `cwd` so it never
  enters a repo. Boards, workspaces and squads are likewise plain JSON.

So a documents-only workspace is a complete workspace, not a degraded one. This
requires relaxing `assertContext`, which currently demands `repos.length > 0`;
that does not collide with groups, since `isGroupRecord()` keys on
`members !== undefined` and never on an empty repo list. Downstream, dispatch
must soft-fail with "this context has no repo" rather than assume `repos[0]`.

**PR publishing does not exist yet.** There is no push, no `gh pr create`, and no
use of the pulls API anywhere in `swarm/` or `broker/`; `dispatcher.ts:327`
appends *"Do not push"* to every task prompt. The checkbox may be offered and
stored as intent, but the copy must not promise behaviour that will not happen on
the first task. Building it should be a per-workspace opt-in, and it is what
finally justifies collecting GitHub here.

## Deferred: the hosted branch

**Not in v1.** Recorded because the decisions were made and the machinery
largely exists; skip this section when planning v1 work.

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

Everything below is optional. A user who stops here has a working app: a name, a
brain, and somewhere to put work. **Every required step precedes every optional
one**, so quitting among these costs nothing.

### Voice mode (optional)

Assign the `deepgram` (STT) and `elevenlabs` (TTS) connectors. Voice Mode may only
be enabled while **both** slots are filled — the existing invariant. Skipping
leaves voice off and everything else working.

### Location (optional)

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

### Configure Anderson — show the speed difference at the point of choice

Installation must not require obtaining anything, so this step **defaults to the
CLI the subscriptions step already validated**: no key, no `.env`, no restart.
But the choice has a large, measurable consequence, and it is named rather than
buried:

```
  How should Anderson think?

  ◉ Your Claude subscription          ready now — nothing to add
      ~6s before he starts talking
      ~29s when he uses a tool, and he won't talk while thinking

  ○ An API key  (anthropic · gemini)  much faster, and needed for voice
      ~1s before he starts talking, ~3s with a tool
      [ paste a key ]                            you can add this later
```

Measured on this machine, 2026-08-15, with a `{speech, tool_calls[]}` schema:

| Engine | Speech streams? | Structured tool calls? | First words | Total |
|---|---|---|---|---|
| `claude -p --output-format stream-json` | **yes** | no | 5.8s | 7.3s |
| the same **plus** `--json-schema` | **no** | **yes** | — | 28.7s |
| `claude -p --json-schema` (no stream) | no | yes | — | 26.5s |
| Gemini API (`gemini-brain.ts`) | **yes** | **yes** | ~0.9s | 3.3s |
| `agy -p --json-schema` | no | **did not enforce** | — | 18.5s |

**This corrects, and then partly restores, an earlier conclusion.** The brain was
put on an SDK (main @ `d943132`) because a CLI supposedly cannot accept
caller-defined tool schemas without MCP inverting control. That reasoning was
wrong: `--json-schema` does exactly that, with execution still in the broker. But
the table shows a real constraint underneath it — **a CLI can stream speech, or
return structured tool calls, never both in one turn.** Schema enforcement
suppresses incremental text entirely. A voice brain needs both, which is what the
SDK path uniquely provides.

Hence the shape of this step: the CLI default costs nothing to set up and is
honest about feeling slow, while the key is presented as the upgrade that makes
voice work. Nobody is blocked, and nobody is surprised later by a 29-second
silence.

`agy` is not offered as a brain until its `--json-schema` invocation is worked
out; it accepted the flag and answered *about* the schema instead of obeying it.

### The prerequisite this creates

The default above is only reachable if the brain engine is *settable*.
`SMITH_BRAIN_PROVIDER` is read once at boot (`config.ts:74`, consumed
`main.ts:110`) with no route and no per-user storage — configuring Anderson today
means editing `.env` and restarting the broker, which is how this install was set
up by hand while writing this spec. A wizard cannot do that.

**The fix is precedented.** The research engine solved the identical problem:
`User.researchEngine?: {cli, model}` persists per user, `PUT /me/research-engine`
sets it, and it resolves per call rather than at boot. The brain wants the same:

- `User.brainEngine?: {kind: "cli" | "key", provider, model}` on the user record
- `PUT /me/brain-engine`, mirroring the research route
- the broker resolving the brain **per turn**, so a change needs no restart
- `SMITH_BRAIN_PROVIDER` demoted to a fallback, preserving today's behaviour

It is what lets someone move from the free-but-slow default to the fast path
without touching a dotfile — which is the whole point of offering both.

### Prerequisites, collected

1. **`PUT /me/brain-engine`** plus per-turn brain resolution — blocks *Configure
   Anderson*, and therefore the zero-friction CLI default as well as the API-key
   upgrade path.
2. **Relax `assertContext`'s `repos.length > 0`** — blocks a documents-only
   workspace. Does not block the author's own coding path, so it is the lower
   of the two priorities.

Everything else the wizard needs already exists and was confirmed by route
inspection rather than assumed.

## Reuse over rebuild

The subscriptions screen is useful long after onboarding — the author's own copilot and codex
problems are still unfixed. It should be a **permanent Settings screen that the
wizard borrows**, not wizard-only UI. The same is true of steps 4, 5 and 6, all
of which already have Settings homes.

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
