/**
 * Documents — blueprint-instantiated collaborative work products (spec
 * 2026-08-10). Broker-owned, persisted one JSON per doc like sessions are.
 * Phase 1 is solo editing; participants/proposals exist in the shape now so
 * phases 2-3 never migrate stored files.
 */
import { type Blueprint, instantiateSections } from "./blueprints.ts";
import { normalizeMarkdown } from "./markdown-normalize.ts";

export interface DocSection {
  id: string;
  heading: string;
  body: string;
}

export interface Proposal {
  id: string;
  sectionId: string;
  agentId: string;
  newBody: string;
  rationale: string;
  state: "open" | "accepted" | "rejected" | "stale";
  createdAt: string;
}

export interface Doc {
  id: string;
  title: string;
  blueprintId: string;
  workType: string;
  sections: DocSection[];
  participants: string[];
  proposals: Proposal[];
  /** Workspaces (group ids later) this doc is pinned to — new sessions there inherit it. Absent on older files. */
  pins?: string[];
  status: "drafting" | "review" | "final";
  createdAt: string;
  updatedAt: string;
}

export interface DocumentStoreLike {
  loadAll(): Doc[];
  save(doc: Doc): void;
}

export class DocumentManager {
  private docs = new Map<string, Doc>();
  private seq = 0;
  private proposalSeq = 0;

  constructor(
    private readonly store: DocumentStoreLike,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  init(): void {
    for (const d of this.store.loadAll()) {
      this.docs.set(d.id, d);
      this.seq = Math.max(this.seq, Number(/^d(\d+)$/.exec(d.id)?.[1] ?? 0));
      for (const p of d.proposals) {
        this.proposalSeq = Math.max(this.proposalSeq, Number(/^p(\d+)$/.exec(p.id)?.[1] ?? 0));
      }
    }
  }

  create(bp: Blueprint, workType: string, title: string): Doc | null {
    const sections = instantiateSections(bp, workType);
    if (!sections) return null;
    this.seq += 1;
    const doc: Doc = {
      id: `d${this.seq}`,
      title: title.trim() || `${bp.name} ${this.seq}`,
      blueprintId: bp.id,
      workType,
      sections,
      participants: [],
      proposals: [],
      status: "drafting",
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    this.docs.set(doc.id, doc);
    this.store.save(doc);
    return doc;
  }

  /** The shared write: normalize, stamp, persist. Both the human patch and an accepted proposal land here. */
  private applySection(doc: Doc, section: DocSection, body: string): Doc {
    section.body = normalizeMarkdown(body);
    doc.updatedAt = this.now();
    this.store.save(doc);
    return doc;
  }

  /**
   * Last-write-wins at section granularity (spec: conflict rules). A HUMAN
   * write stales every open proposal on that section — the suggestion was
   * made against text that no longer exists. acceptProposal deliberately
   * bypasses this via applySection: accepting one suggestion must not kill
   * its siblings before the human has looked at them.
   */
  patchSection(docId: string, sectionId: string, body: string): Doc | null {
    const doc = this.docs.get(docId);
    const section = doc?.sections.find((s) => s.id === sectionId);
    if (!doc || !section) return null;
    for (const p of doc.proposals) {
      if (p.sectionId === sectionId && p.state === "open") p.state = "stale";
    }
    return this.applySection(doc, section, body);
  }

  /** An agent's suggested rewrite — a sticky note, never a write. */
  addProposal(
    docId: string,
    p: { sectionId: string; agentId: string; newBody: string; rationale: string },
  ): Doc | null {
    const doc = this.docs.get(docId);
    if (!doc?.sections.some((s) => s.id === p.sectionId)) return null;
    this.proposalSeq += 1;
    doc.proposals.push({ id: `p${this.proposalSeq}`, ...p, state: "open", createdAt: this.now() });
    doc.updatedAt = this.now();
    this.store.save(doc);
    return doc;
  }

  /** Accepting applies the suggested body through the same normalize path as any write. Open proposals only. */
  acceptProposal(docId: string, proposalId: string): Doc | null {
    const doc = this.docs.get(docId);
    const p = doc?.proposals.find((x) => x.id === proposalId);
    const section = doc?.sections.find((s) => s.id === p?.sectionId);
    if (!doc || !p || !section || p.state !== "open") return null;
    p.state = "accepted";
    return this.applySection(doc, section, p.newBody);
  }

  rejectProposal(docId: string, proposalId: string): Doc | null {
    const doc = this.docs.get(docId);
    const p = doc?.proposals.find((x) => x.id === proposalId);
    if (!doc || !p || p.state !== "open") return null;
    p.state = "rejected";
    doc.updatedAt = this.now();
    this.store.save(doc);
    return doc;
  }

  /**
   * Re-cast a document under a different blueprint. Only legal while every
   * section is still empty: the blueprints share no section ids, so doing this
   * to a written document would silently destroy it. Returns null for an
   * unknown doc, an undeclared work type, or a document that already has text.
   */
  /** Rename a document. An all-whitespace title is refused — a page needs a name. */
  rename(docId: string, title: string): Doc | null {
    const doc = this.docs.get(docId);
    const clean = title.replace(/\s+/g, " ").trim();
    if (!doc || !clean) return null;
    doc.title = clean;
    doc.updatedAt = this.now();
    this.store.save(doc);
    return doc;
  }

  changeBlueprint(docId: string, bp: Blueprint, workType?: string): Doc | null {
    const doc = this.docs.get(docId);
    if (!doc) return null;
    if (doc.sections.some((s) => s.body.trim())) return null;
    const sections = instantiateSections(bp, workType ?? bp.workTypes[0] ?? "");
    if (!sections) return null;
    doc.blueprintId = bp.id;
    doc.workType = workType ?? bp.workTypes[0] ?? "";
    doc.sections = sections;
    doc.updatedAt = this.now();
    this.store.save(doc);
    return doc;
  }

  /** Pin to a workspace/group target: new sessions there inherit the doc. Idempotent. */
  pin(docId: string, target: string): Doc | null {
    const doc = this.docs.get(docId);
    if (!doc) return null;
    doc.pins = [...new Set([...(doc.pins ?? []), target])];
    doc.updatedAt = this.now();
    this.store.save(doc);
    return doc;
  }

  /** Remove a pin. Unpinning an absent target is a no-op, not an error. */
  unpin(docId: string, target: string): Doc | null {
    const doc = this.docs.get(docId);
    if (!doc) return null;
    doc.pins = (doc.pins ?? []).filter((t) => t !== target);
    doc.updatedAt = this.now();
    this.store.save(doc);
    return doc;
  }

  get(id: string): Doc | null {
    return this.docs.get(id) ?? null;
  }

  list(): Doc[] {
    return [...this.docs.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}
