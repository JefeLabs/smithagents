# Elections through the ApiRuntime — Design

**Date:** 2026-08-13 · **Approved:** Edwin (chat) · **Phase 2 of:** 2026-08-13-api-runtime-design.md

Group-leader elections keep their whole shape — blind self-nomination, `parseClaim`, `pickLeader`, the rank-ladder floor, the debounced scheduler, broker-side tally — and swap the transport of the one question each member is asked.

## Decisions (Edwin, 2026-08-13)

1. **Swarm-first, broker fallback.** A member who exists in the swarm registry as an api-kind agent votes through `/api-agents/:id/turn` — their claim comes from their *registry* persona. Everyone else (all members, today) keeps the existing broker-side anthropic ask. Elections migrate member by member as registry agents appear; no flag day.
2. **One-shot turns.** Election turns persist no session. The claim recorded on the group is the evidence, as today.

## Swarm changes

- `ApiRuntime.runOneShot(agent, message)` → `Promise<string>`: provider call with the persona-built system prompt and a single user message; **nothing written to disk**.
- `POST /api-agents/:id/turn` accepts `oneshot?: boolean`. With it: 200 `{ reply }` (no `sessionId`), no session file. Same 404/400/502 contract as normal turns.

## Broker changes

- `election.ts` `AskFactory` params gain `agentId: string` (the candidate's id). `runElection` passes it; nothing else in the election flow changes.
- `SwarmClient.apiAgentOneShot(id, message)` → `{ reply: string } | { notApiAgent: true }` — a clean 404 maps to `notApiAgent`; any other non-2xx throws an error carrying the swarm's typed message; a 10s timeout throws.
- `main.ts` composes the resolver via a pure, testable factory in `election.ts`:

```ts
makeClaimAsk(deps: {
  swarmOneShot(agentId: string, message: string): Promise<{ reply: string } | { notApiAgent: true }>;
  brokerAsk(params: { system: string; prompt: string }): Promise<string>;
}): AskFactory
```

Resolution per member: try `swarmOneShot` — a reply wins; `notApiAgent` falls back to `brokerAsk` (today's behavior, unchanged); **any other failure propagates** so `runElection`'s existing catch records the member as a decline whose reason carries the typed message ("top up Anthropic credits…", "verify the key…"). Only a clean 404 falls back — a billing failure must not double-ask through a second paid path.

## Behavior matrix

| Member state | Claim path |
|---|---|
| api-kind registry agent, key healthy | swarm one-shot turn, registry persona |
| api-kind registry agent, key dead/billing | decline recorded with the typed reason; ladder still floors |
| not in registry / cli-kind (today: everyone) | broker-side ask, byte-identical to shipped behavior |
| broker ask also fails | decline with the error, ladder floors — as today |

## Testing

- Swarm: `runOneShot` returns the reply and writes no file (assert the sessions dir stays absent); route `oneshot` returns `{reply}` without `sessionId`; normal turns unaffected.
- Broker: `makeClaimAsk` — swarm reply wins and brokerAsk is never called; `notApiAgent` falls back; a swarm error propagates (no fallback, no swallow). `election.test.ts` updated for the id-bearing `AskFactory`. `runElection` decline-with-reason path already covered.
- Live smoke: form a group; with the registry empty every member 404s → broker fallback runs (its key is credit-dead, so declines land with reasons) → the ladder elects; the group frame shows leader + claims. This exercises every row of the matrix reachable today.

## Out of scope

Crew-directed sends, topic discovery, seeding, tools. The broker's anthropic client stays for the fallback and its own brain turns.
