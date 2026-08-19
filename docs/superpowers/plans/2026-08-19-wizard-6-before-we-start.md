# Wizard Plan 6 — Before we start

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The wizard's closing screen — a summary whose ticks are receipts of operations that actually ran, ending in *"I think we're ready, {name}."*

**Architecture:** The step runs its three checks itself, on mount, and renders each tick only when its operation completes. Nothing is read from a stored flag, so no tick can be stale or invented. One new broker route supplies the missing half: a one-shot ask, timed.

**Tech Stack:** React 19, vitest + @testing-library/react, Node ≥ 24, TypeScript ~6.0.0.

**Spec:** `docs/superpowers/specs/2026-08-18-welcome-wizard-local-setup.md`, Step 6 of 6.
**Roadmap:** `docs/superpowers/plans/2026-08-18-wizard-sequence-roadmap.md`

## What is already true — measured 2026-08-19

| Receipt the spec asks for | Reality |
|---|---|
| ✓ "I checked my login — it works" | **Real.** `swarm/src/cli-tools.ts:175-176` calls `driver.verifyAuth(binary, run, authTimeoutMs)`; the registry already holds per-tool `active` + `status.detail`. Reachable from the UI at `GET /cli-tools` |
| ✓ "I asked myself a question and answered in 0.8s" | **Does not exist.** No latency measurement anywhere in broker or swarm — every `Date.now() -` is a feed age, memory recency, rediscover throttle, or clock-skew allowance. The round trip exists (`swarmOneShot` → `swarm-client.ts:246 apiAgentOneShot`) and is used by elections, but **nothing times it and it has no HTTP surface** |
| ✓ "I tried my voice out" | **Real.** `control-plane/src/organisms/WizardVoiceStep.tsx:146` `usePreviewVoice()`, shipped by plan 3 |

## The ruling this plan carries

The roadmap named this plan's risk before it was written:

> *"receipts are the easiest thing in the whole sequence to fake, and faking them is worse than omitting them. A static '✓ I checked my login — it works' is a lie the user eventually catches. Every tick must be produced by an operation that ran."*

Two of the three receipts had operations; the latency one had none. Edwin's ruling: **build the real round trip.** The primitive already exists and is already used — what is missing is a stopwatch and a way for the UI to ask.

**Design consequence, and the whole reason this screen can be trusted: the step performs its checks live, on mount.** It reads no stored booleans. A tick renders only after its own operation resolves. This is structural rather than disciplinary — there is no flag anyone *could* set early, so "receipts, not restatements" cannot rot into restatements later.

## Global Constraints

- **No tick without a completed operation.** A tick renders only from that run's own result. Never from `setup`, never from a prop, never optimistically.
- **A failed check is shown, not hidden.** The screen must be honest about a login that did not verify or a brain that did not answer, and must still let the user finish — this is the last screen of first-run setup and cannot become a dead end.
- **`brokerFetch` resolves on non-2xx.** Every call must check `res.ok`; an unchecked response reports a silent success.
- **The measured figure is real or absent.** Never a placeholder, never a rounded guess. If the ask fails there is no number.
- `pnpm --filter smithagents-control-plane typecheck` must exit 0 — note the package name; `--filter control-plane` matches nothing and exits 0 having done nothing.
- Broker: `cd broker && node --import tsx --test src/<file>.test.ts`. Control-plane: `cd control-plane && npx vitest run src/organisms/<File>.test.tsx`.
- Lint baseline is zero diagnostics on touched files.

---

## File Structure

| file | responsibility |
| --- | --- |
| `broker/src/brain-ping.ts` (create) | Times a one-shot ask; pure over an injected asker and clock |
| `broker/src/brain-ping.test.ts` (create) | Its tests |
| `broker/src/text-channel.ts` (modify) | `POST /brain/ping` — the UI's only way to ask |
| `control-plane/src/api/broker.ts` (modify) | `pingBrain()` client |
| `control-plane/src/organisms/WizardReadyStep.tsx` (create) | The screen: runs three checks, renders receipts |
| `control-plane/src/organisms/WizardReadyStep.test.tsx` (create) | Its tests |
| `control-plane/src/lib/wizardSteps.ts` (modify) | `ready` joins `WIZARD_STEPS`, `setupStepsFor`, `STEP_DEFS` |
| `control-plane/src/organisms/WizardGate.tsx` (modify) | Renders it; this is the terminal step |

