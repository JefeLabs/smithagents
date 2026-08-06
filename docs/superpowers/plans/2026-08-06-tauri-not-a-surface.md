# Tauri Is Not a Joinable Surface — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Tauri app is the management console: every agent (freestanding or in a swarm) always appears in its roster; join/admission semantics apply to Discord surfaces only, and `tauri` disappears from the surface concept entirely.

**Architecture:** The broker's `surfaceModes()` parser and its control-plane mirror stop emitting a `tauri` key (retired-key skip), `KNOWN_SURFACES` shrinks to the two Discord surfaces, the tauri roster frame drops its `attends` filter, the presence payload and join endpoint lose their tauri rows, and the popover renders Discord rows only. Stale `"tauri"` keys in agent files are parsed away, so no migration beyond the two live files.

**Tech Stack:** Broker: TypeScript + node:test via tsx (**npm**). Control-plane: React 19 + vitest/RTL (**pnpm** — NEVER npm install there).

**Spec:** `docs/superpowers/specs/2026-08-06-tauri-not-a-surface-design.md`

## Global Constraints

- Broker commands run from `broker/`: `npm test` (all), `node --import tsx --test src/surface-modes.test.ts` (one file), `npm run typecheck`.
- Control-plane commands run from `control-plane/`: `pnpm exec vitest run <file>`, `pnpm typecheck`, `pnpm exec biome check src` (5 pre-existing warnings in IntegrationsGroup.test.tsx are known; no new ones allowed).
- The parser mirror invariant: `broker/src/surface-modes.ts` `surfaceModes()` and `control-plane/src/hooks/useSurfacePolicy.ts` `modesFrom()` must implement the SAME branches — both change in lockstep in this plan (Tasks 1 and 3).
- Retired-key rule (exact): a `"tauri"` key/element in any `channels` value is silently skipped in every branch — map form, legacy array form (including its unknown-extras loop), and defaults. Unknown surfaces other than `tauri` (e.g. `matrix`) still pass through the map form.
- Absent `channels` default: `{ discord: 'autojoin', 'discord-voice': 'disabled' }`. Garbage (non-array, non-object) `channels`: `{ discord: 'disabled', 'discord-voice': 'disabled' }`.
- Do not touch text delivery (`channels.ts` / AdapterHub) — the tauri chat was never adapter-gated.
- Every commit message ends with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Broker parser retires the tauri surface

**Files:**
- Modify: `broker/src/surface-modes.ts`
- Test: `broker/src/surface-modes.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `KNOWN_SURFACES = ['discord', 'discord-voice']`; `surfaceModes()` return maps never contain a `tauri` key; `SurfacePolicy.attends(id, 'tauri')` is therefore always `false` (mode falls to `'disabled'`). Task 2 removes the only remaining consumers of tauri attendance.

- [ ] **Step 1: Update the tests to pin the retired-key behavior**

Replace the four parser tests and the policy test in `broker/src/surface-modes.test.ts` (leave the `applyModeChange` and `decideJoin` tests untouched) with:

```ts
test('legacy array: listed surfaces autojoin, unlisted disabled, tauri retired', () => {
  assert.deepEqual(surfaceModes({ channels: ['tauri', 'discord'] }), {
    discord: 'autojoin',
    'discord-voice': 'disabled',
  });
});

test('absent channels field: discord autojoin, voice disabled, no tauri key', () => {
  assert.deepEqual(surfaceModes({}), {
    discord: 'autojoin',
    'discord-voice': 'disabled',
  });
});

test('map form: tauri key dropped, absent key disabled, unknown surfaces preserved, bad values fail closed', () => {
  const modes = surfaceModes({
    channels: { tauri: 'on-request', 'discord-voice': 'on-request', matrix: 'autojoin', discord: 'sometimes' },
  });
  assert.equal('tauri' in modes, false); // retired: parsed away even when present
  assert.equal(modes['discord-voice'], 'on-request');
  assert.equal(modes.matrix, 'autojoin'); // unknown surface passes through
  assert.equal(modes.discord, 'disabled'); // unrecognized value fails closed
});

test('non-object, non-array channels: all disabled, no tauri key', () => {
  assert.deepEqual(surfaceModes({ channels: 'discord' }), {
    discord: 'disabled',
    'discord-voice': 'disabled',
  });
});

