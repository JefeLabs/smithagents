/**
 * Polish-my-input — one standalone rewrite call BEFORE dispatch (spec
 * 2026-08-10): nothing reaches any agent until the user sends the result.
 * Same free-function-over-StreamFactory shape as session-title.ts; failure
 * returns null and the caller keeps the draft.
 */
import type { StreamFactory } from './brain.ts';

const SYSTEM =
  'You polish rough drafts into clear, well-formed requests. Keep the meaning, intent, language and any names exactly; fix spelling, grammar and structure; stay close to the original length. Reply with ONLY the polished text — no quotes, no preamble.';

export async function polishText(
  streamFactory: StreamFactory,
  model: string,
  text: string,
  context?: string,
): Promise<string | null> {
  try {
    const stream = streamFactory({
      model,
      max_tokens: 500,
      system: SYSTEM,
      messages: [
        {
          role: 'user',
          content: context
            ? `Conversation context (for names/terms only):\n${context.slice(0, 800)}\n\nDraft to polish:\n${text.slice(0, 2000)}`
            : `Draft to polish:\n${text.slice(0, 2000)}`,
        },
      ],
      tools: [] as never,
    });
    const final = await stream.finalMessage();
    const out = final.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text' && typeof (b as { text?: unknown }).text === 'string')
      .map((b) => b.text)
      .join(' ')
      .trim();
    return out || null;
  } catch {
    return null;
  }
}
