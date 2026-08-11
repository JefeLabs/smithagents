import assert from "node:assert/strict";
import { test } from "node:test";
import { loadLiveKitConfig } from "./config.js";

test("loadLiveKitConfig reads the three env vars", () => {
  const cfg = loadLiveKitConfig({
    LIVEKIT_URL: "ws://127.0.0.1:7880",
    LIVEKIT_API_KEY: "devkey",
    LIVEKIT_API_SECRET: "secret",
  } as NodeJS.ProcessEnv);
  assert.equal(cfg.url, "ws://127.0.0.1:7880");
  assert.equal(cfg.apiKey, "devkey");
});

test("loadLiveKitConfig throws when a var is missing", () => {
  assert.throws(() => loadLiveKitConfig({ LIVEKIT_URL: "x" } as NodeJS.ProcessEnv), /LIVEKIT_API_KEY/);
});
