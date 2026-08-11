import assert from "node:assert/strict";
import { test } from "node:test";
import { loadBrokerConfig } from "./config.ts";

const FULL = {
  ANTHROPIC_API_KEY: "sk-ant",
  LIVEKIT_URL: "ws://127.0.0.1:7880",
  LIVEKIT_API_KEY: "devkey",
  LIVEKIT_API_SECRET: "secret",
};

test("loads with defaults for optional vars", () => {
  const c = loadBrokerConfig(FULL);
  assert.equal(c.swarm.baseUrl, "http://127.0.0.1:7777");
  assert.equal(c.swarm.repository, "");
  assert.equal(c.swarm.token, undefined);
  assert.equal(c.livekit.url, "ws://127.0.0.1:7880");
});

test("boots with no voice keys anywhere — voice keys are Settings-managed, not env (spec §6)", () => {
  const config = loadBrokerConfig(FULL); // FULL no longer contains either voice key
  assert.ok(!("deepgramApiKey" in config));
  assert.ok(!("elevenlabsApiKey" in config));
});

test("optional overrides are honored", () => {
  const c = loadBrokerConfig({ ...FULL, SWARM_URL: "http://h:9999", SMITH_API_TOKEN: "t", SWARM_REPO: "git@x:y.git" });
  assert.equal(c.swarm.baseUrl, "http://h:9999");
  assert.equal(c.swarm.token, "t");
  assert.equal(c.swarm.repository, "git@x:y.git");
});

test("gemini config: absent key -> undefined + default image model", () => {
  const c = loadBrokerConfig(FULL);
  assert.equal(c.geminiApiKey, undefined);
  assert.equal(c.geminiImageModel, "gemini-2.5-flash-image");
});

test("gemini config: key and model override are read", () => {
  const c = loadBrokerConfig({ ...FULL, GEMINI_API_KEY: "g-key", GEMINI_IMAGE_MODEL: "imagen-4" });
  assert.equal(c.geminiApiKey, "g-key");
  assert.equal(c.geminiImageModel, "imagen-4");
});

test("auth config defaults: open mode, loopback, localhost rpId", () => {
  const c = loadBrokerConfig({ ...FULL });
  assert.equal(c.host, "127.0.0.1");
  assert.equal(c.auth.required, false);
  assert.equal(c.auth.rpId, "localhost");
  assert.equal(c.auth.webOrigin, "http://localhost:1420");
  assert.equal(c.auth.file, ".smith/auth.json");
});

test("SMITH_BROKER_AUTH=required flips the gate; env overrides flow through", () => {
  const c = loadBrokerConfig({
    ...FULL,
    SMITH_BROKER_AUTH: "required",
    SMITH_BROKER_RPID: "skoolscout.example.com",
    SMITH_BROKER_WEB_ORIGIN: "https://skoolscout.example.com",
    SMITH_BROKER_TOKEN: "bt",
    SMITH_BROKER_AUTH_FILE: "/data/auth.json",
    BROKER_HOST: "0.0.0.0",
  });
  assert.deepEqual(c.auth, {
    required: true,
    rpId: "skoolscout.example.com",
    webOrigin: "https://skoolscout.example.com",
    bridgeToken: "bt",
    file: "/data/auth.json",
  });
  assert.equal(c.host, "0.0.0.0");
});

test("non-loopback bind without auth refuses to load", () => {
  assert.throws(() => loadBrokerConfig({ ...FULL, BROKER_HOST: "0.0.0.0" }), /BROKER_HOST|SMITH_BROKER_AUTH/);
});
