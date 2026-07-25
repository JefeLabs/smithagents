// ---------------------------------------------------------------------------
// @smith/orchestrator — Public API barrel export
// ---------------------------------------------------------------------------

export { Dispatcher } from './dispatcher.js';
export { TmuxRuntime, DockerRuntime, createRuntime } from './runtime.js';
export type { RuntimeAdapter } from './runtime.js';
export { OrchestratorServer } from './server.js';
export type { ServerConfig } from './server.js';
export { QuarantineManager } from './quarantine.js';
export { loadConfig } from './config.js';
export {
  loadProjectConfig,
  loadProjectsFromDir,
  detectCurrentProject,
  resolveManifest,
  interpolatePattern,
} from './project.js';
export {
  AgentNamePool,
  AGENT_ROSTER,
  generateAgentName,
  parseAgentName,
} from './names.js';
export type { AgentName } from './names.js';

// Remote execution
export { RemoteRuntime, WorkerPool } from './remote-runtime.js';
export { SmithWorker, startWorker } from './worker.js';
export * from './remote-types.js';

// Squads
export {
  SquadPool,
  SQUAD_ROSTER,
  SQUAD_MEMBERS,
  DEFAULT_ROLE_PERMISSIONS,
  buildSquadLaunchScript,
  buildPermissionGrant,
  formatPermissionBlock,
  validateCompliance,
  getOutputFilename,
} from './squads.js';
export type {
  SquadId,
  SquadRole,
  SquadModel,
  SquadMode,
  SquadMember,
  SquadDefinition,
  SquadManifest,
  AgentOutputContract,
  PermissionGrant,
  ComplianceResult,
  ComplianceViolation,
} from './squads.js';

export * from './types.js';

// Re-export TmuxSessionManager as a backwards-compatible alias
export { TmuxRuntime as TmuxSessionManager } from './runtime.js';