---

### Task 1: The timed round trip

**Files:**
- Create: `broker/src/brain-ping.ts`, `broker/src/brain-ping.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `interface BrainPing { ok: true; reply: string; latencyMs: number } | { ok: false; reason: string }` and
  `pingBrain(ask: (q: string) => Promise<{ reply: string } | { notApiAgent: true }>, now: () => number, question?: string): Promise<BrainPing>`.

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { pingBrain } from "./brain-ping.ts";

/** A clock the test moves by hand — no timers, no sleeps. */
function fakeClock(start = 1_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

test("a successful ask reports the reply and the measured elapsed time", async () => {
  const clock = fakeClock();
  const result = await pingBrain(async () => {
    clock.advance(812);
    return { reply: "Ready when you are." };
  }, clock.now);

  assert.deepEqual(result, { ok: true, reply: "Ready when you are.", latencyMs: 812 });
});

test("the number is MEASURED, not assumed — a slower ask reports a larger figure", async () => {
  const clock = fakeClock();
  const slow = await pingBrain(async () => {
    clock.advance(2_400);
    return { reply: "x" };
  }, clock.now);
  assert.equal(slow.ok && slow.latencyMs, 2_400);
});

test("an engine that cannot answer one-shot is a failure, not a zero-latency success", async () => {
  const clock = fakeClock();
  const result = await pingBrain(async () => ({ notApiAgent: true }), clock.now);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /one-shot|answer/i);
});

test("a thrown ask is reported, never a fabricated number", async () => {
  const clock = fakeClock();
  const result = await pingBrain(async () => {
    throw new Error("swarm is down");
  }, clock.now);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /swarm is down/);
});

test("an empty reply is not a pass — a receipt needs something answered", async () => {
  const clock = fakeClock();
  const result = await pingBrain(async () => ({ reply: "   " }), clock.now);
  assert.equal(result.ok, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd broker && node --import tsx --test src/brain-ping.test.ts`
Expected: FAIL — `Cannot find module './brain-ping.ts'`

- [ ] **Step 3: Write minimal implementation**

```ts
// The wizard's closing receipt: proof the brain answers, with the time it took.
//
// Deliberately pure over an injected asker and clock — the number this returns
// is the only thing standing behind a tick the user reads as fact, so it must be
// testable without a live engine and impossible to produce without a real call.

export type BrainPing = { ok: true; reply: string; latencyMs: number } | { ok: false; reason: string };

const DEFAULT_QUESTION = "Say hello in one short sentence.";

export async function pingBrain(
  ask: (question: string) => Promise<{ reply: string } | { notApiAgent: true }>,
  now: () => number,
  question: string = DEFAULT_QUESTION,
): Promise<BrainPing> {
  const started = now();
  try {
    const answer = await ask(question);
    if ("notApiAgent" in answer) {
      return { ok: false, reason: "this engine cannot answer a one-shot question" };
    }
    // An empty reply is not an answer. A receipt that ticks for whitespace is
    // the fake this whole screen exists to avoid.
    if (!answer.reply.trim()) return { ok: false, reason: "the engine answered with nothing" };
    return { ok: true, reply: answer.reply, latencyMs: now() - started };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd broker && node --import tsx --test src/brain-ping.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Typecheck, lint, commit**

```bash
pnpm --filter @smithagents/broker typecheck
npx biome check --write broker/src/brain-ping.ts broker/src/brain-ping.test.ts
git add broker/src/brain-ping.ts broker/src/brain-ping.test.ts
git commit -m "feat(broker): time a one-shot ask — the wizard's latency receipt"
```

---

### Task 2: The route and the client

**Files:**
- Modify: `broker/src/text-channel.ts` (add `POST /brain/ping` beside the existing `/topics` handlers)
- Modify: `control-plane/src/api/broker.ts` (add `pingBrain`)

**Interfaces:**
- Consumes: `pingBrain` and `BrainPing` from Task 1.
- Produces: `POST /brain/ping` returning the `BrainPing` shape as JSON, and a control-plane client
  `pingBrain(base?: string): Promise<BrainPing>` that returns `{ ok: false, reason }` rather than throwing.

- [ ] **Step 1: Write the failing client test**

Add to `control-plane/src/api/broker.test.ts`:

```ts
it("pingBrain returns the measured result", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ ok: true, reply: "hi", latencyMs: 812 }), { status: 200 })),
  );
  expect(await api.pingBrain()).toEqual({ ok: true, reply: "hi", latencyMs: 812 });
});

