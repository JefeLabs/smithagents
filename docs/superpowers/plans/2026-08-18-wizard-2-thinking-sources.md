# Wizard Plan 2 — Where I think · What I think with

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the wizard's Subscriptions and Anderson steps with the spec's Step 1 (*Where I think* — pick your thinking sources) and Step 2 (*What I think with* — assign them to roles).

**Architecture:** Step 1 is a multi-select over three source kinds that already exist as concepts in `BrainEngine.kind`: **logins** (`cli`), **your own keys** (`api`), **models on your machine** (`local`). Step 2 is a view over whatever Step 1 configured, assigning sources to three roles. Local-model support needs one new swarm surface — nothing today detects a running Ollama/LM Studio or lists its models.

**Tech Stack:** React 19, TypeScript, react-hook-form, HeroUI + HeroUI Pro, vitest + Testing Library, node:test for swarm, Playwright for the walk.

**Spec:** `docs/superpowers/specs/2026-08-18-welcome-wizard-local-setup.md` — Steps 1 and 2.
**Roadmap:** `docs/superpowers/plans/2026-08-18-wizard-sequence-roadmap.md`

---

## What is already true — measured, not assumed

Establish these before planning around them; six defects in Plan 1 came from
asserting mechanics that were never checked.

| Claim | Reality |
|---|---|
| Step 1's three sources | **Already the shipped type.** `BrainEngine.kind: "cli" \| "local" \| "api"` (`swarm/src/users.ts:51-58`) |
| Logins | `CliToolListing extends EngineOption` with `status` and `active` (`swarm/src/cli-tools.ts:48-51`). `active` already means "usable", and `authOk: "unknown"` counts as active on purpose |
| Keys | `ApiKeyListing { id, label, hasKey, last4, verified: boolean\|"unknown"\|null, detail, lastCheckedAt }` (`swarm/src/api-keys.ts:23-32`). Registered: **anthropic, openai, google** — no openrouter |
| Local models | `broker/src/local-brain.ts` POSTs `${baseUrl}/v1/chat/completions`. **Nothing detects a server or lists models.** Net-new |
| RAM | **Nothing reads it.** Net-new |
| Who may be a brain | `BRAIN_CLI_ALLOWLIST = {"claude"}` only — *"a brain cli must ENFORCE `--json-schema`, not merely accept the flag"* (`swarm/src/server.ts:4249-4257`). `API_BRAIN_PROVIDERS = {"anthropic","gemini"}` (`:4247`) |

### Ruling from the user — Step 1 offers only what something can consume

The spec lists "Anthropic · OpenAI · Google · OpenRouter". **OpenRouter is not
registered at all, and nothing anywhere consumes an OpenAI key** — it cannot
back a brain, research, or anything else. Offering them would collect
credentials that do nothing.

**Step 1 offers Anthropic and Google only**, plus logins and local models.
OpenAI and OpenRouter return when a consumer exists. This is the same call the
user made on the location step, where checking the credential premise shrank the
work rather than growing it.

**Consequence for Step 2, and it is the point:** every dropdown offers only what
the server will actually accept for that role. The alternative — a mixed list
including options the server refuses — is the exact shape that trapped a
codex-only user in the brain step and required a "Skip for now" escape to
rescue. Do not rebuild that.

---

## Global Constraints

- **The spec's copy IS the design.** Match it word for word. Anderson speaks in
  the **first person** and asks rather than instructs.
- **pnpm, never npm.** `pnpm --filter control-plane test -- <name>` does **not**
  filter — use `pnpm exec vitest run <name>` with cwd in `control-plane/`.
  swarm's tests are the node runner (`pnpm test`), not vitest.
- **Baselines on `5e75601`:** control-plane **1062 pass / 2 fail (1064)**;
  swarm **649/0**; control-plane `tsc --noEmit` **10**; biome (cwd
  `control-plane/`) **0 errors / 0 warnings / 1 info**.
