import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DeviceRegistry } from "./device-registry.js";
import type { WorkerRegisterMessage } from "./remote-types.js";
import { evaluateWorkerRegistration } from "./server.js";

function reg(overrides: Partial<WorkerRegisterMessage>): WorkerRegisterMessage {
  return {
    type: "register",
    workerId: "self-asserted",
    name: "box",
    secret: "",
    capacity: 5,
    agents: ["claude"],
    runtimes: ["tmux"],
    version: "0.1.0",
    ...overrides,
  };
}

async function registryWithDevice(): Promise<{ registry: DeviceRegistry; token: string; deviceId: string }> {
  const dir = await mkdtemp(join(tmpdir(), "devices-"));
  const registry = new DeviceRegistry(join(dir, "devices.json"));
  await registry.load();
  const { code } = registry.mintPairingCode();
  const result = (await registry.redeem(code, "paired-box"))!;
  return { registry, token: result.token, deviceId: result.deviceId };
}

test("valid device token: accepted, pool identity is the deviceId (not the self-asserted workerId)", async () => {
  const { registry, token, deviceId } = await registryWithDevice();
  const verdict = await evaluateWorkerRegistration(reg({ token }), registry, []);
  assert.deepEqual(verdict, { accepted: true, poolWorkerId: deviceId, deviceId });
});

test("revoked device token: rejected", async () => {
  const { registry, token, deviceId } = await registryWithDevice();
  await registry.revoke(deviceId);
  const verdict = await evaluateWorkerRegistration(reg({ token }), registry, []);
  assert.equal(verdict.accepted, false);
});

test("legacy secret path still works when no token is presented", async () => {
  const { registry } = await registryWithDevice();
  const configured = [{ url: "", secret: "legacy-secret" }];
  const verdict = await evaluateWorkerRegistration(reg({ secret: "legacy-secret" }), registry, configured);
  assert.ok(verdict.accepted);
  if (verdict.accepted) assert.equal(verdict.poolWorkerId, "self-asserted");
});

test("no token, no matching secret: fail closed with the existing reasons", async () => {
  const { registry } = await registryWithDevice();
  const none = await evaluateWorkerRegistration(reg({}), registry, []);
  assert.deepEqual(none, { accepted: false, reason: "No remote workers configured" });
  const wrong = await evaluateWorkerRegistration(reg({ secret: "nope" }), registry, [{ url: "", secret: "right" }]);
  assert.deepEqual(wrong, { accepted: false, reason: "Invalid secret" });
});

test("a bad token never falls through to the secret path", async () => {
  const { registry } = await registryWithDevice();
  const configured = [{ url: "", secret: "legacy-secret" }];
  const verdict = await evaluateWorkerRegistration(
    reg({ token: "smith-device-bogus", secret: "legacy-secret" }),
    registry,
    configured,
  );
  assert.deepEqual(verdict, { accepted: false, reason: "Invalid device token" });
});
