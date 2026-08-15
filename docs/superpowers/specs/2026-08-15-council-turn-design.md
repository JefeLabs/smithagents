# Council Turn — Design

**Status:** design, awaiting review
**Date:** 2026-08-15

## Goal

Make talking to the crew a *council* rather than one assistant doing impressions.
Edwin says "I want to sketch out the orders database"; Anderson works out what
outcome is wanted, creates the artifact, switches the view to it, and sketches in
mermaid — while real specialists, running on **genuinely different model
families**, weigh in and disagree.

The schema conversation is the first use, not the point. The point is the council
turn: a primitive that fans one question to independent minds and reports where
they diverge.

## Why today's version is theatre

Anderson writes every line. Speech text is prefixed with a speaker name
(`SPEAKER_RE`), the broker resolves that name to a persona and plays it in that
agent's voice. The voices differ; the mind does not. Three consequences:

1. No specialist can reach a conclusion Anderson did not reach.
2. No specialist can disagree with Anderson, because they *are* Anderson.
3. No specialist accumulates a point of view across sessions.

The product thesis is "a council that vets, drafts and decides, not one Jarvis."
Ventriloquism is the version that looks like that without being it.

## What already ships (verified 2026-08-15, not assumed)

Substantial machinery exists. This design adds orchestration, not primitives.

| Capability | Where | State |
|---|---|---|
| Hand-raising for un-addressed agents/squad leaders | `brain.ts` `raise_hand` tool | ships |
| Hands carried to the UI | `broker.ts:563` roster frame `hands` | ships |
| Hands injected into Anderson's prompt | `broker.ts:917` | ships |
| Hand lowered when its owner speaks | `broker.ts` `lowerHandFor()` | ships |
| "Click to give them the floor" | `AgentAvatar.tsx:89` | ships |
| Per-agent TTS voice | `elevenVoiceFor()`, `publishPcm(…, personaId)` | ships |
| Per-agent engine | `AgentEngine {kind, cli, provider, model}` | ships |
| Per-agent memory scope | `memory.ts` `scope.agent` | ships |
| One-instruction doc edit with a persona | `doc-edit.ts` `runDocEditTurn()` | ships |
| CLI-backed inference, no API key | `research.ts` `CliResearch` | ships |
| Mermaid render | `MermaidBlock.tsx`, `DiagramStage.tsx`, `/diagram` | ships |
| Interactive canvas w/ custom nodes | `@xyflow/react`, `map/nodeTypes.tsx` | ships |

**Missing:** a way for a specialist to actually *think* independently, and a way
for Anderson to create an artifact and move the view.

## Verified engine matrix

The council's independence claim rests on running specialists on different model
families. Measured on this machine, 2026-08-15:

| CLI | Family | Status |
|---|---|---|
| `claude` | Anthropic | works |
| `agy` | Google / Antigravity | works |
| `codex` | OpenAI | **402 `deactivated_workspace`** |
| `copilot` | GitHub | **wrong identity** — logged in as `edwin-skoolscout`, whose org policy blocks it; a re-login as `ecruz165` is expected to work |
| `opencode` | configurable | untested |

Two independent families are confirmed working today, both on subscription auth
with **no API credit**, and copilot is a third pending a re-login. `RESEARCH_ARGV`
already maps all five CLIs, and `AgentEngine.cli` already accepts all five.

Note that the Copilot CLI keeps its **own** credential, independent of `gh auth`
— switching the active `gh` account does not change it (`copilot login` does).
Its identity is recorded in `~/.config/github-copilot/apps.json`. Worth knowing
before diagnosing a policy error as an entitlement problem, which is the mistake
made once already.

A council of one family still works — it just disagrees less, so the dissent rule
below carries more weight.

## The council turn

One new primitive in the broker.

```
councilTurn({
  question: string,
  agents: AgentRef[],          // resolved by Anderson, or named by the human
  context: string,             // the artifact under discussion + relevant memory
}) → {
  opinions: Array<{ agent, position, reasoning }>,
  divergence: null | { axis: string, sides: Array<{ position, agents }> },
}
```

Behaviour:

1. **Fan out in parallel.** Each agent gets its own turn, built from *its own*
   `engine` via `engineForAgent(agent) → ResearchEngine` — `kind:"cli"` maps
   through `RESEARCH_ARGV`, `kind:"api"` through the existing provider seam. Each
   turn reads that agent's `scope.agent` memory, so specialists accumulate a real
   point of view.