it("pingBrain reports a non-2xx as a failure — brokerFetch resolves rather than throwing", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
  const result = await api.pingBrain();
  expect(result.ok).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd control-plane && npx vitest run src/api/broker.test.ts`
Expected: FAIL — `api.pingBrain is not a function`

- [ ] **Step 3: Add the client**

In `control-plane/src/api/broker.ts`, beside `getTopicNames`:

```ts
/** `POST /brain/ping` — the wizard's closing receipt. Never throws; a failure is a result. */
export async function pingBrain(base: string = BROKER_BASE): Promise<BrainPing> {
  try {
    const res = await brokerFetch(`/brain/ping`, base, { method: "POST" });
    // brokerFetch resolves for non-2xx too, so an unchecked response would
    // report a silent success and tick a receipt nothing earned.
    if (!res.ok) return { ok: false, reason: `the broker answered ${res.status}` };
    return (await res.json()) as BrainPing;
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}
```

Declare `BrainPing` in `control-plane/src/api/types.ts` with the same shape as Task 1's, and import it here.

- [ ] **Step 4: Add the route**

In `broker/src/text-channel.ts`, beside the existing `/topics` handlers:

```ts
if (req.method === "POST" && feedUrl.pathname === "/brain/ping") {
  const result = await pingBrain((q) => deps.swarmOneShot(hostAgentId, q), Date.now);
  return json(result);
}
```

Match the surrounding handlers' exact idiom for reading `deps`, resolving the host agent id, and returning JSON — copy the shape of the `/topics` GET immediately above rather than inventing one.

- [ ] **Step 5: Run both suites**

Run: `cd control-plane && npx vitest run src/api/broker.test.ts` — expect PASS
Run: `cd broker && node --import tsx --test 'src/*.test.ts'` — expect no regressions

- [ ] **Step 6: Typecheck, lint, commit**

```bash
pnpm --filter @smithagents/broker typecheck && pnpm --filter smithagents-control-plane typecheck
npx biome check --write broker/src/text-channel.ts control-plane/src/api/broker.ts control-plane/src/api/types.ts
git add broker/src/text-channel.ts control-plane/src/api/broker.ts control-plane/src/api/types.ts control-plane/src/api/broker.test.ts
git commit -m "feat: POST /brain/ping — the UI can ask, and time it"
```

---

### Task 3: The step — *Before we start*

**Files:**
- Create: `control-plane/src/organisms/WizardReadyStep.tsx`, `control-plane/src/organisms/WizardReadyStep.test.tsx`

**Interfaces:**
- Consumes: `pingBrain` (Task 2); `useCliTools()` from `../queries/http` for the login receipt.
- Produces: `WizardReadyStep(props: { name: string; onJumpTo: (step: WizardStep) => void; onFinish: () => void })`.

- [ ] **Step 1: Write the failing test**

```tsx
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../test/renderWithProviders";
import { WizardReadyStep } from "./WizardReadyStep";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const base = { name: "Edwin", onJumpTo: () => {}, onFinish: () => {} };

describe("WizardReadyStep", () => {
  it("shows NO latency tick before the ask resolves — a receipt cannot precede its operation", async () => {
    let release: ((r: Response) => void) | null = null;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((r) => { release = r; })));
    renderWithProviders(<WizardReadyStep {...base} />);

    // The tick must be absent while the request is still in flight.
    expect(screen.queryByText(/answered in/i)).toBeNull();
    await waitFor(() => expect(typeof release).toBe("function"));
  });

  it("ticks with the MEASURED figure the ask returned, not a placeholder", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: true, reply: "hi", latencyMs: 812 }), { status: 200 })),
    );
    renderWithProviders(<WizardReadyStep {...base} />);
    await waitFor(() => expect(screen.getByText(/answered in 0\.8s/i)).toBeTruthy());
  });

  it("a different measurement renders differently — proving the number is not hardcoded", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: true, reply: "hi", latencyMs: 2400 }), { status: 200 })),
    );
    renderWithProviders(<WizardReadyStep {...base} />);
    await waitFor(() => expect(screen.getByText(/answered in 2\.4s/i)).toBeTruthy());
  });

  it("a failed ask says so and still lets the user finish — the last screen is never a dead end", async () => {
    const user = userEvent.setup();
    const onFinish = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    renderWithProviders(<WizardReadyStep {...base} onFinish={onFinish} />);

    await waitFor(() => expect(screen.getByText(/couldn't get an answer/i)).toBeTruthy());
    expect(screen.queryByText(/answered in/i)).toBeNull();
    await user.click(screen.getByRole("button", { name: /let's talk/i }));
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it("greets by name", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: true, reply: "hi", latencyMs: 500 }), { status: 200 })),
    );
    renderWithProviders(<WizardReadyStep {...base} />);
    expect(screen.getByText(/ready, Edwin/i)).toBeTruthy();
  });

  it("each receipt line jumps back to the step that earned it", async () => {
    const user = userEvent.setup();
    const onJumpTo = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: true, reply: "hi", latencyMs: 500 }), { status: 200 })),
    );
    renderWithProviders(<WizardReadyStep {...base} onJumpTo={onJumpTo} />);

    await user.click(await screen.findByRole("button", { name: /revisit talking out loud/i }));
    expect(onJumpTo).toHaveBeenCalledWith("voice");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd control-plane && npx vitest run src/organisms/WizardReadyStep.test.tsx`
Expected: FAIL — `Failed to resolve import "./WizardReadyStep"`

- [ ] **Step 3: Write the component**

Requirements it must satisfy, with no code dictated here because the surrounding step components are the pattern to follow — read `WizardMemoryStep.tsx` first and match its structure, footer, and copy register:

- On mount, call `api.pingBrain()` exactly once, and read `useCliTools()` for the login receipt.
- Render each receipt line ONLY once its own result has arrived and succeeded. No tick may render from a prop, from `setup`, or before its operation resolves.
- Format latency as seconds to one decimal (`812` → `0.8s`, `2400` → `2.4s`).
- A failed ask renders "I couldn't get an answer just now" and **no** latency line.
- The voice receipt reflects whether a voice backend is configured; if none is, say so plainly rather than ticking.
- Each line carries a control named `Revisit <step title>` calling `onJumpTo(<step id>)`.
- The primary control is `Let's talk →`, always enabled, calling `onFinish()`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd control-plane && npx vitest run src/organisms/WizardReadyStep.test.tsx`
Expected: PASS, 6 tests

