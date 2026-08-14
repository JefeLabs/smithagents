/**
 * Per-turn research engine resolution (spec 2026-08-14 broker-research-engine):
 * the operator's stored CLI choice wins when it exists and passes its gate;
 * otherwise the Anthropic default. The Anthropic fallback's model is a
 * parameter, not a constant — doc-edit wants claude-sonnet-5's stronger
 * rewriting, every other research site wants claude-haiku-4-5's default
 * speed/cost. Extracted from main.ts (same shape as avatar-engine.ts's
 * resolveAvatarEngine) so that per-site model choice is unit-testable without
 * booting the whole broker.
 */
import { AnthropicResearch, CliResearch, type MessagesCreate, type ResearchEngine, type Spawner } from "./research.ts";

export interface ResearchEngineDeps {
  /** Operator's stored setting. The resolver never distinguishes "no setting"
   * from "couldn't read it" — both fall back to Anthropic — so this returns
   * null on any failure, not just an unset setting. */
  getStoredEngine(): Promise<{ cli: string; model?: string } | null>;
  /** cli id -> one-shot invocation argv, or undefined when that cli can't serve research. */
  argvFor(cli: string): string[] | undefined;
  spawn: Spawner;
  anthropicCreate: MessagesCreate;
}

export async function resolveResearchEngine(
  deps: ResearchEngineDeps,
  fallbackModel = "claude-haiku-4-5",
): Promise<ResearchEngine> {
  const chosen = await deps.getStoredEngine();
  const argv = chosen ? deps.argvFor(chosen.cli) : undefined;
  if (chosen && argv) return new CliResearch(deps.spawn, argv, chosen.model);
  return new AnthropicResearch(deps.anthropicCreate, fallbackModel);
}
