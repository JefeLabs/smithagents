import assert from "node:assert/strict";
import { test } from "node:test";
import { createDiscordWorkspaceSwitcher, type DiscordWorkspaceSwitcherDeps } from "./discord-workspace-switcher.ts";

type Config = { botToken: string; textChannels: string[]; voiceChannels: string[] } | null;

function fakeDeps(configsByWorkspace: Record<string, Config>, overrides: Partial<DiscordWorkspaceSwitcherDeps> = {}) {
  const calls: string[] = [];
  const deps: DiscordWorkspaceSwitcherDeps = {
    swarm: {
      getWorkspaceDiscordConfig: async (name) => {
        calls.push(`getConfig:${name}`);
        return configsByWorkspace[name] ?? null;
      },
    },
    discordTextLifecycle: {
      teardownDiscordText: async () => {
        calls.push("teardownText");
      },
      bootDiscordText: async (token, textChannels) => {
        calls.push(`bootText:${token}:${textChannels.join(",")}`);
        return { stop: async () => {} };
      },
    },
    discordVoiceLifecycle: {
      teardownDiscordVoice: async () => {
        calls.push("teardownVoice");
      },
      bootDiscordVoice: async (token, allowlist) => {
        calls.push(`bootVoice:${token}:${allowlist.join(",")}`);
        return async () => {};
      },
    },
    ...overrides,
  };
  return { deps, calls };
}

test("switchDiscordForWorkspace: tears down both surfaces before booting the new config, in text-then-voice order", async () => {
  const { deps, calls } = fakeDeps({
    acme: { botToken: "tok-acme", textChannels: ["general"], voiceChannels: ["lobby"] },
  });
  const switcher = createDiscordWorkspaceSwitcher(deps);
  await switcher.switchDiscordForWorkspace("acme");
  assert.deepEqual(calls, [
    "teardownText",
    "teardownVoice",
    "getConfig:acme",
    "bootText:tok-acme:general",
    "bootVoice:tok-acme:lobby",
  ]);
});

test("switchDiscordForWorkspace: a workspace with no Discord config tears down without booting anything new", async () => {
  const { deps, calls } = fakeDeps({});
  const switcher = createDiscordWorkspaceSwitcher(deps);
  await switcher.switchDiscordForWorkspace("no-discord");
  assert.deepEqual(calls, ["teardownText", "teardownVoice", "getConfig:no-discord"]);
});

test("switchDiscordForWorkspace: empty voiceChannels boots text but skips the voice boot entirely", async () => {
  const { deps, calls } = fakeDeps({
    acme: { botToken: "tok-acme", textChannels: ["general"], voiceChannels: [] },
  });
  const switcher = createDiscordWorkspaceSwitcher(deps);
  await switcher.switchDiscordForWorkspace("acme");
  assert.deepEqual(calls, ["teardownText", "teardownVoice", "getConfig:acme", "bootText:tok-acme:general"]);
});

test("switchDiscordForWorkspace: different workspaces resolve and boot their own distinct config", async () => {
  const { deps, calls } = fakeDeps({
    acme: { botToken: "tok-acme", textChannels: ["acme-general"], voiceChannels: [] },
    globex: { botToken: "tok-globex", textChannels: ["globex-general"], voiceChannels: ["globex-lobby"] },
  });
  const switcher = createDiscordWorkspaceSwitcher(deps);
  await switcher.switchDiscordForWorkspace("acme");
  await switcher.switchDiscordForWorkspace("globex");
  assert.deepEqual(calls, [
    "teardownText",
    "teardownVoice",
    "getConfig:acme",
    "bootText:tok-acme:acme-general",
    "teardownText",
    "teardownVoice",
    "getConfig:globex",
    "bootText:tok-globex:globex-general",
    "bootVoice:tok-globex:globex-lobby",
  ]);
});

test("switchDiscordForWorkspace: a text-boot failure doesn't block attempting the voice boot, and doesn't reject", async () => {
  const { deps, calls } = fakeDeps(
    { acme: { botToken: "tok-acme", textChannels: ["general"], voiceChannels: ["lobby"] } },
    {
      discordTextLifecycle: {
        teardownDiscordText: async () => void calls.push("teardownText"),
        bootDiscordText: async () => {
          throw new Error("text boot exploded");
        },
      },
    },
  );
  const switcher = createDiscordWorkspaceSwitcher(deps);
  await assert.doesNotReject(() => switcher.switchDiscordForWorkspace("acme"));
  assert.deepEqual(calls, ["teardownText", "teardownVoice", "getConfig:acme", "bootVoice:tok-acme:lobby"]);
});

