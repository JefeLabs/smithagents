/**
 * Blueprints — data-driven document schemas (spec 2026-08-10, "personas
 * principle": config, never a hardcoded enum). Packaged defaults merge with
 * user files by id; `when` conditions activate sections per work type.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface BlueprintSection {
  id: string;
  heading: string;
  /** Author guidance shown as the empty-section placeholder. */
  hint?: string;
  /** Absent = always present. */
  when?: { workType: string[] };
  required?: boolean;
}

export interface Blueprint {
  id: string;
  name: string;
  workTypes: string[];
  sections: BlueprintSection[];
}

const DEFAULT_BLUEPRINTS: Blueprint[] = [
  {
    id: 'spec',
    name: 'Design Spec',
    workTypes: ['feature', 'bugfix', 'integration'],
    sections: [
      { id: 'overview', heading: 'What this is', hint: 'Two paragraphs, plain language.', required: true },
      { id: 'repro', heading: 'Reproduction', hint: 'Exact steps, expected vs actual.', when: { workType: ['bugfix'] } },
      { id: 'ui-refs', heading: 'Design refs', hint: 'Links or descriptions of the target look.', when: { workType: ['feature'] } },
      { id: 'contracts', heading: 'External contracts', hint: 'APIs, events, schemas this touches.', when: { workType: ['integration'] } },
      { id: 'approach', heading: 'Approach', hint: 'How it works, at the level a reviewer needs.' },
      { id: 'non-goals', heading: 'Non-goals', hint: 'What this deliberately does not do.', required: true },
      { id: 'testing', heading: 'Testing', hint: 'How we will know it works.' },
    ],
  },
  {
    id: 'implementation-plan',
    name: 'Implementation Plan',
    workTypes: ['feature', 'bugfix', 'integration'],
    sections: [
      { id: 'goal', heading: 'Goal', hint: 'One sentence.', required: true },
      { id: 'constraints', heading: 'Global constraints', hint: 'What binds every task.' },
      { id: 'tasks', heading: 'Tasks', hint: 'Bite-sized, each with its own test cycle.', required: true },
      { id: 'risks', heading: 'Risks', hint: 'What could go sideways and the early signal for each.' },
      { id: 'verification', heading: 'Verification', hint: 'The gates that must be green before merge.' },
    ],
  },
];

/** Defaults merged with user files (by id, user wins); malformed files are skipped. */
export function loadBlueprints(dir: string = process.env.BROKER_BLUEPRINTS_DIR ?? '.smith/blueprints'): Blueprint[] {
  const byId = new Map<string, Blueprint>(DEFAULT_BLUEPRINTS.map((b) => [b.id, b]));
  try {
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      try {
        const bp = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Blueprint;
        if (typeof bp.id === 'string' && Array.isArray(bp.sections) && Array.isArray(bp.workTypes)) {
          byId.set(bp.id, bp);
        }
      } catch {
        /* skip malformed file; defaults must survive a bad user edit */
      }
    }
  } catch {
    /* no user dir — defaults only */
  }
  return [...byId.values()];
}

/** Sections active for a work type, with empty bodies; null = workType not declared by the blueprint. */
export function instantiateSections(
  bp: Blueprint,
  workType: string,
): Array<{ id: string; heading: string; body: string }> | null {
  if (!bp.workTypes.includes(workType)) return null;
  return bp.sections
    .filter((s) => !s.when || s.when.workType.includes(workType))
    .map((s) => ({ id: s.id, heading: s.heading, body: '' }));
}
