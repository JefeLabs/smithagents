// The broker↔swarm seam for execution modes (spec §1): sessions speak
// ExecutionMode, swarm speaks RuntimeType, and this map is the only place
// the two vocabularies meet.
import type { ExecutionMode } from "./sessions.ts";

export const EXEC_TO_RUNTIME: Record<ExecutionMode, "tmux" | "docker" | "remote-tmux" | "remote-docker"> = {
  "local-in-process": "tmux",
  "local-docker": "docker",
  "remote-in-process": "remote-tmux",
  "remote-docker": "remote-docker",
};

export function isExecutionMode(v: unknown): v is ExecutionMode {
  return typeof v === "string" && v in EXEC_TO_RUNTIME;
}
