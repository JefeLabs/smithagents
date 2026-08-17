# Change visuals — what each kind of change owes a reader

**Purpose:** a human who did not write the change should be able to look at one picture and know enough to disagree with it. Diffs do not do this. A 24KB diff hides the one arrow that matters.

**The rule:** classify the change first, then produce the visual that kind of change owes. Not all three by reflex — the wrong diagram type is worse than none, because it implies a mechanism that isn't there.

## The taxonomy

| Kind | How you recognize it | Required visual | It must show | It fails review if |
|---|---|---|---|---|
| **Data / stored shape** | Persisted records change shape, id, or location; a migration exists | Entity diagram **and** a state diagram of the migration | What is rewritten *together in one pass*; every terminal state, including the defect ones | It implies one mechanism covers things that are actually hand-edited constants |
| **Structural / module** | New module, extraction, changed dependency direction | Component diagram | Direction of every dependency; which edges are value imports vs **type-only** (erased) | A box exists that doesn't correspond to a real module |
| **Behavioural / control flow** | New or changed call path, routing, ordering, retry | Sequence diagram | *Every* participant that can initiate the path — not just the common one; branch points; where a bug lived or could | It shows only the happy path |
| **API / contract** | Route added, payload or type widened, response reshaped | Before/after contract block **and** a sequence for the round trip | Old shape beside new shape; who is obliged to change | It describes the contract in prose without showing the shape |
| **UI / surface** | Component states, layout, navigation | State diagram, or an annotated wireframe | Every state — including empty, loading, error, and denied | It shows only the populated success state |
| **Config / ops** | Env, ports, service topology, deploy wiring | Deployment/topology diagram | What talks to what, on which port/host, and the fallback path | It omits what happens when a dependency is down |
| **Pure refactor** | Behaviour explicitly unchanged | **No diagram.** An equivalence claim plus the tests that prove it | Which existing tests constitute the proof | Someone drew a diagram anyway — that's ceremony, and it buries the real claim |

## Universal rules

- **Mermaid, in fenced ` ```mermaid ` blocks.** This repo renders it natively, so the diagram stays live and diffable rather than a screenshot that rots.
- **5–12 nodes per diagram.** Several focused diagrams beat one that needs zooming. If a diagram won't fit, that's usually the change telling you it does two things.
- **Every box cites a real symbol** — module, function, or route — as `<sha>:<file>:<line>`. No invented components. A box you cannot cite is a box you imagined.
- **Label edges with what flows** (a value, a call, a rewrite), never a bare arrow. "→" tells the reader nothing they couldn't guess wrong.
- **Never rely on colour alone.** It has to survive light mode, dark mode, and a colourblind reader.
- **Pin the range.** Head the document with the immutable SHA range it describes. Branch names move; a reader six weeks later needs the bytes you actually meant.
- **A "Discrepancies" section is mandatory, and may not be empty by default.** The author of the diagram verifies against *code*, not against the brief they were handed. Where the code contradicts the brief, the code wins and the contradiction gets written down.

## Why the last rule is the important one

The first change documented under this standard (`96d6d21..04e76af`, domain-neutral work kinds) had its brief corrected twice by the agent drawing the diagrams:

1. The brief claimed a docstring called something a "recovery path." It doesn't — that was an inference about behaviour restated as a quote. The behaviour was right; the citation was invented.
2. The brief said the column-id rename and *both* route tables "move together in one pass." False at the mechanism level: `board.columns[].id` and every card's `columnId` really are rewritten together at load time by `normalizeBoard`, but `BOARD_ROUTES` (swarm) and `BOARD_ROUTES_UI` (control-plane) are two hand-maintained source literals that merely changed in the same commit. Drift between them is a known soft spot — it doesn't corrupt data, it offers a UI affordance that 400s on click.

Nobody caught either in code review. Both surfaced the moment someone had to *draw* the mechanism, because a diagram cannot hedge: the migration arrow either touches the route tables or it doesn't. That is the actual argument for this standard — not prettiness, but that drawing forces a precision prose lets you skip.

## Where these live

Alongside the work, in the plan's workspace: `.superpowers/sdd/<plan>/change-diagrams.md`. Promote to `docs/` when the change is something the team will need to understand later, rather than only to review now.
