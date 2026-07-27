// Composed-agent registry — the swarm owns agent identity as data.
// One JSON file per agent under .smith/agents/. Replaces the old anonymous
// name pool + hardcoded squad rosters (see the v1 design spec).
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Gender, Reactions } from './personas.js';

export interface AgentEngine {
  cli: 'agy' | 'claude' | 'codex' | 'opencode' | 'copilot';
  model: string;
}

export interface AgentVoice {
  provider: string;
  voiceId?: string;
  /** Web Speech profile for text-channel UIs: named system voice + delivery. */
  speech?: { voiceName?: string; lang?: string; pitch?: number; rate?: number };
}

/** Communication-style profile — shapes how the agent talks, not what it owns. */
export interface AgentPersona {
  style: string;
}

export interface ComposedAgent {
  id: string;
  name: string;
  role: string;
  directives: string;
  engine: AgentEngine;
  persona?: AgentPersona;
  voice?: AgentVoice;
  avatarRing?: string;
  channels?: string[];
  /** Stereotype the persona was seeded from (wizard provenance). */
  stereotype?: string;
  gender?: Gender;
  /** Free-text history that colors how they talk about their work. */
  backstory?: string;
  /** What they say across the agreement spectrum — pre-synthesized for instant playback. */
  reactions?: Partial<Reactions>;
  /** Answers to the getting-to-know-you questions, cached as audio. */
  quickAnswers?: Record<string, string>;
}

function assertAgent(file: string, v: unknown): ComposedAgent {
  const o = v as Record<string, unknown>;
  const engine = o.engine as Record<string, unknown> | undefined;
  const ok =
    o &&
    typeof o.id === 'string' &&
    typeof o.name === 'string' &&
    typeof o.role === 'string' &&
    typeof o.directives === 'string' &&
    engine &&
    typeof engine.cli === 'string' &&
    typeof engine.model === 'string';
  if (!ok) {
    throw new Error(`Invalid composed-agent file ${file}: requires id, name, role, directives, engine{cli,model}`);
  }
  return o as unknown as ComposedAgent;
}

/** Load every *.json in `dir` as a ComposedAgent. Throws (naming the file) on malformed input. */
export async function loadAgents(dir: string): Promise<ComposedAgent[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const files = entries.filter((f) => f.endsWith('.json'));
  const agents: ComposedAgent[] = [];
  for (const file of files) {
    const raw = await readFile(join(dir, file), 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error(`Invalid JSON in composed-agent file ${file}: ${(e as Error).message}`);
    }
    agents.push(assertAgent(file, parsed));
  }
  return agents;
}

/** Write one composed agent to `dir`. Used by the creation wizard. */
export async function saveAgent(dir: string, agent: ComposedAgent): Promise<void> {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(agent.id)) {
    throw new Error(`Invalid agent id "${agent.id}": use lowercase letters, digits and dashes`);
  }
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${agent.id}.json`), `${JSON.stringify(agent, null, 2)}\n`);
}

/** Resolve an agent by id (preferred) or name, case-insensitive. */
export function findAgent(agents: ComposedAgent[], nameOrId: string): ComposedAgent | undefined {
  const q = nameOrId.trim().toLowerCase();
  return agents.find((a) => a.id.toLowerCase() === q) ?? agents.find((a) => a.name.toLowerCase() === q);
}
