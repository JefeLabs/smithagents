# Spanglish STT (nova-3 multi) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Strong Spanish/Spanglish transcription: the Deepgram session gets `language` from `DEEPGRAM_LANGUAGE` with `'multi'` as the default, covering both the in-app PTT mic and the Discord VC ear through the one shared factory.

**Architecture:** Extract the Deepgram connect options into a pure, exported builder (`deepgramLiveOptions`) in `stt.ts` so it's unit-testable; `makeDeepgramLive` in `main.ts` consumes it. No downstream changes — the brain reads Spanish fine and transcripts stay speaker-prefixed.

**Tech Stack:** TypeScript, Deepgram nova-3, Node built-in test runner via tsx.

**Spec:** `docs/superpowers/specs/2026-07-29-spanglish-stt-design.md`

## Global Constraints

- Default language is exactly `'multi'`; `DEEPGRAM_LANGUAGE` overrides (e.g. `en`, `es-419`).
- The existing connect options are load-bearing and must be preserved byte-for-byte: `model: 'nova-3'`, `encoding: 'linear16'`, `channels: 1`, `interim_results: 'true'`, `smart_format: 'true'`, `endpointing: 300` (endpointing drives meeting etiquette).
- Broker commands (from `broker/`): tests `npm test`; one file `node --import tsx --test src/stt.test.ts`; typecheck `npm run typecheck`.
- Do not include the repo's unrelated dirty files in the commit.

---

### Task 1: `deepgramLiveOptions` builder + wiring

**Files:**
- Modify: `broker/src/stt.ts` (add the exported builder)
- Modify: `broker/src/stt.test.ts` (extend, mirroring its import style)
- Modify: `broker/src/main.ts` (`makeDeepgramLive`, connect options at ≈lines 153–162)

**Interfaces:**
- Produces: `export function deepgramLiveOptions(sampleRate: number, env: NodeJS.ProcessEnv = process.env): Record<string, unknown>` in `stt.ts`.

- [ ] **Step 1: Write the failing tests** (append to `broker/src/stt.test.ts`)

```ts
test('deepgramLiveOptions defaults to multi and preserves the load-bearing options', () => {
  const opts = deepgramLiveOptions(48000, {});
  assert.equal(opts.language, 'multi');
  assert.equal(opts.model, 'nova-3');
  assert.equal(opts.encoding, 'linear16');
  assert.equal(opts.sample_rate, 48000);
  assert.equal(opts.channels, 1);
  assert.equal(opts.interim_results, 'true');
  assert.equal(opts.smart_format, 'true');
  assert.equal(opts.endpointing, 300);
});

test('DEEPGRAM_LANGUAGE env overrides the language', () => {
  assert.equal(deepgramLiveOptions(24000, { DEEPGRAM_LANGUAGE: 'es-419' }).language, 'es-419');
  assert.equal(deepgramLiveOptions(24000, { DEEPGRAM_LANGUAGE: 'es-419' }).sample_rate, 24000);
});
```

Import the builder alongside the file's existing imports: `import { deepgramLiveOptions } from './stt.ts';` (match the file's quote/extension style).

- [ ] **Step 2: Run to verify failure**

Run (from `broker/`): `node --import tsx --test src/stt.test.ts`
Expected: FAIL — `deepgramLiveOptions` is not exported.

- [ ] **Step 3: Implement the builder in `stt.ts`**

```ts
/** Deepgram live-session options shared by every hearing path (PTT mic, Discord ear).
 * `language` defaults to 'multi' — nova-3's code-switching mode (Spanish+English in
 * one utterance); pin DEEPGRAM_LANGUAGE=en or es-419 to override. `endpointing: 300`
 * is load-bearing for meeting etiquette — do not change it here. */
export function deepgramLiveOptions(
  sampleRate: number,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> {
  return {
    model: 'nova-3',
    language: env.DEEPGRAM_LANGUAGE ?? 'multi',
    encoding: 'linear16',
    sample_rate: sampleRate,
    channels: 1,
    interim_results: 'true',
    smart_format: 'true',
    endpointing: 300,
  };
}
```

In `main.ts`'s `makeDeepgramLive`, replace the inline object literal passed to `deepgram.listen.v1.connect({ ... })` with `deepgram.listen.v1.connect(deepgramLiveOptions(sampleRate))` and add `deepgramLiveOptions` to the existing `./stt.ts` import.

- [ ] **Step 4: Run tests and typecheck**

Run: `node --import tsx --test src/stt.test.ts && npm run typecheck && npm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add broker/src/stt.ts broker/src/stt.test.ts broker/src/main.ts
git commit -m "feat(broker): Spanglish STT — DEEPGRAM_LANGUAGE env, nova-3 multi default"
```

---

### Task 2: Live smoke test (operator-run)

**Files:**
- Modify: `docs/MANUAL-TESTING.md` (append the checklist)

`multi` has different endpointing/latency behavior than plain English mode — this is the check automated tests can't do.

- [ ] **Step 1: Append to `docs/MANUAL-TESTING.md`:**

```markdown
## Spanglish STT (2026-07-29)

- Broker up with no DEEPGRAM_LANGUAGE set; join a VC with the crew.
- Speak pure English → transcript quality unchanged; agent turn-taking timing feels the same.
- Speak pure Spanish → transcribed correctly (not English-mangled).
- Code-switch mid-sentence ("Ignacio, revisa el broker and ship it") → both halves correct.
- Watch for etiquette regressions: agents interrupting early/late means multi's endpointing
  behaves differently — if so, tune `endpointing` via a follow-up, don't revert the language.
- Repeat one Spanish utterance over the in-app PTT mic (same factory, second path).
- Set DEEPGRAM_LANGUAGE=en, restart, confirm English-only behavior returns (the escape hatch works).
```

- [ ] **Step 2: Run the checklist live; fix regressions through Task 1's test file first**

- [ ] **Step 3: Commit**

```bash
git add docs/MANUAL-TESTING.md
git commit -m "docs: Spanglish STT live smoke checklist"
```
