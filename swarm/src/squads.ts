export type SquadId = "alpha" | "beta" | "gamma";
export type SquadRole = "leader" | "architect" | "senior" | "developer";
export type SquadModel = "gemini-pro" | "claude-fable" | "claude-opus" | "claude-sonnet";
export type SquadMode = "solo" | "squad" | "council";

export interface SquadMember {
  name: string; // 3-syllable voice name
  pane: number; // 1-4 (0 reserved for human in council)
  model: SquadModel;
  role: SquadRole;
  squad: SquadId;
}

export interface SquadDefinition {
  id: SquadId;
  members: [SquadMember, SquadMember, SquadMember, SquadMember]; // exactly 4
  leader: SquadMember; // convenience ref to pane 1
}

export interface SquadManifest {
  squadId: SquadId;
  mode: SquadMode; // solo=1 agent, squad=2-4, council=2-4+human
  taskId: string;
  prompt: string;
  agents: SquadMember[]; // which members are active (1-4)
  sessionName: string; // tmux session name
  containerName?: string; // docker container name
  createdAt: string;
  status: "queued" | "dispatched" | "running" | "completed" | "failed";
}

// JSON output contract - what sub-agents write to disk
export interface AgentOutputContract {
  agent: string; // name
  role: string; // role
  status: "SUCCESS" | "FAILED";
  exitCode: number;
  summary: string;
  changes: {
    modifiedFiles: string[];
    createdFiles: string[];
  };
  verification: {
    command: string;
    passed: boolean;
    details: string;
  };
  error: string | null;
}

// ---------------------------------------------------------------------------
// Permission Grants — leader → sub-agent authorization
// ---------------------------------------------------------------------------

/**
 * Permission grant — what a sub-agent is allowed to do.
 *
 * The leader writes this to `.smith/permissions/<agent>.json` before
 * delegating, and injects a human-readable summary into the agent's
 * prompt via `tmux send-keys`.
 *
 * Enforcement is contractual (prompt-based) + auditable (output contract
 * lists actual file changes for post-hoc compliance checking).
 */
export interface PermissionGrant {
  /** Agent receiving the grant */
  agent: string;
  /** Who granted it (the leader) */
  grantedBy: string;
  /** Squad this grant belongs to */
  squad: SquadId;
  /** Task ID this grant is scoped to */
  taskId: string;
  /** What the agent is allowed to do */
  permissions: {
    /** Glob patterns for writable paths: ["src/components/**", "tests/**"] */
    write: string[];
    /** Glob patterns for readable paths: ["src/**", "package.json"] */
    read: string[];
    /** Allowed shell commands: ["pnpm test", "pnpm biome check"] */
    exec: string[];
    /** Explicitly blocked operations: ["git push", "rm -rf"] */
    deny: string[];
  };
  /** Human-readable scope description */
  scope: string;
  /** Grant dies when the task completes */
  expiresWithTask: boolean;
  /** ISO timestamp */
  grantedAt: string;
}

/**
 * Compliance result — did the agent stay within its permissions?
 */
export interface ComplianceResult {
  agent: string;
  compliant: boolean;
  violations: ComplianceViolation[];
}

export interface ComplianceViolation {
  type: "unauthorized_write" | "unauthorized_exec" | "denied_operation";
  detail: string;
  file?: string;
  command?: string;
}

/**
 * Default permission scopes per role.
 *
 * The leader can override these, but these are sensible starting points
 * so the leader doesn't have to specify everything from scratch.
 */
export const DEFAULT_ROLE_PERMISSIONS: Record<SquadRole, PermissionGrant["permissions"]> = {
  leader: {
    write: ["**"],
    read: ["**"],
    exec: ["*"],
    deny: [],
  },
  architect: {
    write: ["docs/**", "src/**/*.ts", "package.json", "tsconfig*.json", ".smith/**"],
    read: ["**"],
    exec: ["pnpm typecheck", "pnpm biome check", "git log", "git diff", "git status"],
    deny: ["git push", "git merge", "rm -rf"],
  },
  senior: {
    write: ["src/**", "tests/**", "package.json"],
    read: ["**"],
    exec: ["pnpm test", "pnpm typecheck", "pnpm biome check", "pnpm build", "git add", "git commit"],
    deny: ["git push", "git merge", "git rebase", "rm -rf"],
  },
  developer: {
    write: ["src/components/**", "src/views/**", "tests/**", "tests/e2e/**"],
    read: ["src/**", "tests/**", "package.json", "tsconfig*.json"],
    exec: ["pnpm test", "pnpm biome check", "pnpm playwright test"],
    deny: ["git push", "git merge", "git rebase", "rm -rf", "pnpm build"],
  },
};

