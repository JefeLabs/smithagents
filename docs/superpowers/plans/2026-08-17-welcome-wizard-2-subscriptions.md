# Welcome Wizard, Plan 2 — Subscriptions and Configure Anderson

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the wizard its safety net — a subscriptions step that names *which* problem a CLI has and how to fix it, an API-key escape hatch, and a Configure Anderson step that defaults to the strongest thing that actually works.

**Architecture:** The failure *class* becomes a real field rather than free prose, so the UI can offer class-appropriate guidance instead of one generic "unavailable". The wizard **borrows the existing Settings screens** rather than cloning them, per the spec's "reuse over rebuild". Anderson's engine is a separate question from what is installed, defaulting to the strongest validated option so the step is a confirmation.

**Tech Stack:** TypeScript ~6.0.0 (ESM, `.js` specifiers in swarm), Node >= 24, `node:test` + `node:assert/strict` (swarm), vitest + Testing Library (control-plane), React + TanStack Query, HeroUI v3, biome 2.5.3, **pnpm**.

**Spec:** `docs/superpowers/specs/2026-08-15-welcome-wizard-design.md` §"Subscriptions — guide and validate" and §"Configure Anderson". Builds on Plan 1 (the shell), shipped at `62d9df7`.

## What the research changed about this plan's scope

Measured against `main` @ `62d9df7`, not assumed. **Read this before the tasks — it is why some of the spec's screen is not in scope.**

**1. The failure class does not exist anywhere.** `verifyAuth` returns `{ ok: boolean | "unknown"; detail: string }` (`swarm/src/drivers/types.ts:118-122`) — a tri-state and free text. `gateReason` (`swarm/src/cli-tools.ts:80`) collapses everything that is detected-but-not-ok into `detail || "not logged in"`. The spec is explicit that this is the bug: *"'Not installed', 'wrong account' and 'billing dead' need different guidance. Collapsing them into 'unavailable' reproduces a misdiagnosis made while writing this design."*

**2. Only three of five drivers probe auth at all.** `claude`, `codex` and `opencode` implement `verifyAuth`; **`copilot` and `agy` do not**, so they record `authOk: "unknown"` and are treated as active. The spec's own illustrative screen shows `copilot ⚠ signed in as edwin-skoolscout — org policy blocks it` — **that row cannot be produced today**, because copilot has no probe.

**3. No probe can currently detect billing or org policy.** All three existing probes distinguish exactly *logged in / not logged in / unrecognized* (`claude.ts:216-233`, `codex.ts:136-147`, `opencode.ts:118-129`). Nothing reads a billing state, and nothing would know an org policy blocked it. Writing detection for those means guessing what those CLIs print in failure states **we cannot currently observe** — which is how a plan ships a feature that looks right and never fires.

**So this plan implements the taxonomy and the guidance, and populates only the classes a probe can honestly confirm.** `billing` and `policy` are defined in the type and rendered correctly if they ever arrive, but no task in this plan claims to detect them. Fabricating that detection is explicitly out of scope, and the plan says so where a reader would otherwise assume it.

## Global Constraints

