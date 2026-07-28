# Hosted Switchboard — Phase 1 (Tenant Zero) Design

**Date:** 2026-07-28
**Status:** Approved in conversation (Edwin, 2026-07-28); layout mirrors skoolscout-com `.infra` conventions
**Scope:** The cloud switchboard as a BYOK product, proven by dogfooding: broker + swarm control plane on ECS, web UI + one Discord text channel, delegations routed to Edwin's registered local device. Local-first mode remains untouched and first-class.

## Goal

Run the smithagents switchboard (broker + swarm control plane + web UI) on ECS for a single tenant (Edwin), with the subscriber's machine registering as an execution device over the existing worker protocol — conversation in the cloud, execution on the owner's hardware, keys BYOK.

## Settled decisions

- **Tenant zero:** Edwin dogfoods. No signup, no billing, no multi-tenant provisioning. Auth is minimal-but-real behind one seam.
- **Surfaces:** web UI + one Discord **text** channel. Slack, LiveKit/guest links: out.
- **Approach A:** broker and swarm-server co-located in one ECS task (localhost between them — `SwarmClient` untouched; the broker/swarm boundary preserved). Execution reaches the subscriber via the existing `smith-worker` outbound-WS path, upgraded to per-device tokens.
- **All-local stays first-class:** topology is configuration, never a fork. Three run modes: `all-local` (today's stack, auth off), `local-cloud` (same containers + Terraform against LocalStack Pro), `ecs` (real).
- **Terraform**, mirroring skoolscout-com conventions (see §7). Edwin has LocalStack Pro.

## 1. Topology & modes

One codebase; `SMITH_MODE=all-local|local-cloud|ecs` (default `all-local`) selects behavior the services must not otherwise branch on:

| | all-local | local-cloud (LocalStack) | ecs |
|---|---|---|---|
| broker + swarm-server | host processes (today) | containers via LocalStack ECS | Fargate task, 2 containers |
| auth | off (loopback) | on | on |
| state | `./.smith` dirs | container volume | EFS access point |
| execution | tmux in-process | registered worker | registered worker |
| web UI | vite dev / Tauri | static build | S3 + CloudFront |

## 2. Cloud shape

- One ECS Fargate service, one task, two containers (`broker`, `swarm`) sharing localhost; the ALB carries two target groups (broker `:7790`, swarm `:7777`) with listener rules exposing broker HTTP/WS fully, and from swarm ONLY `/workers/connect` and the pairing exchange route — the rest of swarm's API stays task-internal.
- Per-tenant state on EFS (`.smith/` for both services via access point). File-shaped state ports as-is.
- Web UI: the existing vite build (it already runs fully in a plain browser) deployed to S3 + CloudFront, configured with the broker's public URL.
- LiveKit: not deployed in Phase 1.

## 3. Device registration & routing

- `smith-worker` (existing ~1,000-line outbound-WS worker: register, dispatch, steer, kill, output streaming, heartbeats) is the device daemon.
- **Pairing:** the device registry and both pairing routes live in **swarm-server** (devices are execution concerns). `POST /devices/pair/start` (authed) mints a short-lived pairing code — the web UI reaches it via a broker proxy route, the same pattern as the workspace routes; `smith-worker --pair <code> --orchestrator wss://…` calls swarm's public exchange route and receives a durable **device token** (stored locally; hash stored server-side in a device registry file: id, name, token hash, capabilities, last-seen). The shared `--secret` mechanism is superseded.
- **Routing:** tenant-zero resolves every delegation to the single connected device. The workspace→device affinity table exists in schema (workspace record gains optional `device`), trivially resolved now, real later.
- **Offline device:** delegation fails fast with a readable reason the brain can speak ("your machine is offline"). No queueing in Phase 1.
- **Warm agent-sessions are cloud-deferred:** local mode keeps them; cloud mode hides/rejects the affordance until a later phase makes them worker-executed.

## 4. Auth (tenant-zero)

- One tenant record. Web UI + broker HTTP/WS require a bearer token (long random secret from Secrets Manager, entered once in the UI, kept client-side); TLS everywhere public.
- Device tokens are separate, per-device, revocable credentials (delete the registry entry).
- Every check flows through one `auth.ts` seam in each service so a real IdP can replace it at design-partner time without touching routes.
- `all-local` mode: auth disabled, loopback-only — unchanged from today.

## 5. Discord text adapter (first ChannelAdapter)

- A `ChannelAdapter` port lands in the broker: `deliver(line: { agentId, name, text })` outbound; `onUtterance({ text, author, channelRef })` inbound. The existing Tauri text channel is retrofitted as the first implementation (mechanical).
- Discord adapter: one bot, Edwin's guild, **allowlisted channels only** (config). **Mention-gated etiquette**: the crew replies when @mentioned or replied-to; silent otherwise. Per-agent identity via channel webhooks (each agent posts under its own name + avatar).
- Works identically under a local broker — the adapter doesn't care where the socket lives.

## 6. BYOK (degenerate for tenant zero)

Anthropic/Deepgram/ElevenLabs/Discord credentials live in Secrets Manager, injected as env into the task — the same env contract `.env` provides locally. Tenant-namespaced secret paths are the only "key management."

## 7. `.infra` layout (mirrors skoolscout-com)

- **`.infra-shared/`** — long-lived foundations, own S3-backed state: `modules/networking` (VPC/subnets), `modules/route53` (zone + ACM), `modules/security`, `modules/iam`.
- **`.infra/`** — the switchboard app stack, own S3-backed state: root `main.tf` / `provider.tf` / `outputs.tf` / `terraform.tfvars` composing `modules/ecr`, `modules/ecs` (two-container task def + service), `modules/efs`, `modules/alb`, `modules/secrets-manager`, `modules/cloudfront`, `modules/logs`.
- **Terraform workspaces select topology** (skoolscout pattern verbatim): `local` → LocalStack Pro endpoints, no shared credentials; `tenant-zero` → real AWS. AWS provider `~> 6.x`.
- Images built/pushed to ECR by GitHub Actions on tag; `terraform apply` stays manual.

## 8. Out of scope (recorded)

Billing, signup, multi-tenant provisioning, Slack adapter, LiveKit + guest meeting links, cloud warm sessions, offline-device task queueing, hosted execution (Phase 3), key-management UI.

## 9. Verification

- **Infra gate:** full stack boots under the `local` workspace on LocalStack Pro; acceptance = broker health + worker pairing round-trip against the emulated stack.
- **E2E script:** pair a device → @mention an agent in the allowlisted Discord channel → delegation dispatches over the worker socket to the local machine → PR lands on GitHub.
- **Unit seams:** pairing/token logic and the ChannelAdapter port under node:test; Discord adapter against recorded payloads; auth seam covered for on/off modes.
- All existing suites stay green in `all-local` mode — the invariant that the cloud never forked the product.
