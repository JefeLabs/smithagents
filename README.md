# smithagents

A localized, multi-agent autonomous swarm that operates as specialized virtual
contractors accelerating a refactor of the SkoolScout multi-tenant B2B platform.
The swarm enforces a five-level atomic-design structure and interfaces with the
human team over Discord voice and text.

> The full design lives in [`PRD.md`](./PRD.md) — the committed source of truth.

## Monorepo layout

A **Maven reactor** aggregates the JVM modules; the front-end and voice engine are
their own projects alongside it. Each component owns its build, tests, and
dependency graph.

```
smithagents/            (git root)
  pom.xml               reactor: aggregates modules, pins shared versions
  gateway/              Spring Boot: Discord, WebSocket, _embabel, mTLS   (PRD §3)
  personas/             data-driven persona roster: registry + router     (PRD §6)
  agent-robot/          AWT keystroke-injection bridge                     (PRD §2,§4)
  control-plane/        Tauri 2.0 + React/TS (desktop + iOS)              (PRD §5)
  voice-engine/         local MLX audio LLM (Python)                       (PRD §3)
  infra/                docker-compose.yml, ngrok, k8s                     (PRD §4)
  audio-cache/          MLX-generated audio (git-ignored contents)         (PRD §3)
  PRD.md  README.md
```

**Module dependencies:** `gateway → personas`, `gateway → agent-robot`. The
`personas` and `agent-robot` modules are plain libraries; only `gateway` is a
Spring Boot application (and the only module that runs the `spring-boot-maven-plugin`).

**Discord lives inside `gateway`** (JDA embedded — not a separate module or
service). A deliberate choice for responsiveness (no process boundary in the
voice-audio hot path) and simplicity on the single host. Trade-off, accepted:
Discord shares the gateway's lifecycle and failure domain, so an Embabel crash or
a gateway redeploy drops the bot connection.

**Java packages:** base `com.jefelabs.smithagents`, per module `.gateway`,
`.persona`, `.robot`. The gateway sets `scanBasePackages = "com.jefelabs.smithagents"`
so it discovers the persona beans across the module boundary.

## Split-brain architecture

```
        ┌──────────────────── Mac Studio host (central nervous system) ────────────────────┐
        │  gateway/        Spring Boot 4.1 + Embabel (_embabel) + JDA (Discord)             │
        │  voice-engine/   local 3B MLX audio LLM → audio-cache/                            │
        │  Helmsmith       persistent architectural memory (MCP)                            │
        │  infra/          ephemeral per-feature-branch Docker sandboxes                    │
        └───────────────────────────────────┬──────────────────────────────────────────────┘
                                             │  ngrok tunnel (mTLS enforced at the gateway)
                    ┌────────────────────────┴────────────────────────┐
             ┌──────┴───────┐                                 ┌────────┴──────┐
             │ Desktop      │   ← one control-plane codebase →│ iOS (iPhone)  │
             │ Tauri 2.0    │                                 │ Tauri/WKWebView│
             └──────────────┘                                 └───────────────┘
```

## Version decisions

- **Spring Boot 4.1.0** (GA 2026-06-10) — the target.
- **Embabel Agent 2.0.0-SNAPSHOT** — the Spring Boot **4** line is *unreleased*.
  It is pulled from **Embabel's Artifactory** (`repo.embabel.com/artifactory/libs-snapshot`),
  **not** Maven Central. Bleeding edge — snapshot bytes can change without notice,
  and the build depends on that Artifactory being reachable. Baseline is Spring
  Boot 4.0.6 + Spring AI 2.0.0; we run it on 4.1. Pin a timestamped snapshot for
  reproducible CI. ✅ Verified: the full reactor compiles against it.
- **Java 21** (LTS).
- Repos added to the root pom: **Embabel Artifactory** (snapshots + releases) and
  **Spring Milestones** (for Spring AI). It transitively pulls Spring AI 2.0.0 +
  Jackson 3.
- **Routing engine: Embabel (`_embabel`), not Spring Integration** — Spring
  Integration was considered as a routing substrate and explicitly ruled out.

## Security reality-check (mTLS over ngrok)

The PRD requires genuine end-to-end mutual TLS terminating at the gateway. ngrok's
standard HTTPS tunnels terminate TLS at **ngrok's edge**, so client-certificate
validation at your server needs either an ngrok **TLS/TCP** (raw pass-through)
tunnel or ngrok's **mutual-TLS edge** feature. Prove this path before building on
it — it's the riskiest integration in the design.

## Build & run

```bash
# JVM: build every module from the root reactor
mvn -q install

# run the gateway — starts on :8080. Without DISCORD_TOKEN, Discord is disabled
# (the gateway still runs). With a token AND the MESSAGE_CONTENT privileged intent
# enabled in the Discord Developer Portal, the bot connects; type "!ping" in a
# channel and it replies "pong 🏓".
DISCORD_TOKEN=your-bot-token mvn -pl gateway spring-boot:run

# control plane (front-end dev server on :1420)
cd control-plane && npm install && npm run dev
```

> No Maven/Node wrapper is committed yet; add `mvnw`/a pinned Node as a follow-up.
> The Tauri Rust crate (`control-plane/src-tauri/`) is not scaffolded yet.
> **Temporary:** Embabel's `AgentPlatformAutoConfiguration` is excluded in
> `gateway/src/main/resources/application.yml` — it eagerly requires an LLM at
> startup. Remove the exclusion once a local model (e.g. Ollama) is wired.

## Your first contribution

The `_embabel` routing engine's core decision — *which persona handles an incoming
Discord message* — is left for you to shape. The prepared spot is
`PersonaRouter.route(IncomingMessage)` in the **personas** module
(`personas/src/main/java/com/jefelabs/smithagents/persona/PersonaRouter.java`). It
iterates `registry.all()` and matches on `persona.keywords()` / `persona.name()`.
The comment block there lays out the strategy trade-offs (explicit @mention vs.
keyword/domain vs. LLM classification) and the two decisions to make: the cheap
default path, and the no-match behavior. Keep it data-driven — never name a
persona literally.

## Open spec gaps (from PRD §6)

- **Phillip** and **Yellison** are referenced as the audited implementers but never
  defined. Agents (needing persona configs under `personas/`), or humans?
- The mapping of the three personas onto the five atomic-design levels needs to be
  made explicit.
