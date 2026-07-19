# personas

The **data-driven persona roster** (PRD §6) — a plain Java library (no Spring Boot
app) that the gateway depends on. The roster is *configuration, not code*: the
enum-free design means adding a persona is dropping a Markdown file, not editing
Java.

## Contents

- `Persona` — the persona record (id, name, role, keywords, directives).
- `PersonaRegistry` — loads persona configs from the classpath
  (`classpath*:prompts/*.md` by default; override with `smithagents.personas.location`).
- `PersonaRouter` — the `_embabel` routing decision (message → persona). **This is
  the one method left for you to implement** (see the root README).
- `IncomingMessage` — the normalized inbound-message record the router consumes.
- `src/main/resources/prompts/` — the persona config files.

## Persona file format

Each `prompts/*.md` file is optional YAML front-matter + a Markdown directives body:

```markdown
---
name: Manuel
role: The Architect
keywords: [tenant, routing, infrastructure, ...]
---

# Manuel — The Architect
...behavioral contract / system prompt...
```

`PersonaRegistry` parses the front-matter for routing metadata (`name`, `role`,
`keywords`) and keeps the Markdown body as the persona's `directives`. Files
named `README.md` are ignored.

## Roster status

| Persona   | Role                          | Defined |
|-----------|-------------------------------|---------|
| Manuel    | Architect                     | ✅ `prompts/manuel.md` |
| Octavio   | Security / Integration Auditor| ✅ `prompts/octavio.md` |
| Aurelio   | UI Purist                     | ✅ `prompts/aurelio.md` |
| Phillip   | Implementer (audited by Octavio) | ❌ referenced in PRD §6, not yet specified |
| Yellison  | View-component implementer (audited by Aurelio) | ❌ referenced in PRD §6, not yet specified |

> **Open question (PRD §6):** Phillip and Yellison appear only as the *subjects* of
> audits. If they are distinct implementer agents, add their configs here. If they
> are humans, state that so the swarm doesn't try to instantiate them.
