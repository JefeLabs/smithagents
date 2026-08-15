import assert from "node:assert/strict";
import { test } from "node:test";
import type { StreamFactory } from "./brain.ts";
import { type BrainEngine, resolveBrainFactory, resolvingStreamFactory } from "./brain-engine.ts";
import type { Spawner } from "./research.ts";

const PARAMS: Parameters<StreamFactory>[0] = {
  model: "claude-haiku-4-5",
  max_tokens: 1024,
  system: "s",
  messages: [],
  tools: [],
};

const okStream = {
  on() {},
  async finalMessage() {
    return { content: [], stop_reason: "end_turn" };
  },
};
const dummyFactory: StreamFactory = () => okStream;
const dummySpawn: Spawner = async () => ({
  code: 0,
  stdout: JSON.stringify({ speech: "", tool_calls: [] }),
  stderr: "",
});

test("prefers no-key options: local, then cli, then api, then the env fallback", async () => {
  const seen: string[] = [];
  const deps = (stored: BrainEngine | null, envProvider?: string) => ({
    getStoredEngine: async () => stored,
    argvFor: (cli: string) => (cli === "claude" ? ["claude", "-p"] : undefined),
    spawn: dummySpawn,
    envProvider,
    geminiApiKey: "k",
    anthropicFactory: () => {
      seen.push("anthropic");
      return dummyFactory;
    },
  });

  await resolveBrainFactory(deps({ kind: "local", provider: "lmstudio", baseUrl: "http://x" }));
  await resolveBrainFactory(deps({ kind: "cli", provider: "claude" }));
  await resolveBrainFactory(deps({ kind: "api", provider: "gemini" }));

  // No stored setting and no env → anthropic fallback, exactly today's behaviour.
  await resolveBrainFactory(deps(null));
  assert.deepEqual(seen, ["anthropic"]);
});

test("resolution happens per turn, not once", async () => {
  let calls = 0;
  const factory = resolvingStreamFactory({
    getStoredEngine: async () => {
      calls++;
      return null;
    },
    argvFor: () => undefined,
    spawn: dummySpawn,
    geminiApiKey: undefined,
    anthropicFactory: () => dummyFactory,
  });
  await factory(PARAMS).finalMessage();
  await factory(PARAMS).finalMessage();
  assert.equal(calls, 2, "each turn re-reads the setting, so a change needs no restart");
});

test("resolvingStreamFactory buffers listeners registered before resolution and replays them onto the real stream", async () => {
  // brain.ts always does stream.on("text", cb) THEN await stream.finalMessage() — a
  // resolver that drops listeners registered before the real stream exists would
  // silently lose every turn's opening speech.
  const emittingFactory: StreamFactory = () => {
    const listeners: Array<(delta: string) => void> = [];
    return {
      on(event, cb) {
        if (event === "text") listeners.push(cb);
      },
      async finalMessage() {
        for (const cb of listeners) cb("hello");
        return { content: [{ type: "text", text: "hello" }], stop_reason: "end_turn" };
      },
    };
  };

  const heard: string[] = [];
  const factory = resolvingStreamFactory({
    getStoredEngine: async () => null,
    argvFor: () => undefined,
    spawn: dummySpawn,
    geminiApiKey: undefined,
    anthropicFactory: () => emittingFactory,
  });
  const stream = factory(PARAMS);
  stream.on("text", (d) => heard.push(d));
  await stream.finalMessage();
  assert.deepEqual(heard, ["hello"]);
});

test("local kind: the resolved model reaches the adapter's construction-time deps, ignoring params.model", async () => {
  // local-brain.ts binds its model at construction and deliberately ignores
  // params.model — the resolver is the only place that can get the user's
  // chosen model to it, so this proves it actually does.
  const originalFetch = globalThis.fetch;
  const seenModels: string[] = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { model: string };
    seenModels.push(body.model);
    return new Response("data: [DONE]\n\n", { status: 200 });
  }) as typeof fetch;

  try {
    const factory = await resolveBrainFactory({
      getStoredEngine: async () => ({ kind: "local", provider: "lmstudio", baseUrl: "http://x", model: "qwen-14b" }),
      argvFor: () => undefined,
      spawn: dummySpawn,
      geminiApiKey: undefined,
      anthropicFactory: () => dummyFactory,
    });
    await factory({ ...PARAMS, model: "should-be-ignored" }).finalMessage();
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(seenModels, ["qwen-14b"]);
});

