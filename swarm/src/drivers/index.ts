// Driver registry — the dispatcher and session manager look tools up here
// and never learn tool internals. opencode and agy drivers slot in as they
// are characterized (design §4); until then those tools remain task-run and
// steering-only.
import { ClaudeDriver } from './claude.js';
import type { ToolDriver } from './types.js';

const DRIVERS = new Map<string, ToolDriver>([['claude', new ClaudeDriver()]]);

/** Driver for a tool id, or null when the tool has no driver yet. */
export function getDriver(toolId: string): ToolDriver | null {
  return DRIVERS.get(toolId) ?? null;
}

export { ClaudeDriver, encodeProjectDir } from './claude.js';
export * from './errors.js';
export type { NormalizedMessage, ToolDriver } from './types.js';
