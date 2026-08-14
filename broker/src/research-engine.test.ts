import assert from "node:assert/strict";
import { test } from "node:test";
import { AnthropicResearch, CliResearch } from "./research.ts";
import { resolveResearchEngine } from "./research-engine.ts";

const okSpawn = async () => ({ code: 0, stdout: "cli reply", stderr: "" });

test("no stored setting, explicit fallback model -> Anthropic engine sends that model", async () => {
  const calls: Array<{ model: string }> = [];
  const engine = await resolveResearchEngine(
    {
      getStoredEngine: async () => null,
      argvFor: () => undefined,
      spawn: okSpawn,
      anthropicCreate: async (p) => {
        calls.push(p as { model: string });
        return { content: [{ type: "text", text: "ok" }] };
      },
    },
    "claude-sonnet-5",
  );
  assert.ok(engine instanceof AnthropicResearch);
  await engine.complete({ system: "s", prompt: "p", maxTokens: 10 });
  assert.equal(calls[0].model, "claude-sonnet-5");
});

test("no stored setting, no fallback model given -> defaults to claude-haiku-4-5", async () => {
  const calls: Array<{ model: string }> = [];
  const engine = await resolveResearchEngine({
    getStoredEngine: async () => null,
    argvFor: () => undefined,
    spawn: okSpawn,
    anthropicCreate: async (p) => {
      calls.push(p as { model: string });
      return { content: [{ type: "text", text: "ok" }] };
    },
  });
  await engine.complete({ system: "s", prompt: "p", maxTokens: 10 });
  assert.equal(calls[0].model, "claude-haiku-4-5");
});

test("a stored + gated CLI setting wins over the Anthropic fallback, regardless of fallbackModel", async () => {
  const engine = await resolveResearchEngine(
    {
      getStoredEngine: async () => ({ cli: "claude", model: "opus" }),
      argvFor: (cli) => (cli === "claude" ? ["claude", "--print"] : undefined),
      spawn: okSpawn,
      anthropicCreate: async () => {
        throw new Error("must not be called — the CLI engine won");
      },
    },
    "claude-sonnet-5",
  );
  assert.ok(engine instanceof CliResearch);
});

test("a stored cli with no known research argv falls back to Anthropic", async () => {
  // Gate enforcement itself is NOT this resolver's job — the swarm's GET
  // /me/research-engine already hides a gated-off cli behind null (see
  // server.ts's redactResearchEngine), so getStoredEngine never hands this
  // resolver a gated cli in the first place. This exercises the other
  // "can't build an engine" path: a cli the swarm returned that this
  // broker's RESEARCH_ARGV table doesn't know how to invoke.
  const engine = await resolveResearchEngine({
    getStoredEngine: async () => ({ cli: "unknown-tool" }),
    argvFor: () => undefined,
    spawn: okSpawn,
    anthropicCreate: async () => ({ content: [{ type: "text", text: "ok" }] }),
  });
  assert.ok(engine instanceof AnthropicResearch);
});