/**
 * Build a permission grant for a specific agent.
 *
 * The leader calls this before delegating. It uses role defaults
 * and allows overrides for task-specific scoping.
 */
export function buildPermissionGrant(
  agent: SquadMember,
  leader: SquadMember,
  taskId: string,
  scope: string,
  overrides?: Partial<PermissionGrant["permissions"]>,
): PermissionGrant {
  const defaults = DEFAULT_ROLE_PERMISSIONS[agent.role];
  return {
    agent: agent.name,
    grantedBy: leader.name,
    squad: agent.squad,
    taskId,
    permissions: {
      write: overrides?.write ?? defaults.write,
      read: overrides?.read ?? defaults.read,
      exec: overrides?.exec ?? defaults.exec,
      deny: overrides?.deny ?? defaults.deny,
    },
    scope,
    expiresWithTask: true,
    grantedAt: new Date().toISOString(),
  };
}

/**
 * Format a permission grant as a human-readable block for prompt injection.
 *
 * This is what gets sent via `tmux send-keys` to the sub-agent's pane.
 * The agent reads this as part of its initial prompt and must comply.
 */
export function formatPermissionBlock(grant: PermissionGrant): string {
  const lines: string[] = [];
  lines.push(`=== PERMISSION GRANT ===`);
  lines.push(`Agent: ${grant.agent}`);
  lines.push(`Granted by: ${grant.grantedBy} (Squad Leader)`);
  lines.push(`Scope: ${grant.scope}`);
  lines.push(``);
  lines.push(`WRITE (allowed file paths):`);
  for (const p of grant.permissions.write) lines.push(`  ✓ ${p}`);
  lines.push(``);
  lines.push(`READ (allowed file paths):`);
  for (const p of grant.permissions.read) lines.push(`  ✓ ${p}`);
  lines.push(``);
  lines.push(`EXEC (allowed commands):`);
  for (const p of grant.permissions.exec) lines.push(`  ✓ ${p}`);
  if (grant.permissions.deny.length > 0) {
    lines.push(``);
    lines.push(`DENY (explicitly forbidden):`);
    for (const p of grant.permissions.deny) lines.push(`  ✗ ${p}`);
  }
  lines.push(``);
  lines.push(`Output your result to: ${getOutputFilename(grant.agent.toLowerCase())}`);
  lines.push(`You MUST stay within these permissions. Violations will be audited.`);
  lines.push(`=== END GRANT ===`);
  return lines.join("\n");
}

/**
 * Validate an agent's output contract against its permission grant.
 *
 * Called by the leader (or orchestrator) after the agent writes its
 * JSON output contract. Checks that modified/created files match
 * the write permissions.
 */
export function validateCompliance(grant: PermissionGrant, output: AgentOutputContract): ComplianceResult {
  const violations: ComplianceViolation[] = [];

  // Check modified files against write permissions
  for (const file of output.changes.modifiedFiles) {
    if (!matchesAnyGlob(file, grant.permissions.write)) {
      violations.push({
        type: "unauthorized_write",
        detail: `Modified file not covered by write permissions`,
        file,
      });
    }
  }

  // Check created files against write permissions
  for (const file of output.changes.createdFiles) {
    if (!matchesAnyGlob(file, grant.permissions.write)) {
      violations.push({
        type: "unauthorized_write",
        detail: `Created file not covered by write permissions`,
        file,
      });
    }
  }

  // Check verification command against exec permissions
  if (output.verification.command) {
    if (!matchesAnyGlob(output.verification.command, grant.permissions.exec)) {
      violations.push({
        type: "unauthorized_exec",
        detail: `Executed command not in allowed exec list`,
        command: output.verification.command,
      });
    }
  }

  return {
    agent: grant.agent,
    compliant: violations.length === 0,
    violations,
  };
}

