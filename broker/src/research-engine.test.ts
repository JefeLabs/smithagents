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

test("a stored setting for an ungated cli falls back to Anthropic", async () => {
  const engine = await resolveResearchEngine({
    getStoredEngine: async () => ({ cli: "unknown-tool" }),
    argvFor: () => undefined,
    spawn: okSpawn,
    anthropicCreate: async () => ({ content: [{ type: "text", text: "ok" }] }),
  });
  assert.ok(engine instanceof AnthropicResearch);
});