2. **Compare.** Unanimity collapses to one line; divergence is reported with who
   holds which position.
3. **Dissent on suspicious agreement.** If the council returns unanimous, one
   member on a *different* family than the majority is asked to steelman the
   opposing case. Automatic — never a standing role, which would be noise on
   trivial turns.

Parallelism is load-bearing: three sequential CLI turns is ~18s of dead air;
three parallel is ~6s.

**Anderson never votes.** He convenes, narrates, and decides what to draw.

## Anderson's new tools

Three, joining the existing ten.

| Tool | Does | Rides on |
|---|---|---|
| `create_artifact{kind,title}` | Infers the outcome, creates it, moves the view | `POST /documents`, `familyForKind()` |
| `edit_artifact{instruction}` | Rewrites the mermaid to match the conversation | `runDocEditTurn()` |
| `convene{question,agents?}` | Runs a council turn | the primitive above |

`edit_artifact` and `convene` run on `ResearchEngine` — the CLI — so the council
costs **no API credit**. Only Anderson's own judgment runs on the brain provider.

`raise_hand` keeps its current meaning and becomes the cheap signal: Anderson
noticing someone would have something to add, instantly and free. `convene` is
the expensive, real version, spent when it matters.

## The navigate frame

New frame `{type:"navigate", to:{kind,id}}`, joining the ten cases in
`socketStore.ts`. The socket deliberately lives *above* the router, so the store
cannot navigate: it parks a `pendingNavigation`, and a `useBrokerNavigation()`
hook inside the router consumes and clears it. Preserves the "no route loaders"
rule and keeps the path unit-testable without a browser.

## Artifact substrate

**Mermaid `erDiagram` text is the source of truth. React-flow is the renderer.**

- The council and Anderson edit *text*, so the existing `doc-edit.ts` path works
  unchanged. Text stays diffable, greppable, and portable into a PR.
- The canvas renders that text as draggable table nodes with columns and PK/FK
  markers, with manual positions persisted in a small overlay keyed by table
  name. New tables from an agent are auto-placed and can be nudged.
- Phase order matters: shipping the mermaid render first and swapping the
  renderer later is **not** rework, because the truth never changes.

The cost is an `erDiagram` parser. It is small, and it is where bugs will live.

## Phasing

Each phase is independently demoable.

1. **Anderson creates and moves the view.** `create_artifact`, the navigate
   frame, `useBrokerNavigation()`. Delivers the literal request.
2. **Anderson draws.** `edit_artifact` lands `erDiagram` text; `MermaidBlock`
   renders it. Now it is a design tool.
3. **The council convenes.** `convene`, `engineForAgent()`, parallel fan-out,
   divergence report, automatic dissent. This is the product.
4. **The ER canvas.** React-flow over the erDiagram truth, positions persisted.

## Error handling

- **A bad edit must not blank the diagram.** `runDocEditTurn` returns structured
  rewrites; parse the proposed `erDiagram` *before* committing and reject a
  rewrite that does not parse. Never persist unparseable truth.
- **Voice is lossy.** "orders" and "order" both arrive. Entity resolution reads
  the existing diagram text rather than guessing fresh each turn.
- **One specialist failing must not fail the council.** A dead engine (codex's
  402) drops that opinion and is reported, never thrown — the council returns
  with the members that answered.
- **Council latency is bounded.** A member that exceeds the timeout is dropped
  the same way, so one hung CLI cannot hold the floor.

## Testing

Pure functions unit-tested: kind inference, `erDiagram` parse/serialize, position
merge, divergence detection, `engineForAgent` mapping.

**Every phase also gets a live smoke.** Three separate defects this session
shipped with green suites — an unreachable drag path, dead `onGrab` plumbing, an
HTTP route with no server — and today's Gemini adapter passed ten unit tests
while being completely broken for multi-round tool turns. Green tests do not
prove reachability. Each phase must be driven end to end against real services
before it is called done.

## Prerequisite

**The roster has one agent** (`Smoke Tester`, a throwaway). Phase 3 has no
council to convene until real crew exist, with engines deliberately spread across
families — some on `claude`, some on `agy` — because a council where everyone
runs the same model is back to one mind in hats. The 12-card premade chooser
already ships, so this is seeding, not building.

## Open questions

- Should squad leaders carry extra weight in a divergence, or is a leader just
  another opinion?
- Does per-agent memory (`scope.agent`) get written automatically from council
  turns, or only when the human says "remember that"?
