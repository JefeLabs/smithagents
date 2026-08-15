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

## Flow

```
1. What should we call you?      required   ← probe starts here, in the background
2. Local or hosted?              required   — the fork; detection picks the default
3. Is this a coding workspace?   required   — decides engine kind AND repo, in one question
4a. (local)  Your engine         required   — coding → a CLI; design → a CLI or an API key
4b. (hosted) Sign in             required   — passkey register/login
5. Your workspace                required   — coding → repo + source control; design → a name
   ══ the app works from here ══
6. Voice mode?                   optional   — deepgram + elevenlabs
7. Location?                     optional   — powers the weather line in the digest
8. Connect your tools            optional   — atlassian, github, datadog, snyk
   ── finish ── Anderson is here. You can add a crew → [Agents]
```

**One question decides the shape of the rest.** "Is this a coding workspace?"
is asked once, early, and tailors two later steps — because the coding answer
carries a hard technical consequence that is easy to miss:

**Coding work requires an agent CLI; an API key cannot substitute.** The
dispatcher has no `api` branch — `ApiRuntime` is referenced only by its own file
and `server.ts`'s `/api-agents` routes, never by dispatch — so a coding task
spawns a CLI into a worktree or it does not run. Design work is the opposite: it
goes through the broker's `ResearchEngine`, which is satisfied by
`AnthropicResearch` on a plain key.

| Answer | Engine needed | Repo needed | Source control |
|---|---|---|---|
| **Coding** | a working **CLI** (`claude`/`agy`/…) | yes, local clone | offered |
| **Design** | a CLI **or** an API key | none | not asked |

Asking this before engine setup means a design-only user is never told they must
install a CLI they do not need, and a coding user is never allowed to finish with
only a key — which would look fine on the setup screen and then fail on their
first task.

Three ordering rules produced this shape:

**The probe starts during step 1.** Typing a name is dead time; PATH detection
and auth probes run behind it, so the fork already knows what is on the machine
before the user gets there.

**The fork comes second, and detection sets its default — not its position.**
The choice still has to be informed, but a one-line summary and a preselected
option carry that just as well as a full inventory would, at a fraction of the
cost:

```
  We found Claude and Antigravity here.     We didn't find any AI CLIs.
  ◉ Local — use your own subscriptions      ◉ Hosted — works right now
  ○ Hosted — nothing to install             ○ Local — install one, or use an API key
```

Detailed triage is **local-mode content**, so it belongs after the fork, not
before it. Putting it first would march every hosted-bound user through an
inventory of tools they have chosen not to use — a cost no escape hatch fully
repays. **Nothing detected means hosted is the default**, which is the correct
recommendation for that user rather than a nudge.

**Every required step precedes every optional one.** A user who abandons the
wizard after step 5 still has a working app: a name, a brain, and somewhere to
put work. Optional steps are pure upside, so nothing is lost by quitting among
them. This is the "get going faster" principle applied to ordering.

**First run is detected by the absence of a user record.** After a reset,
`swarm/.smith/users/` is empty; that is the sentinel. No new flag.

**The wizard is re-runnable from Settings.** Without this, testing it means
destroying an install, which is exactly what happened while designing it.

### Step 1 — Name (required)

Creates the user record, which also clears the first-run sentinel. Nothing else
in the wizard can persist until this exists.

### Step 2 — Local or hosted (required)

The background probe from step 1 sets the default: a working CLI preselects
local, nothing working preselects hosted. A one-line summary names what was
found. Developers with a working setup are never nagged, and someone with an
empty machine is pointed at the option that works immediately instead of being
walked through an inventory of tools they do not have.

Choosing hosted goes to **step 4b** (passkey sign-in) and skips local engine
setup entirely. Choosing local goes to **step 4a**.

The hosted path is largely built: `control-plane/src/lib/cloud.ts`,
`LoginScreen.tsx`, and a full broker passkey stack (`/auth/register/options`,
`/auth/register/verify`, `/auth/login/options`, `/auth/login/verify`,
`/auth/me`, `/auth/logout`, `/auth/invites`). For this audience hosted is rarely
"I have nothing" — it is "use my crew from my phone, or a teammate's machine".

### Step 3 — Is this a coding workspace? (required)

The pivot. One question, asked in the user's terms, that decides engine kind and
repo together rather than as two unrelated screens later.

