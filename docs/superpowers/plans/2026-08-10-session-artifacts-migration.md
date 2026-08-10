# Session Artifacts Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Claimed by:** unclaimed — claim this header before executing

**Goal:** Replace session kinds with optional session artifacts, make the composer a kind toggle where SEND commits document creation, and add the stage-manager artifact shelf — migrating the phase-1 model shipped at `dc6fc5a`.

**Architecture:** Broker: `Session.artifacts` replaces `kind`/`docId` (legacy files normalize at init), `addArtifact` on the manager, and `POST /documents` v2 (`{blueprintId, workType?, text}` — title derived via `truncateTitle`, doc attached to the active session, lazily creating one, text fed through the utterance path). Control-plane: types/parsers mirror (absent artifacts → `[]`), SessionsPanel rows grow artifact chips, NewSessionScreen reverts to chat-only, the Composer gains the arm/send toggle with blueprint chips, and a new `ArtifactShelf` molecule stages the active session's documents on the chat stage.

**Tech Stack:** Same as phase 1 — broker Node ≥24/tsx/node:test/npm; control-plane React 19/HeroUI/vitest/pnpm. **No new dependencies. No new HeroUI compound components** (the kind group and chips are plain buttons — zero API-verification risk).

**Spec:** `docs/superpowers/specs/2026-08-10-session-artifacts-design.md`

## Global Constraints

- **Base:** branch `session-artifacts` off `develop` (tip ≥ `20b92a2`, which contains the shipped phase 1 at `dc6fc5a`). Isolated worktree `.worktrees/session-artifacts`.
- Package managers: broker = npm (`npm run typecheck && npm test` from `broker/`; targeted `node --import tsx --test src/<f>.test.ts`); control-plane = pnpm (`pnpm typecheck && pnpm lint && pnpm test` from `control-plane/`). Exit codes after a redirect, never a pipe.
- **Lockstep parsers:** the session frame's shape changes in BOTH `broker/src/main.ts` (`sessionFrame()`) + `broker/src/text-channel.ts` (ChannelFrame type) AND `control-plane/src/api/types.ts` + `src/stores/socketStore.ts` + `src/queries/pushed.ts` (ActiveSession). `artifacts` is ALWAYS present on the wire from the new broker; the CP parser normalizes absent (old broker) to `[]`. Legacy `kind`/`docId` on persisted session FILES must never crash — normalized at broker `init()`.
- **Frozen:** `components.css` never touched. New styles → `src/styles/documents.css` (already `layer(legacy)`). Pro-default conflicts → `overrides.css` under `@layer overrides`; never inline `style={{}}`.
- The Composer's hold-to-talk gesture code and its 18 frozen tests: byte-identical, as always.
- Copy: all-lowercase UI copy ("chat", "document", "describe the document you want…", "create as document").
- Organisms router-free; no route loaders; queries above the router.
- Commit messages lowercase-descriptive; every commit lists exactly its task's files.

---

## File Structure

