// Who is being spoken TO — a lexical read of the utterance, not the brain's.
//
// The brain decides who ANSWERS. That decision arrives after a model round
// trip, which is far too late for a listening indicator: the ring has to light
// up while you are still talking to them. So this is deliberately dumb, fast,
// and local — it runs the moment an utterance lands.
//
// Precision matters more than recall here. "I talked to Manuel yesterday" is
// not addressing Manuel, and a ring that pulses on every passing mention stops
// meaning anything. So a name counts only when it is used as a vocative:
// leading the utterance, or introduced by a greeting.

/** Greetings that mark the next word as a vocative, in both crew languages. */
const VOCATIVES = ["hey", "hi", "hello", "yo", "ok", "okay", "hola", "oye", "oiga", "mira"];

/** Words that address the whole room rather than one teammate. */
const EVERYONE = ["team", "everyone", "everybody", "all of you", "gente", "equipo", "crew"];

/** Lowercase, strip accents, collapse punctuation to spaces. */
export function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Names addressed in `text`, drawn from `names` (agents, squads, groups).
 *
 * Returns every name when the room is addressed collectively, so "hey team"
 * lights up the whole roster — which is exactly what the human just did.
 */
export function whoIsAddressed(text: string, names: string[]): string[] {
  const haystack = normalize(text);
  if (!haystack) return [];

  const words = haystack.split(" ");
  if (EVERYONE.some((w) => haystack.includes(w) && isVocativeAt(words, w.split(" ")[0] ?? w))) {
    return [...names];
  }

  return names.filter((name) => {
    const needle = normalize(name);
    if (!needle) return false;
    return isVocativeAt(words, needle);
  });
}

/**
 * Is `needle` used as a vocative in `words` — leading the utterance, or
 * directly after a greeting? Multi-word names are matched as a phrase.
 */
function isVocativeAt(words: string[], needle: string): boolean {
  const parts = needle.split(" ");
  for (let i = 0; i <= words.length - parts.length; i++) {
    if (!parts.every((p, k) => words[i + k] === p)) continue;
    // Leading the utterance: "Manuel, can you take this?"
    if (i === 0) return true;
    // Introduced by a greeting: "hey Manuel", "ok Manuel".
    if (VOCATIVES.includes(words[i - 1] ?? "")) return true;
  }
  return false;
}
