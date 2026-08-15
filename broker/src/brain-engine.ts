/**
 * Per-turn brain engine resolution — the sibling of research-engine.ts, for
 * the conversational brain rather than tool-free research calls. Picks the
 * no-key-first order the product wants: a stored `local` setting, then a
 * stored `cli` whose argv resolves, then a stored `api` choice, then — with
 * nothing usable stored — the env fallback that keeps every existing install
 * behaving exactly as it does today.
 *
 * local-brain.ts and cli-brain.ts bind their model at CONSTRUCTION
 * (`deps.model`) and deliberately ignore the per-call `params.model` that
 * brain.ts always sets; gemini-brain.ts has no model dep and reads
 * `params.model` instead. So the resolved model has to be routed
 * differently depending on which kind won: into the factory's deps for
 * local/cli, or as an override of `params.model` for gemini/anthropic (see
 * `withModel`). Getting this wrong doesn't error — it silently runs the
 * wrong model.
 */
import type { StreamFactory } from "./brain.ts";
import { createCliStreamFactory } from "./cli-brain.ts";
import { createGeminiStreamFactory } from "./gemini-brain.ts";
import { createLocalStreamFactory } from "./local-brain.ts";
import type { Spawner } from "./research.ts";
import type { BrainEngine } from "./swarm-client.ts";

export type { BrainEngine };

export interface BrainEngineDeps {
  /** Operator's stored setting (swarm's `/me/brain-engine`), re-read on every
   * turn by resolvingStreamFactory so a change needs no broker restart. */
  getStoredEngine(): Promise<BrainEngine | null>;
  /** cli id -> one-shot invocation argv, or undefined when that cli can't serve as a brain. */
  argvFor(cli: string): string[] | undefined;
  /** The `cli` kind cannot run without a spawner — always required, never optional. */
  spawn: Spawner;
  /** SMITH_BRAIN_PROVIDER — consulted only when there is no usable stored setting. */
  envProvider?: string;
  /** The env-configured model paired with envProvider, same fallback-only scope. */
  envModel?: string;
  geminiApiKey?: string;
  /** Builds the Anthropic SDK StreamFactory. A thunk so it is only constructed
   * when the fallback actually needs it, not on every resolution. */
  anthropicFactory(): StreamFactory;
}

/**
 * Wraps a StreamFactory that reads its model from `params.model` (gemini,
 * anthropic) so a resolved model — when there is one — overrides whatever
 * brain.ts filled in at construction. `model` undefined means "nothing to
 * override": params pass through unchanged, which is what keeps today's
 * no-stored-setting behaviour byte for byte.
 */
function withModel(factory: StreamFactory, model: string | undefined): StreamFactory {
  return (params) => factory(model ? { ...params, model } : params);
}

/**
 * Resolves today's brain engine. See the file header for the four-tier,
 * no-key-first order and why the model has to travel two different ways.
 */
export async function resolveBrainFactory(deps: BrainEngineDeps): Promise<StreamFactory> {
  const stored = await deps.getStoredEngine();

  if (stored?.kind === "local") {
    // LocalBrainDeps.model is a required string bound at construction, but
    // an operator can leave it unset (swarm only requires baseUrl for this
    // kind) — so, uniquely among these kinds, building the real adapter is
    // deferred until a turn's params.model is available as the fallback.
    const baseUrl = stored.baseUrl ?? "";
    const model = stored.model;
    return (params) => createLocalStreamFactory({ baseUrl, model: model ?? params.model })(params);
  }

  if (stored?.kind === "cli") {
    const argv = deps.argvFor(stored.provider);
    if (argv) return createCliStreamFactory({ argv, model: stored.model, spawn: deps.spawn });
    // argvFor didn't resolve (gated off, or a cli this broker doesn't know
    // how to invoke as a brain) — fall through to the same terminal
    // fallback as "nothing stored at all", exactly like research-engine.ts's
    // sibling handles an unresolvable stored cli.
  }

  if (stored?.kind === "api" && stored.provider === "gemini") {
    return withModel(createGeminiStreamFactory({ apiKey: deps.geminiApiKey ?? "" }), stored.model);
  }
  if (stored?.kind === "api") {
    return withModel(deps.anthropicFactory(), stored.model);
  }

  if (deps.envProvider === "gemini") {
    return withModel(createGeminiStreamFactory({ apiKey: deps.geminiApiKey ?? "" }), deps.envModel);
  }
  return withModel(deps.anthropicFactory(), deps.envModel);
}

/**
 * The StreamFactory main.ts actually wires in. Resolution is deferred into
 * finalMessage() because StreamFactory is synchronous while reading the
 * stored setting is not; brain.ts calls the factory, THEN registers its
 * "text" listener, THEN awaits finalMessage() — so listeners raised before
 * the real stream exists are buffered here and replayed onto it once
 * resolution finishes. Dropping them instead of replaying would lose the
 * opening speech of every turn. Same lazy shape as gemini-brain.ts's own
 * factory (createGeminiStreamFactory), one level up.
 */
export function resolvingStreamFactory(deps: BrainEngineDeps): StreamFactory {
  return (params) => {
    const listeners: Array<(delta: string) => void> = [];
    return {
      on(event, cb) {
        if (event === "text") listeners.push(cb);
      },
      async finalMessage() {
        const inner = await resolveBrainFactory(deps);
        const stream = inner(params);
        for (const cb of listeners) stream.on("text", cb);
        return stream.finalMessage();
      },
    };
  };
}
