# Dock Sends Edit the Artifact Implementation Plan

> **CLAIMED:** in execution by Claude session d43af92a (inline, main checkout) since 2026-08-11. Do not execute concurrently.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sends from `/doc`/`/diagram` carry the viewed artifact and run a broker edit turn — Anderson applies section rewrites directly; sends directed at a crew agent land as sticky-note Proposals with Accept/Dismiss.

**Architecture:** The `/utterance` route gains an optional `doc: { docId, sectionId? }` passed through the directed seam. main.ts branches: brain resolution → in-broker edit turn (new `doc-edit.ts`, stubbed-LLM-testable) applied via `patchSection`; agent resolution + doc context → the same turn persona-flavored, stored via new `DocumentManager` proposal methods, never dispatched to the CLI swarm. Frontend: `uiStore.docTarget` aim chip (SectionCard → Composer), `postUtterance(text, target, doc?)`, and sticky-note cards on DocumentStage wired to accept/reject routes.

**Tech Stack:** Broker: Node http routes in text-channel.ts, Anthropic SDK (`anthropic.messages.create`), node:test. CP: React 19, zustand, vitest.

**Spec:** `docs/superpowers/specs/2026-08-11-dock-sends-edit-artifact-design.md`

## Global Constraints

- Anderson/default (`resolveTarget` → `{kind:"brain"}`) = direct apply; crew (`{kind:"agent"}`) + doc context = Proposal, NO swarm dispatch. Squad/group targets with doc context → 400 ("direct a doc instruction at one agent").
- Failure semantics: unparseable/failed model reply → nothing written, error broadcast as `{type:"speech", text}`. Never a half-applied doc.
- All proposal state changes and applied edits broadcast `documentsFrame()`.
- Edit-turn model: `claude-sonnet-5` (document rewrites deserve it; utilities stay haiku).
- Every mutating route carries the same `originBlocked()` guard as existing document writes.
- Dashboards excluded. Diagrams: whole-doc target (no aim UI on DiagramStage).
- Shared checkout discipline: stage only named files, verify `[main <hash>]` + counts; co-author footer.

---

### Task 1: DocumentManager proposal lifecycle (broker)

**Files:** Modify `broker/src/documents.ts`; Test `broker/src/documents.test.ts` (follow its existing fixture style — it builds a manager over an in-memory `DocumentStoreLike`).

**Produces:**
- `addProposal(docId, p: { sectionId, agentId, newBody, rationale }): Doc | null` — pushes `{id: "p"+seq, state:"open", createdAt: now()}`; null on unknown doc/section.
- `acceptProposal(docId, proposalId): Doc | null` — applies `newBody` through the same normalize+save path as `patchSection`, marks `accepted`; null unless proposal is `open`.
- `rejectProposal(docId, proposalId): Doc | null` — marks `rejected`; null unless `open`.
- `patchSection` additionally marks every OPEN proposal on that section `stale` (the human wrote over it) — EXCEPT the apply performed inside `acceptProposal` (use a private `applySection` both call; only the public `patchSection` stales).

