# Two-State Chat Window (VoiceStage) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the control-plane stage two states — a centered hero column when the session has no messages, and a full-height Claude.ai-style chat view once messages exist — with a motion-animated transition, a two-row composer, and an always-listening voice toggle shared between both states.

**Architecture:** `chatActive` is derived from `messages.length` inside `VoiceStage`; no new state. The composer persists across both states inside a `motion.div layout` wrapper so motion FLIP-animates its glide to the bottom dock; the greeting + mic hero exit through `AnimatePresence mode="popLayout"`. All new CSS lands under new class names (`.composer--stacked`, `.composer__row`, `.chat-log`, `.composer-dock`, `main.chat-active`) so `WorkStage`'s inline single-row `.composer` keeps working untouched.

**Tech Stack:** React 19, TypeScript, Vite 6, `motion@^13` (`motion/react` imports), lucide-react icons, vitest + @testing-library/react + userEvent in jsdom, biome.

**Spec:** `docs/superpowers/specs/2026-08-06-chat-window-states-design.md`

## Global Constraints

- Working directory for all commands: `control-plane/` (e.g. `cd control-plane && npx vitest run …`).
- Copy strings are exact and load-bearing for tests:
  - Hero idle caption/label: `Activate always listening`
  - Hero live caption: `Listening…` + `tap to stop`
  - Composer voice toggle label: `Always listening`
  - Offline placeholder: `Broker offline — start the broker to chat…`
  - Online placeholder: `Type a request…`
- Icon for BOTH voice controls (hero + composer): lucide `AudioLines`. They drive the same `onMicToggle`.
- `motion` imports come from `motion/react` only. No `framer-motion` package.
- Tests use plain vitest matchers (`.toBeNull()`, `.toBe(...)`) — this repo does NOT use jest-dom (`.toBeInTheDocument()` will not compile).
- RTL `getByRole(…, { name: "…" })` with a **string** is an exact full match — that is how tests distinguish `Always listening` (composer) from `Activate always listening` (hero).
- Do not modify `WorkStage.tsx` or any base `.composer` CSS rule it relies on.
- Every commit message ends with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Verification trio after each task: `npx vitest run <file>`, `npm run typecheck`, `npm run lint`.

---

### Task 1: Two-row Composer

**Files:**
- Modify: `control-plane/src/molecules/Composer.tsx`
- Modify: `control-plane/src/styles/components.css` (append after the `.selector svg` block, ~line 770)
- Modify: `control-plane/src/styles/base.css` (the `@media (prefers-reduced-motion: reduce)` block, lines 88–96)
- Test: `control-plane/src/molecules/Composer.test.tsx` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces: `Composer` props consumed by Task 4:
  `{ onSend: (text: string) => void; disabled?: boolean; micLive?: boolean; onMicToggle?: () => void; soundOn?: boolean; onSoundToggle?: () => void }`.
  The voice button renders only when `onMicToggle` is provided; the speaker button only when `onSoundToggle` is provided (so the current `VoiceStage` usage keeps compiling mid-plan).

- [ ] **Step 1: Write the failing test**

Create `control-plane/src/molecules/Composer.test.tsx`:

```tsx
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer";

describe("Composer", () => {
  afterEach(() => {
    cleanup();
  });

  it("Enter sends the trimmed draft and clears it", async () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    const box = screen.getByRole("textbox", { name: "Type a request" });
    await userEvent.type(box, "  ship it  {Enter}");
    expect(onSend).toHaveBeenCalledWith("ship it");
    expect((box as HTMLTextAreaElement).value).toBe("");
  });

  it("Shift+Enter inserts a newline instead of sending", async () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    const box = screen.getByRole("textbox", { name: "Type a request" });
    await userEvent.type(box, "a{Shift>}{Enter}{/Shift}b");
    expect(onSend).not.toHaveBeenCalled();
    expect((box as HTMLTextAreaElement).value).toBe("a\nb");
  });

  it("send button submits and is disabled while the draft is empty", async () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    const send = screen.getByRole("button", { name: "Send" });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(screen.getByRole("textbox", { name: "Type a request" }), "hello");
    expect((send as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(send);
    expect(onSend).toHaveBeenCalledWith("hello");
  });

  it("voice and speaker buttons render only when wired, and fire their handlers", async () => {
    const onMicToggle = vi.fn();
    const onSoundToggle = vi.fn();
    const { rerender } = render(<Composer onSend={() => {}} />);
    expect(screen.queryByRole("button", { name: "Always listening" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Mute agent voices" })).toBeNull();

    rerender(
      <Composer onSend={() => {}} micLive={false} onMicToggle={onMicToggle} soundOn={true} onSoundToggle={onSoundToggle} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Always listening" }));
    expect(onMicToggle).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Mute agent voices" }));
    expect(onSoundToggle).toHaveBeenCalledTimes(1);
  });

  it("offline: textarea and send are disabled with the offline placeholder", () => {
    render(<Composer onSend={() => {}} disabled />);
    const box = screen.getByRole("textbox", { name: "Type a request" }) as HTMLTextAreaElement;
    expect(box.disabled).toBe(true);
    expect(box.placeholder).toBe("Broker offline — start the broker to chat…");
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd control-plane && npx vitest run src/molecules/Composer.test.tsx`
Expected: FAIL — the current component renders an `<input>` (no `textbox` named textarea behavior differences matter later, but the "Send" button queries fail with "Unable to find role").

- [ ] **Step 3: Rewrite `Composer.tsx` as the two-row layout**

Replace the whole file with:

```tsx
import { ArrowUp, AudioLines, ChevronDown, Plus, Volume2, VolumeX } from "lucide-react";
import { useState } from "react";

interface ComposerProps {
  onSend: (text: string) => void;
  disabled?: boolean;
  /** Always-listening state; the toggle renders only when onMicToggle is wired. */
  micLive?: boolean;
  onMicToggle?: () => void;
  /** TTS output state; the toggle renders only when onSoundToggle is wired. */
  soundOn?: boolean;
  onSoundToggle?: () => void;
}

export function Composer({
  onSend,
  disabled = false,
  micLive = false,
  onMicToggle,
  soundOn = false,
  onSoundToggle,
}: ComposerProps) {
  const [draft, setDraft] = useState("");

  const submit = () => {
    const text = draft.trim();
    if (!text || disabled) return;
    onSend(text);
    setDraft("");
  };

  return (
    <form
      className="composer composer--stacked"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <textarea
        rows={1}
        placeholder={disabled ? "Broker offline — start the broker to chat…" : "Type a request…"}
        aria-label="Type a request"
        value={draft}
        disabled={disabled}
        onChange={(e) => {
          setDraft(e.target.value);
          // Auto-grow up to the CSS max-height (132px ≈ 6 lines), then scroll internally.
          e.target.style.height = "auto";
          e.target.style.height = `${Math.min(e.target.scrollHeight, 132)}px`;
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="composer__row">
        <button type="button" className="plus" title="Add context — links, files, screenshots" aria-label="Add context">
          <Plus strokeWidth={1.7} />
        </button>
        <div className="composer__actions">
          {/* biome-ignore lint/a11y/useSemanticElements: artifact-faithful markup — .selector styles a div; becomes a real menu trigger when routing is wired */}
          <div className="selector" role="button" tabIndex={0} title="Route to a specific agent, or let the swarm decide">
            Swarm
            <ChevronDown strokeWidth={2} />
          </div>
          {onMicToggle && (
            <button
              type="button"
              className={micLive ? "voice-toggle live" : "voice-toggle"}
              title="Always listening"
              aria-label="Always listening"
              aria-pressed={micLive}
              onClick={onMicToggle}
            >
              <AudioLines strokeWidth={1.7} />
            </button>
          )}
          {onSoundToggle && (
            <button
              type="button"
              className={soundOn ? "sound-toggle" : "sound-toggle off"}
              title={soundOn ? "Mute agent voices" : "Unmute agent voices"}
              aria-label={soundOn ? "Mute agent voices" : "Unmute agent voices"}
              aria-pressed={soundOn}
              onClick={onSoundToggle}
            >
              {soundOn ? <Volume2 strokeWidth={1.7} /> : <VolumeX strokeWidth={1.7} />}
            </button>
          )}
          <button type="submit" className="send" title="Send" aria-label="Send" disabled={disabled || !draft.trim()}>
            <ArrowUp strokeWidth={2} />
          </button>
        </div>
      </div>
    </form>
  );
}
```

