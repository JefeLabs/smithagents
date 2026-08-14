// One background call after a session's first reply names it (spec §3:
// "truncate now, brain retitles once"). Failure is silent — the truncated
// title simply stays; naming must never break a conversation.
import type { ResearchEngine } from "./research.ts";

const SYSTEM =
  "You name chat sessions. Reply with ONLY a 2-6 word title for the conversation excerpt. No quotes, no trailing punctuation, no explanation.";

export async function generateSessionTitle(
  engine: ResearchEngine,
  firstUserText: string,
  firstReply: string,
): Promise<string | null> {
  try {
    const prompt = `User: ${firstUserText.slice(0, 600)}\n\nAssistant: ${firstReply.slice(0, 600)}`;
    const text = await engine.complete({ system: SYSTEM, prompt, maxTokens: 30 });
    const clean = text
      .replace(/\s+/g, " ")
      .replace(/^["'\s]+|["'.\s]+$/g, "")
      .trim();
    if (!clean) return null;
    return clean.length <= 60 ? clean : `${clean.slice(0, 59).trimEnd()}…`;
  } catch {
    return null;
  }
}
