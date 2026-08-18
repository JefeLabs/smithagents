/**
 * The two ways a broker write fails, told apart once instead of at each call
 * site.
 *
 * `brokerFetch` never throws on a non-2xx, so the two are genuinely different
 * events and they want different reactions:
 *
 *  - **refused** — the request RESOLVED carrying `{error}`. A firm no from the
 *    server, with a sentence written for a human. Roll back whatever was done
 *    optimistically and show that sentence.
 *  - **rejected** — the promise THREW. A network-level failure, and ambiguous:
 *    the write may well have landed. Stay optimistic, report it.
 *
 * There were four hand-written copies of this reasoning in the wizard before
 * this existed (`WizardGate`'s `advance`, `goBack` and `editAnswers`, and the
 * brain step's `proceed`), each having to re-derive it. This is the extracted
 * form, not a fifth copy; the host's three still inline it and should be moved
 * onto this when that file is next edited.
 *
 * Note the `?.`: a successful CLEAR resolves to a literal `null` body on
 * several of these routes, and a bare `.error` on it throws a TypeError inside
 * the very `.then` that was meant to handle failure.
 */
export type SaveOutcome = { kind: "ok" } | { kind: "refused" | "rejected"; message: string };

const FALLBACK_MESSAGE = "Could not save — check your connection and try again.";

export async function classifySave(run: () => Promise<unknown>): Promise<SaveOutcome> {
  let result: unknown;
  try {
    result = await run();
  } catch (err) {
    return { kind: "rejected", message: err instanceof Error ? err.message : (String(err) ?? FALLBACK_MESSAGE) };
  }
  // An empty-string error is still an error the server chose to send; only its
  // absence means success. Which is why this is a property check and not a
  // truthiness one — but there would then be nothing to show, so the generic
  // sentence stands in.
  if (result && typeof result === "object" && "error" in result) {
    const { error } = result as { error?: string };
    if (error !== undefined) return { kind: "refused", message: error || FALLBACK_MESSAGE };
  }
  return { kind: "ok" };
}