- Node >= 24; TypeScript ~6.0.0; ESM with `.js` specifiers on every relative import in swarm. **pnpm, never npm.**
- **Nothing working is a stop, but never a dead end.** The step cannot be completed until something validates, and two routes out are always offered: install a CLI (copy the exact command, then re-probe) or paste an API key.
- **A failed probe is informative, never fatal.** It reports its reason and offers a re-check; it never strands the wizard.
- **Never claim a confirmed negative from an unrecognised signal.** The driver contract already says this — `ok: false` only on a CONFIRMED logged-out signal, anything unrecognisable is `"unknown"`, and `"unknown"` counts as active. **Keep that invariant**: a new failure class must never turn an `"unknown"` into a confirmed failure.
- **Running installers is out of scope** — hand over the exact command, re-probe on demand.
- **Reuse over rebuild:** the subscriptions screen is a permanent Settings screen the wizard *borrows*. `CliToolsGroup` and `ApiKeysGroup` already exist and take no props (`control-plane/src/organisms/settings/`). Extend them; do not clone them.
- Codebase rules: **no route loaders ever**; **organisms are router-free**; server state via TanStack Query, UI state via zustand.
- Baselines on `main` @ `62d9df7`:
  - swarm **643 passing / 0 failing**, `tsc` **12 errors** (pre-existing: `agent-sessions.ts`, `jira-sync.test.ts`, `server.ts`).
  - broker **667 passing / 0 failing**, `tsc` 1 pre-existing.
  - control-plane **953 passing, 2 FAILING** — `HomePage.test.tsx > picking another session backs out of an explicitly-opened composer` and `MapStage.test.tsx > offers a pan-mode toggle in the zoom controls cluster`. Pre-existing. **Confirm by NAME, never by count. A third is yours.**
  - control-plane `tsc` 10 pre-existing errors. One pre-existing biome violation at `swarm/src/capabilities.test.ts:615`.
- Measurement traps:
  - Typecheck swarm with `cd swarm && ./node_modules/.bin/tsc --noEmit`. **Never `npx tsc` from the repo root** — decoy placeholder package.
  - Strip ANSI (`sed 's/\x1b\[[0-9;]*m//g'`) and count with `grep -c 'error TS'`. **Never `grep -oE 'Found [0-9]+ error'`** — it returns empty here, which looks exactly like success. Cross-check the exit code.
  - `node:test` summary lines start with `ℹ`, not `#`.
  - A `cd` outside the project is silently dropped inside a compound Bash command, and a `cd` from an earlier command persists within one invocation. Use absolute paths.

## Scope

**In:** a failure-class field on the auth probe; classification for what the existing probes confirm; auth probes for `copilot` and `agy` (login state only); the wizard's subscriptions step borrowing the existing Settings screens, with the "cannot continue until something works" gate; the API-key route; the Configure Anderson step.