test('policy: attends = autojoin, or on-request + admitted; tauri never attends; revoked on demand', () => {
  const agents = [{ id: 'ignacio', channels: { discord: 'on-request', tauri: 'autojoin' } }];
  const policy = new SurfacePolicy(() => agents);
  assert.equal(policy.attends('ignacio', 'tauri'), false); // retired surface: no mode, no attendance
  assert.equal(policy.attends('ignacio', 'discord'), false);
  policy.admit('ignacio', 'discord');
  assert.equal(policy.attends('ignacio', 'discord'), true);
  policy.revoke('ignacio', 'discord');
  assert.equal(policy.attends('ignacio', 'discord'), false);
  policy.admit('ignacio', 'discord');
  policy.revokeAll('discord');
  assert.equal(policy.attends('ignacio', 'discord'), false);
  assert.equal(policy.attends('ghost', 'discord'), false); // unknown agent: disabled
});
```

- [ ] **Step 2: Run the file to verify the new tests fail**

Run: `cd broker && node --import tsx --test src/surface-modes.test.ts`
Expected: the five updated tests FAIL (maps still carry `tauri`); `applyModeChange`/`decideJoin` tests still pass.

- [ ] **Step 3: Implement the retired-key parser**

In `broker/src/surface-modes.ts`, update the header comment and the constants/parser (types, `SurfacePolicy`, `decideJoin`, `applyModeChange` are untouched):

```ts
/** Per-agent, per-surface presence modes parsed from the agent file's `channels`
 * field, plus the runtime admission state for on-request surfaces.
 *
 * The tauri app is NOT a surface: it is the management console, every agent
 * always appears there, and any `tauri` key lingering in an agent file is
 * parsed away (retired). Legacy compatibility is behavior-exact per call
 * site: an ARRAY means listed → autojoin, unlisted → disabled. An ABSENT
 * field historically passed the text delivery filter (channels.ts) but
 * failed the voice designation (discord-voice.ts), so it parses as
 * text-autojoin + voice-disabled.
 */
export type SurfaceMode = 'autojoin' | 'on-request' | 'disabled';
export type SurfaceModeMap = Record<string, SurfaceMode>;
export const KNOWN_SURFACES = ['discord', 'discord-voice'] as const;

const MODES: ReadonlySet<string> = new Set(['autojoin', 'on-request', 'disabled']);
/** Retired surface keys: skipped in every branch so old agent files stay valid. */
const RETIRED_SURFACES: ReadonlySet<string> = new Set(['tauri']);

export function surfaceModes(agent: { channels?: unknown }): SurfaceModeMap {
  const channels = agent.channels;
  if (channels === undefined || channels === null) {
    return { discord: 'autojoin', 'discord-voice': 'disabled' };
  }
  if (Array.isArray(channels)) {
    const out: SurfaceModeMap = {};
    for (const surface of KNOWN_SURFACES) {
      out[surface] = channels.includes(surface) ? 'autojoin' : 'disabled';
    }
    for (const surface of channels) {
      if (typeof surface === 'string' && !RETIRED_SURFACES.has(surface) && !(surface in out)) {
        out[surface] = 'autojoin';
      }
    }
    return out;
  }
  if (typeof channels === 'object') {
    const out: SurfaceModeMap = {};
    for (const surface of KNOWN_SURFACES) out[surface] = 'disabled';
    for (const [surface, mode] of Object.entries(channels as Record<string, unknown>)) {
      if (RETIRED_SURFACES.has(surface)) continue;
      out[surface] = typeof mode === 'string' && MODES.has(mode) ? (mode as SurfaceMode) : 'disabled';
    }
    return out;
  }
  return { discord: 'disabled', 'discord-voice': 'disabled' };
}
```

- [ ] **Step 4: Run the file to verify it passes**

Run: `cd broker && node --import tsx --test src/surface-modes.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Full broker suite + typecheck**

Run: `cd broker && npm test && npm run typecheck`
Expected: all suites pass (if another broker test asserted a `tauri` mode key, fix it to the retired-key expectation and note it in your report), typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add broker/src/surface-modes.ts broker/src/surface-modes.test.ts
git commit -m "feat(broker): retire tauri as a surface — parser never emits a tauri mode

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Broker main.ts — unfiltered roster, no tauri presence/join