test("local kind with no stored model: the request omits `model` entirely, never leaking params.model", async () => {
  // Regression, twin of the gemini-default-model bug: swarm only requires
  // baseUrl for a stored `local` engine, so `model` is legally unset here.
  // Before the fix this fell back to params.model — BrokerBrain's Anthropic
  // default ("claude-haiku-4-5") sent to a local, non-Anthropic server.
  const originalFetch = globalThis.fetch;
  let sentBody: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    sentBody = JSON.parse(String(init?.body));
    return new Response("data: [DONE]\n\n", { status: 200 });
  }) as typeof fetch;

  try {
    const factory = await resolveBrainFactory({
      getStoredEngine: async () => ({ kind: "local", provider: "lmstudio", baseUrl: "http://x" }),
      argvFor: () => undefined,
      spawn: dummySpawn,
      geminiApiKey: undefined,
      anthropicFactory: () => dummyFactory,
    });
    await factory(PARAMS).finalMessage();
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.ok(sentBody);
  assert.equal("model" in (sentBody ?? {}), false, `expected no "model" key, got ${JSON.stringify(sentBody)}`);
});

test("api/gemini kind: the resolved model overrides params.model, since createGeminiStreamFactory reads params.model", async () => {
  const originalFetch = globalThis.fetch;
  const seenUrls: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    seenUrls.push(String(url));
    return new Response("data: [DONE]\n\n", { status: 200 });
  }) as typeof fetch;

  try {
    const factory = await resolveBrainFactory({
      getStoredEngine: async () => ({ kind: "api", provider: "gemini", model: "gemini-2.5-pro" }),
      argvFor: () => undefined,
      spawn: dummySpawn,
      geminiApiKey: "k",
      anthropicFactory: () => dummyFactory,
    });
    await factory({ ...PARAMS, model: "should-be-ignored" }).finalMessage();
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.ok(seenUrls[0]?.includes("gemini-2.5-pro"), `expected the resolved model in the URL, got ${seenUrls[0]}`);
  assert.ok(!seenUrls[0]?.includes("should-be-ignored"));
});

test("cli kind: the resolved model reaches the spawner's --model flag, not params.model", async () => {
  const argvs: string[][] = [];
  const spy: Spawner = async (argv) => {
    argvs.push(argv);
    return { code: 0, stdout: JSON.stringify({ speech: "hi", tool_calls: [] }), stderr: "" };
  };
  const factory = await resolveBrainFactory({
    getStoredEngine: async () => ({ kind: "cli", provider: "claude", model: "opus" }),
    argvFor: (cli) => (cli === "claude" ? ["claude", "-p"] : undefined),
    spawn: spy,
    geminiApiKey: undefined,
    anthropicFactory: () => dummyFactory,
  });
  await factory({ ...PARAMS, model: "should-be-ignored" }).finalMessage();
  assert.deepEqual(argvs[0]?.slice(0, 4), ["claude", "-p", "--model", "opus"]);
});

test("stored api/anthropic overrides params.model through anthropicFactory, mirroring the gemini case", async () => {
  const calls: Array<{ model: string }> = [];
  const factory = await resolveBrainFactory({
    getStoredEngine: async () => ({ kind: "api", provider: "anthropic", model: "claude-opus-5" }),
    argvFor: () => undefined,
    spawn: dummySpawn,
    geminiApiKey: undefined,
    anthropicFactory: () =>
      ((params) => {
        calls.push(params as { model: string });
        return okStream;
      }) as StreamFactory,
  });
  await factory({ ...PARAMS, model: "should-be-ignored" }).finalMessage();
  assert.equal(calls[0]?.model, "claude-opus-5");
});