```
  Is this a coding workspace?

    → Yes    agents read and write code here
             needs an agent CLI and a local repo

    → No     diagrams, docs, dashboards, boards, the council
             a model is all you need — CLI or API key
```

Its two consequences are enforced, not merely displayed. A **coding** answer
makes step 4a refuse to complete without a working CLI, because an API key
cannot run a coding task and discovering that on the first dispatch is a far
worse experience than being told during setup. A **design** answer suppresses the
repo and source-control questions in step 5 entirely, so nobody is asked for a
clone they will never use.

The answer is a property of this workspace, not of the install — a later
workspace may answer differently.

### Step 4a — Your engine, local mode (required)

Local mode only. The screen that earns the wizard. Built entirely on the existing registry:
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

**Local does not mean CLI-only.** A subscription is one way to power local mode;
an API key is the other, and for some users the faster one. The step offers both:

```
  No working subscription? Two ways forward:
    → Install one            claude · agy · codex · copilot   [copy command] [re-check]
    → Paste an API key       anthropic · gemini               [paste] [verify]
```

The key path is not hypothetical — the author's own brain runs on a Gemini API
key today, after the Anthropic subscription's API balance ran dry. Whichever
path is taken, the step completes only on a **live turn**, never on a green row.

### Step 4b — Sign in, hosted mode (required)

Hosted mode only, and the reason this fork is cheap to offer: the path is
largely built. Passkey register or login against the broker's existing stack,
after which the brain runs in the cell and **nothing needs to be installed or
pasted** — the step is done the moment the session is established.

No local triage runs. A user who later wants local can switch from Settings,
which re-enters step 4a; the fork is never a one-way door.

### Step 5 — Your workspace (required)

Boards, sessions, and documents all hang off a workspace; without one there is
nowhere to put anything. Reuses the shipped new-workspace flow.

**A GitHub account is never required to use the product.** `WorkspaceRepo.repository`
(the remote URL) is optional and informational; `WorkspaceRepo.github` is
optional and its own comment calls an unset `connectorId` a *soft-fail, not a
required field*; agents commit on their branch and are instructed not to push,
so the core loop never contacts a remote. GitHub is one of six optional
connectors at step 8, and `copilot` is one of five CLIs. Nothing about the
product's value depends on having an account.

It *is* required on one branch of one step — choosing source control at step 5
below — because that is a choice the user makes deliberately, not a gate on
entry. Declining it costs nothing but code hosting.

**A local repo is no longer required either.** Today `assertContext` demands
`repos.length > 0` with an absolute path, which would strand anyone who wants
the design side. A workspace may now hold **zero repos**.

That the design side truly needs no git is verified, not assumed:

- Documents live in `BROKER_DOCUMENTS_DIR ?? ".smith/documents"` — the broker's
  own state directory, never a repo. (The reset performed while writing this
  design found all 60 documents there.)
- `documents.ts` and `doc-edit.ts` contain **zero** git references — no `git`,
  no worktree, no `.git`.
- `CliResearch` spawns with **no `cwd`**, inheriting the broker's directory, so
  a generation turn never enters a user repo.

Boards, workspaces and squads are the same: plain JSON under `.smith/`. The
dependency line falls cleanly between the product's two halves:

| Half | Needs git? | Why |
|---|---|---|
| Design (broker) — documents, diagrams, dashboards, boards, the council | **No** | JSON state; the CLI runs outside any repo |
| Code (swarm) — dispatch, worktrees, branch commits | **Yes** | worktrees are cut from a local clone |

So a repo-less context is not a degraded workspace. It is a complete one for
everything except running coding agents.

This does not collide with groups. `isGroupRecord()` keys on
`members !== undefined`, and `assertContext` branches on `Array.isArray(members)`
before repos are considered, so "group" is identified by members and never by an
empty repo list. The validator change is a single clause; the consequences are
downstream and must be handled explicitly:

- **Dispatch must soft-fail, not crash.** A task aimed at a repo-less context has
  nowhere to build a worktree. It reports "this context has no repo — add one to
  run agents" and declines. It must never throw or quarantine confusingly.
- **Repo-dependent UI must tolerate empty.** Repo pickers, branch selectors, and
  anything reading `repos[0]` need an empty state rather than an index error.
- **Adding a repo later is the upgrade path.** A design-only context becomes a
  working one the moment a repo is attached; nothing is migrated or recreated.