/**
 * Simple glob matching — checks if a path matches any of the patterns.
 *
 * Supports:
 *   - `**` matches everything
 *   - `*` matches any single segment
 *   - `dir/**` matches anything under dir/
 *   - Exact matches
 */
function matchesAnyGlob(path: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (pattern === "**" || pattern === "*") return true;
    if (pattern === path) return true;
    if (pattern.endsWith("/**")) {
      const prefix = pattern.slice(0, -3);
      if (path.startsWith(`${prefix}/`) || path === prefix) return true;
    }
    if (pattern.endsWith("/*")) {
      const prefix = pattern.slice(0, -2);
      if (path.startsWith(`${prefix}/`) && !path.slice(prefix.length + 1).includes("/")) return true;
    }
    // Simple wildcard in filename: src/**/*.ts
    if (pattern.includes("*")) {
      const regex = new RegExp(`^${pattern.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*")}$`);
      if (regex.test(path)) return true;
    }
  }
  return false;
}

// The twelve — a Latino crew out of the Dominican Republic. Naming convention
// kept: initial encodes role (G=leader, F=architect, O=senior, S=developer),
// three syllables each for clean TTS.
export const SQUAD_MEMBERS: SquadMember[] = [
  { name: "Gabriel", pane: 1, model: "gemini-pro", role: "leader", squad: "alpha" },
  { name: "Fabian", pane: 2, model: "claude-fable", role: "architect", squad: "alpha" },
  { name: "Osvaldo", pane: 3, model: "claude-opus", role: "senior", squad: "alpha" },
  { name: "Santiago", pane: 4, model: "claude-sonnet", role: "developer", squad: "alpha" },

  { name: "Gustavo", pane: 1, model: "gemini-pro", role: "leader", squad: "beta" },
  { name: "Fernando", pane: 2, model: "claude-fable", role: "architect", squad: "beta" },
  { name: "Orlando", pane: 3, model: "claude-opus", role: "senior", squad: "beta" },
  { name: "Sebastian", pane: 4, model: "claude-sonnet", role: "developer", squad: "beta" },

  { name: "Graciela", pane: 1, model: "gemini-pro", role: "leader", squad: "gamma" },
  { name: "Francisca", pane: 2, model: "claude-fable", role: "architect", squad: "gamma" },
  { name: "Ofelia", pane: 3, model: "claude-opus", role: "senior", squad: "gamma" },
  { name: "Soledad", pane: 4, model: "claude-sonnet", role: "developer", squad: "gamma" },
];

/**
 * The live squad roster. Seeded from the defaults below on first boot, then
 * owned by `.smith/squads/*.json` — squads are DATA, like agents: editable,
 * deletable, and cleared by a settings reset. Mutated in place by
 * setSquadRoster so existing holders of this array see the change.
 */
/** Slice one squad out of SQUAD_MEMBERS, refusing to boot on a malformed table. */
function defaultSquad(id: SquadId): SquadDefinition {
  const members = SQUAD_MEMBERS.filter((m) => m.squad === id);
  const leader = members.find((m) => m.role === "leader");
  if (members.length !== 4 || !leader) {
    throw new Error(
      `SQUAD_MEMBERS is malformed for squad "${id}": ${members.length} members (expected 4), leader ${leader ? "present" : "missing"}`,
    );
  }
  return { id, members: members as [SquadMember, SquadMember, SquadMember, SquadMember], leader };
}

export const SQUAD_ROSTER: SquadDefinition[] = [defaultSquad("alpha"), defaultSquad("beta"), defaultSquad("gamma")];

/** Replace the live roster in place (boot-time load, reset). */
export function setSquadRoster(defs: SquadDefinition[]): void {
  SQUAD_ROSTER.length = 0;
  SQUAD_ROSTER.push(...defs);
}

