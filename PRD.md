# Implementation Product Requirements Document: `smithagents`

> **Status:** Source of truth. Committed 2026-07-18. Amend this file — do not fork it into side docs.

## 1. Product Overview

**Project Name:** `smithagents`

**Objective:** Deploy a localized, multi-agent autonomous swarm to operate as
specialized virtual contractors accelerating the refactor of a multi-tenant B2B
platform (SkoolScout). The swarm rigidly enforces a five-experience atomic
design structure (atoms → molecules → organisms → templates → pages),
interfacing with the human engineering team via Discord voice and text.

**Hosting Infrastructure:** A split-brain architecture. The computational heavy
lifting — local MLX audio generation, LLM orchestration, and ephemeral
execution environments — is centralized on a localized Mac Studio (Apple silicon
Ultra; verify exact SKU). The control plane is a unified Tauri 2.0 application
deployed to both a premium iPhone and a remote laptop, communicating securely
back to the host via an `ngrok` tunnel.

---

## 2. Flat Topology & File System

The repository architecture explicitly forbids a traditional `src` folder. All
orchestrators, registries, configuration files, and terminal views live directly
at the root to maintain strict domain visibility and prevent nested abstraction.

**Root Directory Map:**

* `.github/prompts/` — Persona configurations, behavioral constraints, and domain directives.
* `audio-cache/` — Repository for instantaneously accessible `.wav`/`.mp3` files, populated by the local MLX engine.
* `GatewayApplication.java` — The Spring Boot entry point, operating the Discord WebSockets, the `_embabel` routing engine, and the mTLS validation layer.
* `AgentRobot.java` — The native AWT execution bridge for OS-level keystroke injection.
* `docker-compose.yml` — Infrastructure definitions for the ephemeral branch environments.
* `tauri.conf.json` & `index.html` — The Tauri 2.0 configuration and React entry points for the unified desktop and iOS control plane.

---

## 3. The Mac Studio Host (The Central Nervous System)

The Ultra host executes the entire backend infrastructure with zero reliance on
external APIs.

* **Spring Boot & `_embabel` Gateway:** Runs the Java Discord API (JDA) to stream raw PCM audio directly to the channel and route transcriptions. Hosts the WebSocket server that synchronizes the Tauri thin clients.
* **Native MLX Voice Engine:** A localized 3B audio LLM (e.g., Step Audio EditX or Qwen3-TTS) runs directly in unified memory. When triggered, it zero-shot clones voices and synthesizes paralinguistic reactions (sighs, "hmm") in milliseconds, dumping assets straight into `audio-cache/`.
* **Helmsmith Memory Server:** The persistent memory module maintaining established architectural decisions and multi-tenant rules across the SkoolScout platform. It outlives the ephemeral Docker containers and acts as the contextual bedrock.

---

## 4. The Ephemeral Execution Sandboxes

Execution environments are tied exclusively to the lifecycle of a feature branch.
They are spawned when a branch is created and completely annihilated the moment
the pull request is merged.

* **The Blueprint Handoff:** Once the Java gateway generates a structured `PRD-*.md` file from a Discord conversation, the `AgentRobot` triggers the integrated terminal.
* **The Isolated Environment:** A Docker DevContainer spins up specifically for the active feature branch. Inside, Claude Code operates via a `tmux` session, outfitted with the GitHub CLI, `@biomejs/biome`, `kubectl`, and the TypeScript compiler.
* **Context Initialization:** Before executing, the container immediately connects to the Helmsmith MCP to ingest the strict atomic design rules, ensuring no codebase modifications violate established patterns.

---

## 5. The Tauri Control Plane (Mobile & Desktop)

The operator dashboard is a single React/TypeScript codebase compiled into two
distinct native wrappers using Tauri 2.0, acting as remote controls for the host.

* **Security (mTLS over `ngrok`):** Both clients connect to the Spring Boot WebSocket server through the `ngrok` tunnel. The Java backend strictly enforces Mutual TLS (mTLS); it rejects any connection lacking the specific device certificates stored in the laptop's secure enclave and the iPhone's keychain.
* **iOS Tactical Interface:** Running via WKWebView on the iPhone, the mobile view provides push-to-talk audio injection and instant haptic feedback when a feature branch container spins up or dies. It allows immediate overriding and audio-cache generation on the go.
* **Desktop Strategic Interface:** The laptop view uses the wider screen real estate for multiplexed streaming. It renders real-time terminal outputs from active Docker containers alongside the Audio Forge, allowing drag-and-drop voice cloning directly into the MLX pipeline.

---

## 6. The Persona Roster & Team Alignment

The swarm's logic is defined by the specific roles of the agents, dictating how
they influence the repository and interact with human engineers.

* **Manuel (The Architect):** Commands the overarching multi-tenant routing and infrastructure. Pulls context directly from Helmsmith to evaluate cross-domain impacts and deflects processing latency with warm, human-like conversational audio generated by the local MLX engine.
* **Octavio (The Security / Integration Auditor):** Coldly analytical. Asserts complete control over API integration boundaries and page-level compositions. Relentlessly audits Phillip's pull requests, pulling diffs via the GitHub MCP and interjecting with clipped, pre-cached acoustic humming if an API payload strays from specification.
* **Aurelio (The UI Purist):** The absolute enforcer of atomic design patterns. Focuses exclusively on Yellison's view components. If a proposed component breaks visual isolation rules, Aurelio triggers an arrogant, locally synthesized sigh into the Discord voice channel before the Biome.js failure logs are even posted.

### Open spec gaps (to resolve)

* **Phillip** and **Yellison** are referenced as the *implementers* whose work is
  audited (Octavio → Phillip's PRs; Aurelio → Yellison's components) but are not
  defined in this roster. If the swarm has implementer agents distinct from the
  three auditors, they need roles, domains, and prompt configs.
* The mapping between the three defined personas and the five atomic-design
  levels needs to be made explicit (which persona owns molecules vs. organisms
  vs. templates?).
