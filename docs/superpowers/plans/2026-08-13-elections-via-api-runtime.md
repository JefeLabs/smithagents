# Elections via ApiRuntime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **CLAIMED by the main session (d43af92a), 2026-08-13 — inline execution.**

**Goal:** Election claims route swarm-first (api-kind registry agents answer as their registry personas, one-shot) with the existing broker ask as the 404 fallback; provider failures become typed declines.

**Spec:** docs/superpowers/specs/2026-08-13-elections-via-api-runtime-design.md

## Global Constraints

- Only a clean 404 falls back to the broker ask — no double-asking on billing/auth failures.
- One-shot turns write nothing to disk.
- `pickLeader`/ladder/scheduler untouched.

### Task 1: Swarm one-shot turns

**Files:** Modify `swarm/src/api-runtime.ts`, `swarm/src/server.ts`; Test `swarm/src/api-runtime.test.ts`.

- [ ] `ApiRuntime.runOneShot(agent, message)` — provider call, no persistence.
- [ ] Turn route: `oneshot === true` → `{ reply }`, no session file; same 404/400/502 contract.
- [ ] Tests: one-shot returns reply + sessions dir stays empty; normal turn contract unchanged.
- [ ] Swarm suite; commit `feat(swarm): one-shot api turns — election-grade, nothing persisted`.

### Task 2: Broker swarm-first ask

**Files:** Modify `broker/src/election.ts`, `broker/src/swarm-client.ts`, `broker/src/main.ts`; Test `broker/src/election.test.ts`, `broker/src/swarm-client.test.ts`.

**Interfaces:** `AskFactory` params gain `agentId`; `SwarmClient.apiAgentOneShot(id, message)` → `{reply} | {notApiAgent: true}` (throws otherwise, 10s timeout); `makeClaimAsk({swarmOneShot, brokerAsk}): AskFactory` in election.ts.

- [ ] `AskFactory` signature + `runElection` passes `agentId`; `makeClaimAsk` per spec (swarm reply wins; notApiAgent → brokerAsk; other errors propagate).
- [ ] `SwarmClient.apiAgentOneShot` with the 404 mapping and timeout.
- [ ] `main.ts`: `askForClaim = makeClaimAsk({ swarmOneShot: (id, m) => swarm.apiAgentOneShot(id, m), brokerAsk: <existing anthropic call> })`.
- [ ] Tests: makeClaimAsk three paths; election.test updated for the new signature; swarm-client 404/500/timeout mapping.
- [ ] Broker suite; commit `feat(broker): elections ask swarm-first — registry personas vote via one-shot api turns`.

### Task 3: Verify and ship

- [ ] Swarm + broker + CP suites green.
- [ ] Restart swarm + broker. Live smoke: form a 2-member group via compose; watch `[election]` log — 404-fallback asks run; credit-dead broker key → declines with reasons → ladder leader lands on the group frame with claims recorded.
- [ ] Push (ecruz165); memory; tick checkboxes.
