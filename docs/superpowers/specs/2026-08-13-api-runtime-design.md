# ApiRuntime v1 — Design

**Date:** 2026-08-13 · **Approved:** Edwin (chat) · **Direction:** memory `api-runtime-direction` (settled 2026-07-29/2026-08-06)

One swarm, two engine kinds. `cli` = the hands (tmux/Docker, subscription-billed, device-routed). `api` = the thinkers (provider-API turns, token-billed, ECS-runnable). Never a second broker — the conversation broker learns nothing this round.

## Decisions (Edwin, 2026-08-13)

1. **v1 scope: runtime + registry only.** No dependents wired — elections, crew turns, and topic discovery come later and will call the HTTP surface this ships.
2. **Provider: Anthropic-first behind one interface**, mock for tests. Live turns are unverifiable until API credits are topped up; everything structural verifies now.
3. **No seeding.** Agents-as-data appear only through the Add Agent flow.

## Engine model

`AgentEngine` becomes:

```ts
interface AgentEngine {
  kind?: "cli" | "api";          // absent = "cli" — every legacy file stays valid
  cli?: "agy" | "claude" | "codex" | "opencode" | "copilot"; // required when kind cli
  provider?: "anthropic";        // required when kind api
  model: string;                 // cli alias ids for cli-kind; REAL provider ids for api-kind
}
```

Validation forks per kind in `assertAgent` and the create/update routes:
- cli-kind: existing rules unchanged (known CLI, CLI-availability gate, model-id charset).
- api-kind: `provider` must be a registry provider; the **stored key must be `verified === true`** (subscription-first enforced at the door — "verified:false never picks api engine"); the CLI gate is skipped entirely.

## ApiRuntime — `swarm/src/api-runtime.ts`

Not a `RuntimeAdapter`: API agents have no process; their unit is a **turn**.

- `runTurn(agent, sessionId | null, message)` → `{ sessionId, reply }`. Loads or creates the session file, builds the system prompt from the agent's role + directives + persona style + backstory + language, appends the user message, calls the provider with the whole history, appends the reply, persists, returns.
- Session state: `.smith/api-sessions/<agentId>/<sessionId>.json` — `{ id, agentId, createdAt, updatedAt, messages: [{role: "user"|"assistant", text, at}] }`. Serializable JSON is the whole runtime state; restarts cost nothing.
- `listSessions(agentId)`, `deleteSession(agentId, sessionId)`.
- History cap: the provider call sends at most the last 40 messages (a thinker session, not an archive problem — the file keeps everything).
- No tools in v1.

## Provider seam — `swarm/src/api-provider.ts`

```ts
interface ApiProvider {
  complete(req: { model: string; system: string; messages: Array<{ role: "user" | "assistant"; text: string }> }): Promise<string>;
}
```

- `AnthropicProvider`: POST `https://api.anthropic.com/v1/messages` (`anthropic-version: 2023-06-01`, `max_tokens: 1024`), key read via `getCredential(path, "anthropic")` **at call time** — key rotation needs no restart.
- Errors are typed `ApiProviderError { kind: "auth" | "billing" | "provider" | "network"; message }`: 401/403 → auth ("verify the key in Settings → API Keys"), 4xx bodies mentioning credit/billing and 429 → billing ("top up Anthropic credits"), other non-2xx → provider with status + body snippet, fetch failure → network. Never swallowed.
- `MockProvider` (tests): scripted replies, records calls.
- Failed turns persist nothing to the transcript — the session is exactly what the model has actually seen.

## HTTP surface (wired to nothing yet)

- `POST /api-agents/:id/turn` body `{ sessionId?, message }` → `{ sessionId, reply }`. 404 unknown/archived/cli-kind agent; 400 empty message; provider errors → 502 with the typed message (auth/billing texts name the fix).
- `GET /api-agents/:id/sessions` → `{ sessions: [{ id, createdAt, updatedAt, messageCount }] }`.
- `DELETE /api-agents/:id/sessions/:sid` → 204 (404 when absent).

## Add Agent flow (control plane, minimal)

- The catalog's `engines` list gains one entry: `{ cli: "api:anthropic", label: "API — Anthropic", kind: "api", provider: "anthropic", models: [real Anthropic model ids], active: <anthropic key verified>, statusDetail: <why not> }`. The pseudo `cli` id keeps the modal's option identity untouched; the wizard's existing gray-out-inactive behavior gates it exactly like an unavailable CLI.
- On submit, an entry with `kind: "api"` posts `engine: { kind: "api", provider, model }` instead of `{ cli, model }`. No other modal changes.

## Testing

- Swarm: assertAgent both kinds (legacy file without `kind` loads; api without provider rejects); create route — api-kind rejected without a verified key, accepted with one, CLI gate not consulted; runTurn with MockProvider (session created, history grows, system prompt carries role/directives, cap at 40); provider error mapping (401→auth, credit-text→billing); turn route 404s for cli-kind; catalog carries the api entry with `active` mirroring the key state.
- CP: api engine option renders when active, grays out with `statusDetail` when not; submit posts the api engine shape.
- **Live-turn verification is explicitly deferred** until credits return; the billing error path IS live-verifiable and stands in as the smoke.

## Out of scope

Broker integration (elections, crew sends), topic discovery, tools/HTTP-tool use, multi-provider, ECS deployment, session UI.
