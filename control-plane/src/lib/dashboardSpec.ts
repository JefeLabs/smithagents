/**
 * The dashboard document's renderable source (spec 2026-08-11
 * dashboards-as-documents): a fenced JSON block in the doc's `spec` section,
 * exactly as Mermaid text is a diagram's. `composeSpec` serializes the mock
 * fixtures today; the real composition backend will write better specs into
 * the same shape. Pins are DOC-level metadata and deliberately not in here.
 */
import { DASH_ANSWER, DASH_KPIS, DASH_ROWS } from "../data/dashboards";

export interface DashSpec {
  summary: string;
  kpis: Array<{ label: string; value: string; delta?: string; tone?: "ok" | "watch" | "high" }>;
  charts: Array<{ kind: "line" | "bars"; title: string; series?: string[] }>;
  table?: { title: string; columns: string[]; rows: string[][] };
  /**
   * Prose answer cards (spec 2026-08-11-workspace-groups §7) — chat-written
   * text with an informational source label ("session s12", "doc d34").
   */
  texts?: Array<{ title: string; body: string; source?: string }>;
}

/** First fenced ```json block (or a bare object); null unless the shape holds. */
export function parseDashSpec(body: string): DashSpec | null {
  const raw = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/.exec(body)?.[1] ?? /\{[\s\S]*\}/.exec(body)?.[0] ?? "";
  try {
    const parsed = JSON.parse(raw) as DashSpec;
    if (typeof parsed.summary !== "string" || !Array.isArray(parsed.kpis) || !Array.isArray(parsed.charts)) {
      return null;
    }
    // texts are optional but validated when present — a malformed entry fails
    // the WHOLE parse, all-or-nothing like every other field.
    if (parsed.texts !== undefined) {
      const ok =
        Array.isArray(parsed.texts) &&
        parsed.texts.every(
          (t) =>
            t &&
            typeof t.title === "string" &&
            typeof t.body === "string" &&
            (t.source === undefined || typeof t.source === "string"),
        );
      if (!ok) return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Serialize the mock's composed answer for `question`/`scope` into the schema. */
export function composeSpec(_question: string, _scope: string): DashSpec {
  return {
    summary: DASH_ANSWER,
    kpis: DASH_KPIS.map((k) => ({ label: k.label, value: k.value, delta: k.delta, tone: k.tone })),
    charts: [
      { kind: "line", title: "shipped vs intake", series: ["shipped", "intake"] },
      { kind: "bars", title: "where work is sitting" },
    ],
    table: {
      title: "groups — sorted by risk",
      columns: ["group", "cards", "wip", "cycle", "risk"],
      rows: DASH_ROWS.map((r) => [r.name, String(r.cards), String(r.wip), r.cycle, r.risk]),
    },
  };
}

export function specToFence(spec: DashSpec): string {
  return `\`\`\`json\n${JSON.stringify(spec, null, 2)}\n\`\`\``;
}
