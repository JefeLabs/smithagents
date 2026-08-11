/**
 * The document-edit turn (spec 2026-08-11 dock-sends-edit-artifact): one
 * instruction against one doc, answered as structured section rewrites. The
 * caller owns everything stateful — resolving the doc, applying or proposing
 * the rewrites, broadcasting frames — so this stays a pure prompt/parse seam
 * that tests drive with a stubbed `create`.
 */
import type { Doc } from "./documents.ts";

export interface DocEditResult {
  rewrites: Array<{ sectionId: string; newBody: string }>;
  /** One short line for the transcript ("tightened Approach"). */
  note: string;
}

/** anthropic.messages.create-shaped; injected so tests never touch the network. */
type CreateLike = (params: object) => Promise<{ content: Array<{ type: string; text?: string }> }>;

const OUTPUT_CONTRACT = `Reply with EXACTLY one JSON object (fenced or bare), no other commentary:
{"rewrites":[{"sectionId":"<id>","newBody":"<full replacement markdown for that section>"}],"note":"<one short line describing the change>"}
Rewrite ONLY the sections the instruction calls for; every sectionId must be one of the ids listed. newBody replaces the section wholesale — prose only, never the "section id=…" header line from the input format.`;

export async function runDocEditTurn(opts: {
  doc: Doc;
  instruction: string;
  targetSectionId?: string;
  /** Crew agent persona line; absent = the host editor. */
  persona?: string;
  create: CreateLike;
  model?: string;
}): Promise<DocEditResult> {
  const { doc, instruction, targetSectionId, persona, create } = opts;
  const system = `You are ${persona ?? "the workspace's host editor"}, revising a working document at its owner's instruction. ${OUTPUT_CONTRACT}`;
  const sections = doc.sections
    .map((s) => `## section id=${s.id} heading=${JSON.stringify(s.heading)}\n${s.body || "(empty)"}`)
    .join("\n\n");
  const content = [
    `DOCUMENT: ${doc.title} (blueprint ${doc.blueprintId}, ${doc.workType})`,
    sections,
    targetSectionId ? `TARGET SECTION: ${targetSectionId} — the instruction is about this section.` : "",
    `INSTRUCTION: ${instruction}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const reply = await create({
    model: opts.model ?? "claude-sonnet-5",
    max_tokens: 4096,
    system,
    messages: [{ role: "user", content }],
  });
  const text = reply.content.find((b) => b.type === "text")?.text ?? "";
  const raw = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/.exec(text)?.[1] ?? /\{[\s\S]*\}/.exec(text)?.[0] ?? "";
  let parsed: { rewrites?: Array<{ sectionId?: unknown; newBody?: unknown }>; note?: unknown } = {};
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    /* falls through to the guard below */
  }
  const ids = new Set(doc.sections.map((s) => s.id));
  const rewrites = (parsed.rewrites ?? [])
    .filter(
      (r): r is { sectionId: string; newBody: string } =>
        typeof r.sectionId === "string" && ids.has(r.sectionId) && typeof r.newBody === "string",
    )
    // Models sometimes parrot the input format's section header into the
    // body; the contract forbids it, and this belt-and-braces strip keeps a
    // near-miss reply useful instead of publishing scaffolding into the doc.
    .map((r) => ({ ...r, newBody: r.newBody.replace(/^#{0,6}\s*section id=[^\n]*\n?/, "").trimStart() }));
  // All-or-nothing: a reply that named unknown sections or produced nothing
  // usable is a failed turn, not a partial edit.
  if (rewrites.length === 0 || rewrites.length !== (parsed.rewrites?.length ?? 0)) {
    throw new Error("edit turn returned no usable rewrites");
  }
  return { rewrites, note: typeof parsed.note === "string" && parsed.note ? parsed.note : "updated the document" };
}
