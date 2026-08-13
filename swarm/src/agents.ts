// Composed-agent registry — the swarm owns agent identity as data.
// One JSON file per agent under .smith/agents/. Replaces the old anonymous
// name pool + hardcoded squad rosters (see the v1 design spec).
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Gender, Reactions } from "./personas.js";

/**
 * Two execution kinds (api-runtime spec 2026-08-13): `cli` — the hands,
 * tmux/Docker sessions on subscription CLIs; `api` — the thinkers, turns run
 * through a provider API. Absent `kind` = "cli", so every agent file written
 * before kinds existed stays valid untouched.
 */
export interface AgentEngine {
  kind?: "cli" | "api";
  /** Required when kind is "cli" (or absent). */
  cli?: "agy" | "claude" | "codex" | "opencode" | "copilot";
  /** Required when kind is "api". */
  provider?: "anthropic";
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
  /** Portrait filename under .smith/avatars/ (assets/avatars/ for presets). */
  avatar?: string;
  /** Legacy array (listed = designated) or a per-surface mode map (`{tauri: 'autojoin', ...}`); broker enforces semantics, swarm just persists. */
  channels?: string[] | Record<string, string>;
  /** Stereotype the persona was seeded from (wizard provenance). */
  stereotype?: string;
  /** Job role picked in the wizard — kept so editing can restore the choice. */
  jobRole?: string;
  gender?: Gender;
  /** Free-text history that colors how they talk about their work. */
  backstory?: string;
  /** Primary language they speak in meetings (see personas.LANGUAGES). */
  language?: string;
  /** What they say across the agreement spectrum — pre-synthesized for instant playback. */
  reactions?: Partial<Reactions>;
  /** Answers to the getting-to-know-you questions, cached as audio. */
  quickAnswers?: Record<string, string>;
  /** Archived in place: hidden from roster/delegation, kept for history. */
  archived?: boolean;
}

function assertAgent(file: string, v: unknown): ComposedAgent {
  const o = v as Record<string, unknown>;
  const engine = o.engine as Record<string, unknown> | undefined;
  const base =
    o &&
    typeof o.id === "string" &&
    typeof o.name === "string" &&
    typeof o.role === "string" &&
    typeof o.directives === "string" &&
    engine &&
    typeof engine.model === "string";
  // The kind fork (api-runtime spec 2026-08-13): api needs a provider, cli
  // (and every pre-kind file, where `kind` is absent) needs a cli.
  const kindOk =
    engine &&
    (engine.kind === "api" ? typeof engine.provider === "string" : typeof engine.cli === "string");
  if (!base || !kindOk) {
    throw new Error(
      `Invalid composed-agent file ${file}: requires id, name, role, directives, engine{cli,model} or engine{kind:"api",provider,model}`,
    );
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
  const files = entries.filter((f) => f.endsWith(".json"));
  const agents: ComposedAgent[] = [];
  for (const file of files) {
    const raw = await readFile(join(dir, file), "utf8");
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

/** Agents visible to the roster, catalog, and delegation. */
export function activeAgents(agents: ComposedAgent[]): ComposedAgent[] {
  return agents.filter((a) => !a.archived);
}