- [ ] **Step 4: Append the stacked-composer CSS**

In `control-plane/src/styles/components.css`, after the `.selector svg` block (end of the composer section), append:

```css
/* Two-row composer (VoiceStage). WorkStage keeps the single-row base .composer. */
.composer--stacked {
  flex-direction: column;
  align-items: stretch;
  gap: 4px;
  padding: 12px 12px 8px 16px;
  border-radius: 22px;
}
.composer--stacked textarea {
  width: 100%;
  resize: none;
  background: transparent;
  border: none;
  outline: none;
  color: var(--text);
  font: inherit;
  font-size: 14px;
  line-height: 22px;
  max-height: 132px;
  overflow-y: auto;
  scrollbar-width: none;
}
.composer--stacked textarea::-webkit-scrollbar {
  display: none;
}
.composer--stacked textarea::placeholder {
  color: var(--text-dim);
}
.composer__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.composer__actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
.composer--stacked .voice-toggle,
.composer--stacked .sound-toggle {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  cursor: pointer;
  background: transparent;
  border: none;
  color: var(--text-2);
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}
.composer--stacked .voice-toggle:hover,
.composer--stacked .sound-toggle:hover {
  color: var(--text);
}
.composer--stacked .voice-toggle.live {
  color: var(--accent);
  animation: voice-pulse 1.6s ease-in-out infinite;
}
@keyframes voice-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.55;
  }
}
.composer--stacked .sound-toggle.off {
  color: var(--text-dim);
}
.composer--stacked .send {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  cursor: pointer;
  border: none;
  background: var(--accent);
  color: #fff;
}
.composer--stacked .send:disabled {
  opacity: 0.4;
  cursor: default;
}
```

- [ ] **Step 5: Reduced-motion opt-out for the live pulse**

In `control-plane/src/styles/base.css`, extend the existing media block so it reads:

```css
@media (prefers-reduced-motion: reduce) {
  .greeting,
  .voice {
    animation: none;
  }
  .mic-hero::after {
    animation: none;
  }
  .voice-toggle.live {
    animation: none;
  }
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd control-plane && npx vitest run src/molecules/Composer.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 7: Typecheck + lint**

Run: `cd control-plane && npm run typecheck && npm run lint`
Expected: both clean. (Biome may reformat the CSS keyframe indentation — run `npm run format` if `lint` complains about formatting only.)

- [ ] **Step 8: Commit**

```bash
git add control-plane/src/molecules/Composer.tsx control-plane/src/molecules/Composer.test.tsx control-plane/src/styles/components.css control-plane/src/styles/base.css
git commit -m "feat(control-plane): two-row composer with voice, speaker, and send controls

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: MicHero becomes the always-listening toggle

**Files:**
- Modify: `control-plane/src/molecules/MicHero.tsx`
- Test: `control-plane/src/molecules/MicHero.test.tsx` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces: `MicHero` keeps its exact existing props `{ live: boolean; onToggle: () => void }` — Task 4 relies on that signature being unchanged.

- [ ] **Step 1: Write the failing test**

Create `control-plane/src/molecules/MicHero.test.tsx`:

```tsx
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MicHero } from "./MicHero";

describe("MicHero", () => {
  afterEach(() => {
    cleanup();
  });

  it("idle: reads as the always-listening activator and fires onToggle", async () => {
    const onToggle = vi.fn();
    render(<MicHero live={false} onToggle={onToggle} />);
    const hero = screen.getByRole("button", { name: "Activate always listening" });
    expect(screen.getByText("Activate always listening")).toBeTruthy();
    await userEvent.click(hero);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("live: shows the listening caption", () => {
    render(<MicHero live={true} onToggle={() => {}} />);
    expect(screen.getByText("Listening…")).toBeTruthy();
    expect(screen.queryByText("Activate always listening")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd control-plane && npx vitest run src/molecules/MicHero.test.tsx`