test("a stored cli whose argvFor doesn't resolve falls through to the same fallback as no stored setting at all", async () => {
  const seen: string[] = [];
  await resolveBrainFactory({
    getStoredEngine: async () => ({ kind: "cli", provider: "unknown-tool" }),
    argvFor: () => undefined,
    spawn: dummySpawn,
    geminiApiKey: undefined,
    anthropicFactory: () => {
      seen.push("anthropic");
      return dummyFactory;
    },
  });
  assert.deepEqual(seen, ["anthropic"]);
});

test("envModel overrides params.model on the no-stored-setting fallback, mirroring config.brain.model today", async () => {
  const calls: Array<{ model: string }> = [];
  const factory = await resolveBrainFactory({
    getStoredEngine: async () => null,
    argvFor: () => undefined,
    spawn: dummySpawn,
    geminiApiKey: undefined,
    envModel: "claude-sonnet-5",
    anthropicFactory: () =>
      ((params) => {
        calls.push(params as { model: string });
        return okStream;
      }) as StreamFactory,
  });
  await factory({ ...PARAMS, model: "should-be-ignored" }).finalMessage();
  assert.equal(calls[0]?.model, "claude-sonnet-5");
});

test("no stored setting, no envModel: params.model passes through unchanged (today's behaviour, byte for byte)", async () => {
  const calls: Array<{ model: string }> = [];
  const factory = await resolveBrainFactory({
    getStoredEngine: async () => null,
    argvFor: () => undefined,
    spawn: dummySpawn,
    geminiApiKey: undefined,
    anthropicFactory: () =>
      ((params) => {
        calls.push(params as { model: string });
        return okStream;
      }) as StreamFactory,
  });
  await factory(PARAMS).finalMessage();
  assert.equal(calls[0]?.model, PARAMS.model);
});

test("no stored setting, envProvider=gemini, no envModel: gets gemini's own default, not BrokerBrain's Claude default", async () => {
  // Regression: BrokerBrain's built-in default (brain.ts) is a Claude model
  // and 404s against Gemini's API — SMITH_BRAIN_PROVIDER=gemini with no
  // SMITH_BRAIN_MODEL must still resolve to a real Gemini model.
  const originalFetch = globalThis.fetch;
  const seenUrls: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    seenUrls.push(String(url));
    return new Response("data: [DONE]\n\n", { status: 200 });
  }) as typeof fetch;

  try {
    const factory = await resolveBrainFactory({
      getStoredEngine: async () => null,
      argvFor: () => undefined,
      spawn: dummySpawn,
      envProvider: "gemini",
      geminiApiKey: "k",
      anthropicFactory: () => dummyFactory,
    });
    await factory(PARAMS).finalMessage();
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.ok(!seenUrls[0]?.includes(PARAMS.model), `must not carry BrokerBrain's Claude default, got ${seenUrls[0]}`);
  assert.ok(seenUrls[0]?.includes("gemini"), `expected a gemini model in the URL, got ${seenUrls[0]}`);
});

test("stored api/gemini with no model: gets gemini's own default, not BrokerBrain's Claude default", async () => {
  const originalFetch = globalThis.fetch;
  const seenUrls: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    seenUrls.push(String(url));
    return new Response("data: [DONE]\n\n", { status: 200 });
  }) as typeof fetch;

  try {
    const factory = await resolveBrainFactory({
      getStoredEngine: async () => ({ kind: "api", provider: "gemini" }),
      argvFor: () => undefined,
      spawn: dummySpawn,
      geminiApiKey: "k",
      anthropicFactory: () => dummyFactory,
    });
    await factory(PARAMS).finalMessage();
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.ok(!seenUrls[0]?.includes(PARAMS.model), `must not carry BrokerBrain's Claude default, got ${seenUrls[0]}`);
  assert.ok(seenUrls[0]?.includes("gemini"), `expected a gemini model in the URL, got ${seenUrls[0]}`);
});