| Path | Change |
|---|---|
| `broker/src/sessions.ts` | `artifacts` replaces `kind`/`docId`; legacy normalization; `addArtifact` |
| `broker/src/sessions.test.ts` | migration + addArtifact tests; kind tests replaced |
| `broker/src/main.ts` | `sessionFrame()` artifacts; documents.create closure v2 (attach + lazy session + utterance feed) |
| `broker/src/text-channel.ts` (+test) | ChannelFrame session variant type; POST /documents v2 body (`text`, no `title`) |
| `control-plane/src/api/types.ts` | `SessionSummary.artifacts: string[]`; session-frame variant; kind/docId gone |
| `control-plane/src/stores/socketStore.ts` (+test) | normalize `artifacts ?? []` when writing both session + sessions keys |
| `control-plane/src/queries/pushed.ts` | ActiveSession gains `artifacts` (drops kind/docId) |
| `control-plane/src/queries/http.ts` | `useBlueprints()` hook (fetch `getBlueprints`, staleTime Infinity, file's existing idiom) |
| `control-plane/src/api/broker.ts` | `postDocument(blueprintId, text, workType?)` v2 |
| `control-plane/src/organisms/SessionsPanel.tsx` (+test) | row container + artifact chips; kind badge removed |
| `control-plane/src/pages/HomePage.tsx` | activation always `/`; `onOpenArtifact`; panel wiring |
| `control-plane/src/organisms/NewSessionScreen.tsx` (+test) | document mode REMOVED (chat-only) |
| `control-plane/src/molecules/Composer.tsx` (+test) | kind group, armed state, blueprint chips, `onSendDocument` |
| `control-plane/src/molecules/ArtifactShelf.tsx` (+test, new) | the stage-manager shelf |
| `control-plane/src/organisms/VoiceStage.tsx` (+test) | renders the shelf via props |
| `control-plane/src/router.tsx` (+test) | VoiceRoute wires shelf + armed send; DocRoute wires the group's chat side |
| `control-plane/src/styles/documents.css` | group/chips/shelf/armed styles |

---

### Task 1: Broker — artifacts on sessions

**Files:**
- Modify: `broker/src/sessions.ts`
- Test: `broker/src/sessions.test.ts`

**Interfaces:**
- Produces: `Session.artifacts?: string[]` (absent = none; legacy `kind`/`docId` fields REMOVED from the type but normalized when loading old files); `SessionSummary.artifacts: string[]` (always resolved, kind/docId gone); `create(workspace, opts)` accepts `artifacts?: string[]` (kind/docId opts gone); `addArtifact(sessionId: string, docId: string): Session | null` (append-if-absent, bump updatedAt, persist; null on unknown session). Tasks 2/3 build on these.

- [ ] **Step 1: Replace the kind tests with failing artifacts tests**

In `sessions.test.ts`, DELETE the two phase-1 kind tests ("sessions default to kind chat…" and "a persisted legacy session with no kind lists as chat") and add, using the file's existing store/manager helpers:

```ts
test('sessions list with their artifacts; none means empty array', () => {
  const m = new SessionManager({ loadAll: () => [], save: () => {} });
  m.create('acme', {});
  const [row] = m.list();
  assert.deepEqual(row.artifacts, []);
});

test('addArtifact appends once, bumps updatedAt, persists; unknown session is null', () => {
  const writes: Session[] = [];
  let t = 0;
  const m = new SessionManager({ loadAll: () => [], save: (s) => writes.push(structuredClone(s)) }, () => `2026-08-10T00:00:0${t++}.000Z`);
  const s = m.create('acme', {});
  assert.ok(m.addArtifact(s.id, 'd1'));
  assert.equal(m.addArtifact(s.id, 'd1')?.artifacts?.length, 1); // idempotent append
  assert.ok(m.addArtifact(s.id, 'd2'));
  assert.deepEqual(m.list()[0].artifacts, ['d1', 'd2']);
  assert.equal(m.addArtifact('s99', 'd3'), null);
  assert.ok(writes.length >= 3); // create + two effective appends
});

test('a legacy persisted document-kind session normalizes to artifacts', () => {
  const legacy = {
    id: 's4', title: 'Login spec', workspace: 'acme', runtime: 'local-in-process',
    kind: 'document', docId: 'd7',
    createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
    transcript: [], brainHistory: [],
  } as unknown as Session;
  const m = new SessionManager({ loadAll: () => [legacy], save: () => {} });
  m.init();
  assert.deepEqual(m.list()[0].artifacts, ['d7']);
});
```

- [ ] **Step 2: Run to confirm failures**

Run: `node --import tsx --test src/sessions.test.ts`
Expected: 3 new tests FAIL (`artifacts` undefined / addArtifact missing); the deleted tests are gone; the rest PASS.

- [ ] **Step 3: Implement**

In `sessions.ts`:
- Remove `SessionKind`, and `kind`/`docId` from `Session` and `SessionSummary`. Add to `Session` (after `runtime`): `/** Documents this session produced/works on. Absent on old files = none. */ artifacts?: string[];` and to `SessionSummary`: `artifacts: string[];`
- `create()` opts: replace `kind?/docId?` with `artifacts?: string[]`; construct with `artifacts: opts?.artifacts ?? []`.
- `list()` maps `artifacts: s.artifacts ?? []` (drop the kind/docId mappings).
- `init()` normalization, inside the load loop (legacy tolerance is permanent):

```ts
      // Legacy phase-1 files: kind:"document" + docId → artifacts. Old fields
      // are dropped in memory and vanish on the next save.
      const legacy = s as Session & { kind?: string; docId?: string };
      if (!s.artifacts) s.artifacts = legacy.kind === 'document' && legacy.docId ? [legacy.docId] : [];
      delete legacy.kind;
      delete legacy.docId;
```

- Add the method:

```ts
  /** Attach a document to a session (append-once). The artifact list is the
   *  session's claim on its work products — spec 2026-08-10 (artifacts pivot). */
  addArtifact(sessionId: string, docId: string): Session | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    session.artifacts ??= [];
    if (!session.artifacts.includes(docId)) {
      session.artifacts.push(docId);
      session.updatedAt = this.now();
      this.store.save(session);
    }
    return session;
  }
```

- [ ] **Step 4: Fix the compile ripple in `main.ts` minimally**

`npm run typecheck` will flag `sessionFrame()`'s `kind`/`docId` reads and the documents closure's `create(..., {kind, docId, title})` call. Make the SMALLEST edits that compile — Task 2 rewrites both properly: in `sessionFrame()` replace `kind: s.kind ?? 'chat', docId: s.docId` with `artifacts: s.artifacts ?? []`; in the documents closure replace the session-creation call's opts with `{ title: doc.title, artifacts: [doc.id] }` (still creates a session — Task 2 changes that to attach).

- [ ] **Step 5: Run gates, commit**

Run: `node --import tsx --test src/sessions.test.ts` → PASS. Then `npm run typecheck && npm test` (text-channel tests may still pass since the frame type is unchanged until Task 2 — if any fail on the frame shape, note it and fix in Task 2, not here; the gate that must be green is typecheck + sessions/documents/blueprints/polish suites).

```bash
git add src/sessions.ts src/sessions.test.ts src/main.ts
git commit -m "feat: sessions carry artifacts — kinds die, legacy files normalize"
```

---

### Task 2: Broker — POST /documents v2 and the frame

**Files:**
- Modify: `broker/src/main.ts`, `broker/src/text-channel.ts`
- Test: `broker/src/text-channel.test.ts`

**Interfaces:**
- Consumes: `addArtifact`, `artifacts` (Task 1); existing `truncateTitle`, `startSession`, `handleUserText`, `documentManager`, `blueprints`, `documentsFrame`, `sessionFrame` in `main.ts`.
- Produces (Task 3 mirrors): `POST /documents` accepts `{blueprintId, workType?, text}` → 200 `{doc}` | 400 `{error}` (unknown blueprint / undeclared workType / empty text). Semantics: title = `truncateTitle(text)`; workType absent → blueprint's first declared; doc attached to the ACTIVE session (lazily created via the same path chat uses when none exists); broadcasts `documents` + `session` frames; then `text` goes through the utterance path (`broadcast({type:'utterance', text})` + `handleUserText(text)`). ChannelFrame session variant: `artifacts: string[]` replaces `kind`/`docId`.

- [ ] **Step 1: Update the route tests (failing first)**

In `text-channel.test.ts`, rewrite the existing "POST /documents forwards the body…" test's create expectations to the v2 body and add the validation case. The `documents.create` closure type in `channelWith` changes to `(body: { blueprintId?: string; workType?: string; text?: string })`:

```ts
    const created = await fetch(`http://127.0.0.1:${port}/documents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ blueprintId: 'spec', workType: 'feature', text: 'Spec out the login flow rework' }),
    });
    assert.equal(created.status, 200);