Expected: FAIL — accessible name is still "Push to talk".

- [ ] **Step 3: Update `MicHero.tsx`**

Replace the whole file with:

```tsx
import { AudioLines } from "lucide-react";

interface MicHeroProps {
  live: boolean;
  onToggle: () => void;
}

export function MicHero({ live, onToggle }: MicHeroProps) {
  return (
    <div className="voice">
      <button
        type="button"
        className={live ? "mic-hero live" : "mic-hero"}
        title="Activate always listening"
        aria-label="Activate always listening"
        aria-pressed={live}
        onClick={onToggle}
      >
        <AudioLines strokeWidth={1.7} />
      </button>
      <div className="mic-caption">
        {live ? (
          <>
            <b style={{ color: "var(--accent)" }}>Listening…</b> tap to stop
          </>
        ) : (
          <b>Activate always listening</b>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd control-plane && npx vitest run src/molecules/MicHero.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck + lint**

Run: `cd control-plane && npm run typecheck && npm run lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add control-plane/src/molecules/MicHero.tsx control-plane/src/molecules/MicHero.test.tsx
git commit -m "feat(control-plane): mic hero becomes the always-listening toggle with AudioLines icon

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Install motion; transcript bubble entry + hidden scrollbar + top fade

**Files:**
- Modify: `control-plane/package.json` + `control-plane/package-lock.json` (via `npm install motion`)
- Modify: `control-plane/src/molecules/Transcript.tsx`
- Modify: `control-plane/src/styles/components.css` (the `.transcript` section, ~line 673, and append chat-state rules)
- Test: `control-plane/src/molecules/Transcript.test.tsx` (create)

**Interfaces:**
- Consumes: `ChatMessage { id: number; role: "user" | "broker"; text: string }` from `../hooks/useBrokerChat` (unchanged).
- Produces: `Transcript` keeps its exact existing props `{ messages: ChatMessage[] }`; CSS classes `.chat-log`, `.composer-dock`, and `main.chat-active` rules that Task 4's JSX will attach to.

- [ ] **Step 1: Install motion**

Run: `cd control-plane && npm install motion@^13 && npm ls motion`
Expected: `motion@13.x` in the tree, no peer warnings (peer range allows React 19).

- [ ] **Step 2: Write the failing test**

