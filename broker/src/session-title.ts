// One background call after a session's first reply names it (spec §3:
// "truncate now, brain retitles once"). Failure is silent — the truncated
// title simply stays; naming must never break a conversation.
import type { StreamFactory } from './brain.ts';

const SYSTEM =
  'You name chat sessions. Reply with ONLY a 2-6 word title for the conversation excerpt. No quotes, no trailing punctuation, no explanation.';

export async function generateSessionTitle(
  streamFactory: StreamFactory,
  model: string,
  firstUserText: string,
  firstReply: string,
): Promise<string | null> {
  try {
    const stream = streamFactory({
      model,
      max_tokens: 30,
      system: SYSTEM,
      messages: [{ role: 'user', content: `User: ${firstUserText.slice(0, 600)}\n\nAssistant: ${firstReply.slice(0, 600)}` }],
      tools: [] as never,
    });
    const final = await stream.finalMessage();
    const text = final.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text' && typeof (b as { text?: unknown }).text === 'string')
      .map((b) => b.text)
      .join(' ');
    const clean = text.replace(/\s+/g, ' ').replace(/^["'\s]+|["'.\s]+$/g, '').trim();
    if (!clean) return null;
    return clean.length <= 60 ? clean : `${clean.slice(0, 59).trimEnd()}…`;
  } catch {
    return null;
  }
}