```

and a new case in the same test: posting `{ blueprintId: 'spec' }` (no text) must 400 WITHOUT invoking the closure — the route validates `text` presence itself (mirror how /polish 400s on empty text). Assert the closure call log length is unchanged.

- [ ] **Step 2: Run to confirm the changed tests fail**

Run: `node --import tsx --test src/text-channel.test.ts`
Expected: the rewritten /documents test FAILS (route still forwards `title`, rejects nothing); others PASS.

- [ ] **Step 3: Route edit in `text-channel.ts`**

In the POST /documents handler: parse `text` instead of `title`; after parsing, `if (!(typeof parsed.text === 'string') || !parsed.text.trim()) { json(400, { error: 'text is required' }); return; }`; forward `{blueprintId, workType, text}` to the closure. Update the `documents.create` ctor dep's body type accordingly. In the ChannelFrame union's session variant replace `kind`/`docId` with `artifacts: string[]`.

- [ ] **Step 4: Closure + frame edits in `main.ts`**

Replace the documents `create` closure body:

```ts
create: async (body) => {
  const bp = blueprints.find((b) => b.id === body.blueprintId);
  if (!bp) return { error: `unknown blueprint: ${body.blueprintId ?? '(none)'}` };
  const workType = body.workType ?? bp.workTypes[0];
  if (!bp.workTypes.includes(workType)) return { error: `workType must be one of: ${bp.workTypes.join(', ')}` };
  const text = (body.text ?? '').trim();
  if (!text) return { error: 'text is required' };
  // The active session owns the artifact; a fresh install gets its session
  // the same way a chat send does.
  let active = sessionManager.activeOrNull();
  if (!active) active = startSession(defaultWorkspaceName, { runtime: LEGACY_MODE_DEFAULT, title: truncateTitle(text), awaitingTitle: true });
  const doc = documentManager.create(bp, workType, truncateTitle(text));
  if (!doc) return { error: 'could not create document' };
  sessionManager.addArtifact(active.id, doc.id);
  textChannel.broadcast(documentsFrame());
  textChannel.broadcast(sessionFrame());
  // The send is still a send: the room hears it and the brain responds in context.
  textChannel.broadcast({ type: 'utterance', text });
  handleUserText(text);
  return { doc };
},
```

Anchors to resolve while editing (read the file, don't guess): `LEGACY_MODE_DEFAULT` = whatever runtime value `startSession`'s existing chat callers default to (find the lazy-create call site and reuse its exact expression); `startSession`'s real signature (it exists — phase-1 verified); if `startSession` already broadcasts `sessionFrame()`, keep the explicit broadcast after `addArtifact` anyway (the attach mutates the session AFTER `startSession` ran). `sessionFrame()`'s session variant now reads `artifacts: s.artifacts ?? []` (done minimally in Task 1 — verify it matches the ChannelFrame type exactly).

- [ ] **Step 5: Run gates, commit**

Run: `node --import tsx --test src/text-channel.test.ts src/sessions.test.ts` → PASS. Then `npm run typecheck && npm test`.

```bash
git add src/main.ts src/text-channel.ts src/text-channel.test.ts
git commit -m "feat: documents attach to the session that said them — send is the commit"
```

---

### Task 3: Control-plane — lockstep mirror + api v2

**Files:**
- Modify: `control-plane/src/api/types.ts`, `src/stores/socketStore.ts`, `src/queries/pushed.ts`, `src/api/broker.ts`, `src/queries/http.ts`
- Test: `src/stores/socketStore.test.ts` + every fixture file the compiler flags

**Interfaces:**
- Produces (Tasks 4–7 consume): `SessionSummary.artifacts: string[]` (kind/docId GONE); session-frame variant + `pushed.ts` ActiveSession likewise (`artifacts: string[]`); socket parser normalizes `artifacts ?? []` on BOTH the active-session object and every summary when writing the cache (old-broker tolerance); `postDocument(blueprintId: string, text: string, workType?: string, base?): Promise<{doc?: DocT; error?: string}>` (v2 body `{blueprintId, workType, text}`); `useBlueprints(): UseQueryResult<BlueprintT[]>` in `queries/http.ts` — `queryFn: () => getBlueprints()`, `staleTime: Infinity`, written in that file's existing hook idiom (read it first).

- [ ] **Step 1: Failing socket test**

Extend the socket suite's session-frame test data OR add one focused case, mirroring the sibling setup exactly: deliver a session frame whose session and summaries OMIT `artifacts` (cast the fixture `as never` past the now-stricter type — that's the point: the wire may be old) and assert the cache holds `artifacts: []` on both the active session and each summary after the write.

- [ ] **Step 2: Run to confirm it fails, then implement**

Types per the Interfaces block (delete `SessionKind` from types.ts; `DocT`/`BlueprintT`/frames unchanged). socketStore session case normalizes:

```ts
case "session":
  qc.setQueryData<SessionFrame["session"]>(qk.session, frame.session ? { ...frame.session, artifacts: frame.session.artifacts ?? [] } : null);
  qc.setQueryData<SessionSummary[]>(qk.sessions, frame.sessions.map((s) => ({ ...s, artifacts: s.artifacts ?? [] })));
  ...rest unchanged
