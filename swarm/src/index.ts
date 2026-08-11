// ---------------------------------------------------------------------------
// @smith/orchestrator — Public API barrel export
// ---------------------------------------------------------------------------

export type { AgentEngine, AgentVoice, ComposedAgent } from "./agents.js";
// Composed-agent registry
export { findAgent, loadAgents } from "./agents.js";
export { loadConfig } from "./config.js";
export { Dispatcher } from "./dispatcher.js";
export type { Meeting, MeetingJoin } from "./meetings.js";
// Meetings
export { MeetingOrchestrator } from "./meetings.js";
export type { AgentName } from "./names.js";
export {
  AGENT_ROSTER,
  AgentNamePool,
  generateAgentName,
  parseAgentName,
} from "./names.js";
export { QuarantineManager } from "./quarantine.js";

// Remote execution
export { RemoteRuntime, WorkerPool } from "./remote-runtime.js";
export * from "./remote-types.js";
export type { RuntimeAdapter } from "./runtime.js";
// Re-export TmuxSessionManager as a backwards-compatible alias
export { createRuntime, DockerRuntime, TmuxRuntime, TmuxRuntime as TmuxSessionManager } from "./runtime.js";
export type { ServerConfig } from "./server.js";
export { OrchestratorServer } from "./server.js";
export type {
  AgentOutputContract,
  ComplianceResult,
  ComplianceViolation,
  PermissionGrant,
  SquadDefinition,
  SquadId,
  SquadManifest,
  SquadMember,
  SquadMode,
  SquadModel,
  SquadRole,
} from "./squads.js";
// Squads
export {
  buildPermissionGrant,
  buildSquadLaunchScript,
  DEFAULT_ROLE_PERMISSIONS,
  formatPermissionBlock,
  getOutputFilename,
  SQUAD_MEMBERS,
  SQUAD_ROSTER,
  SquadPool,
  validateCompliance,
} from "./squads.js";
export * from "./types.js";
export { SmithWorker, startWorker } from "./worker.js";