Create `control-plane/src/molecules/Transcript.test.tsx`. Note the two jsdom stubs — `scrollIntoView` (used by the auto-scroll effect, missing in jsdom) and `matchMedia` (used by motion's `useReducedMotion`, guard in case jsdom lacks it):

```tsx
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Transcript } from "./Transcript";

beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = () => {};
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
  }
});

describe("Transcript", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders nothing while empty", () => {
    render(<Transcript messages={[]} />);
    expect(screen.queryByRole("log")).toBeNull();
  });

  it("renders bubbles with speaker parsing intact", () => {
    render(
      <Transcript
        messages={[
          { id: 1, role: "user", text: "ship it" },
          { id: 2, role: "broker", text: "Manuel: On it." },
        ]}
      />,
    );
    expect(screen.getByRole("log")).toBeTruthy();
    expect(screen.getByText("ship it")).toBeTruthy();
    expect(screen.getByText("Manuel")).toBeTruthy();
    expect(screen.getByText("On it.")).toBeTruthy();
  });
});
```

- [ ] **Step 3: Run the test to verify current behavior**

Run: `cd control-plane && npx vitest run src/molecules/Transcript.test.tsx`
Expected: PASS already (this pins behavior before the motion rewrite — the failing signal for this task is the CSS/motion diff, and this test must STILL pass after Step 4).

- [ ] **Step 4: Add motion entry animation to bubbles**

Replace `control-plane/src/molecules/Transcript.tsx` with:

```tsx
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useRef } from "react";
import type { ChatMessage } from "../hooks/useBrokerChat";

interface TranscriptProps {
  messages: ChatMessage[];
}

/** Rolling meeting transcript — user utterances right, broker speech left. */
export function Transcript({ messages }: TranscriptProps) {
  const endRef = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    if (messages.length > 0) endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [messages.length]);

  if (messages.length === 0) return null;

  return (
    <div className="transcript" role="log" aria-label="Conversation transcript">
      {messages.map((m) => {
        // Broker speech is speaker-prefixed ("Manuel: On it.") — render the name as a label.
        const spoken = m.role === "broker" ? /^([A-Z][\w-]{1,24}):\s+(.*)$/s.exec(m.text) : null;
        return (
          <motion.div
            key={m.id}
            className={`msg ${m.role}`}
            initial={reduceMotion ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, ease: "easeOut" }}
          >
            {spoken ? (
              <>
                <b className="speaker">{spoken[1]}</b> {spoken[2]}
              </>
            ) : (
              m.text
            )}
          </motion.div>
        );
      })}
      <div ref={endRef} />
    </div>
  );
}
```

- [ ] **Step 5: Hide the scrollbar and add the chat-state CSS**

In `control-plane/src/styles/components.css`, inside the existing `.transcript` rule (~line 673) add the scrollbar-hiding line by changing `scrollbar-width: thin;` to `scrollbar-width: none;`, then immediately after that rule's closing brace add:

```css
.transcript::-webkit-scrollbar {
  display: none;
}
```

Then append at the end of the file (Task 4's JSX attaches these classes):

```css
/* Chat state: full-height transcript column with a top fade instead of a hard clip. */
main.chat-active {
  gap: 16px;
}
.chat-log {
  flex: 1;
  min-height: 0;
  width: min(760px, 92%);
  display: flex;
  flex-direction: column;
}
.chat-log .transcript {
  flex: 1;
  max-height: none;
  width: 100%;
  padding-top: 56px;
  mask-image: linear-gradient(to bottom, transparent 0, #000 56px);
  -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 56px);
}
.composer-dock {
  width: min(560px, 90%);
  display: flex;
  justify-content: center;
}
.composer-dock .composer {
  width: 100%;
}
main.chat-active .composer-dock {
  width: min(680px, 92%);
  padding-bottom: 8px;
}
.hero-intro {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 30px;
}
```

- [ ] **Step 6: Run the test to verify it still passes**

Run: `cd control-plane && npx vitest run src/molecules/Transcript.test.tsx`
Expected: PASS (2 tests) — motion.div renders synchronously in jsdom.

- [ ] **Step 7: Typecheck + lint**

Run: `cd control-plane && npm run typecheck && npm run lint`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add control-plane/package.json control-plane/package-lock.json control-plane/src/molecules/Transcript.tsx control-plane/src/molecules/Transcript.test.tsx control-plane/src/styles/components.css
git commit -m "feat(control-plane): motion bubble entries, hidden scrollbar, top fade mask for chat

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: VoiceStage two states with animated transition

**Files:**
- Modify: `control-plane/src/organisms/VoiceStage.tsx`
- Modify: `control-plane/src/styles/components.css` (delete the now-dead `.stage-tools` block, ~line 648)
- Test: `control-plane/src/organisms/VoiceStage.test.tsx` (create)

**Interfaces:**
- Consumes: `Composer` props from Task 1 (`micLive`, `onMicToggle`, `soundOn`, `onSoundToggle`), `MicHero { live, onToggle }` from Task 2, `Transcript { messages }` and CSS classes `.chat-log` / `.composer-dock` / `.hero-intro` / `main.chat-active` from Task 3.
- Produces: `VoiceStage` keeps its exact existing props — `HomePage.tsx` needs no change.

- [ ] **Step 1: Write the failing test**

Create `control-plane/src/organisms/VoiceStage.test.tsx`:

```tsx
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../hooks/useBrokerChat";
import { VoiceStage } from "./VoiceStage";

beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = () => {};
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
  }
});

const MESSAGES: ChatMessage[] = [
  { id: 1, role: "user", text: "ship it" },
  { id: 2, role: "broker", text: "Manuel: On it." },
];

function renderStage(overrides: Partial<Parameters<typeof VoiceStage>[0]> = {}) {
  const props = {
    micLive: false,
    onMicToggle: vi.fn(),
    messages: [] as ChatMessage[],
    brokerConnected: true,
    onSend: vi.fn(),
    soundOn: true,
    onSoundToggle: vi.fn(),
    ...overrides,
  };
  render(<VoiceStage {...props} />);
  return props;
}

describe("VoiceStage", () => {
  afterEach(() => {
    cleanup();
  });

  it("empty state: greeting and hero, no transcript", () => {
    renderStage();
    expect(screen.getByText(/the mic is yours/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Activate always listening" })).toBeTruthy();
    expect(screen.queryByRole("log")).toBeNull();
  });

  it("chat state: transcript fills the stage, greeting and hero are gone", () => {
    renderStage({ messages: MESSAGES });
    expect(screen.getByRole("log")).toBeTruthy();
    expect(screen.getByText("Manuel")).toBeTruthy();
    expect(screen.queryByText(/the mic is yours/i)).toBeNull();
    expect(screen.queryByRole("button", { name: "Activate always listening" })).toBeNull();
  });

  it("chat state: composer voice toggle drives onMicToggle", async () => {
    const { onMicToggle } = renderStage({ messages: MESSAGES });
    await userEvent.click(screen.getByRole("button", { name: "Always listening" }));
    expect(onMicToggle).toHaveBeenCalledTimes(1);
  });

  it("speaker toggle in the composer drives onSoundToggle (stage-tools row is gone)", async () => {
    const { onSoundToggle } = renderStage({ messages: MESSAGES });
    const speakers = screen.getAllByRole("button", { name: "Mute agent voices" });
    expect(speakers.length).toBe(1);
    await userEvent.click(speakers[0]);
    expect(onSoundToggle).toHaveBeenCalledTimes(1);
  });

  it("sending flows through the composer in chat state", async () => {
    const { onSend } = renderStage({ messages: MESSAGES });
    await userEvent.type(screen.getByRole("textbox", { name: "Type a request" }), "hello{Enter}");
    expect(onSend).toHaveBeenCalledWith("hello");
  });

  it("broker offline: composer disabled in the empty state too", () => {
    renderStage({ brokerConnected: false });
    const box = screen.getByRole("textbox", { name: "Type a request" }) as HTMLTextAreaElement;
    expect(box.disabled).toBe(true);
    expect(box.placeholder).toBe("Broker offline — start the broker to chat…");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd control-plane && npx vitest run src/organisms/VoiceStage.test.tsx`
Expected: FAIL — greeting still renders in chat state, no composer voice/speaker buttons (VoiceStage doesn't pass the new props yet), and the old stage-tools speaker makes the name query ambiguous.

- [ ] **Step 3: Rewrite `VoiceStage.tsx`**

Replace the whole file with:

```tsx
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { ChatMessage } from "../hooks/useBrokerChat";
import { Composer } from "../molecules/Composer";
import { MicHero } from "../molecules/MicHero";
import { Transcript } from "../molecules/Transcript";

interface VoiceStageProps {
  micLive: boolean;
  onMicToggle: () => void;
  messages: ChatMessage[];
  brokerConnected: boolean;
  onSend: (text: string) => void;
  soundOn: boolean;
  onSoundToggle: () => void;
}

export function VoiceStage({
  micLive,
  onMicToggle,
  messages,
  brokerConnected,
  onSend,
  soundOn,
  onSoundToggle,
}: VoiceStageProps) {
  const chatActive = messages.length > 0;
  const reduceMotion = useReducedMotion();
  const spring = reduceMotion ? { duration: 0 } : { type: "spring" as const, duration: 0.5, bounce: 0 };

  return (
    <main className={chatActive ? "chat-active" : undefined}>
      <AnimatePresence mode="popLayout" initial={false}>
        {!chatActive && (
          <motion.div
            key="hero"
            className="hero-intro"
            initial={{ opacity: 0, scale: 0.92, y: 24 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.92, y: -24 }}
            transition={spring}
          >
            <h1 className="greeting">
              The mic is yours, <em>Edwin</em>
            </h1>
            <MicHero live={micLive} onToggle={onMicToggle} />
          </motion.div>
        )}
      </AnimatePresence>
      {chatActive && (
        <motion.div key="log" className="chat-log" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={spring}>
          <Transcript messages={messages} />
        </motion.div>
      )}
      <motion.div layout className="composer-dock" transition={spring}>
        <Composer
          onSend={onSend}
          disabled={!brokerConnected}
          micLive={micLive}
          onMicToggle={onMicToggle}
          soundOn={soundOn}
          onSoundToggle={onSoundToggle}
        />
      </motion.div>
    </main>
  );
}
```

- [ ] **Step 4: Delete the dead stage-tools CSS**

In `control-plane/src/styles/components.css`, delete this block (~line 648) — the sound toggle now lives in the composer, and `.sound-toggle` base rules are still used there via the `.composer--stacked .sound-toggle` overrides, so delete ONLY the `.stage-tools` rule:

```css
.stage-tools {
  width: min(560px, 90%);
  display: flex;
  justify-content: flex-end;
}
```

Keep `.sound-toggle`, `.sound-toggle:hover`, and `.sound-toggle.off` — the composer buttons still class-match them.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd control-plane && npx vitest run src/organisms/VoiceStage.test.tsx`
Expected: PASS (6 tests).

- [ ] **Step 6: Full suite + typecheck + lint**

Run: `cd control-plane && npm run test && npm run typecheck && npm run lint`
Expected: all suites pass (including the pre-existing ones), clean typecheck and lint.

- [ ] **Step 7: Commit**

```bash
git add control-plane/src/organisms/VoiceStage.tsx control-plane/src/organisms/VoiceStage.test.tsx control-plane/src/styles/components.css
git commit -m "feat(control-plane): two-state chat stage with motion transition

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Visual smoke check

**Files:**
- None modified — verification only. (Any fix discovered here gets its own minimal edit + the Task 4 test/lint cycle + a `fix(control-plane):` commit.)

**Interfaces:**
- Consumes: the finished feature.
- Produces: confirmation the transition looks right outside jsdom.

- [ ] **Step 1: Launch the dev server**

Run: `cd control-plane && npm run dev` (background). Vite serves on the fixed port `1420`.

- [ ] **Step 2: Drive the empty state in a browser**

Open `http://localhost:1420` (Playwright MCP browser or a normal browser). Confirm: greeting + `AudioLines` hero with "Activate always listening", two-row composer beneath (textarea row, then `+` left and `Swarm ▾ / Always-listening / speaker / send` right), no transcript, no floating sound toggle, no visible scrollbars anywhere.

- [ ] **Step 3: Drive the chat state**

If the broker is up (tmux session `smith-broker`, port 7790), send a message from the composer. If it is down, do NOT restart anything — instead verify the chat state by temporarily hardcoding `messages` in `HomePage`'s `useBrokerChat` result is NOT needed: just confirm the offline placeholder renders and rely on the vitest coverage for the state flip, then note in the summary that the live transition awaits a broker session. When the broker IS up, confirm: hero animates out (fade/scale/drift), composer glides to the bottom dock, transcript fills the height, oldest bubbles fade at the top edge, no scrollbar.

- [ ] **Step 4: Stop the dev server and report**

Kill only the vite process started here (Ctrl-C / kill its PID — never an unscoped `pkill`). Summarize what was verified.

---

## Self-Review Notes

- Spec coverage: states/trigger → Task 4; two-row composer + send/disabled rules → Task 1; hero relabel + shared `AudioLines` icon → Task 2 (hero) + Task 1 (composer); no-scrollbar + top fade → Task 3; motion package + choreography + reduced-motion → Tasks 3–4; testing section → Tasks 1, 2, 4 (split per component to match repo idiom — SurfacePolicyPopover precedent — instead of one monolithic VoiceStage.test.tsx; same behaviors covered); WorkStage untouched → enforced by new-class-only CSS.
- Reverse transition (chat → empty on session switch) is exercised by the same `AnimatePresence` code path; jsdom can't meaningfully assert mid-flight animation, so it is covered by the Step-1/Step-2 state tests plus the Task 5 smoke check.
- Type consistency: `Composer` optional props appear identically in Tasks 1 and 4; `MicHero`/`Transcript`/`VoiceStage` public props are unchanged everywhere; accessible names are exact strings reused across Tasks 1, 2, 4.