- [ ] **Step 5: Typecheck, lint, commit**

```bash
pnpm --filter smithagents-control-plane typecheck
npx biome check --write control-plane/src/organisms/WizardReadyStep.tsx control-plane/src/organisms/WizardReadyStep.test.tsx
git add control-plane/src/organisms/WizardReadyStep.tsx control-plane/src/organisms/WizardReadyStep.test.tsx
git commit -m "feat(control-plane): wizard step 6 — receipts, measured live"
```

---

### Task 4: Into the sequence, as the terminal step

**Files:**
- Modify: `control-plane/src/lib/wizardSteps.ts`, `control-plane/src/lib/wizardSteps.test.ts`
- Modify: `control-plane/src/organisms/WizardGate.tsx`, `control-plane/src/organisms/WizardGate.test.tsx`

**Interfaces:**
- Consumes: `WizardReadyStep` (Task 3).
- Produces: `"ready"` in `WizardStep`; `setupStepsFor({mode:"local"})` returns six ids ending in `ready`.

- [ ] **Step 1: Write the failing test**

Append to `wizardSteps.test.ts`:

```ts
describe("Before we start closes the sequence", () => {
  it("comes after memory, making the local sequence six steps", () => {
    expect(setupStepsFor({ mode: "local" })).toEqual([
      "sources",
      "roles",
      "voice",
      "talk",
      "memory",
      "ready",
    ]);
  });

  it("counts as step 6 of 6 — the spec's own 'Step n of 6'", () => {
    expect(progressFor("ready", { mode: "local" })).toEqual({ n: 6, of: 6 });
    expect(progressFor("sources", { mode: "local" })).toEqual({ n: 1, of: 6 });
  });

  it("is terminal — nothing follows it", () => {
    expect(nextStep("memory", { mode: "local" })).toBe("ready");
    expect(nextStep("ready", { mode: "local" })).toBeNull();
  });

  it("carries the spec's own section name", () => {
    expect(stepsFor({ mode: "local" }).find((s) => s.id === "ready")?.title).toBe("Before we start");
  });

  it("its skip writes nothing but the finish — there is no answer on this screen", () => {
    // Every other step's skip records a stated default. This one asks nothing,
    // so a default would be an answer to a question that was never put.
    expect(stepsFor({ mode: "local" }).find((s) => s.id === "ready")?.skipDefault()).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd control-plane && npx vitest run src/lib/wizardSteps.test.ts`
