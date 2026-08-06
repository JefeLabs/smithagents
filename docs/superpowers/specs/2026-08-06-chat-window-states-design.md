# Two-state chat window (VoiceStage)

**Date:** 2026-08-06
**Status:** Approved by Edwin (sections 1–4), plus two mid-review additions: two-row composer, top-fade scroll mask.

## Problem

The control-plane stage renders one fixed layout: centered greeting, 84px mic hero, a transcript capped at 220px, and a single-row composer. Once a conversation is running, the transcript is cramped and the hero column wastes the screen. We want two distinct states — a pre-session hero state and a full-height session chat view (Claude.ai-style) — with an animated transition between them.

## States & trigger

`chatActive = messages.length > 0`, derived in `VoiceStage` from the WS-driven
`useBrokerChat` messages. No new state, no explicit session flag.

- **Empty state** (no messages in the active session): centered hero column —
  greeting "The mic is yours, *Edwin*", big mic hero, two-row composer beneath.
  No transcript. The hero is an **always-listening toggle**: idle caption
  "**Activate always listening**" (replacing "Push to talk — or type below"),
  live caption unchanged ("Listening… tap to stop"). Its icon changes from
  lucide `Mic` to lucide `AudioLines` — the **same icon** the composer's
  voice toggle uses, since both drive the same `onMicToggle`.
- **Chat state**: greeting + mic hero gone. Transcript takes the full stage
  height (column widened to `min(760px, 92%)`, `flex: 1`, scrollable,
  auto-scroll preserved). Composer docks at the bottom.
- Switching to a session with no messages plays the transition in reverse.
- Voice state carries across: if the mic is live during the flip, the
  composer's dictate button renders already-live.

## Composer redesign (both states)

```
┌─────────────────────────────────────────────┐
│ Type a request…                             │  ← auto-growing textarea
│ [+]                   Swarm ▾  [mic] [spk] [↑]│  ← controls row
└─────────────────────────────────────────────┘
```

- **Row 1**: auto-growing textarea, capped at ~6 lines then scrolls
  internally. Enter sends; Shift+Enter inserts a newline. Disabled + offline
  placeholder when the broker is down (unchanged behavior).
- **Row 2 left**: `+` add-context button (links, files — remains a stub wired
  like today's attach button).
- **Row 2 right**, in order: `Swarm ▾` routing selector (relocated from the
  input row) · **hold-to-talk** button (lucide `Mic`; walkie-talkie: pointer
  down starts listening via `onMicToggle`, release/leave/cancel stops it;
  inert while always-listening is already latched; label "Hold to talk") ·
  **always-listening** toggle (lucide `AudioLines`, matching the
  hero; accent + pulse when live; calls the same `onMicToggle`) · **speaker**
  toggle (TTS on/off; the current
  stage-tools sound toggle moves here, and the floating stage-tools row is
  removed) · **send arrow** button (accent-filled, like the reference
  screenshot; disabled while the draft is empty or the broker is offline).
- New layout ships under a modifier class (`.composer--stacked`). Base
  `.composer` rules stay intact because `WorkStage` has its own inline
  single-row `.composer` form — **WorkStage is untouched**.

## Transcript presentation (chat state)

- **No visible scrollbar**: `scrollbar-width: none` +
  `::-webkit-scrollbar { display: none }` on the transcript scroller.
- **Top fade-out**: a CSS gradient mask on the scroll container
  (`mask-image: linear-gradient(to bottom, transparent 0, black ~56px)`, with
  `-webkit-` prefix for WKWebView) so messages dissolve as they reach the top
  of the chat viewport instead of clipping.
- Speaker-name parsing, roles, and scroll-to-end behavior are unchanged.

## Animation (motion package)

- Add the `motion` dependency (Framer Motion's successor); import from
  `motion/react`.
- **Empty → chat**: greeting and mic hero exit via `AnimatePresence`
  (fade + scale-down + upward drift). The composer carries the `layout` prop,
  so motion FLIP-animates its glide from mid-stage to the bottom dock. The
  transcript fades in as it expands.
- **Chat → empty**: same choreography reversed through the same
  `AnimatePresence`.
- **Message bubbles**: small entry animation (opacity + 8px rise), consistent
  with the existing `rise` keyframe idiom.
- One gentle spring (~0.5s perceived, no bounce) shared across the
  transition.
- `useReducedMotion` disables all of it (instant swap), matching the existing
  `prefers-reduced-motion` CSS block.

## Component changes

| Unit | Change |
| --- | --- |
| `VoiceStage.tsx` | Orchestrates the two states; wraps hero pieces in `AnimatePresence`; passes mic/speaker props into `Composer`; drops the stage-tools row. |
| `Composer.tsx` | Two-row layout (`.composer--stacked`); textarea + Enter/Shift+Enter; new optional props `micLive`, `onMicToggle`, `soundOn`, `onSoundToggle`; send button. |
| `MicHero.tsx` | Icon `Mic` → `AudioLines`; idle caption/title/aria become "Activate always listening"; live caption unchanged. |
| `Transcript.tsx` | Motion entry per bubble; otherwise unchanged logic. |
| `components.css` | `.composer--stacked` rules; full-height transcript variant; scrollbar hiding + top mask; chat-state stage layout. |
| `HomePage.tsx` | No structural change (props already flow through `VoiceStage`). |

## Testing

New `VoiceStage.test.tsx` (vitest + RTL, jsdom):

- Empty state: greeting present, no transcript log; hero reads "Activate
  always listening" when idle.
- With messages: transcript renders, greeting absent.
- Dictate button fires `onMicToggle`; speaker fires `onSoundToggle`.
- Enter sends and clears the draft; Shift+Enter does not send.
- Disabled (broker offline): send/dictate disabled, offline placeholder shown.

## Out of scope

- WorkStage composer unification.
- Real attach/context implementation behind the `+` button.
- Session title header / share button from the reference screenshot.