```

`postDocument` v2 in api/broker.ts (same fetch idiom, body `JSON.stringify({ blueprintId, workType, text })`, signature `(blueprintId, text, workType?, base?)`). `useBlueprints` added to `queries/http.ts` in the file's idiom. Fixture sweep: the compiler flags every `kind: "chat"` fixture from phase 1 — at each site REPLACE `kind: "chat" as const` with `artifacts: []` (and delete any `kind: "document", docId:` fixture fields, replacing with `artifacts: ["<the docId>"]`). List every touched file in the report and commit.

- [ ] **Step 3: Run gates, commit**

Run: `pnpm vitest run src/stores/socketStore.test.ts` → PASS. Then `pnpm typecheck && pnpm lint && pnpm test` — the panel/router/new-session suites WILL fail on behavior (kind badge, kind routing, document mode) — that is Tasks 4–5's work; the gate for THIS commit is typecheck + lint + the suites this task touched. Run the full suite anyway, record which files fail and why in the report, and confirm each failure belongs to a later task in this plan (anything else — stop and investigate).

```bash
git add src/api/types.ts src/stores/socketStore.ts src/stores/socketStore.test.ts src/queries/pushed.ts src/queries/http.ts src/api/broker.ts <fixture files>
git commit -m "feat: the ui mirrors artifacts — parser normalizes, api speaks v2"
```

---

### Task 4: SessionsPanel chips + HomePage routing

**Files:**
- Modify: `control-plane/src/organisms/SessionsPanel.tsx`, `src/pages/HomePage.tsx`
- Test: `src/organisms/SessionsPanel.test.tsx`, `src/router.test.tsx`

**Interfaces:**
- Consumes: `SessionSummary.artifacts` (Task 3); `useDocuments` (for chip titles — optional; chips may show icon + index without titles in v1: DECIDED — icon-only chips, `aria-label` \"open document <docId>\"; titles come from the shelf).
- Produces: `SessionsPanelProps` gains `onOpenArtifact: (sessionId: string, docId: string) => void` and LOSES nothing else; rows restructure: `div.session-row` container holding the existing activate `<button class="session-row__main">` (title/meta/workspace — unchanged content) plus, when `s.artifacts.length > 0`, one `<button class="session-row__artifact">` per docId (`FileText` icon). `HomePage`: `onActivateSession` navigates `/` always (kind branch deleted); `onOpenArtifact={(sid, did) => { closeComposer(); void api.activateSession(sid); void navigate({ to: "/doc/$docId", params: { docId: did } }); }}`.

- [ ] **Step 1: Update panel tests (failing first)**

Delete the phase-1 kind-badge test. Update the two Task-7 tests if they referenced kinds. Add:

```tsx
it("artifact chips render per doc and report their ids", () => {
  const onOpenArtifact = vi.fn();
  renderPanel({
    onOpenArtifact,
    sessions: [
      { id: "s1", title: "Council", workspace: "acme", updatedAt: "t", active: true, runtime: "local-in-process", artifacts: ["d1", "d2"] },
      { id: "s2", title: "Plain", workspace: "acme", updatedAt: "t", active: false, runtime: "local-in-process", artifacts: [] },
    ],
  });
  const chips = screen.getAllByRole("button", { name: /open document/i });
  expect(chips).toHaveLength(2);
  fireEvent.click(chips[1]);
  expect(onOpenArtifact).toHaveBeenCalledWith("s1", "d2");
});