/** Serializable form of a squad — what a .smith/squads/*.json file holds. */
export interface SquadFile {
  id: string;
  members: Array<{ name: string; pane: number; model: SquadModel; role: SquadRole }>;
}

function toDefinition(file: SquadFile): SquadDefinition {
  const members = file.members.map((m) => ({ ...m, squad: file.id as SquadId })) as SquadDefinition["members"];
  const leader = members.find((m) => m.role === "leader") ?? members[0];
  return { id: file.id as SquadId, members, leader };
}

/**
 * Load squads from `dir`. On first ever boot the directory does not exist:
 * seed it with the built-in roster so it is visible and editable on disk.
 * An existing but EMPTY directory means "no squads" — that is a valid state
 * (e.g. after a settings reset), never a reason to resurrect the defaults.
 */
export async function loadSquadsFromDir(dir: string): Promise<SquadDefinition[]> {
  const { readdir, readFile, mkdir, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    await mkdir(dir, { recursive: true });
    for (const squad of SQUAD_ROSTER) {
      const file: SquadFile = {
        id: squad.id,
        members: squad.members.map((m) => ({ name: m.name, pane: m.pane, model: m.model, role: m.role })),
      };
      await writeFile(join(dir, `${squad.id}.json`), JSON.stringify(file, null, 2));
    }
    return [...SQUAD_ROSTER];
  }
  const defs: SquadDefinition[] = [];
  for (const entry of entries.filter((f) => f.endsWith(".json"))) {
    const raw = await readFile(join(dir, entry), "utf8");
    const parsed = JSON.parse(raw) as SquadFile;
    if (!parsed.id || !Array.isArray(parsed.members) || parsed.members.length === 0) {
      throw new Error(`Invalid squad file ${entry}: requires id and a non-empty members[]`);
    }
    defs.push(toDefinition(parsed));
  }
  return defs;
}

export class SquadPool {
  private activeAssignments = new Map<SquadId, string>();

  /**
   * Claim the first free squad, or `squadId` when the caller has already
   * picked one. The named form assigns unconditionally — callers that care
   * whether it was free must check `isActive` first.
   */
  claim(taskId: string, squadId?: SquadId): SquadId | null {
    if (squadId) {
      this.activeAssignments.set(squadId, taskId);
      return squadId;
    }
    for (const squad of SQUAD_ROSTER) {
      if (!this.activeAssignments.has(squad.id)) {
        this.activeAssignments.set(squad.id, taskId);
        return squad.id;
      }
    }
    return null;
  }

  release(squadId: SquadId): void {
    this.activeAssignments.delete(squadId);
  }

  resolve(nameOrId: string): SquadId | null {
    const lower = nameOrId.toLowerCase();
    const byId = SQUAD_ROSTER.find((s) => s.id === lower);
    if (byId) return byId.id;

    const byName = SQUAD_MEMBERS.find((m) => m.name.toLowerCase() === lower);
    if (byName) return byName.squad;

    return null;
  }

  getSquad(squadId: SquadId): SquadDefinition {
    const squad = SQUAD_ROSTER.find((s) => s.id === squadId);
    if (!squad) throw new Error(`Squad ${squadId} not found`);
    return squad;
  }

  getMemberByName(name: string): SquadMember | undefined {
    return SQUAD_MEMBERS.find((m) => m.name.toLowerCase() === name.toLowerCase());
  }

  list(): Array<{ squadId: SquadId; taskId: string }> {
    return Array.from(this.activeAssignments.entries()).map(([squadId, taskId]) => ({
      squadId,
      taskId,
    }));
  }

  available(): SquadId[] {
    return SQUAD_ROSTER.filter((s) => !this.activeAssignments.has(s.id)).map((s) => s.id);
  }

  isActive(squadId: SquadId): boolean {
    return this.activeAssignments.has(squadId);
  }
}

export function getOutputFilename(agentName: string): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");

  return `${year}-${month}${day}-${hours}:${minutes}.${agentName}.json`;
}