Step 3 has already settled coding versus design, so step 5 never re-asks it. It
renders one of two shapes:

```
  ── coding ──────────────────        ── design ──────────────────
  Repo      [ ~/dev/my-project ]      Name  [ Schema work        ]
  Branch    [ main            ]
  □ Connect GitHub                    Nothing else to set up.
     agents commit to branches         (add a repo any time later)
     you review — opening PRs
     for you is coming
```

The design shape asks for a name and nothing more, which is the whole point of
routing the question early: a user who is here to draw diagrams is never shown a
repo picker, a branch selector, or a GitHub prompt.

**The copy describes today, not the roadmap.** Agents currently work in a
worktree and commit to a `smith/<taskId>` branch — nothing more.
`dispatcher.ts:327` appends *"Do not push"* to every task prompt, and there is no
`gh pr create`, no push, and no use of the pulls API anywhere in `swarm/` or
`broker/`. Promising PRs in onboarding would break on the user's first task, so
they are named as coming and nothing more.

**"Yes" collects GitHub, and only there** — `WorkspaceRepo.github {owner, repo}`
plus the `github` connector, rather than waiting for step 7.

**Known soft spot, recorded deliberately:** until agents push, this requirement
is weakly justified. Local git alone delivers everything the yes branch currently
promises, so GitHub is being collected mainly in anticipation of PR creation,
plus the issue and PR context the connector already provides. This is a conscious
trade — asking once during setup beats interrupting later — but it is the first
thing to revisit when PR creation lands, along with the copy above.

One consequence worth stating plainly: **the wizard stops offering a
currently-supported case** — a local git repo with no remote, which the model
still allows (`repository` and `github` are both optional). That case is not
removed, only unlisted; it remains reachable from Settings by adding a repo to a
context. This follows the pattern already used for step 4a: the wizard presents
the clean binary, Settings retains the full range. Keeping a third "local git,
no remote" option in onboarding would cost every user a decision to serve a
minority who can already get there another way.

### Step 6 — Voice mode (optional)

Assign the `deepgram` (STT) and `elevenlabs` (TTS) connectors. Voice Mode may
only be enabled while **both** slots are filled — the existing invariant. Skipping
leaves voice off and everything else working.

### Step 7 — Location (optional)

Feeds `feeds/weather.ts` (`weatherLine`, `weatherUrl`), which supplies the
weather line in Anderson's morning digest (`BrainTurn.digest`). Needs `lat,lon`,
so browser geolocation fits. **Name the payoff in the UI** — a permission prompt
with a stated reason converts far better than a bare one.

Timezone is **detected, never asked**. The agenda's midnight sweep is per-user
and date-keyed (`agendaSweptDay`), so a wrong zone sweeps plates at the wrong
hour. Show what was detected and let it be corrected.

### Step 8 — Connect your tools (optional)

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

But the council pitch must not vanish. Step 4a states the payoff ("your council
spans 2 model families") and the finish screen carries the pointer to Agents.
The promise lands; the work is deferred.

When a crew is created later, **engines spread across the working families** —
left alone, people put everyone on one CLI, and a council sharing one model is
one mind in hats. See the council turn design (2026-08-15).

## Reuse over rebuild

Step 4a is useful long after onboarding — the author's own copilot and codex
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

- Should step 4a offer to run installers in v1, or stay copy-a-command? (Scoped
  out above; the audience mostly has the binaries.)
- For the repo path in step 5, is choosing an existing local clone enough, or
  should the wizard also offer `git init` on a new folder?
- **Agents opening PRs does not exist** (no push, no `gh pr create`; the task
  prompt says "Do not push"). It is named as coming in step 5 copy. When it is
  built it should be a per-workspace opt-in, not a new default, since pushing
  from an agent worktree is a real behaviour change — and it is what finally
  justifies collecting GitHub at step 5.
- Does relaxing `repos.length > 0` belong in this plan, or as its own change
  landed first? It touches the swarm validator and every repo-reading caller,
  so it is arguably a prerequisite rather than wizard work.

**Settled during design:** where the local/hosted fork belongs. It was first
placed after subscription triage, on the reasoning that the choice needs a
concrete inventory behind it. That was wrong: detection can set the fork's
*default and summary* without spending a whole screen on it, and triage is
local-mode content that a hosted-bound user should never have to walk through.
The fork sits at step 2, and nothing detected makes hosted the default.