**Files:**
- Modify: `broker/src/main.ts` (~lines 54, 342-366, 805, 830)

**Interfaces:**
- Consumes: Task 1's guarantee that nothing else needs tauri attendance.
- Produces: the tauri roster frame contains every `roster.agents` entry; the `/agents` presence payload carries `discord` and `discord-voice` keys only; `POST /agents/:id/surfaces/tauri/join` returns 404 `unknown surface: tauri`. Task 3's popover relies on the presence payload shape; Task 4 smoke-verifies the roster.

`toRosterEntries` is module-private in `main.ts`, which boots the broker on import — there is no unit seam without a larger extraction the spec doesn't want. The filter change is a pure deletion verified by the full suite + typecheck here and behaviorally in Task 4's live check. Say this in your report rather than inventing a test that imports `main.ts`.

- [ ] **Step 1: Remove the roster attendance filter**

In `broker/src/main.ts` (~line 350), replace:

```ts
  return [
  // Presence policy gates tauri surface attendance same as text/voice —
  // squads/groups/freed are composite units without a single agent id, so
  // they're left to the underlying members' own presence for now.
  ...roster.agents.filter((p) => policy.attends(p.agent.id, 'tauri')).map(
```

with:

```ts
  return [
  // The tauri app is the management console: every agent always appears in
  // its roster. Surface attendance (SurfacePolicy) gates Discord only.
  ...roster.agents.map(
```

- [ ] **Step 2: Drop tauri from the presence payload**

In the `presence: () => {...}` block (~line 805), replace:

```ts
        out[a.id] = {
          tauri: policy.attends(a.id, 'tauri'),
          discord: isDiscordTextActive(discordTextLifecycle) && policy.attends(a.id, 'discord'),
          'discord-voice': voiceIds.has(a.id),
        };
```

with:

```ts
        out[a.id] = {
          discord: isDiscordTextActive(discordTextLifecycle) && policy.attends(a.id, 'discord'),
          'discord-voice': voiceIds.has(a.id),
        };
```

- [ ] **Step 3: Reject tauri at the join endpoint**

In the `join:` handler (~line 830), replace:

```ts
      if (surface !== 'discord' && surface !== 'tauri') return { error: `unknown surface: ${surface}`, status: 404 };
```

with:

```ts
      if (surface !== 'discord') return { error: `unknown surface: ${surface}`, status: 404 };
```

- [ ] **Step 4: Fix the stale wiring comment**

At ~line 54 the comment reads "which surfaces each agent attends. Wired into text delivery and the tauri" (continuing onto the next line — read the full sentence in place). Rewrite that sentence to say the policy is wired into external text delivery and the Discord join endpoint only, e.g.:

```ts
// which external surfaces each agent attends. Wired into adapter text
// delivery and the Discord join endpoint; the tauri roster is never gated.
```

- [ ] **Step 5: Full broker suite + typecheck**

Run: `cd broker && npm test && npm run typecheck`
Expected: all pass, clean. Typecheck failures here usually mean a missed `tauri` consumer — fix, don't suppress.

- [ ] **Step 6: Commit**

