# ApiRuntime v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.
>
> **CLAIMED by the main session (d43af92a), 2026-08-13 — inline execution.**

**Goal:** The swarm gains the `api` engine kind — agents whose turns run through provider APIs — with an Anthropic-first provider seam, serializable sessions, an HTTP turn surface, and an Add Agent path. Zero dependents wired.

**Architecture:** `AgentEngine.kind` forks validation; `ApiRuntime` (turn manager over JSON session files) calls an `ApiProvider` (Anthropic impl + mock); three `/api-agents` routes expose it; the wizard catalog carries one gated api engine entry.

**Spec:** docs/superpowers/specs/2026-08-13-api-runtime-design.md

## Global Constraints

- Legacy agent files (no `kind`) load unchanged as cli-kind.
- api-kind creation requires the provider key `verified === true`; the CLI gate is never consulted for it.
- Provider errors are typed (auth/billing/provider/network) and name the fix; failed turns append nothing to the transcript.
- Broker untouched. Live model turns unverifiable (credits) — mock covers structure; the billing error path is the live smoke.

---

### Task 1: Engine kind in the registry

**Files:** Modify `swarm/src/agents.ts`, `swarm/src/personas.ts` (EngineOption gains `kind`/`provider`), `swarm/src/server.ts` (create/update gates + catalog entry); Test `swarm/src/agents.test.ts`, `swarm/src/server.test.ts` (or nearest route test home).

**Interfaces:** Produces `AgentEngine { kind?: "cli"|"api"; cli?; provider?: "anthropic"; model }`; catalog engine entry `{ cli: "api:anthropic", kind: "api", provider: "anthropic", … }`.

- [x] `AgentEngine` reshaped; `assertAgent` accepts both kinds (api requires provider+model; cli requires cli+model; absent kind = cli).
- [x] Create + update routes: api-kind branch — known provider, `verified === true` key gate (reuse `loadApiKeysFile`), skip CLI gate/model-charset-only validation stays; error texts name Settings → API Keys.
- [x] `GET /agents/catalog`: append the api engine entry, `active` from the key registry, `statusDetail` explaining an unverified/missing key.
- [x] Tests: legacy file loads; api file without provider throws; create api agent 400s without verified key and succeeds with one (key file fixture); catalog entry mirrors key state.
- [x] Swarm suite; commit `feat(swarm): api engine kind — registry + gates + catalog`.

### Task 2: Provider seam + ApiRuntime + routes

**Files:** Create `swarm/src/api-provider.ts`, `swarm/src/api-runtime.ts`; Modify `swarm/src/server.ts`; Test `swarm/src/api-runtime.test.ts`.

**Interfaces:** Produces `ApiProvider.complete({model, system, messages}) → Promise<string>`, `ApiProviderError{kind,message}`, `AnthropicProvider(keyPath)`, `MockProvider`; `ApiRuntime(dir, provider).runTurn(agent, sessionId|null, message) → {sessionId, reply}` + `listSessions`/`deleteSession`; routes per spec.

- [x] `api-provider.ts` per spec §Provider seam (fetch, error taxonomy, call-time key read).
- [x] `api-runtime.ts` per spec §ApiRuntime (session files, system prompt from role/directives/persona/backstory/language, 40-message send cap, failed turn appends nothing).
- [x] Routes: turn (404 cli-kind/unknown/archived, 400 empty message, 502 typed provider errors), sessions list, session delete.
- [x] Tests with MockProvider: turn creates + grows a session; system prompt content; cap; provider auth/billing mapping; route 404/400/502 shapes; delete.
- [x] Swarm suite; commit `feat(swarm): ApiRuntime — provider seam, sessions, turn routes`.

### Task 3: Add Agent flow

**Files:** Modify `control-plane/src/organisms/AddAgentModal.tsx` (+ its catalog type); Test `control-plane/src/organisms/AddAgentModal.test.tsx`.

- [x] `EngineOption` type gains `kind?`/`provider?`; submit forks: selected entry `kind === "api"` → `engine: { kind: "api", provider, model }`.
- [x] Tests: api option grayed with statusDetail when inactive; active api option submits the api engine shape.
- [x] CP suite for the file; commit `feat(cp): Add Agent offers the API engine when a verified key exists`.

### Task 4: Verify and ship

- [x] Full swarm + CP suites green; biome clean (CP only — no biome in swarm).
- [x] Restart swarm. Smoke via curl: catalog shows the api entry with real `active`; creating an api agent without a verified key 400s with the Settings pointer; if the anthropic key is verified, create one and POST a turn — expect the TYPED billing/auth error (credits exhausted) with the top-up message, and no transcript entry persisted.
- [x] Push (ecruz165); memory file; tick plan checkboxes.
