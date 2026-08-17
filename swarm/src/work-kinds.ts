// Work kinds are DATA, keyed by id — never a TypeScript union.
//
// This list went from three domains to seven in the course of one conversation
// and was still growing when it was written down; a union would make every new
// domain a release. The codebase settled this question elsewhere:
// AgentEngine.stereotype is an open string, and personas load as config rather
// than being enumerated in code. Keeping vocabularies here makes "bring your own
// words" a product capability rather than a code change — which matters most for
// teams whose words are their differentiator.
//
// A kind supplies LABELS ONLY. Column ids never vary, because ids are the
// contract: BOARD_ROUTES matches on them, the agenda axis stores one per card,
// and the shared queue keys off them.
import type { WorkColumn } from "./work-items.js";

/** A source preset a work kind offers. Presentational — executors read origin/transform. */
export interface WorkKindPreset {
  id: string;
  label: string;
  cadence: "hourly" | "6h" | "nightly";
}

export interface WorkKind {
  id: string;
  label: string;
  /** Column label by column id. A missing id falls back to the template's own name. */
  columns: Record<string, string>;
  presets: WorkKindPreset[];
}

/** Skipping the question reproduces today's behaviour exactly. */
export const DEFAULT_WORK_KIND = "product";

export const WORK_KINDS: Record<string, WorkKind> = {
  product: {
    id: "product",
    label: "Product / software",
    columns: { define: "Spec", design: "Tech design", breakdown: "Decomposed", complete: "Merged" },
    presets: [
      { id: "jira", label: "Jira", cadence: "nightly" },
      { id: "releases", label: "Releases", cadence: "nightly" },
      { id: "observability", label: "Observability", cadence: "hourly" },
      { id: "support", label: "Support", cadence: "6h" },
    ],
  },
  marketing: {
    id: "marketing",
    label: "Marketing",
    columns: { define: "Brief", design: "Concept", breakdown: "Assets", complete: "Live" },
    presets: [
      { id: "campaign-metrics", label: "Campaign metrics", cadence: "hourly" },
      { id: "brand-mentions", label: "Brand mentions", cadence: "6h" },
      { id: "competitor", label: "Competitor", cadence: "nightly" },
    ],
  },
  sales: {
    id: "sales",
    label: "Sales",
    columns: { define: "Discovery", design: "Proposal", breakdown: "Terms", complete: "Closed-won" },
    presets: [
      { id: "crm", label: "CRM", cadence: "hourly" },
      { id: "inbound", label: "Inbound", cadence: "hourly" },
      { id: "pipeline", label: "Pipeline", cadence: "nightly" },
    ],
  },
  consulting: {
    id: "consulting",
    label: "Consulting",
    columns: { define: "Scope", design: "Approach", breakdown: "Work packages", complete: "Delivered" },
    presets: [{ id: "topic", label: "Topic", cadence: "nightly" }],
  },
  content: {
    id: "content",
    label: "Content",
    columns: { define: "Brief", design: "Outline", breakdown: "Sections", complete: "Published" },
    presets: [
      { id: "topic", label: "Topic", cadence: "nightly" },
      { id: "keyword", label: "Keyword", cadence: "nightly" },
      { id: "publication", label: "Publication", cadence: "6h" },
    ],
  },
  // Deliberately separate from `content`: the board words are similar, the
  // sources are not. Content is long-form through one channel; a creator runs
  // many channels at once and repurposes one idea across them.
  creator: {
    id: "creator",
    label: "Influencer / creator",
    columns: { define: "Hook", design: "Concept", breakdown: "Shot list", complete: "Posted" },
    presets: [
      { id: "youtube", label: "YouTube", cadence: "6h" },
      { id: "tiktok", label: "TikTok", cadence: "hourly" },
      { id: "instagram", label: "Instagram", cadence: "6h" },
      { id: "x", label: "X", cadence: "hourly" },
      { id: "comments", label: "Comments", cadence: "hourly" },
      { id: "trends", label: "Trends", cadence: "hourly" },
    ],
  },
  trading: {
    id: "trading",
    label: "Trading",
    columns: { define: "Thesis", design: "Sizing", breakdown: "Orders", complete: "Closed" },
    presets: [
      { id: "tickers", label: "Tickers", cadence: "hourly" },
      { id: "filings", label: "Filings", cadence: "nightly" },
      { id: "news", label: "News", cadence: "hourly" },
    ],
  },
};

/**
 * The work kind for an id, falling back to product/software.
 *
 * Never throws and never returns undefined: a vocabulary is user-editable data
 * and will eventually name a kind that no longer exists. Falling back to the
 * default is always better than seeding an empty board.
 */
export function workKindFor(id?: string): WorkKind {
  return (id && WORK_KINDS[id]) || (WORK_KINDS[DEFAULT_WORK_KIND] as WorkKind);
}

/**
 * A column's label under this work kind, falling back to the template's own name.
 *
 * Per column, so a partial vocabulary degrades exactly one cell instead of
 * breaking a board — and so columns no vocabulary renames (queue, ready, review,
 * verify, triage …) need no entry anywhere.
 */
export function columnLabel(kind: WorkKind, column: Pick<WorkColumn, "id" | "name">): string {
  return kind.columns[column.id] ?? column.name;
}

/**
 * Every preset id any work kind offers, plus `custom`.
 *
 * Derived rather than hardcoded so adding a kind adds its presets for free —
 * and still a closed set, so a typo in a stored source is caught.
 */
export function allPresetIds(): Set<string> {
  const ids = new Set<string>(["custom"]);
  for (const kind of Object.values(WORK_KINDS)) {
    for (const preset of kind.presets) ids.add(preset.id);
  }
  return ids;
}