```bash
git add broker/src/main.ts
git commit -m "feat(broker): tauri roster unfiltered; presence and join drop the tauri surface

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Control-plane mirror + Discord-only popover

**Files:**
- Modify: `control-plane/src/hooks/useSurfacePolicy.ts`
- Modify: `control-plane/src/molecules/SurfacePolicyPopover.tsx:52`
- Test: `control-plane/src/molecules/SurfacePolicyPopover.test.tsx`

**Interfaces:**
- Consumes: Task 2's presence payload (`discord` / `discord-voice` keys only — but the hook already defaults missing keys to `false`, so it tolerates either shape).
- Produces: `SURFACES` = Discord text + Discord voice; `modesFrom()` never emits `tauri` (mirror of Task 1); popover renders exactly two rows.

- [ ] **Step 1: Update the popover tests**

In `control-plane/src/molecules/SurfacePolicyPopover.test.tsx`, replace the first two tests (`renders one row per surface…` and `mode click PUTs…`) with (third test is unchanged):

```tsx
  it("renders only the two Discord rows — a stale tauri key never renders a row", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify(
              agentsPayload(
                { tauri: "on-request", discord: "on-request", "discord-voice": "on-request" },
                {
                  discord: true,
                  "discord-voice": false,
                },
              ),
            ),
          ),
      ),
    );
    render(<SurfacePolicyPopover agentId="ignacio" name="Ignacio" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("Discord voice")).toBeDefined());
    expect(screen.queryByText("Tauri app")).toBeNull();
    expect(screen.getByText("Discord text")).toBeDefined();
    // discord is on-request but PRESENT (admitted) → no Join now; discord-voice absent → Join now.
    expect(screen.getAllByRole("button", { name: /join now/i })).toHaveLength(1);
  });

  it("mode click PUTs the full record with a tauri-free channels map", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") return new Response(JSON.stringify({ ok: true }));
      return new Response(JSON.stringify(agentsPayload(["tauri", "discord"], { discord: true })));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<SurfacePolicyPopover agentId="ignacio" name="Ignacio" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("Discord text")).toBeDefined());
    const disabledTabs = screen.getAllByRole("tab", { name: /disabled/i });
    await userEvent.click(disabledTabs[0] as HTMLElement); // first row = Discord text (autojoin → disabled)
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(put).toBeDefined();
    const [, init] = put ?? [];
    const body = JSON.parse(String(init?.body));
    expect(body.channels).toMatchObject({ discord: "disabled", "discord-voice": "disabled" });
    expect("tauri" in body.channels).toBe(false);
  });
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `cd control-plane && pnpm exec vitest run src/molecules/SurfacePolicyPopover.test.tsx`
Expected: both updated tests FAIL ("Tauri app" row still renders; PUT body still carries `tauri`). Third test still passes.

- [ ] **Step 3: Update the hook mirror**

In `control-plane/src/hooks/useSurfacePolicy.ts`:

Replace lines 7-14 (`SURFACES` + `KNOWN_SURFACES` + `MODES` stay adjacent):

```ts
export const SURFACES = [
  { key: "discord", label: "Discord text" },
  { key: "discord-voice", label: "Discord voice" },
] as const;

const KNOWN_SURFACES = ["discord", "discord-voice"] as const;
const MODES: ReadonlySet<string> = new Set(["autojoin", "on-request", "disabled"]);
/** Retired surface keys: skipped in every branch, mirroring the broker parser. */
const RETIRED_SURFACES: ReadonlySet<string> = new Set(["tauri"]);
```

Replace the body of `modesFrom` to mirror Task 1's broker parser exactly (same doc comment stays, with one added sentence: "The tauri app is not a surface — a `tauri` key is retired and parsed away."):

```ts
export function modesFrom(record: { channels?: unknown }): Record<string, SurfaceMode> {
  const channels = record.channels;
  if (channels === undefined || channels === null) {
    return { discord: "autojoin", "discord-voice": "disabled" };
  }
  if (Array.isArray(channels)) {
    const out: Record<string, SurfaceMode> = {};
    for (const surface of KNOWN_SURFACES) {
      out[surface] = channels.includes(surface) ? "autojoin" : "disabled";
    }
    for (const surface of channels) {
      if (typeof surface === "string" && !RETIRED_SURFACES.has(surface) && !(surface in out)) {
        out[surface] = "autojoin";
      }
    }
    return out;
  }
  if (typeof channels === "object") {
    const out: Record<string, SurfaceMode> = {};
    for (const surface of KNOWN_SURFACES) out[surface] = "disabled";
    for (const [surface, mode] of Object.entries(channels as Record<string, unknown>)) {
      if (RETIRED_SURFACES.has(surface)) continue;
      out[surface] = typeof mode === "string" && MODES.has(mode) ? (mode as SurfaceMode) : "disabled";
    }
    return out;
  }
  return { discord: "disabled", "discord-voice": "disabled" };
}
```

- [ ] **Step 4: Simplify the popover's grayed rule**

In `control-plane/src/molecules/SurfacePolicyPopover.tsx:51-52`, replace:

```tsx
          // Discord's two surfaces go inert together when the broker has no Discord identity configured.
          const grayed = surface.key !== "tauri" && !discord.configured;
```

