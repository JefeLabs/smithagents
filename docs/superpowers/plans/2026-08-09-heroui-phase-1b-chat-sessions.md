# HeroUI Phase 1b — Chat Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Claimed by:** session 4826ab44 (team-lead w/ Edwin), 2026-08-10 — executing via subagent-driven-development on branch `heroui-phase-1b` off `develop`.

**UNBLOCKED 2026-08-10.** Both Phase-1a gates resolved 2026-08-09 (Pro licensing is
time-boxed not version-gated; the stagnation claim was an npm `time.created` misread —
see heroui-pro-evaluation memory). Phase 1a merged to main in `c38134f` (2026-08-10), so
`src/molecules/form/` exists. Edwin approved completing the migration 2026-08-10
("let's complete the hero UI migration").

**Goal:** Migrate `Transcript`, `Composer`, `SessionsPanel` and `NewSessionScreen`
(527 LOC) onto HeroUI's AI components, adding markdown rendering — the one capability
this migration gains rather than swaps.

**Architecture:** `ChatConversation` replaces the transcript's hand-rolled
`scrollIntoView` effect; `ChatMessage.User`/`.Assistant` replace the `.msg` divs;
`Markdown` renders broker speech. `PromptInput` replaces the composer *shell* only —
the hold-to-talk gesture, the STT capability gate and the auto-height reset stay
hand-written inside `PromptInput`'s action slots, because no library component
implements press-and-hold-to-transmit.

**Tech Stack:** React 19, TypeScript 5.6 (strict), `@heroui-pro/react` 1.0.0-beta.8,
`@heroui/react` 3.2.4, Vitest 4 + jsdom, Testing Library, Biome, pnpm. Adding:
`streamdown`, `react-markdown`, `marked`, `remark-gfm`.

**Spec:** `docs/superpowers/specs/2026-08-08-heroui-pro-adoption-design.md` (Phase 1,
"Chat sessions" row)

## Global Constraints

- Package manager is **pnpm**, run from `control-plane/`. Never `npm`.
- **No change to `queries/`, `stores/`, or `api/`.** The transcript is fed by
  `useTranscript()` off the WebSocket-written Query cache; that path is untouched.
- **`onPress` not `onClick`, `isDisabled` not `disabled`** on every HeroUI component.
- **No redesign**, with one sanctioned exception: messages containing markdown syntax
  now render as formatted output. A message with **no** markdown syntax must render
  byte-identically to today. Task 4 gates on exactly that.
- `pnpm typecheck`, `pnpm lint`, `pnpm test` green before every commit.
- Branch is `heroui-phase-1b`, created off `main` after Phase 1a merges.
- Import `FormTextField` and friends from `../molecules/form`. Do not write an inline
  `<Controller>`; if a field shape is missing, add it to that directory with a test.
- **Do not touch `components.css`.** Phase 3 deletes it wholesale.

---

## The two hazards specific to this phase

**1. `Markdown` is a subpath import with optional peers that are not installed.**

```
import {Markdown} from "@heroui-pro/react/markdown";
```

The docs state it depends on the optional `streamdown`, `react-markdown`, `marked` and
`remark-*` peers and is deliberately not exported from the package root. Importing it
without installing them fails at build, not at type-check. Task 1 installs them and
proves the import resolves before any component depends on it — the same canary logic
Phase 0 used, for the same reason.

This also compounds the spec's Risk 1: markdown rendering pulls four more packages in
behind a pre-1.0 paid library. If Edwin's beta-cadence gate came back negative, **this
is the task to stop at** — `Transcript` without `Markdown` is still a clean migration,
and the capability can be added later or by another library.

**2. Hold-to-talk has no library equivalent, and 16 tests defend it.**

`Composer.tsx` implements press-and-hold-to-transmit: `startHold`/`endHold` driven by
pointer-down, pointer-up, pointer-leave and blur, with a latched always-listening mode
that makes the hold inert, plus an `sttEnabled` gate that reroutes presses to
`onVoiceBlocked`. `PromptInput` has `PromptInput.Action` slots but no press-and-hold
semantics. The gesture code moves verbatim into an action slot; only the shell changes.