it("rows without artifacts render no chips and still activate", () => {
  const onActivate = vi.fn();
  renderPanel({
    onActivate,
    sessions: [{ id: "s2", title: "Plain", workspace: "acme", updatedAt: "t", active: false, runtime: "local-in-process", artifacts: [] }],
  });
  expect(screen.queryByRole("button", { name: /open document/i })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /plain/i }));
  expect(onActivate).toHaveBeenCalledWith("s2");
});
```

In `router.test.tsx`: the phase-1 "document session activation lands on its document" test is REWRITTEN — activation now lands on `/`; the doc entry is the chip. Seed a session with `artifacts: ["d1"]` + the doc, open the panel, click the artifact chip, assert pathname `/doc/d1` and the Document region.

- [ ] **Step 2: Confirm failures, implement**

Panel: restructure the row (`div.session-row` wrapper keeps the existing classes' styling contract — the row styles live in components.css (FROZEN): keep `session-row` classes on the container so existing styles apply, put the main content in an inner button `.session-row__main` styled in documents.css to inherit/reset (block, full-width, transparent, inherit font/color, text-align left), chips absolutely/flex-positioned at the row's right). The main button keeps the activate+close behavior; chips call `onOpenArtifact(s.id, docId)` then `onClose()`. documents.css gains `.session-row__main` (reset) + `.session-row__artifact` (small icon button, accent color) + a flex rule for the container (`display:flex; align-items:center; gap:4px;` — verify against the rendered look; the frozen components.css `.session-row` styles were written for a button, check they tolerate a div or override what doesn't in documents.css).

HomePage: delete the kind branch (navigate `/` unconditionally after activate), add the `onOpenArtifact` prop wiring per the Interfaces block.

- [ ] **Step 3: Run gates, commit**

Run: `pnpm vitest run src/organisms/SessionsPanel.test.tsx src/router.test.tsx` → PASS. Then full gate; remaining known-red suites must be only Task 5's (NewSessionScreen document mode).

```bash
git add src/organisms/SessionsPanel.tsx src/organisms/SessionsPanel.test.tsx src/pages/HomePage.tsx src/router.test.tsx src/styles/documents.css
git commit -m "feat: artifact chips on the panel — activation goes home, chips go to the doc"
```

---

### Task 5: NewSessionScreen back to chat-only

**Files:**
- Modify: `control-plane/src/organisms/NewSessionScreen.tsx`, `src/pages/HomePage.tsx`
- Test: `src/organisms/NewSessionScreen.test.tsx`

Remove the phase-1 document mode wholesale: the kind RadioButtonGroup, blueprint/work-type/title fields, `onCreateDocument`/`listBlueprints` props, and their three tests (plus the fix-wave's workspace-hiding test — the workspace block loses its `kind === "chat"` gate since kind no longer exists there). HomePage drops the `onCreateDocument`/`listBlueprints` wiring (the qk.documents seeding moves to the composer flow in Task 7). The screen's chat behavior, forced/cancel semantics, and remaining tests must end byte-equivalent to their pre-phase-1 form EXCEPT keeping any unrelated fixes (compare against `git show dc6fc5a^:...` is NOT the reference — the reference is: delete what Task 8 + the fix wave added, keep everything else exactly as it now stands).

- [ ] **Step 1:** Delete the three document-mode tests + the workspace-hiding test; run the suite — remaining tests must PASS already if the deletion is clean (they will FAIL first while the component still renders the toggle: delete component code and tests in the same motion, verifying the remaining suite is green and the deleted behaviors are gone — `screen.queryByRole("radio", { name: /document/i })` nowhere).
- [ ] **Step 2:** Full gate — the whole CP suite must now be green (this task closes the last known-red from Task 3).
- [ ] **Step 3:**

```bash
git add src/organisms/NewSessionScreen.tsx src/organisms/NewSessionScreen.test.tsx src/pages/HomePage.tsx
git commit -m "refactor: the new-session screen births chats only — documents are born mid-conversation"
```

---

### Task 6: Composer arm/send toggle

**Files:**
- Modify: `control-plane/src/molecules/Composer.tsx`, `src/styles/documents.css`
- Test: `src/molecules/Composer.test.tsx`

**Interfaces:**
- Produces: `ComposerProps` gains `kind?: "chat" | "document"` (default `"chat"` — which SURFACE this composer sits on), `onKindChat?: () => void` (doc surface's "chat" press), `onSendDocument?: (blueprintId: string, text: string) => Promise<{ error?: string } | undefined>`, `blueprints?: BlueprintT[]`. Group renders when `onSendDocument` is wired OR `kind === "document"`. Behavior: on a chat surface, pressing `document` ARMS (local state; placeholder → "describe the document you want…", blueprint chips appear, first blueprint preselected); pressing `chat` disarms. Armed submit calls `onSendDocument(blueprintId, text)` instead of `onSend`; `undefined` result → clear draft + disarm (consumer navigates); `{error}` → keep draft, stay armed, show the error through the same status affordance polish errors use. On a document surface (`kind="document"`), the group shows `document` active and `chat` presses call `onKindChat`. The 18 frozen gesture tests + 3 polish tests stay byte-identical.

- [ ] **Step 1: Failing tests**

```tsx
it("the kind group arms document mode and send routes to onSendDocument", async () => {
  const onSend = vi.fn();
  const onSendDocument = vi.fn().mockResolvedValue(undefined);
  render(
    <Composer onSend={onSend} onSendDocument={onSendDocument}
      blueprints={[{ id: "spec", name: "Design Spec", workTypes: ["feature"] }, { id: "implementation-plan", name: "Implementation Plan", workTypes: ["feature"] }]} />,
  );
  fireEvent.click(screen.getByRole("button", { name: /^document$/i }));
  const box = screen.getByRole("textbox", { name: /type a request|describe the document/i });
  expect((box as HTMLTextAreaElement).placeholder).toMatch(/describe the document/i);
  fireEvent.change(box, { target: { value: "Spec out login" } });
  fireEvent.click(screen.getByRole("button", { name: /design spec/i })); // chip stays/preselected — clicking asserts selectable
  fireEvent.submit(box.closest("form") ?? box); // use the same submit path the existing send tests use — read them and mirror
  await waitFor(() => expect(onSendDocument).toHaveBeenCalledWith("spec", "Spec out login"));
  expect(onSend).not.toHaveBeenCalled();
  await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe("")); // cleared + disarmed on success
});

