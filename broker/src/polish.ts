/**
 * Polish-my-input — one standalone rewrite call BEFORE dispatch (spec
 * 2026-08-10): nothing reaches any agent until the user sends the result.
 * Same free-function-over-ResearchEngine shape as session-title.ts; failure
 * returns null and the caller keeps the draft.
 */
import type { ResearchEngine } from "./research.ts";

const SYSTEM =
  "You polish rough drafts into clear, well-formed requests. Keep the meaning, intent, language and any names exactly; fix spelling, grammar and structure; stay close to the original length. Reply with ONLY the polished text — no quotes, no preamble.";

export async function polishText(engine: ResearchEngine, text: string, context?: string): Promise<string | null> {
  try {
    const prompt = context
      ? `Conversation context (for names/terms only):\n${context.slice(0, 800)}\n\nDraft to polish:\n${text.slice(0, 2000)}`
      : `Draft to polish:\n${text.slice(0, 2000)}`;
    const out = (await engine.complete({ system: SYSTEM, prompt, maxTokens: 500 })).trim();
    return out || null;
  } catch {
    return null;
  }
}