- **Both pre-existing failures fail in ISOLATION too** — `MapStage`
  pan-mode-toggle (react-flow inside jsdom) and `HomePage` composer-backs-out
  (genuinely broken, unrelated). Neither is starvation. **A third failure is
  yours** — but the suite *is* starvation-prone at this size, so re-run and
  check isolation before concluding, and say that you did.
- **`brokerFetch` never throws on a non-2xx.** A network failure REJECTS
  (ambiguous — stay optimistic); a server refusal RESOLVES with `{error}` (a
  firm no — roll back, surface the server's sentence). There are already
  **four** handlers with this shape; do not add a fifth by copy-paste.
- **Setup MERGES, it never clears.** `buildUserUpdate` persists
  `{...existing.setup, ...body.setup}`, so an omitted field keeps its old value.
  Any answer change sends explicit values.
- **Obey `WizardSaveState`.** Every control that can start a `PUT /me` must be
  inert while one is in flight. Plan 1 shipped this guard and then had to fix
  two controls that bypassed it.
- **Never create a dead end.** A user with a working subscription must always be
  able to finish. This rule has been violated twice on this feature.
- **Exactly one `<h1>` per screen**; steps use `<h2>`.
- **jsdom has no layout and no theme.** Anything whose correctness is geometric
  needs a browser.
- Five themes — default, light, dark, midnight, **sand**.

---

## File Structure

- `swarm/src/local-models.ts` — **create.** Detect a local OpenAI-compatible
  server and list its models.
- `swarm/src/local-models.test.ts` — **create.**
- `swarm/src/machine.ts` — **create.** Total RAM, for Step 2's advice.
- `swarm/src/server.ts` — **modify.** `GET /local-models`, `GET /machine`.
- `control-plane/src/queries/http.ts`, `keys.ts` — **modify.** Client hooks.
- `control-plane/src/organisms/WizardSourcesStep.tsx` — **create.** Step 1.
- `control-plane/src/organisms/WizardRolesStep.tsx` — **create.** Step 2.
- `control-plane/src/lib/wizardSteps.ts` — **modify.** Replace the two step ids.
- `control-plane/src/organisms/WizardGate.tsx` — **modify.** Render them.
- `control-plane/src/organisms/WizardSubscriptionsStep.tsx`,
  `WizardBrainStep.tsx` — **delete**, once nothing renders them.

---

### Task 1: Swarm knows what is running on this machine

**Files:**
- Create: `swarm/src/local-models.ts`, `swarm/src/local-models.test.ts`,
  `swarm/src/machine.ts`, `swarm/src/machine.test.ts`
- Modify: `swarm/src/server.ts`

**Interfaces produced:**
```ts
export interface LocalServer {
  /** "ollama" | "lmstudio" — which default port answered. */
  id: string;
  label: string;
  baseUrl: string;
  models: { id: string; sizeBytes: number | null }[];
}
/** Probes the known default ports. Never throws — an absent server is [] . */
export function detectLocalServers(deps: { fetchImpl?: typeof fetch }): Promise<LocalServer[]>
export function machineFacts(): { totalMemBytes: number }
```

**Why these ports:** `local-brain.ts` already POSTs `${baseUrl}/v1/chat/completions`,
the OpenAI-compatible shape both servers expose. The same servers answer
`GET ${baseUrl}/v1/models`. Ollama defaults to `http://127.0.0.1:11434`,
LM Studio to `http://127.0.0.1:1234`.

- [ ] **Step 1: Write the failing tests**

```ts
test("detectLocalServers: a server that answers /v1/models is reported with its models", async () => {
  const fetchImpl = stubJson({
    "http://127.0.0.1:11434/v1/models": { data: [{ id: "qwen3:8b" }] },
  });
  const found = await detectLocalServers({ fetchImpl });
  assert.equal(found.length, 1);
  assert.equal(found[0].id, "ollama");
  assert.deepEqual(found[0].models.map((m) => m.id), ["qwen3:8b"]);
});

test("detectLocalServers: nothing running is an empty list, never a throw", async () => {
  // The wizard renders this. A rejected probe must not take the step down.
  const fetchImpl = () => Promise.reject(new Error("ECONNREFUSED"));
  assert.deepEqual(await detectLocalServers({ fetchImpl }), []);
});

test("detectLocalServers: a server answering garbage is skipped, not surfaced as a broken entry", async () => {
  const fetchImpl = stubJson({ "http://127.0.0.1:1234/v1/models": { nope: true } });
  assert.deepEqual(await detectLocalServers({ fetchImpl }), []);
});

test("detectLocalServers: both servers running yields both, in a stable order", async () => {
  const fetchImpl = stubJson({
    "http://127.0.0.1:11434/v1/models": { data: [{ id: "a" }] },
    "http://127.0.0.1:1234/v1/models": { data: [{ id: "b" }] },
  });
  const found = await detectLocalServers({ fetchImpl });
  assert.deepEqual(found.map((s) => s.id), ["ollama", "lmstudio"]);
});

test("machineFacts: reports this machine's total memory", () => {
  assert.equal(machineFacts().totalMemBytes, os.totalmem());
});
```

- [ ] **Step 2: Run them and verify they FAIL**

Run: `pnpm test` with cwd in `swarm/`
Expected: module not found.

**That red proves the file is new, nothing more.** Before continuing, state for
each test what wrong implementation would also pass it. The
reject-becomes-`[]` and the garbage-shape tests are the two that discriminate;
say so, and say what you checked beyond them.

- [ ] **Step 3: Implement**

Probe both ports concurrently with a short timeout (`AbortSignal.timeout`), take
`data[].id`, and read a size if the server offers one — Ollama's native
`/api/tags` reports `size`, the OpenAI-compatible `/v1/models` does not, so
`sizeBytes` is `null` when unavailable rather than guessed. Never throw:
`Promise.allSettled`, and a rejected or malformed probe contributes nothing.

Wire `GET /local-models` and `GET /machine` in `server.ts` alongside the
existing `/cli-tools` and `/api-keys` routes.

- [ ] **Step 4: Verify**

```bash
pnpm test                     # cwd swarm/ — expect 649 + your additions, 0 fail
pnpm exec tsc --noEmit        # cwd swarm/
```

Then **live**: `curl -s 127.0.0.1:7777/local-models` and `/machine`. Report what
this machine actually answers — if no local server is running, that is a valid
and useful result, and say so rather than inventing one.

- [ ] **Step 5: Commit**

```bash
git add swarm/src/local-models.ts swarm/src/local-models.test.ts swarm/src/machine.ts swarm/src/machine.test.ts swarm/src/server.ts
git commit -m "feat(swarm): detect local model servers, and report machine memory"
```

---

### Task 2: The broker proxies both routes

**Files:** `broker/src/main.ts`, `broker/src/text-channel.ts`,
`broker/src/swarm-client.ts` + their tests.

**This task exists because the same bug has shipped to main twice**: a route
added on swarm that the control-plane calls via `brokerFetch` 404s, because the
UI talks to the broker on `:7790` and never to swarm on `:7777`. Once it was
`/work-kinds` (silent fallback forever); once `/me/brain-engine` (the wizard's
last step could not complete and a fresh install never reached the app).

- [ ] **Step 1: Write the failing tests** in `broker/src/text-channel.test.ts`,
  mirroring the existing `brain-engine` arms: each route proxied, and a swarm
  refusal carrying the swarm's own sentence through.

- [ ] **Step 2: Run and verify they FAIL** — `pnpm test` with cwd in `broker/`.

- [ ] **Step 3: Add the passthroughs**, mirroring the `research` and
  `brainEngineSetting` objects in `main.ts` and their arms in
  `text-channel.ts`. **Name the passthrough objects carefully** — `brain` was
  already a block-scoped `const` in `main.ts` and a duplicate would be a
  SyntaxError at load, which `tsc` catches and no test does, because tsx strips
  types and no suite loads `main.ts`.

- [ ] **Step 4: Verify both ports answer**

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7777/local-models   # swarm
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7790/local-models   # broker
```

**Both must be 200.** Broker-404 + swarm-200 IS the bug. A restart is required —
routes are added at `TextChannel` construction and tsx does not hot-reload
`main.ts`. Note that `tmux send-keys -t smith-broker C-c` **kills the whole
session**; recreate with
`tmux new-session -d -s smith-broker -c <repo>/broker 'node --env-file=../.env --import tsx src/main.ts'`.

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(broker): proxy /local-models and /machine"
```

---

### Task 3: Step 1 — *Where I think*

**Files:**
- Create: `control-plane/src/organisms/WizardSourcesStep.tsx` + test
- Modify: `control-plane/src/queries/http.ts`, `keys.ts`

**Copy — verbatim from the spec:**

> **Where should I get my thinking from, {name}?**
> Pick as many as you like — I'll use whichever suits each job.
>
> ☑ **Logins you already have** — nothing to paste
> ☐ **Your own API keys** — Anthropic · Google
> ☐ **Models on your machine** — I'll download them, and nothing leaves your computer

Under **logins**, each detected CLI with its state, in the spec's shape:
`✓ claude — you're signed in` · `✗ codex — not installed`.

**Requirements:**
- **Detected logins arrive pre-checked**, so the step can be a single click.
- Keys expand **inline per provider with live verification** — reuse
  `ApiKeysGroup`'s verify path rather than a second implementation, filtered to
  the two providers something can consume.
- Local expands to the **runtime check** from Task 1, listing what is installed.
  If no server is running, say so plainly and offer nothing false.
- **Multi-select, not a fork** — sources accumulate.
- Gates like the step it replaces: cannot continue until at least one source is
  genuinely usable. `authOk: "unknown"` counts as usable — `copilot` and `agy`
  have no auth probe at all and stranding them is the bug this rule exists for.

- [ ] **Step 1: Write the failing tests**, covering at minimum: detected logins
  pre-checked; an undetected CLI shown but not counted as usable; Continue
  disabled with nothing usable and enabled with one; the local section honest
  when nothing is running; and that unchecking every source re-disables Continue.

For each, state what wrong implementation would also pass it.

- [ ] **Step 2: Run and verify they FAIL.**
- [ ] **Step 3: Build it.**
- [ ] **Step 4: Verify** — suite, `tsc`, biome, all at baseline plus your delta.
- [ ] **Step 5: Commit.**

---

### Task 4: Step 2 — *What I think with*

**Files:**
- Create: `control-plane/src/organisms/WizardRolesStep.tsx` + test
- Modify: `swarm/src/users.ts` (two new engine fields), `swarm/src/server.ts`

**Copy — verbatim:**

> **Which of these should I use, and for what?**
>
> My main brain `[ … ]`
> Quick little things `[ … ]`
> If something's unavailable `[ nothing — I'll just tell you ]`

**Data model.** `brainEngine` already exists and is the main brain. Add two
siblings of the same shape, so the wire stays one idea:

```ts
/** Same shape as brainEngine. Absent = fall back to the main brain. */
quickEngine?: BrainEngine;
/** Absent, or explicitly null = "nothing — I'll just tell you". */
fallbackEngine?: BrainEngine | null;
```

Mirror onto the control-plane's `MeRecord`. Plan 1 shipped a drift here that had
to be closed separately — do both sides in this task.

**Requirements:**
- Every dropdown **lists all configured sources together, mixed — not grouped by
  origin**. That is the spec's wording and it is deliberate.
- **Each dropdown offers only what the server will accept for that role.** Per
  the ruling above: `cli` is `claude` only, `api` is `anthropic`/`gemini`, and
  `local` needs a `baseUrl`. Offering a refusable option rebuilds the dead end
  that trapped a codex-only user.
- Local picks **show size**; download progress runs inline **only if** a
  download is actually started — do not fake a progress bar.
- The RAM line from Task 1 is **advice, not a gate**: *"You've got 32GB of RAM,
  so I've leaned toward models that'll feel quick."* If `machineFacts` is
  unavailable, omit the sentence rather than guessing a number.
- The fallback's **"nothing — I'll just tell you"** is a real, selectable value,
  not the absence of a choice.

- [ ] **Step 1: Write the failing tests** — including one that a refusable
  option never appears in the main-brain dropdown, and one that the fallback's
  "nothing" persists explicitly rather than as an omitted field (setup merges).
- [ ] **Step 2: Run and verify they FAIL.**
- [ ] **Step 3: Build it.**
- [ ] **Step 4: Verify.**
- [ ] **Step 5: Commit.**

---

### Task 5: Swap them into the sequence

**Files:** `control-plane/src/lib/wizardSteps.ts`, `WizardGate.tsx`, their tests;
delete `WizardSubscriptionsStep.tsx` and `WizardBrainStep.tsx` and their tests.

The registry's two step ids become `sources` and `roles`, each with a
`skipLabel` that **states its default** and a `skipDefault()` returning
**explicit values** — an empty patch applies nothing, because setup merges.

**Three things in the deleted files are load-bearing and must survive in some
form**, each of which fixed a bug that reached `main`:

1. **The escape after a refused save.** A user whose only option the server
   refuses must still be able to finish. Task 4's dropdown filtering removes the
   *cause*, but a server can still refuse at save time — keep an escape.
2. **The shared in-flight guard on Back**, and the rule that a guard must not
   outlive the write it guards. A permanent version of it left the final screen
   with every footer button disabled.
3. **`headingLevel`** on the reused Settings groups, if Task 3 reuses them —
   exactly one `<h1>` per screen.

- [ ] Steps 1-5 as the other tasks: tests first, red, build, verify, commit.
  **Account for the test-count delta** — you delete two suites and the total
  moves. A green suite that lost coverage looks identical to one that did not;
  on this branch that was caught only by arithmetic.

---

### Task 6: Walk it in a browser

**Files:** none expected; commit any fix.

A green suite has failed **four** times on this feature to catch what a browser
saw at once: a Continue button below the fold, a last step that could not save,
a radio indicator painted over its own label, and a `<legend>` colliding with
its own card.

- [ ] **Assert the viewport (1280x900) in the same call as every measurement.**
  Below 768px the gate serves a compact screen instead of the wizard.
- [ ] Get a genuine first run by **moving `~/.smithagents/users/me.json`
  aside** — you cannot `PUT` your way there, setup merges. **The controller
  holds a backup**; take your own too, but a crash on your side will not lose
  the user's record.
- [ ] Walk: gate → Step 1 → Step 2 → done. Confirm detected logins arrive
  pre-checked; a key verifies inline; the local section tells the truth about
  this machine; each dropdown offers only acceptable options; the fallback's
  "nothing" round-trips.
- [ ] **Exercise a failure path** — the one thing every previous walk skipped.
  Refuse a save (stop the broker, or pick something the server rejects) and
  confirm the user still has something clickable and the reason on screen.
- [ ] All five themes, including **sand**.
- [ ] **Restore the record file**; diff the **file**, not `GET /me`, which does
  not serialise `agendaSweptDay`. Confirm the app opens with no wizard.

---

## Self-Review

**Spec coverage.** Step 1's three sources, pre-checked logins, inline key
verification, and the local runtime check (Task 3); Step 2's three roles, mixed
dropdowns, sizes and RAM advice (Task 4); the supporting swarm and broker
surfaces (Tasks 1-2); the sequence swap (Task 5); the walk (Task 6).

**Deliberately not covered:** OpenAI and OpenRouter as key providers — the
user's ruling, because nothing consumes them. Model *downloading* is specced
("I'll download them") but only progress-for-a-real-download is in scope here;
initiating a pull is its own work and a fake progress bar is worse than none.

**Type consistency.** `LocalServer`/`machineFacts` are produced in Task 1 and
consumed in Tasks 3-4. `quickEngine`/`fallbackEngine` mirror `BrainEngine` and
are added to both `swarm/src/users.ts` and the control-plane `MeRecord` in the
same task, because Plan 1 shipped that drift and had to close it separately.

**Known risk.** Task 2's broker passthrough is the step most likely to be
skipped as boilerplate, and it is the one whose omission has twice produced a
user-facing failure that every test suite passed. Its live two-port check is not
optional.