it("a failed document send keeps the draft, stays armed, shows the error", async () => {
  const onSendDocument = vi.fn().mockResolvedValue({ error: "broker unreachable" });
  render(<Composer onSend={vi.fn()} onSendDocument={onSendDocument} blueprints={[{ id: "spec", name: "Design Spec", workTypes: ["feature"] }]} />);
  fireEvent.click(screen.getByRole("button", { name: /^document$/i }));
  const box = screen.getByRole("textbox", { name: /describe the document/i });
  fireEvent.change(box, { target: { value: "Draft kept" } });
  // trigger submit exactly as the prior test does
  await screen.findByText(/broker unreachable/);
  expect((box as HTMLTextAreaElement).value).toBe("Draft kept");
  expect(screen.getByRole("button", { name: /^document$/i }).getAttribute("aria-pressed")).toBe("true");
});

it("without onSendDocument there is no group; on a document surface chat presses call onKindChat", () => {
  const { rerender } = render(<Composer onSend={vi.fn()} />);
  expect(screen.queryByRole("button", { name: /^document$/i })).toBeNull();
  const onKindChat = vi.fn();
  rerender(<Composer onSend={vi.fn()} kind="document" onKindChat={onKindChat} />);
  expect(screen.getByRole("button", { name: /^document$/i }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: /^chat$/i }));
  expect(onKindChat).toHaveBeenCalled();
});
```

Adapt the submit-trigger plumbing to how the EXISTING send tests drive submission (read them; PromptInput's onSubmit path) — the assertions above are binding, the trigger mechanics follow the file.

- [ ] **Step 2: Confirm failures, implement**

Composer: `const [armed, setArmed] = useState(false); const [blueprintId, setBlueprintId] = useState<string>();` — effective blueprint = `blueprintId ?? blueprints?.[0]?.id`. Group markup (plain buttons, right of the polish action):

```tsx
{(onSendDocument || kind === "document") && (
  <div className="composer__kind-group" role="group" aria-label="composer mode">
    <button type="button" className={`composer__kind${kind === "chat" && !armed ? " composer__kind--on" : ""}`}
      aria-pressed={kind === "chat" && !armed}
      onClick={() => (kind === "document" ? onKindChat?.() : setArmed(false))}>
      chat
    </button>
    <button type="button" className={`composer__kind${kind === "document" || armed ? " composer__kind--on" : ""}`}
      aria-pressed={kind === "document" || armed}
      onClick={() => { if (kind !== "document") setArmed(true); }}>
      document
    </button>
  </div>
)}
```

Chips row (renders only while armed, above or below the toolbar per what reads best in the running app — implementer's call, disclosed): one button per blueprint, `composer__bp-chip`/`--on`, click sets `blueprintId`. `submit()` branches: armed && onSendDocument → call it with (effectiveBlueprintId, text); on undefined clear+disarm+clear error; on error set the shared status message state. Placeholder: armed ? "describe the document you want…" : existing logic. Styles in documents.css: `.composer__kind-group` (pill pair, small, matches `.selector`'s scale), `.composer__kind`, `--on` (accent tint like `dash-chip--on`'s pattern but with the app's tokens), `.composer__bp-chip`(+`--on`). Gesture code untouched.

- [ ] **Step 3: Run gates, commit**

Run: `pnpm vitest run src/molecules/Composer.test.tsx` → PASS (24: 18+3+3). Full gate.

```bash
git add src/molecules/Composer.tsx src/molecules/Composer.test.tsx src/styles/documents.css
git commit -m "feat: the composer toggles kinds — arm is free, send is the commit"
```

---

### Task 7: Shelf + route wiring

**Files:**
- Create: `control-plane/src/molecules/ArtifactShelf.tsx`, `src/molecules/ArtifactShelf.test.tsx`
- Modify: `control-plane/src/organisms/VoiceStage.tsx`, `src/router.tsx`, `src/styles/documents.css`
- Test: `src/organisms/VoiceStage.test.tsx` (one added case), `src/router.test.tsx` (create-flow test updated)

**Interfaces:**
- Consumes: `DocT`, `useDocuments`, `useSession`, `useBlueprints`, `postDocument` (Task 3); Composer contract (Task 6).
- Produces: `ArtifactShelf({ docs, onOpen }: { docs: DocT[]; onOpen: (docId: string) => void })` — renders null on empty; VoiceStage gains `shelf?: ReactNode` (composition slot, organisms stay router-free); VoiceRoute derives the active session's artifact docs and wires everything.

- [ ] **Step 1: Failing shelf test**

```tsx
// src/molecules/ArtifactShelf.test.tsx
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DocT } from "../api/types";
import { ArtifactShelf } from "./ArtifactShelf";