`Composer.test.tsx` has one class-based assertion —
*"blocked mic buttons carry the is-voice-disabled class"* — which is exactly the kind of
coupling the spec's Testing section says to convert **before** touching markup. Task 3
Step 1 does that as its own commit.

## Four components the spec lists that this plan does not use

The spec's Phase 1 table names `ChainOfThought`, `chat-tool`, `chat-message-actions` and
`code-block` for this surface. None is used here, for one shared reason: **the data does
not exist.** `ChatMessage` in `src/api/types.ts` is `{id, role, text}` where `role` is
`"user" | "broker" | "notice"`. There are no tool calls, no reasoning traces, and no
per-message actions in the transcript, because the broker's text channel never sends
them — `socketStore.ts`'s frame union carries `utterance`, `speech` and `notice` only.

Adopting those four components means **broker work first**: new frame types, new fields
on the transcript, and a decision about whether agent tool-calls should be visible to the
operator at all. That is a feature, not a migration.

`code-block` is the near miss — fenced code in broker speech will render through
`Markdown` already, which likely uses `code-block` internally. Task 4's markdown test
covers inline code; if fenced blocks render unstyled, add a test and check whether
`Markdown` needs `code-block` wired explicitly.

**Recorded for Edwin, not blocking.** This plan migrates what exists.

## File Structure

| Path | Responsibility |
|---|---|
| `src/molecules/MarkdownCanary.tsx` | Temporary. Proves the subpath import and its peers resolve. Deleted in Task 4. |
| `src/molecules/Transcript.tsx` | Modified — `ChatConversation` + `ChatMessage` + `Markdown`. |
| `src/molecules/Composer.tsx` | Modified — `PromptInput` shell; gesture logic unchanged. |
| `src/organisms/SessionsPanel.tsx` | Modified — `Sheet` + `ListView`. |
| `src/organisms/NewSessionScreen.tsx` | Modified — form fields onto `src/molecules/form/`. |

---

### Task 1: Install the markdown peers and prove the subpath import

**Files:**
- Modify: `control-plane/package.json`
- Create: `src/molecules/MarkdownCanary.tsx`, `src/molecules/MarkdownCanary.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: a proven `import {Markdown} from "@heroui-pro/react/markdown"`. Task 4 relies
  on it resolving.

- [ ] **Step 1: Install the peers**

```bash
pnpm add streamdown react-markdown marked remark-gfm
```

Record the resolved versions from `pnpm-lock.yaml` in the Step 6 commit message. If any
of the four fails to resolve against React 19, **stop and report** — do not substitute a
different markdown library, because `Markdown`'s internals expect these specific peers.

- [ ] **Step 2: Write the failing canary test**

Create `src/molecules/MarkdownCanary.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarkdownCanary } from "./MarkdownCanary";