/**
 * Build the launch script for a squad.
 *
 * In squad mode:
 *   1. Creates a tmux session with N panes
 *   2. Writes permission grants to `.smith/permissions/<agent>.json`
 *   3. Starts each agent CLI in its pane
 *   4. Sends the full prompt ONLY to the leader pane
 *   5. The leader's prompt includes instructions to delegate with permissions
 */
export function buildSquadLaunchScript(manifest: SquadManifest): string {
  const { sessionName, agents, prompt } = manifest;

  if (agents.length === 0) {
    return `echo "No agents to launch in squad"`;
  }

  const leader = agents.find((a) => a.role === "leader") ?? agents[0];
  const subAgents = agents.filter((a) => a.name !== leader.name);
  const lines: string[] = [];

  lines.push(`#!/bin/bash`);
  lines.push(`set -e`);
  lines.push(``);
  lines.push(`# --- Squad ${manifest.squadId} Launch Script ---`);
  lines.push(`# Leader: ${leader.name} (${leader.model})`);
  lines.push(`# Members: ${agents.map((a) => a.name).join(", ")}`);
  lines.push(``);

  // Create permissions directory
  lines.push(`mkdir -p .smith/permissions`);
  lines.push(``);

  // Write permission grants for each sub-agent
  for (const agent of subAgents) {
    const defaults = DEFAULT_ROLE_PERMISSIONS[agent.role];
    const grantJson = JSON.stringify(
      {
        agent: agent.name,
        grantedBy: leader.name,
        squad: manifest.squadId,
        taskId: manifest.taskId,
        permissions: defaults,
        scope: prompt.substring(0, 200),
        expiresWithTask: true,
        grantedAt: new Date().toISOString(),
      } satisfies PermissionGrant,
      null,
      2,
    );

    lines.push(`cat > .smith/permissions/${agent.name.toLowerCase()}.json << 'PERM_EOF'`);
    lines.push(grantJson);
    lines.push(`PERM_EOF`);
    lines.push(``);
  }

  // Create tmux session
  lines.push(`tmux new-session -d -s ${sessionName}`);

  // Create panes
  for (let i = 1; i < agents.length; i++) {
    lines.push(`tmux split-window -t ${sessionName}`);
    lines.push(`tmux select-layout -t ${sessionName} tiled`);
  }
  lines.push(``);

  // Start CLI in each pane
  agents.forEach((agent, index) => {
    const paneIndex = index;
    const startCmd = `agent-cli --name ${agent.name} --model ${agent.model}`;
    lines.push(`tmux send-keys -t ${sessionName}.${paneIndex} "${startCmd}" C-m`);
  });
  lines.push(``);

  // Send prompt ONLY to the leader — includes delegation instructions
  const leaderIndex = agents.indexOf(leader);
  const escapedPrompt = prompt.replace(/'/g, "'\\''");

  // Build the leader's full prompt with delegation context
  const leaderPrompt = [
    escapedPrompt,
    "",
    "---",
    `You are ${leader.name}, the Squad Leader for Squad ${manifest.squadId.toUpperCase()}.`,
    `You have ${subAgents.length} sub-agent(s) available in this tmux session:`,
    ...subAgents.map((a) => `  - ${a.name} (${a.role}, pane ${agents.indexOf(a)}, ${a.model})`),
    "",
    "DELEGATION PROTOCOL:",
    "1. Plan the work breakdown for your team",
    "2. Permission grants are pre-written at .smith/permissions/<name>.json",
    `3. Delegate to each agent via: tmux send-keys -t ${sessionName}.<pane> -l "<prompt>"`,
    "4. Include the permission block from their grant file in your delegation prompt",
    `5. Monitor their output JSON files: ${subAgents.map((a) => getOutputFilename(a.name.toLowerCase())).join(", ")}`,
    "6. Validate compliance: each agent must only modify files within their write permissions",
    "7. On success: compile results and exit 0",
    "8. On unrecoverable failure: exit 1 (quarantine)",
  ].join("\\n");

  lines.push(`# Send prompt to leader only`);
  lines.push(`tmux send-keys -t ${sessionName}.${leaderIndex} $'${leaderPrompt}' C-m`);
  lines.push(``);
  lines.push(`tmux attach-session -t ${sessionName}`);

  return lines.join("\n");
}
