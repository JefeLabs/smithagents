// The wizard's closing receipt: proof the brain answers, with the time it took.
//
// Deliberately pure over an injected asker and clock. The number this returns is
// the only thing standing behind a tick the user reads as fact, so it has to be
// testable without a live engine — and impossible to produce without a real
// call. Every failure path returns a reason rather than a number, because a
// receipt that ticks for nothing is worse than one that is absent.

export type BrainPing = { ok: true; reply: string; latencyMs: number } | { ok: false; reason: string };

const DEFAULT_QUESTION = "Say hello in one short sentence.";

export async function pingBrain(
  ask: (question: string) => Promise<{ reply: string } | { notApiAgent: true }>,
  now: () => number,
  question: string = DEFAULT_QUESTION,
): Promise<BrainPing> {
  const started = now();
  try {
    const answer = await ask(question);
    if ("notApiAgent" in answer) {
      return { ok: false, reason: "this engine cannot answer a one-shot question" };
    }
    // An empty reply is not an answer. A receipt that ticks for whitespace is
    // exactly the fake this screen exists to avoid.
    if (!answer.reply.trim()) return { ok: false, reason: "the engine answered with nothing" };
    return { ok: true, reply: answer.reply, latencyMs: now() - started };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}