describe("MarkdownCanary", () => {
  // Proves the subpath import and its four optional peers resolve at build time.
  // Without this, a broken install surfaces halfway through Task 4, where a
  // pipeline failure and a migration bug look identical.
  it("renders markdown as real elements, not literal text", () => {
    render(<MarkdownCanary source={"**bold** and `code`"} />);
    expect(screen.getByText("bold").tagName).toBe("STRONG");
    expect(screen.getByText("code").tagName).toBe("CODE");
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `pnpm vitest run src/molecules/MarkdownCanary.test.tsx`
Expected: FAIL — unresolved import `./MarkdownCanary`.

- [ ] **Step 4: Write the canary**

Create `src/molecules/MarkdownCanary.tsx`:

```tsx
import { Markdown } from "@heroui-pro/react/markdown";

/**
 * Temporary. Proves `@heroui-pro/react/markdown` and its optional peers
 * (streamdown, react-markdown, marked, remark-gfm) resolve before Transcript
 * depends on them. Deleted in Task 4, exactly as Phase 0's HeroCanary was.
 */
export function MarkdownCanary({ source }: { source: string }) {
  return <Markdown>{source}</Markdown>;
}
```

- [ ] **Step 5: Run the test**

Run: `pnpm vitest run src/molecules/MarkdownCanary.test.tsx`
Expected: PASS, 1 test.

If it fails with a module-resolution error inside Vitest specifically, the peers likely
need adding to `vitest.config.ts`'s `server.deps.inline`. Check `vitest.config.ts`
before changing anything about the import itself.

- [ ] **Step 6: Verify and commit**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
Expected: green. Note the new `dist/assets/index-*.js` size — markdown is not small, and
Phase 1c's plan should know what it cost.

```bash
git add package.json pnpm-lock.yaml src/molecules/MarkdownCanary.tsx src/molecules/MarkdownCanary.test.tsx
git commit -m "feat: install markdown peers, canary the subpath import"
```

---

### Task 2: De-couple the transcript tests from markup

**Files:**
- Modify: `src/molecules/Transcript.test.tsx`, `src/organisms/VoiceStage.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: a test suite that queries by role and text only, so Task 4's markup change
  cannot break it for cosmetic reasons.

The spec is explicit: *"before touching a component's markup, convert its tests to
role/label/text queries. This is the testing-library idiom regardless, and it makes the
tests survive the restyle that follows."* Doing it as a separate commit means the diff
that changes markup contains no test edits, so a reviewer can tell behaviour changes
from query changes at a glance.

- [ ] **Step 1: Find every class-coupled query in the chat surfaces**

Run:
```bash
grep -n "transcript__\|\.msg\|is-voice-disabled\|composer--\|chat-log\|hero-intro" \
  src/molecules/Transcript.test.tsx src/molecules/Composer.test.tsx src/organisms/VoiceStage.test.tsx
```

Expected hits (verified 2026-08-09): the `.transcript__notice` query in the VoiceStage
suite, and `Composer.test.tsx`'s *"blocked mic buttons carry the is-voice-disabled
class"*. Convert every hit found — the list above is what exists today, not a cap.

- [ ] **Step 2: Convert the notice query**

A notice is a distinct kind of transcript line. Give it a role instead of a class hook.
In `src/molecules/Transcript.tsx`, add `role="status"` to the notice paragraph — a
one-line markup change made **here**, in the test-decoupling commit, so the query has
something to bind to:

```tsx
if (m.role === "notice") {
  return (
    <p key={m.id} className="transcript__notice" role="status">
      {m.text}
    </p>
  );
}
```

Then replace the class query in `VoiceStage.test.tsx` with:

```tsx
expect(screen.getByRole("status")).toHaveTextContent("broker restarted");
```

Use the notice text the existing test already asserts on; do not invent new fixture text.

- [ ] **Step 3: Convert the `is-voice-disabled` assertion**

That test asserts a *class*, but its real subject is that the mic controls are visibly
inert while STT is unavailable. Express that as state, in `Composer.test.tsx`:

```tsx
it("blocked mic buttons are marked unavailable to assistive tech", () => {
  render(
    <Composer onSend={vi.fn()} onMicToggle={vi.fn()} sttEnabled={false} onVoiceBlocked={vi.fn()} />,
  );
  // Still pressable — a press must reach onVoiceBlocked to raise the notice —
  // so this is aria-disabled, never the `disabled` attribute.
  expect(screen.getByRole("button", { name: /hold to talk/i })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
});
```

Then add `aria-disabled={!sttEnabled}` beside the existing `is-voice-disabled` className
in `Composer.tsx`. Keep the class — Task 3 removes it, and this commit is tests only.

Match `/hold to talk/i` to the button's actual accessible name; read it with
`screen.debug()` rather than guessing.

- [ ] **Step 4: Run the full suite**

Run: `pnpm test`
Expected: green, same count as before this task. Behaviour did not change — only how
tests ask about it.

- [ ] **Step 5: Confirm no class-coupled queries remain in these files**

Run the Step 1 grep again against the three test files.
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add src/molecules/Transcript.tsx src/molecules/Transcript.test.tsx src/molecules/Composer.tsx src/molecules/Composer.test.tsx src/organisms/VoiceStage.test.tsx
git commit -m "test: query chat surfaces by role, not class, ahead of the migration"
```

---

### Task 3: Composer onto `PromptInput`

**Files:**
- Modify: `src/molecules/Composer.tsx`
- Test: `src/molecules/Composer.test.tsx` (16 tests — must pass unedited after Task 2)

**Interfaces:**
- Consumes: `PromptInput` from `@heroui-pro/react`.
- Produces: `Composer` with its existing props unchanged — `VoiceStage` is not modified.

- [ ] **Step 1: Baseline and screenshots**

Run: `pnpm vitest run src/molecules/Composer.test.tsx` — record the count (16).

```bash
mkdir -p .screenshots/phase1b
```
Capture `composer-{dark,light,midnight,sand}-before.png`, plus one with the mic held.

The composer is **position-fixed chrome**, so the spec's hard gate applies: ≤ 0.5%
differing pixels. This is the tightest gate in the phase.

- [ ] **Step 2: Keep the gesture logic, replace only the shell**

In `src/molecules/Composer.tsx`, leave lines 1-52 (props, `startHold`, `endHold`,
`submit`, the refs and the two `useState`s) **exactly as they are**. Replace only the
returned JSX:

```tsx
  return (
    <PromptInput
      value={draft}
      onValueChange={setDraft}
      onSubmit={submit}
      isDisabled={disabled}
      layout="stacked"
    >
      <PromptInput.Shell>
        <PromptInput.Content>
          <PromptInput.TextArea
            ref={textareaRef}
            placeholder={disabled ? "broker offline" : "Say something to the room…"}
          />
        </PromptInput.Content>
        <PromptInput.Toolbar>
          <PromptInput.ToolbarStart>
            {onMicToggle && (
              <PromptInput.Action
                aria-label="Hold to talk"
                aria-disabled={!sttEnabled}
                onPointerDown={startHold}
                onPointerUp={endHold}
                onPointerLeave={endHold}
                onBlur={endHold}
              >
                <Mic size={16} />
              </PromptInput.Action>
            )}
            {onMicToggle && (
              <PromptInput.Action
                aria-label={micLive ? "Stop always-listening" : "Start always-listening"}
                aria-disabled={!sttEnabled}
                isDisabled={holding}
                onPress={() => (sttEnabled ? onMicToggle() : onVoiceBlocked?.())}
              >
                <AudioLines size={16} />
              </PromptInput.Action>
            )}
            {onSoundToggle && (
              <PromptInput.Action
                aria-label={soundOn ? "Mute replies" : "Unmute replies"}
                onPress={onSoundToggle}
              >
                {soundOn ? <Volume2 size={16} /> : <VolumeX size={16} />}
              </PromptInput.Action>
            )}
          </PromptInput.ToolbarStart>
          <PromptInput.ToolbarEnd>
            <PromptInput.Send aria-label="Send" isDisabled={disabled || draft.trim() === ""} />
          </PromptInput.ToolbarEnd>
        </PromptInput.Toolbar>
      </PromptInput.Shell>
    </PromptInput>
  );
```

Four things to get right, each of which a test already checks:

1. **`onPointerDown`/`onPointerUp`/`onPointerLeave`/`onBlur` stay pointer handlers, not
   `onPress`.** `onPress` fires once on release; hold-to-talk needs press *and* release
   as separate events. Four tests depend on this.
2. **`aria-disabled`, never `isDisabled`, on the two mic actions.** A truly disabled
   button swallows the press, and two tests require a blocked press to reach
   `onVoiceBlocked`. `isDisabled={holding}` on the always-listening toggle is different
   and correct — that one really is inert.
3. **The offline placeholder** is asserted verbatim by a test. Copy the string from the
   current file rather than retyping it.
4. **The textarea `ref`** is what `submit()` uses to reset auto-height. If
   `PromptInput.TextArea` does not forward a ref, keep the ref on a wrapping element and
   query the textarea from it — one test asserts the height reset.

- [ ] **Step 3: Run the composer test**

Run: `pnpm vitest run src/molecules/Composer.test.tsx`
Expected: PASS, 16 tests, **no edits to the test file** (Task 2 already made it
markup-independent).

If the hold-to-talk tests fail, the cause is almost always #1 above. Do not relax the
tests; they encode the gesture.

- [ ] **Step 4: Remove the now-dead voice-disabled class**

Run: `grep -n "is-voice-disabled" src/molecules/Composer.tsx`
Remove the className (the `aria-disabled` added in Task 2 replaced its job). Leave the
CSS rule in `components.css` — Phase 3 deletes the file.

- [ ] **Step 5: Screenshot gate**

Capture the after-shots. **Hard gate: ≤ 0.5% differing pixels** on the composer dock in
all four themes, since it is fixed chrome. If it exceeds that, the layout changed;
adjust with utilities in the `overrides` cascade layer rather than accepting the diff.

- [ ] **Step 6: Verify and commit**

Run: `pnpm typecheck && pnpm lint && pnpm test`

```bash
git add src/molecules/Composer.tsx
git commit -m "refactor: Composer shell onto PromptInput, hold-to-talk unchanged"
```

---

### Task 4: Transcript onto `ChatConversation` + `Markdown`

**Files:**
- Modify: `src/molecules/Transcript.tsx`
- Delete: `src/molecules/MarkdownCanary.tsx`, `src/molecules/MarkdownCanary.test.tsx`
- Test: `src/molecules/Transcript.test.tsx`

**Interfaces:**
- Consumes: `ChatConversation`, `ChatMessage` from `@heroui-pro/react`; `Markdown` from
  `@heroui-pro/react/markdown` (proven in Task 1).
- Produces: `Transcript` with its existing `{ messages: ChatMessage[] }` prop unchanged.

- [ ] **Step 1: Write the new capability test first**

Markdown rendering is the one behaviour this phase *adds*, so it gets a test before the
markup changes. Append to `src/molecules/Transcript.test.tsx`:

```tsx
it("renders markdown in broker speech", () => {
  render(
    <Transcript messages={[{ id: 1, role: "broker", text: "Manuel: shipped **v2** today" }]} />,
  );
  expect(screen.getByText("Manuel")).toBeTruthy();
  expect(screen.getByText("v2").tagName).toBe("STRONG");
});

// The no-redesign rule: a message with no markdown syntax must render as it
// always did. This is the test that catches markdown "helpfully" reflowing
// ordinary speech.
it("leaves plain text exactly as plain text", () => {
  render(<Transcript messages={[{ id: 1, role: "broker", text: "Manuel: On it." }]} />);
  expect(screen.getByText("On it.")).toBeTruthy();
});

// Speaker extraction must run BEFORE markdown, or the "Manuel:" prefix becomes
// part of the rendered body and the speaker label disappears.
it("extracts the speaker before rendering the body as markdown", () => {
  render(<Transcript messages={[{ id: 1, role: "broker", text: "Ana: `deploy` is green" }]} />);
  expect(screen.getByText("Ana").tagName).toBe("B");
  expect(screen.getByText("deploy").tagName).toBe("CODE");
});
```

- [ ] **Step 2: Run and confirm the two markdown tests fail**

Run: `pnpm vitest run src/molecules/Transcript.test.tsx`
Expected: the plain-text test PASSES (current behaviour), the two markdown tests FAIL
with the text rendered literally. That split is the proof the tests are wired to the
right thing.

- [ ] **Step 3: Rewrite `Transcript.tsx`**

```tsx
import { ChatConversation, ChatMessage as ChatMessageUI } from "@heroui-pro/react";
import { Markdown } from "@heroui-pro/react/markdown";
import type { ChatMessage } from "../api/types";

interface TranscriptProps {
  messages: ChatMessage[];
}

/** Rolling meeting transcript — user utterances right, broker speech left. */
export function Transcript({ messages }: TranscriptProps) {
  if (messages.length === 0) return null;

  return (
    <ChatConversation className="transcript" role="log" aria-label="Conversation transcript">
      <ChatConversation.Content>
        {messages.map((m) => {
          if (m.role === "notice") {
            return (
              <p key={m.id} className="transcript__notice" role="status">
                {m.text}
              </p>
            );
          }
          if (m.role === "user") {
            return (
              <ChatMessageUI.User key={m.id}>
                <ChatMessageUI.Bubble>
                  <ChatMessageUI.Content>{m.text}</ChatMessageUI.Content>
                </ChatMessageUI.Bubble>
              </ChatMessageUI.User>
            );
          }
          // Broker speech is speaker-prefixed ("Manuel: On it."). The prefix is
          // stripped BEFORE the body reaches Markdown — otherwise "Manuel:" is
          // parsed as body text and the speaker label disappears.
          const spoken = /^([A-Z][\w-]{1,24}):\s+(.*)$/s.exec(m.text);
          return (
            <ChatMessageUI.Assistant key={m.id}>
              <ChatMessageUI.Body>
                <ChatMessageUI.Content>
                  {spoken ? (
                    <>
                      <b className="speaker">{spoken[1]}</b> <Markdown>{spoken[2]}</Markdown>
                    </>
                  ) : (
                    <Markdown>{m.text}</Markdown>
                  )}
                </ChatMessageUI.Content>
              </ChatMessageUI.Body>
            </ChatMessageUI.Assistant>
          );
        })}
      </ChatConversation.Content>
      <ChatConversation.ScrollAnchor />
    </ChatConversation>
  );
}
```

Three deletions worth calling out in review:

- **The `endRef` + `useEffect` + `scrollIntoView` block is gone.**
  `ChatConversation.ScrollAnchor` implements stick-to-bottom. This removes the app's
  only `scrollTo` call, which is also the source of the repeated
  *"Not implemented: Window's scrollTo()"* noise in the jsdom test output.
- **The `motion.div` per-message entrance animation is gone.** `ChatMessage` carries its
  own. If the after-screenshot shows messages appearing without transition, re-add
  `motion` around `ChatMessageUI.Assistant` rather than accepting a static list — the
  entrance animation is part of how this surface reads.
- **`useReducedMotion` is gone** with it. If motion is re-added, the reduced-motion
  guard comes back with it; do not ship an animation that ignores the preference.

- [ ] **Step 4: Run the transcript tests**

Run: `pnpm vitest run src/molecules/Transcript.test.tsx`
Expected: PASS, all five (2 original + 3 new).

- [ ] **Step 5: Delete the markdown canary**

```bash
git rm src/molecules/MarkdownCanary.tsx src/molecules/MarkdownCanary.test.tsx
```

Run: `grep -rn "MarkdownCanary" src`
Expected: no output.

- [ ] **Step 6: Screenshot gate**

Capture `transcript-{dark,light,midnight,sand}-after.png` with a seeded conversation
containing a user line, a speaker-prefixed broker line, and a notice. Structural gate,
not the 0.5% one — the transcript scrolls, it is not fixed chrome.

- [ ] **Step 7: Verify and commit**

Run: `pnpm typecheck && pnpm lint && pnpm test`

```bash
git add src/molecules/Transcript.tsx src/molecules/Transcript.test.tsx
git commit -m "feat: transcript on ChatConversation with markdown rendering"
```

---

### Task 5: `SessionsPanel` and `NewSessionScreen`

**Files:**
- Modify: `src/organisms/SessionsPanel.tsx` (106 LOC),
  `src/organisms/NewSessionScreen.tsx` (211 LOC)
- Test: `src/organisms/SessionsPanel.test.tsx` (125 LOC),
  `src/organisms/NewSessionScreen.test.tsx` (177 LOC)

**Interfaces:**
- Consumes: `Sheet` from `@heroui-pro/react`; `ListView` from `@heroui-pro/react`;
  `FormTextField` and `ModalShell` from `../molecules/form` (Phase 1a).
- Produces: both components with props unchanged. `HomePage` is not modified.

- [ ] **Step 1: Baseline both suites**

Run: `pnpm vitest run src/organisms/SessionsPanel.test.tsx src/organisms/NewSessionScreen.test.tsx`
Record both counts.

- [ ] **Step 2: De-couple any class-based queries first**

Run:
```bash
grep -n "querySelector\|selector:" src/organisms/SessionsPanel.test.tsx src/organisms/NewSessionScreen.test.tsx
```
Expected (verified 2026-08-09): no output. If that holds, skip to Step 3. If a hit
appears, convert it to a role/text query and commit that alone, as Task 2 did.

- [ ] **Step 3: `SessionsPanel` onto `Sheet`**

`SessionsPanel` is a slide-in panel with an `open` prop, a close button, a workspace
filter chip row, a session list, and a "manage" entry. Replace its outer markup with
`Sheet`, keeping every handler and the list's own markup:

```tsx
<Sheet isOpen={open} onOpenChange={(next) => { if (!next) onClose(); }}>
  <Sheet.Content side="left" aria-label="Sessions">
    <Sheet.Header>
      <Sheet.Title>Sessions</Sheet.Title>
    </Sheet.Header>
    <Sheet.Body>{/* existing chip row, list and manage entry, unchanged */}</Sheet.Body>
  </Sheet.Content>
</Sheet>
```

Read the real compound names with `mcp__heroui-pro__get_component_docs(["sheet"])`
before writing this — the names above are the expected shape, not verified API. Do not
guess; the `isOpen`/`onOpenChange` wiring is the part that matters and matches
`Modal.Backdrop`'s.

**Do not add an opener.** `SessionsPanel` deliberately has none — the hint bar was
removed and that was a decision, not an oversight. `ToolRail`'s sessions button is the
only entry point.

- [ ] **Step 4: Run the sessions test**

Run: `pnpm vitest run src/organisms/SessionsPanel.test.tsx`
Expected: PASS, same count, unedited.

- [ ] **Step 5: `NewSessionScreen` fields onto the Phase 1a adapters**

`NewSessionScreen` is a stage, not a modal — it renders inline where the `<Outlet />`
would be, so it gets **no** `ModalShell`. Migrate its inputs only:

- the prompt textarea → `FormTextField ... multiline rows={4}`
- the workspace picker → `FormSelect`
- the execution-mode 2×2 → `RadioButtonGroup` with four items, exactly as Phase 1a
  Task 5 used it for the repo-source toggle

The `lockedWorkspace` and `forced` props keep their current meaning: `forced` is the
confirmed-zero-sessions state, and it must still suppress the cancel affordance. One
test asserts that; do not weaken it.

- [ ] **Step 6: Run the new-session test**

Run: `pnpm vitest run src/organisms/NewSessionScreen.test.tsx`
Expected: PASS, same count, unedited.

- [ ] **Step 7: Screenshots and full verification**

Capture `sessions-panel-*` and `new-session-*` in all four themes; compare structurally.

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`

- [ ] **Step 8: Commit**

```bash
git add src/organisms/SessionsPanel.tsx src/organisms/NewSessionScreen.tsx
git commit -m "refactor: sessions panel and new-session screen onto heroui"
```

---

### Task 6: Close the phase

- [ ] **Step 1: Confirm no test file was edited during a markup task**

```bash
git log --oneline main..HEAD --name-only | grep "\.test\." | sort -u
```

Expected: only files touched by **Task 2** (the deliberate de-coupling commit) and the
new tests added in Tasks 1 and 4. A pre-existing test edited inside Task 3 or 5 means a
behaviour changed — investigate before merging.

- [ ] **Step 2: Confirm the state layer was not touched**

```bash
git diff --stat main -- src/api src/queries src/stores
```
Expected: no output.

- [ ] **Step 3: Record the bundle cost**

Run: `pnpm build`. Record `dist/assets/index-*.js` and `index-*.css` against Phase 1a's
figures. Markdown's four peers are the largest single addition in the whole migration;
Phase 1c's plan and any future code-splitting decision both need this number.

- [ ] **Step 4: UI smoke against a live broker**

Start the broker (tmux `smith-broker`, port 7790) and `pnpm dev`. Then:

1. Send a message. Confirm it appears right-aligned and the view sticks to the bottom.
2. Have an agent reply with backticks or `**bold**`. Confirm it renders formatted.
3. Have an agent reply with plain prose. Confirm it looks exactly as it did before.
4. Hold the mic button; confirm transmission starts on press and stops on release.
5. Drag the pointer off the mic button while holding; confirm it stops.
6. With no Deepgram key configured, press the mic; confirm the Settings notice appears
   rather than the mic engaging.
7. Toggle always-listening; confirm hold-to-talk goes inert while it is latched.
8. Open the sessions panel from the tool rail; confirm ESC and click-outside close it —
   both new.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: close heroui phase 1b"
```

---

## Notes for the Phase 1c implementer

- The transcript no longer calls `scrollIntoView`. If you see jsdom "Not implemented"
  noise in your test output, it is coming from a different surface — do not assume it
  is pre-existing.
- Markdown's peers are installed repo-wide now. Kanban card descriptions could render
  markdown for free; that is **not** in the Phase 1 spec table, so do not add it without
  Edwin's sign-off.
- `PromptInput.Action` accepts raw pointer handlers alongside `onPress`. If kanban needs
  a press-and-hold affordance, that is the precedent.
</content>
