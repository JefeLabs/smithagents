// Analyze transform (spec 2026-08-13 queue-sources): an LLM judges a polled
// payload into zero or more work items. Pure prompt/parse halves — the LLM
// call itself is injected in main.ts exactly like cards.ts's plan() dep.
const RAW_CAP = 6_000;

export function analyzeBrief(source: { label: string; analyzePrompt?: string }, raw: string): string {
  return [
    `You triage a monitoring feed ("${source.label}") for a working engineer.`,
    source.analyzePrompt ? `Operator instruction: ${source.analyzePrompt}` : "",
    'Findings that deserve action become work items. Output each as a line "WORK ITEM: <imperative title>" followed by 1-3 lines of notes. If nothing deserves action, output exactly "NOTHING".',
    "",
    raw.slice(0, RAW_CAP),
  ]
    .filter(Boolean)
    .join("\n");
}

export function workItemsFrom(text: string): Array<{ title: string; notes: string }> {
  const items: Array<{ title: string; notes: string }> = [];
  let current: { title: string; notes: string[] } | null = null;
  for (const line of text.split("\n")) {
    const m = /^\s*WORK ITEM:\s*(.+)$/.exec(line);
    if (m) {
      if (current) items.push({ title: current.title, notes: current.notes.join("\n").trim() });
      current = { title: m[1].trim(), notes: [] };
    } else if (current && line.trim()) {
      current.notes.push(line.trim());
    }
  }
  if (current) items.push({ title: current.title, notes: current.notes.join("\n").trim() });
  return items;
}