Expected: FAIL — the sequence has five entries and `STEP_DEFS` has no `ready` key.

- [ ] **Step 3: Implement**

`WIZARD_STEPS` gains `"ready"`; `setupStepsFor` returns the six ids; `STEP_DEFS` gains:

```ts
  ready: {
    title: "Before we start",
    description: "What I understood, and what I checked",
    skipLabel: "Skip — take me straight in",
    // The ONLY step whose skip writes nothing: this screen asks no question, so
    // there is no answer to default. Every other entry here records one because
    // an omitted field would leave an earlier run's answer standing.
    skipDefault: () => ({}),
  },
```

- [ ] **Step 4: Update the assertions that encoded five steps**

Exactly as the previous two plans did — the sequence arrays, the titles list, the `progressFor` literals `of: 5` → `of: 6`, the `nextStep` walk, `Step 1 of 5` → `Step 1 of 6`, and the two **last-step** footer tests, which move memory → ready. They have now moved roles → voice → talk → memory → ready, once per appended step. **Read each test in full before editing**: a previous session bounded a test block at the first `});`, which is an inner closure, and left the tail asserting the old value.

- [ ] **Step 5: Render it in the gate**

Terminal step, so its `onFinish` writes `setup.step = SETUP_DONE`. Wire `onJumpTo` to the gate's existing step navigation, and pass `me.name`.

- [ ] **Step 6: Run the touched suites, typecheck, lint, commit**

```bash
cd control-plane && npx vitest run src/lib/wizardSteps.test.ts src/organisms/WizardGate.test.tsx src/organisms/WizardReadyStep.test.tsx
cd .. && pnpm --filter smithagents-control-plane typecheck
npx biome check --write control-plane/src
git add control-plane/src && git commit -m "feat(control-plane): wizard — Before we start closes the sequence at Step 6 of 6"
```

---

### Task 5: Walk it

- [ ] **Step 1: Check for a browser that can click.** If none, say so and do not report a walk. Plan 4 and plan 5 both stopped here; do not let "the tests pass" stand in for it.

