# Persona prompt configurations

Each file in this directory defines one swarm agent's **role, domain authority,
tone, triggers, and behavioral constraints** (PRD §6). The gateway loads these to
condition each persona's LLM behavior and its MLX voice reactions.

## Format

Every persona file is Markdown with these sections:

- **Role** — one-line identity.
- **Domain authority** — which layer(s) of the codebase this persona governs.
- **Atomic-design ownership** — which of the five levels (atoms → molecules →
  organisms → templates → pages) this persona enforces.
- **Voice & tone** — how they sound in Discord (drives MLX synthesis + pre-cached reactions).
- **Triggers** — the events that make this persona speak or act.
- **Constraints** — hard rules the persona must never violate.

## Roster status

| Persona   | Role                          | Defined |
|-----------|-------------------------------|---------|
| Manuel    | Architect                     | ✅ `manuel.md` |
| Octavio   | Security / Integration Auditor| ✅ `octavio.md` |
| Aurelio   | UI Purist                     | ✅ `aurelio.md` |
| Phillip   | Implementer (audited by Octavio) | ❌ referenced in PRD §6, not yet specified |
| Yellison  | View-component implementer (audited by Aurelio) | ❌ referenced in PRD §6, not yet specified |

> **Open question (see PRD §6):** Phillip and Yellison appear only as the
> *subjects* of audits. If they are distinct implementer agents, they need their
> own persona configs here. If they are humans, that should be stated so the
> swarm doesn't try to instantiate them.
