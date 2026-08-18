/**
 * voice-preview.ts — the wizard's "How should I sound?" list (GET
 * /voice/options) and its ▶ Say something preview (POST /voice/preview).
 *
 * Both lean on machinery that already exists in main.ts rather than
 * duplicating it:
 *  - `voiceOptionsFrom` derives the curated list straight from speak()'s own
 *    premade stand-in cast (PREMADE_STANDINS) — never a second hardcoded
 *    catalog that could drift out of sync with it.
 *  - `previewVoice` mirrors speak()'s own currentTts()/timeout-guard/
 *    402-fallback control flow, so a preview degrades exactly the way a real
 *    turn's speech would — but RESOLVES `{error}` on every failure path
 *    instead of throwing, because a direct request/response caller needs an
 *    answer, not a rejected promise it must remember to catch. A bare 500 or
 *    a hang is a bug here, not an edge case.
 *
 * Kept dependency-injected and side-effect-free on purpose: this module
 * opens no ElevenLabs client of its own (main.ts wires its real currentTts()
 * in) and is unit-testable without the real SDK clients main.ts builds at
 * module load — no test suite loads main.ts (tsx strips types at runtime,
 * so a load-time bug there — like the `brain` shadowing incident — is
 * invisible to every test); this module is where the actual logic gets
 * covered.
 */

export interface VoiceOption {
  id: string;
  label: string;
}

/**
 * Derives the curated list from the caller's own premade stand-in cast
 * (main.ts's PREMADE_STANDINS, keyed by speaker name → ElevenLabs voiceId).
 * Takes the map as an argument rather than importing it — this module never
 * has its own hardcoded copy, so the wizard's list can't drift from
 * speak()'s 402-fallback cast.
 */
export function voiceOptionsFrom(standIns: Record<string, string>): VoiceOption[] {
  return Object.entries(standIns).map(([label, id]) => ({ id, label }));
}

/** Anderson's own line — the default preview text when the caller sends none. */
export const VOICE_PREVIEW_LINE = "Anderson here — this is what I sound like.";

export type PreviewResult = { mime: string; dataB64: string } | { error: string };

/** Minimal synth surface previewVoice needs. main.ts's real implementation
 * is `currentTts()`'s `provider.synthesize(...)` — the same ElevenLabs
 * client speak()/broadcastSpokenAudio() already use, never a second one. */
export interface PreviewSynth {
  synthesize(req: { voiceId: string; text: string; signal: AbortSignal }): Promise<{ data: Uint8Array }>;
}

export interface PreviewDeps {
  /** Same currentTts() speak() calls — null means no TTS key is configured. */
  currentTts(): Promise<PreviewSynth | null>;
  /** The one human sentence for "nothing configured" (voice-keys.ts's VOICE_TTS_HINT) — never re-worded here. */
  noTtsHint: string;
  /** Free-tier premade stand-in to retry with on a 402 (main.ts's PREMADE_DEFAULT). */
  standInVoiceId: string;
  /** Same TTS_TIMEOUT_MS speak() is bounded by. */
  timeoutMs: number;
  /** Same isTtsTimeout() speak() uses to recognize an aborted signal. */
  isTimeout(err: unknown): boolean;
  /**
   * Where the RAW provider failure goes. Injected rather than a `console.warn`
   * here so this module stays side-effect-free (see the header) — and required
   * rather than optional, because "the detail is logged, never rendered" is
   * only a guarantee if every caller has to supply somewhere to put it.
   */
  logDetail(err: unknown): void;
}

const is402 = (err: unknown) => /402|payment_required|paid_plan_required/.test(String(err));

/**
 * The credential itself was refused. Worth its own sentence because it is the
 * one provider failure the user can DO something about, and the action is on
 * the screen they are already looking at — never "go to Settings", which a
 * first-run user has not reached.
 */
export const VOICE_PREVIEW_AUTH_REFUSAL = "That key didn't work for speaking — check it and try again.";
/** Everything else, in one sentence: a preview gates nothing, so the only useful advice is "try again". */
export const VOICE_PREVIEW_FAILED = "I couldn't say that just now — try again, or pick a different voice.";

/**
 * The provider adapter's throw carries the HTTP status AND the raw response
 * body (`ElevenLabs TTS failed: 401 {"detail":{...}}`) — and this string is
 * rendered verbatim on the wizard's first-run screen. Interpolating it there
 * put an ElevenLabs error payload in front of a user setting up their machine.
 *
 * So: recognized shapes become written sentences, everything else becomes one
 * generic sentence, and the raw text goes to `logDetail` — the operator's
 * copy — instead of to the screen. Matched against `String(err)` rather than
 * `err.message` because the adapters throw plain Errors today and the status
 * could just as well arrive on a thrown response object tomorrow.
 */
const isAuthRefusal = (err: unknown) => /\b(401|403)\b|unauthor|forbidden|invalid[_ -]?api[_ -]?key/i.test(String(err));

function humanize(err: unknown, logDetail: (err: unknown) => void): string {
  logDetail(err);
  return isAuthRefusal(err) ? VOICE_PREVIEW_AUTH_REFUSAL : VOICE_PREVIEW_FAILED;
}

/**
 * Resolves — never throws, never hangs. Mirrors speak()'s own
 * timeout-guard/402-fallback flow (main.ts:281), converted from "throw"
 * (speak() runs inside a turn queue that already handles a rejection) to
 * "resolve `{error}`" (a direct request/response caller needs an answer).
 */
export async function previewVoice(voiceId: string, text: string, deps: PreviewDeps): Promise<PreviewResult> {
  const t = await deps.currentTts();
  if (!t) return { error: deps.noTtsHint };

  const attempt = (id: string) => t.synthesize({ voiceId: id, text, signal: AbortSignal.timeout(deps.timeoutMs) });
  try {
    const result = await attempt(voiceId);
    return { mime: "audio/mpeg", dataB64: Buffer.from(result.data).toString("base64") };
  } catch (err) {
    if (deps.isTimeout(err)) return { error: `That took too long — try again.` };
    if (!is402(err) || deps.standInVoiceId === voiceId) return { error: humanize(err, deps.logDetail) };
    try {
      const result = await attempt(deps.standInVoiceId);
      return { mime: "audio/mpeg", dataB64: Buffer.from(result.data).toString("base64") };
    } catch (err2) {
      if (deps.isTimeout(err2)) return { error: `That took too long — try again.` };
      return { error: humanize(err2, deps.logDetail) };
    }
  }
}