**Out, deliberately:** detecting billing or org-policy failures (see finding 3 — unobservable from here); running installers; the "validate live on one real turn" requirement (see Task 3's note — it needs a real CLI turn and belongs with whatever plan owns turn execution); the workspace step and optional steps (Plans 3 and 4); the hosted branch.

---

### Task 1: The auth probe reports a failure class

**Files:**
- Modify: `swarm/src/drivers/types.ts` (`verifyAuth`'s return type)
- Modify: `swarm/src/drivers/claude.ts:216`, `swarm/src/drivers/codex.ts:136`, `swarm/src/drivers/opencode.ts:118`
- Modify: `swarm/src/cli-tools.ts` (`CliToolStatus`, `inactiveDetail`, `sweepCliTools`)
- Test: `swarm/src/cli-tools.test.ts`, `swarm/src/drivers/verify-auth.test.ts`

**Interfaces:**
- Produces: `type AuthFailure = "missing" | "unauthenticated" | "billing" | "policy" | "unknown"`, exported from `swarm/src/cli-tools.ts`.
- `verifyAuth` returns `{ ok: boolean | "unknown"; detail: string; failure?: AuthFailure }`.
- `CliToolStatus` gains `failure?: AuthFailure`.

- [ ] **Step 1: Write the failing tests**

Append to `swarm/src/cli-tools.test.ts`:

```ts
test("a missing binary classifies as `missing`, not as an auth problem", async () => {
  // The spec's whole point: three failures need three different fixes. Telling
  // someone to log in when the binary isn't installed is the misdiagnosis.
  const file = await sweepCliTools(tmpFile(), stubDeps({ found: false }));
  assert.equal(file.tools.claude.failure, "missing");
  assert.equal(file.tools.claude.detected, false);
});

test("a confirmed logged-out classifies as `unauthenticated`", async () => {
  const file = await sweepCliTools(tmpFile(), stubDeps({ found: true, auth: { ok: false, detail: "not logged in" } }));
  assert.equal(file.tools.claude.failure, "unauthenticated");
});

test("an UNRECOGNISED probe result stays unknown and carries NO failure class", async () => {
  // The driver contract's standing invariant: ok:false only on a CONFIRMED
  // negative. A failure class must never manufacture a confirmed failure out of
  // an unrecognised signal — that would start gating tools that actually work.
  const file = await sweepCliTools(tmpFile(), stubDeps({ found: true, auth: { ok: "unknown", detail: "???" } }));
  assert.equal(file.tools.claude.authOk, "unknown");
  assert.equal(file.tools.claude.failure, undefined);
});

test("a working tool carries no failure class", async () => {
  const file = await sweepCliTools(tmpFile(), stubDeps({ found: true, auth: { ok: true, detail: "logged in as e@x" } }));
  assert.equal(file.tools.claude.failure, undefined);
});

test("a driver-supplied class wins over the default derivation", async () => {
  // Forward compatibility: when a driver CAN confirm billing or policy, its
  // classification must survive rather than be flattened to unauthenticated.
  const file = await sweepCliTools(
    tmpFile(),
    stubDeps({ found: true, auth: { ok: false, detail: "workspace deactivated", failure: "billing" } }),
  );
  assert.equal(file.tools.claude.failure, "billing");
});

test("inactiveDetail still returns prose, unchanged, for every class", () => {
  // The class is ADDITIVE. Existing consumers of the human string must not change.
  assert.match(inactiveDetail({ detected: false, enabled: true, authOk: "unknown", detail: "" } as never), /PATH/);
  assert.equal(inactiveDetail({ detected: true, enabled: false, authOk: true, detail: "" } as never), "disabled in Settings → CLI Tools");
});
```

**`stubDeps` and `tmpFile` may not exist in that shape.** Read `swarm/src/cli-tools.test.ts` first and use whatever fixture helpers it already has; adapt these tests to them rather than inventing new ones. **Report what you found.**

- [ ] **Step 2: Run them to verify they fail**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  'src/cli-tools.test.ts' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -12
```

Expected: FAIL — `failure` is not a field.

- [ ] **Step 3: Extend the contract**

In `swarm/src/cli-tools.ts`:

```ts
/**
 * Why a tool cannot be used, as a CLASS rather than prose.
 *
 * The prose `detail` stays — it is what a human reads — but a class is what
 * lets the UI offer the RIGHT next action: install a binary, log in, or fix
 * billing. Collapsing these into one "unavailable" is the misdiagnosis the
 * welcome-wizard spec calls out by name.
 *
 * `billing` and `policy` are defined here and rendered by the UI, but NO probe
 * currently detects them: every driver's probe distinguishes only logged-in /
 * logged-out / unrecognised. They are forward compatibility, not shipped
 * detection — do not write guidance implying the system can spot a lapsed
 * subscription today.
 */
export type AuthFailure = "missing" | "unauthenticated" | "billing" | "policy" | "unknown";
```

Add `failure?: AuthFailure` to `CliToolStatus`, and in `sweepCliTools` set it: `missing` when the binary is not found; otherwise the driver's own `failure` when it supplied one; otherwise `unauthenticated` when `ok === false`; otherwise leave it undefined. **`ok === "unknown"` must never produce a class.**

In `swarm/src/drivers/types.ts`, widen `verifyAuth`'s return to `{ ok: boolean | "unknown"; detail: string; failure?: AuthFailure }` and document that a driver supplies `failure` only when it can *confirm* the cause.

- [ ] **Step 4: Classify in the three existing probes**

Each already distinguishes the cases; add the class to the confirmed-negative branch only:
- `claude.ts:228` — `{ ok: false, detail: "not logged in — run `claude /login`", failure: "unauthenticated" }`
- `codex.ts:145` — same shape.
- `opencode.ts` — never returns `ok: false` (it also runs local models), so it needs **no** class. Leave it alone and say so in your report.

- [ ] **Step 5: Verify and commit**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  'src/*.test.ts' 'src/**/*.test.ts' > /tmp/s1.txt 2>&1; echo "exit=$?"
sed 's/\x1b\[[0-9;]*m//g' /tmp/s1.txt | grep -E "^ℹ (tests|pass|fail)"
cd swarm && ./node_modules/.bin/tsc --noEmit > /tmp/s1tsc.txt 2>&1
echo "errors=$(sed 's/\x1b\[[0-9;]*m//g' /tmp/s1tsc.txt | grep -c 'error TS')"
npx biome check src/cli-tools.ts src/cli-tools.test.ts src/drivers/types.ts src/drivers/claude.ts src/drivers/codex.ts
git add swarm/src/cli-tools.ts swarm/src/cli-tools.test.ts swarm/src/drivers/
git commit -m "feat(cli-tools): an auth failure has a class, not just prose

Not-installed, logged-out and billing need different fixes; one collapsed
\"unavailable\" is the misdiagnosis the wizard spec names. An unrecognised
probe result still yields no class — unknown must never become a confirmed
failure."
```

Expected: **649 pass / 0 fail** (643 + 6); `errors=12`.

---

### Task 2: `copilot` and `agy` get auth probes

The spec's own example screen shows a copilot row. **Copilot has no probe**, so it can never produce one.

**Files:**
- Modify: `swarm/src/drivers/copilot.ts`, `swarm/src/drivers/agy.ts`
- Test: `swarm/src/drivers/verify-auth.test.ts`

**Interfaces:** consumes `AuthFailure` from Task 1. Adds `verifyAuth` to both drivers.

- [ ] **Step 1: Find each CLI's real status command before writing anything**

**Do not guess the command or its output.** For each of `copilot` and `agy`, check whether the binary exists on this machine and what a status command actually prints:

```bash
command -v copilot && copilot --help 2>&1 | head -30
command -v agy && agy --help 2>&1 | head -30
```

**Report what you find, including "the binary is not installed".** If a CLI has no reliable non-interactive status command, the correct answer is to **not** implement `verifyAuth` for it — the contract explicitly allows omission, and a probe that guesses at output is worse than none because it manufactures confident wrong answers. If that is the case for either tool, say so and skip it; that is a successful outcome for this task, not a failure.

- [ ] **Step 2: Write tests against the real output you observed**

Follow `swarm/src/drivers/verify-auth.test.ts`'s existing shape (read it first). Cover, for each tool you implement: a confirmed logged-in, a confirmed logged-out (→ `failure: "unauthenticated"`), and an unrecognised output (→ `ok: "unknown"`, no class). Use **real strings you observed**, not invented ones, and say in your report where each came from.

- [ ] **Step 3: Implement, verify, commit** — mirroring `codex.ts:136-147`'s shape, which is the simplest of the three.

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  'src/*.test.ts' 'src/**/*.test.ts' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E "^ℹ (tests|pass|fail)"
git add swarm/src/drivers/ && git commit -m "feat(drivers): copilot and agy report auth state"
```

**If you implement neither, commit nothing and report why.** That is a legitimate result.

---

### Task 3: The subscriptions step

**Files:**
- Modify: `control-plane/src/organisms/settings/CliToolsGroup.tsx` (class-aware guidance)
- Create: `control-plane/src/organisms/WizardSubscriptionsStep.tsx`
- Modify: `control-plane/src/lib/wizardSteps.ts` (insert the step)
- Modify: `control-plane/src/organisms/WizardGate.tsx` (render it)
- Test: the corresponding `.test.tsx` files

**Interfaces:**
- Consumes: `WIZARD_STEPS`/`nextStep` from Plan 1's step machine; `useCliTools`/`useRefreshCliTools` from `queries/http`; `CliToolStatus.failure` from Task 1.
- Produces: `WIZARD_STEPS` gains `"subscriptions"` after `"fork"`.

- [ ] **Step 1: Class-aware guidance in the shared screen**

`CliToolsGroup` is a permanent Settings screen and the wizard borrows it — so the guidance lands **there**, not in a wizard-only clone. For each inactive tool render the action its class calls for:

| class | action |
|---|---|
| `missing` | the exact install command, with a copy affordance, plus re-check |
| `unauthenticated` | the exact login command (the probe's `detail` already carries it), plus re-check |
| `billing` | a link out to the vendor's billing page, plus re-check |
| `policy` | the `detail` prose plus re-check — there is no generic fix |
| absent / `unknown` | today's existing rendering, unchanged |

**Do not invent install commands.** `DEFAULT_AGENT_COMMANDS` (`swarm/src/config.ts:14-20`) has each tool's binary; the install command is vendor-specific and is **not** in this codebase. If you cannot source a real one, render the binary name and a link rather than a fabricated `npm i -g …`. **Report what you did.**

- [ ] **Step 2: Write the failing tests**

```tsx
it("tells a missing tool to install, not to log in", async () => {
  renderCliTools({ tools: { codex: { detected: false, failure: "missing", detail: "binary not found on PATH" } } });
  expect(await screen.findByText(/not found|install/i)).toBeInTheDocument();
  expect(screen.queryByText(/log ?in/i)).toBeNull();
});

it("tells a logged-out tool to log in, not to install", async () => {
  renderCliTools({ tools: { codex: { detected: true, authOk: false, failure: "unauthenticated", detail: "not logged in — run `codex login`" } } });
  expect(await screen.findByText(/codex login/i)).toBeInTheDocument();
  expect(screen.queryByText(/install/i)).toBeNull();
});

it("an unknown-auth tool is not presented as broken", async () => {
  // 'unknown' counts as ACTIVE. Showing it as a failure would tell users to fix
  // a tool that works — the inverse of the misdiagnosis this step exists to end.
  renderCliTools({ tools: { opencode: { detected: true, authOk: "unknown", detail: "auth list unavailable" } } });
  expect(screen.queryByRole("alert")).toBeNull();
});

it("the wizard step cannot continue while nothing validates", async () => {
  renderStep({ tools: { codex: { detected: false, failure: "missing" } } });
  expect(screen.getByRole("button", { name: /continue/i })).toBeDisabled();
});

it("one working tool unblocks continue", async () => {
  renderStep({ tools: { claude: { detected: true, authOk: true, enabled: true } } });
  expect(await screen.findByRole("button", { name: /continue/i })).toBeEnabled();
});

it("a verified API key unblocks continue with no CLI at all", async () => {
  // The spec's second route out. Someone with no CLIs must still get past this step.
  renderStep({ tools: {}, keys: [{ provider: "anthropic", verified: true }] });
  expect(await screen.findByRole("button", { name: /continue/i })).toBeEnabled();
});
```

**Note the `disabled` trap from Plan 1:** this stylesheet gives `aria-disabled` `pointer-events: none`, and react-aria's focus walk only honours native `disabled`. If Continue is disabled by `aria-disabled` alone it stays keyboard-reachable. Use whichever HeroUI button API produces a genuinely disabled control, and **assert it is not keyboard-activatable**, not merely that an attribute is present.

- [ ] **Step 3: Build the step**

It renders `CliToolsGroup` and the API-key route (borrow `ApiKeysGroup`, or its verify affordance if the whole screen is too heavy — read it and decide, then say which and why). Continue is enabled when **either** at least one CLI is active **or** at least one API key is verified.

**A note on the spec's "validate live" requirement.** The spec says *"A green row is not proof; the step completes on one real turn."* That means actually running a CLI turn, which this plan does **not** implement — nothing here owns turn execution, and a fake "turn" would be worse than none. This plan gates on *probe* validity. Record the gap in your report; it belongs with whatever plan owns running a turn.

- [ ] **Step 4: Insert the step and verify**

Add `"subscriptions"` to `WIZARD_STEPS` after `"fork"`. Plan 1's `resumeStep`/`nextStep` are data-driven, so no logic changes — **confirm that by running Plan 1's step-machine tests unchanged.**

```bash
cd control-plane && npx vitest run > /tmp/s3.txt 2>&1; echo "exit=$?"
grep -E "Tests " /tmp/s3.txt | tail -2; grep -E "^ FAIL" /tmp/s3.txt | head -4
cd control-plane && npx tsc --noEmit 2>&1 | tail -3
```

The 2 failures must still be only `HomePage` and `MapStage`, **by name**.

- [ ] **Step 5: Commit**

```bash
git add control-plane/src && git commit -m "feat(wizard): the subscriptions step names the right problem

Guidance lands in the permanent Settings screen the wizard borrows, keyed on
the failure class rather than one collapsed \"unavailable\". Continue unblocks
on one working CLI or one verified key — never a dead end."
```

---

### Task 4: Configure Anderson

Separate from Task 3 on purpose: that step asks *what is available*, this asks *what Anderson should use*. They diverge in practice — this install runs Anderson on a Gemini key while its coding agents run on the `claude` subscription.

**Files:**
- Create: `control-plane/src/organisms/WizardBrainStep.tsx` + test
- Modify: `control-plane/src/lib/wizardSteps.ts`, `WizardGate.tsx`

**Interfaces:** consumes `GET`/`PUT /me/brain-engine` (`swarm/src/server.ts:2444-2456`) and `buildBrainEngineUpdate` (`:4248`), all shipped. Adds `"brain"` to `WIZARD_STEPS` after `"subscriptions"`.

- [ ] **Step 1: Read `buildBrainEngineUpdate` first**

It already gates which engines may back the brain and returns `{error}` for a refusal — `swarm/src/server.test.ts` has tests asserting non-claude CLIs are refused with a reason. **The step must surface that refusal, not pre-filter the list into it.** Report what the gate actually allows; do not assume.

- [ ] **Step 2: Write the failing tests**

```tsx
it("defaults to the strongest validated option, so the step is a confirmation", async () => {
  renderBrainStep({ tools: { claude: { active: true } }, keys: [{ provider: "anthropic", verified: true }] });
  expect(await screen.findByRole("radio", { name: /claude/i })).toBeChecked();
});

it("offers a verified API key when no CLI can back the brain", async () => {
  renderBrainStep({ tools: {}, keys: [{ provider: "gemini", verified: true }] });
  expect(await screen.findByRole("radio", { name: /gemini/i })).toBeEnabled();
});

it("surfaces the server's refusal rather than hiding the option", async () => {
  // buildBrainEngineUpdate refuses some engines with a reason. Silently omitting
  // them leaves the user unable to learn why their tool isn't offered.
  renderBrainStep({ tools: { codex: { active: true } } });
  await userEvent.click(await screen.findByRole("radio", { name: /codex/i }));
  await userEvent.click(screen.getByRole("button", { name: /continue/i }));
  expect(await screen.findByText(/claude|--json-schema/i)).toBeInTheDocument();
});
```

- [ ] **Step 3: Build it, verify, commit** — same gates as Task 3.

**Remember Plan 1's rollback limitation**, which is a named precondition for this plan: on a server-reported error the host rolls the step back and the step's form remounts against its original prop, losing state. That barely mattered for a name; here the user may have picked an engine. **Decide deliberately whether this step needs to preserve its selection across a rollback, and say what you chose.** If it does, that is a change to how the host passes state to steps — flag it rather than working around it locally.

---

### Task 5: Live smoke

**Files:** none. **No commit.** Green tests do not prove reachability — this project has shipped defects past green suites repeatedly, and the last two were caught only by a live check.

- [ ] **Step 1: Back up** the whole state root (`cp -a ~/.smithagents "$B/smithagents"`); this task touches the user record.

- [ ] **Step 2: Restart the swarm, and confirm the class reaches the wire**

```bash
PID=$(lsof -nP -iTCP:7777 -sTCP:LISTEN -t | head -1); kill "$PID"
until ! lsof -nP -iTCP:7777 -sTCP:LISTEN >/dev/null 2>&1; do sleep 1; done
cd swarm && nohup node --env-file=../.env --import tsx src/server.ts > /tmp/swarm-w2.log 2>&1 &
until curl -s -m 3 http://127.0.0.1:7777/health > /dev/null; do sleep 1; done
curl -s -m 20 -X POST http://127.0.0.1:7777/cli-tools/refresh > /dev/null
curl -s -m 5 http://127.0.0.1:7777/cli-tools | python3 -c "
import sys,json
for t in json.load(sys.stdin).get('tools', []):
    s = t.get('status') or {}
    print(f\"  {t.get('cli'):10} detected={s.get('detected')} authOk={s.get('authOk')} failure={s.get('failure')} detail={s.get('detail','')[:50]}\")"
```

**This is the measurement that matters**: a real probe of this machine's real CLIs. Report the actual table. **An `unknown` with no class is a correct result, not a gap.**

- [ ] **Step 3: Confirm it survives the broker hop** — the app talks to the broker, not the swarm. Plan 1 shipped with this half-missed:

```bash
curl -s -m 5 http://127.0.0.1:7790/cli-tools | head -c 300; echo
curl -s -o /dev/null -w "  control: /execution-modes -> %{http_code}\n" -m 5 http://127.0.0.1:7790/execution-modes
```

If `/cli-tools` 404s at the broker, that is the same class of bug the work-kinds branch shipped — a route on one service whose only client calls another. **Fix it before proceeding.**

- [ ] **Step 4: Walk the wizard in a browser** (`pnpm dev` in `control-plane`, then Settings → re-run setup). Confirm: each inactive tool shows the guidance its class calls for; Continue is blocked with nothing working and **not keyboard-activatable**; a re-check actually re-probes; Anderson defaults to the strongest validated option; and a reload mid-step resumes there.

- [ ] **Step 5: Restore** — stop the dev server, and report anything left changed on the install.

- [ ] **Step 6: No commit.** If Step 2 shows no class for a genuinely missing binary, or Step 4's Continue is keyboard-activatable while disabled, the branch does not merge.

---

## Self-review

**Spec coverage.** §"Subscriptions" three requirements: *name the right problem* → Tasks 1-3, with the taxonomy as a real field; *hand over the exact command* → Task 3 Step 1, with an explicit instruction not to fabricate one; *validate live* → **NOT implemented**, and Task 3 Step 3 says so and says why rather than faking it. §"Configure Anderson" → Task 4, including the spec's "defaults to the strongest validated option" and its point that this question is separate from availability. "Reuse over rebuild" → Task 3 puts the guidance in the shared Settings screen rather than a wizard clone.

**Placeholders.** None. Five steps defer to observed reality rather than invention — the test fixture helpers in `cli-tools.test.ts`, the real status commands for copilot/agy, the real install commands, what `buildBrainEngineUpdate` actually permits, and whether `ApiKeysGroup` is borrowable whole — each naming the exact command to run and requiring a report. Task 2 explicitly authorises "implement neither" as a successful outcome.

**Type consistency.** `AuthFailure`, `failure`, `CliToolStatus`, `verifyAuth` are spelled identically across the contract, the three probes, the registry, the wire and the client. `WIZARD_STEPS` gains `"subscriptions"` then `"brain"`, and Plan 1's `resumeStep`/`nextStep` are data-driven so they need no change — Task 3 Step 4 verifies that rather than assuming it.

**Known risks, stated plainly.**
1. **`billing` and `policy` ship undetectable.** They are in the type and rendered by the UI, but no probe populates them, because no failure state is observable from here. A reader could easily assume the system spots a lapsed subscription; it does not, and the plan says so three times.
2. **Task 2 may correctly produce nothing.** If copilot and agy have no reliable non-interactive status command, the right answer is no probe. That leaves the spec's own illustrative copilot row unreproducible — which is a fact about the spec's example, not a defect in this plan.
3. **"Validate live on one real turn" is deferred.** This plan gates on probe validity, which is strictly weaker: a CLI can probe green and still fail its first real turn — which the spec says happened twice in one day during design.
4. **Plan 1's rollback state-loss lands here for real.** Task 4 has the user picking an engine; a server refusal rolls the step back and the form remounts stale. Task 4 requires a deliberate decision on it, and fixing it properly is a change to the host's contract with its steps.