const DOC = (id: string, title: string): DocT => ({
  id, title, blueprintId: "spec", workType: "feature", sections: [], participants: [], status: "drafting", createdAt: "t", updatedAt: "t",
});

describe("ArtifactShelf", () => {
  afterEach(() => cleanup());

  it("renders nothing with no docs", () => {
    const { container } = render(<ArtifactShelf docs={[]} onOpen={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it("stacks a card per doc and opens on click", () => {
    const onOpen = vi.fn();
    render(<ArtifactShelf docs={[DOC("d1", "Login spec"), DOC("d2", "Login plan")]} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: /login plan/i }));
    expect(onOpen).toHaveBeenCalledWith("d2");
  });
});
```

- [ ] **Step 2: Confirm failure, write the shelf**

```tsx
// src/molecules/ArtifactShelf.tsx
import { FileText } from "lucide-react";
import type { DocT } from "../api/types";

interface ArtifactShelfProps {
  docs: DocT[];
  onOpen: (docId: string) => void;
}

/** Stage-manager shelf: the active session's documents, stacked at the chat's
 *  edge. Click brings one to center stage (spec 2026-08-10, artifacts pivot). */
export function ArtifactShelf({ docs, onOpen }: ArtifactShelfProps) {
  if (docs.length === 0) return null;
  return (
    <aside className="artifact-shelf" aria-label="session documents">
      {docs.map((d, i) => (
        <button key={d.id} type="button" className="artifact-shelf__card" style={undefined /* offsets are CSS nth-child, never inline */}
          data-index={i} onClick={() => onOpen(d.id)}>
          <FileText size={14} aria-hidden="true" />
          <span className="artifact-shelf__title">{d.title}</span>
          <span className="artifact-shelf__tag">{d.blueprintId}</span>
        </button>
      ))}
    </aside>
  );
}
```

(Remove the placeholder `style={undefined}` line entirely in the real file — offsets/fanning are pure CSS.) documents.css: `.artifact-shelf` absolutely positioned left inside the stage (`position:absolute; left:10px; top:50%; transform:translateY(-50%); display:flex; flex-direction:column; gap:6px; z-index:3; max-width:180px;`), `.artifact-shelf__card` (small card: pill border, ellipsized title, slight per-card offset via `&:nth-child` translateX steps, hover translateX(4px) transition — the fan), `__title` (ellipsis), `__tag` (mono dim). Reduced-motion: the hover translate is a transition, acceptable under reduced motion (no keyframe animation).

- [ ] **Step 3: VoiceStage slot + route wiring**

VoiceStage: add `shelf?: ReactNode` prop, render `{shelf}` inside the stage root (read the component; place as a direct child of the stage section so absolute positioning anchors correctly). One VoiceStage test: renders the slot content when provided (a `data-testid` probe).

`router.tsx` VoiceRoute: derive + wire —

```tsx
const { data: active } = useSession();
const { data: docs = NO_DOCS } = useDocuments();
const { data: blueprints = NO_BLUEPRINTS } = useBlueprints();
const navigate = useNavigate();
const shelfDocs = (active?.artifacts ?? []).map((id) => docs.find((d) => d.id === id)).filter((d): d is DocT => !!d);
```

pass `shelf={<ArtifactShelf docs={shelfDocs} onOpen={(id) => void navigate({ to: "/doc/$docId", params: { docId: id } })} />}` into VoiceStage, and to its Composer: `blueprints={blueprints}` + `onSendDocument={async (blueprintId, text) => { const r = await api.postDocument(blueprintId, text); if (r.error) return { error: r.error }; if (r.doc) { qc.setQueryData<DocT[]>(qk.documents, (prev) => [r.doc!, ...(prev ?? []).filter((d) => d.id !== r.doc!.id)]); void navigate({ to: "/doc/$docId", params: { docId: r.doc.id } }); } return undefined; }}` (VoiceRoute gets `const qc = useQueryClient()`; check how VoiceStage passes composer props through — it may need the two new props threaded, mirror how onSend/mic props thread today). DocRoute's dock Composer gains `kind="document"` + `onKindChat={() => void navigate({ to: "/" })}`.

`router.test.tsx`: update the create-flow test (it previously drove NewSessionScreen's document mode) to the composer path: seed a session, arm via the group, type, submit, assert `postDocument`-shaped fetch or (simpler, matching the harness) assert navigation to `/doc/<id>` after mocking fetch's /documents response with `{doc: DOC}` — mirror how the harness stubs fetch today (the beforeEach fetch stub gains a `/documents` case returning a doc).

- [ ] **Step 4: Run gates, commit**

Run: `pnpm vitest run src/molecules/ArtifactShelf.test.tsx src/organisms/VoiceStage.test.tsx src/router.test.tsx` → PASS. Full gate `pnpm typecheck && pnpm lint && pnpm test` → ENTIRELY green (this is the last code task).

```bash
git add src/molecules/ArtifactShelf.tsx src/molecules/ArtifactShelf.test.tsx src/organisms/VoiceStage.tsx src/organisms/VoiceStage.test.tsx src/router.tsx src/router.test.tsx src/styles/documents.css
git commit -m "feat: the shelf stages the session's documents — click one to center it"
```

---

### Task 8: Full verification + live smoke

Same protocol as phase 1's Task 11 (isolated broker on 7791 with /tmp state dirs; the CORS wall note applies; live broker/Tauri untouched; Playwright or the harness; kill only your own tmux sessions).

- [ ] **Step 1:** Broker gates (`npm run typecheck && npm test`), CP gates (`pnpm typecheck && pnpm lint && pnpm test && pnpm build`), bundle delta vs 2059.47 kB raw / 637.53 kB gzip.
- [ ] **Step 2:** Live walk: chat session active → arm document → chip check (spec preselected, plan selectable) → send → land on `/doc/…` with animation, title = your words → dock shows the SAME conversation (the brain's reply to your send appears there) → toggle chat → back on `/`, same session, shelf now shows the doc card → click the card → doc returns to center → panel shows the artifact chip → chip navigates. Legacy check: hand-write a phase-1-style session file (kind+docId) into the smoke sessions dir before boot, confirm it lists with artifacts and nothing crashes. Old-parser check: none required (no old clients in the field beyond Edwin's own).
- [ ] **Step 3:** Report per the honest-smoke convention: exercised vs not, verdicts, created-state cleanup, no commit unless fixes were needed.

---

## Self-Review (done at plan time)

- **Spec coverage:** artifacts model + legacy normalization ✔ (T1), POST v2 + attach + lazy session + utterance feed ✔ (T2), lockstep mirror + normalization + api v2 + useBlueprints ✔ (T3), panel chips + activation-home ✔ (T4), NewSessionScreen chat-only ✔ (T5), composer arm/send + chips + error path ✔ (T6), shelf + VoiceStage slot + route wiring + DocRoute group ✔ (T7), smoke incl. legacy-file check ✔ (T8). Deferred items (retitle, workType chips, dock pinning, detach/rename) correctly absent.
- **Type consistency:** `artifacts: string[]` required on summaries/ActiveSession everywhere; optional only on the broker's persisted `Session`; `postDocument(blueprintId, text, workType?)` matches the wire `{blueprintId, workType, text}`; `onSendDocument(blueprintId, text)` matches its VoiceRoute consumer; `ArtifactShelf{docs, onOpen}` matches its VoiceRoute usage.
- **Placeholder scan:** T6's submit-trigger plumbing and T7's VoiceStage prop-threading are read-the-file contracts (established, executed cleanly 3× today); the one literal placeholder line in the shelf snippet is annotated for removal. No TBDs.
