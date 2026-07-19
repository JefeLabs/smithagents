# smithagents

A localized, multi-agent autonomous swarm that operates as specialized virtual
contractors accelerating a refactor of the SkoolScout multi-tenant B2B platform.
The swarm enforces a five-level atomic-design structure and interfaces with the
human team over Discord voice and text.

> **This is the skeleton.** The full design lives in [`PRD.md`](./PRD.md) — the
> committed source of truth. Read it first.

## Split-brain architecture

```
        ┌──────────────────────────── Mac Studio host (central nervous system) ──────────────────────────┐
        │  GatewayApplication.java   Spring Boot 4.1 + Embabel (_embabel routing) + JDA (Discord)         │
        │  MLX voice engine          local 3B audio LLM → audio-cache/                                    │
        │  Helmsmith memory server   persistent architectural memory (MCP)                                │
        │  docker-compose.yml        ephemeral per-feature-branch sandboxes                               │
        └───────────────────────────────────────────────┬────────────────────────────────────────────────┘
                                                         │  ngrok tunnel (mTLS enforced at the gateway)
                            ┌────────────────────────────┴────────────────────────────┐
                 ┌──────────┴───────────┐                                   ┌──────────┴───────────┐
                 │  Desktop (laptop)    │   ← single React/TS codebase →    │  iOS (iPhone)        │
                 │  Tauri 2.0 wrapper   │      (index.html + *.tsx)         │  Tauri 2.0 / WKWebView│
                 └──────────────────────┘                                   └──────────────────────┘
```

## Flat topology

Per PRD §2 there is **no `src/` folder** — orchestrators, config, and views live
at the repo root. That collides with several toolchains' defaults, so each is
explicitly reconciled:

| Toolchain | Default it wants | How we override it |
|-----------|------------------|--------------------|
| Maven     | `src/main/java`  | `pom.xml` sets `<sourceDirectory>${project.basedir}</sourceDirectory>` + a root resources filter for `application.*` |
| Spring Boot | non-default package | `GatewayApplication` is in the **default package**; documented caveat — component scan walks the whole classpath (interacts with Embabel's `@Agent` scanning) |
| Vite      | `src/` entry     | `vite.config.ts` uses the repo root as `root`; `index.html` loads `/main.tsx` |
| Tauri 2.0 | `src-tauri/` crate | **Open decision** — the Rust crate (`Cargo.toml`, `lib.rs`) is *not* scaffolded yet; a truly flat Tauri crate needs a config-path override or a sanctioned `src-tauri/` exception |

## Version decisions

- **Spring Boot 4.1.0** (GA 2026-06-10) — the target.
- **Embabel Agent 2.0.0** — the Spring Boot **4** line (validated against Spring
  Boot 4.0.6 + Spring AI 2.0.0-M8, Java 17+). We run it on 4.1; **fallback to
  4.0.6** if a Spring AI/Framework transitive conflict appears.
- **Java 21** (LTS).
- Spring AI 2.0.0-M8 is a milestone → `pom.xml` adds the Spring Milestones repo.
- **Routing engine: Embabel (`_embabel`), not Spring Integration.** Spring
  Integration was considered as an alternative messaging/routing substrate and
  explicitly ruled out — the stack is Spring Boot + Embabel only.

## Security reality-check (mTLS over ngrok)

The PRD requires genuine end-to-end mutual TLS terminating at the Spring Boot
gateway. ngrok's standard HTTPS tunnels terminate TLS at **ngrok's edge**, so
client-certificate validation at your server needs either an ngrok **TLS/TCP**
(raw pass-through) tunnel or ngrok's **mutual-TLS edge** feature. Prove this path
before building on it — it's the riskiest integration in the design.

## Repository map

```
PRD.md                     source of truth (PRD §1–6)
README.md                  this file
GatewayApplication.java    Spring Boot + Embabel + JDA entry point (PRD §3)
AgentRobot.java            AWT keystroke-injection bridge (PRD §2, §4)
pom.xml                    Maven build (flat-topology overrides)
docker-compose.yml         ephemeral per-branch sandboxes (PRD §4)
tauri.conf.json            Tauri 2.0 config (PRD §5)
index.html / main.tsx / App.tsx   React control-plane entry (PRD §5)
vite.config.ts / tsconfig.json / package.json   front-end build
.github/prompts/           persona configs: manuel, octavio, aurelio (PRD §6)
audio-cache/               MLX-generated audio (git-ignored contents)
```

## Build (once toolchains are installed)

```bash
# JVM gateway
mvn spring-boot:run

# Control plane (front-end dev server on :1420)
npm install
npm run dev
```

> No Maven/Node wrapper is committed yet; add `mvnw`/pinned Node as a follow-up.

## Your first contribution

The `_embabel` routing engine's core decision — *which persona handles an
incoming Discord message* — is left for you to shape. The prepared spot is
`GatewayApplication.routeToPersona(IncomingMessage)`. See the comment block there
for the strategy trade-offs (explicit @mention vs. keyword/domain vs. LLM
classification) and the two decisions to make: the cheap default path, and the
no-match behavior.

## Open spec gaps (from PRD §6)

- **Phillip** and **Yellison** are referenced as the implementers being audited
  but are never defined. Are they agents (need persona configs) or humans?
- The mapping of the three personas onto the five atomic-design levels needs to
  be made explicit.