- [ ] Tests first: add/accept round-trip (body normalized, states correct, accepted proposal's section updated); reject; stale-on-patchSection (open→stale, accepted/rejected untouched); null cases (unknown doc/section/proposal, non-open proposal). Run → FAIL.
- [ ] Implement (private `proposalSeq` counter persisted by scanning ids on `init`, like doc seq). Run → PASS. Commit `feat(broker): proposal lifecycle on DocumentManager`.

### Task 2: the edit turn (broker)

**Files:** Create `broker/src/doc-edit.ts`, `broker/src/doc-edit.test.ts`.

**Produces:**
```ts
export interface DocEditResult { rewrites: Array<{ sectionId: string; newBody: string }>; note: string }
export async function runDocEditTurn(opts: {
  doc: Doc; instruction: string; targetSectionId?: string;
  persona?: string;              // crew agent persona/name; absent = the host
  create: (params: object) => Promise<{ content: Array<{ type: string; text?: string }> }>; // anthropic.messages.create-shaped
  model?: string;                // default "claude-sonnet-5"
}): Promise<DocEditResult>       // throws Error("edit turn returned no usable rewrites") on garbage
```
- Prompt: system = editor persona + STRICT output contract (single fenced JSON `{"rewrites":[{"sectionId","newBody"}],"note":"one short line"}`); user = doc title/blueprint/workType + every section (id, heading, body) + `TARGET SECTION: <id>` when given + the instruction.
- Parse: first ```json fence or bare JSON object in the text content; validate every `sectionId` exists on the doc and `newBody` is a string; empty/invalid → throw. Never partial.

- [ ] Tests with a stubbed `create` (capture params; return canned fences): happy path (rewrites+note; prompt contains target flag + persona when given), invalid sectionId → throw, malformed JSON → throw, model default + override in params. Run → FAIL, implement, PASS. Commit `feat(broker): runDocEditTurn — structured section rewrites from an instruction`.

### Task 3: /utterance carries doc context; main.ts branches (broker)

**Files:** Modify `broker/src/text-channel.ts` (utterance route + `directed` seam type), `broker/src/main.ts` (directed.send), Test `broker/src/text-channel.test.ts`.

- text-channel: parse optional `doc` (`{docId: string, sectionId?: string}`) from the utterance body; when present, ALWAYS take the directed path (default target = host) passing it through: seam becomes `send(text, target, doc?)`. Existing no-target/no-doc behavior byte-identical (202 fast path).
- main.ts `send(text, rawTarget, doc?)`:
  - no doc → exactly today's behavior.
  - doc + resolution brain → `runDocEditTurn({doc: documentManager.get(docId), instruction: text, targetSectionId, create: (p)=>anthropic.messages.create(p as never)})`; apply each rewrite via `documentManager.patchSection`; broadcast `documentsFrame()` + `{type:"speech", text: note}` (falls back to `updated ${headings.join(", ")}`); return `{ok:true}`. Unknown docId → `{error, status:404}`. Turn throw → `{ok:true}` AFTER broadcasting `{type:"speech", text: "couldn't apply that: …"}` — the transcript carries the failure, the composer isn't blocked.
  - doc + resolution agent → same turn with `persona: <agent name/role from directory>`; store each rewrite via `addProposal(docId, {sectionId, agentId: name, newBody, rationale: note})`; broadcast documentsFrame + speech ("N suggestion(s) from <name> on <doc title>"). No dispatch.
  - doc + squad/group resolution → `{error: "direct a doc instruction at one agent", status: 400}`.
- [ ] Route tests (stub seam capturing args): doc passes through; doc with no target still hits directed path; plain utterance unchanged. main.ts branches are covered by Task 2's unit tests + Task 7 smoke (main.ts is wiring, per repo convention). Run → FAIL, implement, PASS. Commit `feat(broker): doc-context sends run the edit turn — apply for host, propose for crew`.

### Task 4: proposal accept/reject routes (broker)

**Files:** Modify `broker/src/text-channel.ts` (routes + documents seam: add `acceptProposal(docId, pid): string | null`, `rejectProposal(docId, pid): string | null` — null=ok, string=error, mapped 404), `broker/src/main.ts` (adapter calls manager + broadcasts documentsFrame), Test `broker/src/text-channel.test.ts`.

- `POST /documents/:id/proposals/:pid/accept` and `/reject`, originBlocked-guarded, following the PATCH section route's shape.
- [ ] Route tests with stubbed seam (200 on null, 404 on string, guard present). Run → FAIL, implement, PASS. Commit `feat(broker): proposal accept/reject routes`.

### Task 5: send carries the doc + aim chip (control plane)

**Files:** Modify `control-plane/src/api/types.ts` (DocT gains `proposals?: ProposalT[]`; `export interface ProposalT { id; sectionId; agentId; newBody; rationale; state; createdAt }`), `api/broker.ts` (`postUtterance(text, target?, doc?: {docId; sectionId?})` — include `doc` in the body when given; new `acceptProposal(docId, pid)`, `rejectProposal(docId, pid)` POST helpers returning `string | null` error), `stores/uiStore.ts` (`docTarget: {docId; sectionId; heading} | null`, `setDocTarget`, `clearDocTarget`), `pages/HomePage.tsx` (onSend wrapper: on `/doc/:id`/`/diagram/:id` paths inject `doc: {docId: pathId, sectionId: docTarget?.docId === pathId ? docTarget.sectionId : undefined}`; clear the target after a successful send), `molecules/Composer.tsx` (optional `docTarget?: {heading} `+`onClearDocTarget` → dismissible chip `→ {heading}` beside the target selector), `organisms/document/SectionCard.tsx` (optional `onAim?: () => void` → crosshair button, aria-label `Target {heading}`), `organisms/DocumentStage.tsx` (optional `onAimSection?: (sectionId, heading) => void` passed down), `router.tsx` DocRoute wires it to the store. Tests in each file's suite.

- [ ] Tests: uiStore set/clear; postUtterance body includes doc (fetch stub); SectionCard aim fires; DocumentStage forwards; Composer chip renders + clears; HomePage sends doc context on /doc and clears the chip (renderApp at /doc/d1 with seeded queries, stub fetch, click aim, type+send, assert body). Run → FAIL, implement, PASS. Commit `feat(cp): dock sends carry the viewed doc + aim-a-section chip`.

### Task 6: sticky notes (control plane)

**Files:** Modify `organisms/DocumentStage.tsx` (render `doc.proposals` with `state==="open"` grouped under their section, above the SectionCard: agent name, rationale line, `newBody` preview (first ~240 chars), Accept/Dismiss buttons → new optional props `onAcceptProposal?/onRejectProposal?: (proposalId: string) => Promise<string | null>`), `router.tsx` DocRoute wires the api helpers, `styles/documents.css` (`.sticky-note` card: warm accent-tinted border/background via color-mix on `--accent`, small rotation for the sticky feel, monospace agent tag). Tests in DocumentStage.test.tsx.

- [ ] Tests: open proposal renders under its section with agent+rationale; accept/dismiss call through with the id; accepted/rejected/stale proposals don't render. Run → FAIL, implement, PASS. Commit `feat(cp): sticky-note proposals on the document canvas`.

### Task 7: verification, smoke, restart, push

- [ ] `pnpm test` (root, all packages) exit 0 via redirect; `pnpm typecheck`; `pnpm lint` zero diagnostics.
- [ ] Restart the live broker (tmux `smith-broker`, C-c + `node --env-file=../.env --import tsx src/main.ts` — session survives, it was recreated shell-first… verify with capture-pane first).
- [ ] Live smoke on a real doc: dock send "tighten the Approach section" → section updates + speech ack; aim a section and send; direct a send at a crew agent → sticky note appears → Accept applies it. Screenshot each state and LOOK.
- [ ] Update the spec's status line to SHIPPED, commit, push (ecruz165 dance), update memory.