with:

```tsx
          // Both Discord surfaces go inert together when the broker has no Discord identity configured.
          const grayed = !discord.configured;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd control-plane && pnpm exec vitest run src/molecules/SurfacePolicyPopover.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 6: Full control-plane suite + typecheck + lint**

Run: `cd control-plane && pnpm exec vitest run && pnpm typecheck && pnpm exec biome check src`
Expected: full suite passes, typecheck clean, no new lint warnings.

- [ ] **Step 7: Commit**

```bash
git add control-plane/src/hooks/useSurfacePolicy.ts control-plane/src/molecules/SurfacePolicyPopover.tsx control-plane/src/molecules/SurfacePolicyPopover.test.tsx
git commit -m "feat(control-plane): surface popover manages Discord only; tauri key retired in the mirror parser

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Settle agent files, PRD note, live verification

**Files:**
- Modify: `swarm/.smith/agents/ignacio.json` (channels block)
- Modify: `swarm/.smith/agents/wilkin.json` (channels block)
- Modify: `PRD.md` (~lines 122-125)

**Interfaces:**
- Consumes: Tasks 1-3 landed (parsers ignore `tauri`, roster unfiltered).
- Produces: committed agent files without the dead key; PRD records the decision.

- [ ] **Step 1: Strip the dead tauri key from both agent files**

Both files currently end (uncommitted working-tree state) with:

```json
  "channels": {
    "tauri": "on-request",
    "discord": "autojoin",
    "discord-voice": "disabled"
  }
```

Replace that block in BOTH `swarm/.smith/agents/ignacio.json` and `swarm/.smith/agents/wilkin.json` with:

```json
  "channels": {
    "discord": "autojoin",
    "discord-voice": "disabled"
  }
```

(Everything else in each file — directives, persona, reactions, quickAnswers — stays byte-identical.)

- [ ] **Step 2: Add the PRD note**

In `PRD.md`, the 2026-07-28 paragraph ends (~lines 122-125):

```
turns or into a meeting. Designation is per agent (`channels` in
`swarm/.smith/agents/*.json`); Ignacio and Wilkin both carry `"discord"`
alongside `"tauri"`.
```

Replace those lines with:

```
turns or into a meeting. Designation is per agent (`channels` in
`swarm/.smith/agents/*.json`); Ignacio and Wilkin both carry `"discord"`.
Updated 2026-08-06: the tauri app is NOT a designated surface — it is the
management console, so every agent (freestanding or in a swarm) always
appears in its roster; `channels` modes and join/admission apply to external
surfaces (Discord text/voice) only, and a lingering `"tauri"` key is parsed
away.
```

- [ ] **Step 3: Verify both packages end-to-end**

Run: `cd broker && npm test && npm run typecheck`
Run: `cd control-plane && pnpm exec vitest run && pnpm typecheck`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add swarm/.smith/agents/ignacio.json swarm/.smith/agents/wilkin.json PRD.md
git commit -m "chore(swarm): drop retired tauri surface key from agent files; PRD notes tauri is the management console

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 5: Live verification note (manual — do NOT restart anything yourself)**

The live broker runs in tmux session `smith-broker` from the main checkout and still executes the old code. Do not kill or restart it — report in your summary that after Edwin restarts it, the AGENTS rail should show Ignacio and Wilkin (idle or busy) with no other action, and the agent popover should show two Discord rows.

---

## Self-Review Notes

- Spec coverage: parser/KNOWN_SURFACES → Task 1; roster/presence/join/main-comment → Task 2; SURFACES/modesFrom/popover-grayed → Task 3; agent files + PRD → Task 4; "text delivery untouched" → enforced by no task touching channels.ts. Roster-frame test from the spec's Testing section is intentionally downgraded to full-suite + live verification because `toRosterEntries` is private to a boot-on-import module — recorded in Task 2's preamble.
- Placeholder scan: none; every step carries exact code or exact commands.
- Type consistency: `RETIRED_SURFACES` name and semantics identical in Tasks 1 and 3; `KNOWN_SURFACES` two-element in both parsers; presence payload keys in Task 2 match the popover's `presence[surface.key]` lookups in Task 3.