- [ ] **Step 2: Prove the receipt is real, which needs no browser.**

```bash
curl -s -X POST http://127.0.0.1:7790/brain/ping | python3 -m json.tool
```

Run it twice. The two `latencyMs` values must **differ** — an identical figure across runs means it is not being measured.

- [ ] **Step 3: Prove a failure is honest.** Stop the engine or point it at a dead provider; the route must return `ok:false` with a reason and no `latencyMs`.

- [ ] **Step 4: Walk the screen if clicking is possible** — ticks appear only as their operations land, `Step 6 of 6`, each line jumps back, `Let's talk →` finishes.

- [ ] **Step 5: Report what was and was not observed.**

---

## Self-Review

**Spec coverage.** Editable summary with per-line jump-back (Task 3), receipts from real operations (Tasks 1–3), `Step n of 6` (Task 4), the named sign-off (Task 3).

**Gaps, stated rather than hidden:**

- **The voice receipt is weaker than the other two.** It reflects whether a voice backend is *configured*, not that a preview was actually heard — plan 3's preview is a user action the wizard does not record. Ticking "I tried my voice out" when the user never pressed play would be exactly the fake this plan exists to prevent, so Task 3 requires the line to say what it actually knows. If a true "you heard it" receipt is wanted, the preview must record that it played, and that is a change to plan 3's step.
- **`hostAgentId` in Task 2's route is named but not verified.** Confirm how the surrounding handlers resolve the host agent before writing it; the `/topics` GET immediately above is the idiom to copy.
- **Task 3 Step 3 gives requirements, not a code block, and that is a deviation
  from the plan-writing rule that code steps must show the code.** It is
  deliberate: the component's structure, footer and copy register must match
  `WizardMemoryStep.tsx` exactly, and pasting 150 lines here would drift from
  that sibling the first time either changed. The requirements list is
  exhaustive and every test in Step 1 is concrete, so an implementer is not
  guessing about behaviour — only about layout, where the answer is "copy the
  file beside it". Reject this if you would rather the plan carry the code.
- **Nothing consumes the ping outside this screen.** It is a wizard receipt, not a health check. If a general engine-latency surface is wanted, it should be designed where `engine-latency-matrix` lives, not here.

---

## Task 5 walk — what was and was not observed (2026-08-19)

Run against an **isolated second broker** on `:7791` with its own
`SMITH_STATE_ROOT`, so the live install on `:7790` was never touched. Verified
before and after: `:7790` answered 200 throughout and its tmux session survived.

**Observed:**

- The route is reachable and wired end to end — `POST /brain/ping` returned
  HTTP 200 with real JSON from a running broker.
- Real model calls were attempted: two runs produced two distinct Anthropic
  `request_id`s, so the handler genuinely reached the provider rather than
  short-circuiting.
- **A failure carries no number.** Both runs returned
  `{ok:false, reason:"…credit balance is too low…"}` with `latencyMs` **absent**
  from the payload. This is the property the whole screen rests on, and it now
  holds against a live failure rather than only against a mock.

**Not observed:**

- **Two successful pings differing.** The install's API key is out of credits,
  and `researchEngine()` reads its OWN stored engine — separate from
  `/me/brain-engine`, which was set to `{kind:"cli",provider:"claude"}` and made
  no difference. Blocked by billing and config, not by this code. The measured
  figure remains proven only by unit test (`pingBrain` returns `now() - started`;
  a slower ask reports a larger figure; the screen renders 0.8s and 2.4s
  differently).
- **Every interaction proof.** No browser that can click: Playwright's MCP server
  disconnected mid-session and the remaining browser tool loads and screenshots
  only. Untested: ticks appearing as their operations land, `Step 6 of 6`, the
  per-line jump-back, and `Let's talk →` finishing.

**Follow-up worth its own task:** point `researchEngine()` at an engine with
credit and re-run the two-ping check. It is the one assertion that distinguishes
a measured figure from a plausible constant in the running system.
