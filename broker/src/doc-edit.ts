/**
 * The document-edit turn (spec 2026-08-11 dock-sends-edit-artifact): one
 * instruction against one doc, answered as structured section rewrites. The
 * caller owns everything stateful — resolving the doc, applying or proposing
 * the rewrites, broadcasting frames — so this stays a pure prompt/parse seam
 * over a ResearchEngine, which tests drive with a one-line fake.
 */
import type { Doc } from "./documents.ts";
import type { ResearchEngine } from "./research.ts";

export interface DocEditResult {
  rewrites: Array<{ sectionId: string; newBody: string }>;
  /** One short line for the transcript ("tightened Approach"). */
  note: string;
}

const OUTPUT_CONTRACT = `Reply with EXACTLY one JSON object (fenced or bare), no other commentary:
{"rewrites":[{"sectionId":"<id>","newBody":"<full replacement markdown for that section>"}],"note":"<one short line describing the change>"}
Rewrite ONLY the sections the instruction calls for; every sectionId must be one of the ids listed. newBody replaces the section wholesale — prose only, never the "section id=…" header line from the input format.`;

export async function runDocEditTurn(opts: {
  doc: Doc;
  instruction: string;
  targetSectionId?: string;
  /** Crew agent persona line; absent = the host editor. */
  persona?: string;
  engine: ResearchEngine;
}): Promise<DocEditResult> {
  const { doc, instruction, targetSectionId, persona } = opts;
  const system = `You are ${persona ?? "the workspace's host editor"}, revising a working document at its owner's instruction. ${OUTPUT_CONTRACT}`;
  const sections = doc.sections
    .map((s) => `## section id=${s.id} heading=${JSON.stringify(s.heading)}\n${s.body || "(empty)"}`)
    .join("\n\n");
  const content = [
    `DOCUMENT: ${doc.title} (blueprint ${doc.blueprintId}, ${doc.workType})`,
    sections,
    // Dashboard docs render their spec section as JSON (hand-mirrored schema:
    // control-plane/src/lib/dashboardSpec.ts). Without this contract the model
    // mimics the existing JSON's shape and silently drops OPTIONAL fields it
    // was asked to add — live-observed: "add a text card" produced a rewrite
    // with no texts[] and a note claiming success.
    doc.blueprintId === "dashboard"
      ? 'SPEC SCHEMA: the "spec" section is ONE fenced ```json object: { summary: string, ' +
        'kpis: [{label, value, delta?, tone?: "ok"|"watch"|"high"}], ' +
        'charts: [{kind: "line"|"bars", title, series?}], ' +
        "table?: {title, columns: string[], rows: string[][]}, " +
        "texts?: [{title: string, body: string, source?: string}] }. " +
        'texts are prose answer cards (source is a label like "session s2") — add or edit them there.'
      : "",
    targetSectionId ? `TARGET SECTION: ${targetSectionId} — the instruction is about this section.` : "",
    `INSTRUCTION: ${instruction}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const text = await opts.engine.complete({ system, prompt: content, maxTokens: 4096 });
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