/** Flushes every microtask queued so far (a macrotask boundary), more robust than guessing a fixed number of `await Promise.resolve()` ticks. Mirrors discord-voice-lifecycle.test.ts's own helper. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("switchDiscordForWorkspace: two overlapping calls are serialized — the second's teardown waits for the first's boot to settle, and exactly one connection ends up tracked active, never orphaned", async () => {
  const calls: string[] = [];
  // Models the real lifecycle module's own `active*` tracking (see
  // discord-text-lifecycle.ts): teardown clears it (no-op if already null),
  // boot assigns it once the "login" resolves. Without the Fix 1
  // serialization, switch(b)'s teardown can run — and no-op — before
  // switch(a)'s gated boot below ever assigns `active`, so switch(a)'s
  // eventual boot silently overwrites whatever switch(b) already put there:
  // an orphan, since nothing calls that connection's own stop() again.
  // Object-wrapped (rather than a bare `let`) so mutations from inside the
  // fake's own async closures below are visible without TS narrowing the
  // outer binding's type from its `null` initializer.
  const state: { active: { workspace: string } | null } = { active: null };
  const orphaned: string[] = [];

  let resolveABoot: (() => void) | undefined;
  const aBootGate = new Promise<void>((resolve) => {
    resolveABoot = resolve;
  });

  const deps: DiscordWorkspaceSwitcherDeps = {
    swarm: {
      getWorkspaceDiscordConfig: async (name) => {
        calls.push(`getConfig:${name}`);
        return { botToken: `tok-${name}`, textChannels: ["general"], voiceChannels: [] };
      },
    },
    discordTextLifecycle: {
      teardownDiscordText: async () => {
        calls.push("teardownText");
        state.active = null;
      },
      bootDiscordText: async (token) => {
        calls.push(`bootText:${token}`);
        // Parks workspace "a"'s boot mid-flight, like a real Gateway login
        // would — this is the window a non-serialized switch(b) could race into.
        if (token === "tok-a") await aBootGate;
        const conn = { workspace: token };
        if (state.active) orphaned.push(state.active.workspace); // something is still tracked active that nobody tore down first
        state.active = conn;
        return { stop: async () => {} };
      },
    },
    discordVoiceLifecycle: {
      teardownDiscordVoice: async () => void calls.push("teardownVoice"),
      bootDiscordVoice: async () => {
        calls.push("bootVoice");
        return async () => {};
      },
    },
  };

  const switcher = createDiscordWorkspaceSwitcher(deps);
  const p1 = switcher.switchDiscordForWorkspace("a");
  await flushMicrotasks(); // let switch(a) run teardown + getConfig + start its boot, then park inside the gate
  assert.deepEqual(calls, ["teardownText", "teardownVoice", "getConfig:a", "bootText:tok-a"]);

  const p2 = switcher.switchDiscordForWorkspace("b");
  await flushMicrotasks();
  // Without Fix 1, switch(b)'s OWN teardownText would already show up here,
  // right now, while switch(a)'s boot is still parked mid-flight — that's the
  // bug. Serialized, switch(b) must still be waiting behind switch(a)'s
  // still-in-flight doSwitch, so calls is unchanged.
  assert.deepEqual(calls, ["teardownText", "teardownVoice", "getConfig:a", "bootText:tok-a"]);

  resolveABoot!();
  await Promise.all([p1, p2]);

  // switch(b)'s teardownText only ran AFTER switch(a)'s boot resolved above.
  assert.deepEqual(calls, [
    "teardownText",
    "teardownVoice",
    "getConfig:a",
    "bootText:tok-a",
    "teardownText",
    "teardownVoice",
    "getConfig:b",
    "bootText:tok-b",
  ]);
  assert.deepEqual(orphaned, []); // nothing was ever overwritten while still tracked active
  assert.equal(state.active?.workspace, "tok-b"); // exactly one connection ends up tracked as active — no second, unreachable client left behind
});

test("switchDiscordForWorkspace: a voice-boot failure doesn't reject the overall switch", async () => {
  const { deps, calls } = fakeDeps(
    { acme: { botToken: "tok-acme", textChannels: ["general"], voiceChannels: ["lobby"] } },
    {
      discordVoiceLifecycle: {
        teardownDiscordVoice: async () => void calls.push("teardownVoice"),
        bootDiscordVoice: async () => {
          throw new Error("voice boot exploded");
        },
      },
    },
  );
  const switcher = createDiscordWorkspaceSwitcher(deps);
  await assert.doesNotReject(() => switcher.switchDiscordForWorkspace("acme"));
  assert.deepEqual(calls, ["teardownText", "teardownVoice", "getConfig:acme", "bootText:tok-acme:general"]);
});
