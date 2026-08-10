/**
 * Documents — blueprint-instantiated collaborative work products (spec
 * 2026-08-10). Broker-owned, persisted one JSON per doc like sessions are.
 * Phase 1 is solo editing; participants/proposals exist in the shape now so
 * phases 2-3 never migrate stored files.
 */
import { type Blueprint, instantiateSections } from './blueprints.ts';

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
  state: 'open' | 'accepted' | 'rejected' | 'stale';
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
  status: 'drafting' | 'review' | 'final';
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

  constructor(
    private readonly store: DocumentStoreLike,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  init(): void {
    for (const d of this.store.loadAll()) {
      this.docs.set(d.id, d);
      this.seq = Math.max(this.seq, Number(/^d(\d+)$/.exec(d.id)?.[1] ?? 0));
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
      status: 'drafting',
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    this.docs.set(doc.id, doc);
    this.store.save(doc);
    return doc;
  }

  /** Last-write-wins at section granularity (spec: conflict rules). */
  patchSection(docId: string, sectionId: string, body: string): Doc | null {
    const doc = this.docs.get(docId);
    const section = doc?.sections.find((s) => s.id === sectionId);
    if (!doc || !section) return null;
    section.body = body;
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
