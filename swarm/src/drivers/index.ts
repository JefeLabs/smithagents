// Driver registry — the dispatcher and session manager look tools up here
// and never learn tool internals. opencode and agy drivers slot in as they
// are characterized (design §4); until then those tools remain task-run and
// steering-only.
import { AgyDriver } from './agy.js';
import { ClaudeDriver } from './claude.js';
import { CodexDriver } from './codex.js';
import { CopilotDriver } from './copilot.js';
import { OpencodeDriver } from './opencode.js';
import type { ToolDriver } from './types.js';

const DRIVERS = new Map<string, ToolDriver>([
  ['claude', new ClaudeDriver()],
  ['codex', new CodexDriver()],
  ['opencode', new OpencodeDriver()],
  ['copilot', new CopilotDriver()],
  ['agy', new AgyDriver()],
]);

/** Tool ids with a driver, for catalogs and validation. */
export function driverIds(): string[] {
  return [...DRIVERS.keys()];
}

/** Driver for a tool id, or null when the tool has no driver yet. */
export function getDriver(toolId: string): ToolDriver | null {
  return DRIVERS.get(toolId) ?? null;
}

export { AgyDriver } from './agy.js';
export { ClaudeDriver, encodeProjectDir } from './claude.js';
export { CodexDriver } from './codex.js';
export { CopilotDriver } from './copilot.js';
export { OpencodeDriver } from './opencode.js';
export * from './errors.js';
export type { NormalizedMessage, ToolDriver } from './types.js';
