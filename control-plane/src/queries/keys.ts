/**
 * Every query key in the app. Centralised so an invalidation in the socket
 * store and a read in a component can never drift apart.
 */
export const qk = {
  session: ["session"] as const,
  sessions: ["sessions"] as const,
  workspaces: ["workspaces"] as const,
  transcript: ["transcript"] as const,
  roster: ["roster"] as const,
  agentRecords: ["agent-records"] as const,
  workspaceRecords: ["workspace-records"] as const,
  workspaceChannels: (name: string) => ["workspace-channels", name] as const,
  connectorVendors: ["connector-vendors"] as const,
  myConnectors: ["my-connectors"] as const,
  cliTools: ["cli-tools"] as const,
  apiKeys: ["api-keys"] as const,
  containers: ["containers"] as const,
  voiceSettings: ["voice-settings"] as const,
  me: ["me"] as const,
  executionModes: ["execution-modes"] as const,
  activity: (name: string) => ["activity", name] as const,
  board: (id: string) => ["board", id] as const,
  boards: ["boards"] as const,
  capability: (id: string) => ["capability", id] as const,
  capabilities: ["capabilities"] as const,
};
