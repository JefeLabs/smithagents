import assert from "node:assert/strict";
import { test } from "node:test";
import { discoveryBrief, startDiscovery } from "./discovery.ts";
import type { Topic } from "./topics.ts";

const topic: Topic = { id: "spring-boot", name: "Spring Boot", status: "discovering", candidates: [], declined: [] };

test("the brief names the topic, the four kinds, and the file to WRITE", () => {
  const brief = discoveryBrief(topic, ".smith/topics/spring-boot.json");
  assert.match(brief, /Spring Boot/);
  for (const kind of ["site", "github", "youtube", "x"]) assert.match(brief, new RegExp(kind));
  assert.match(brief, /\.smith\/topics\/spring-boot\.json/);
  assert.match(brief, /write/i);
  assert.match(brief, /evidence/i);
  assert.match(brief, /do not print/i, "terminal output is not a data format");
});

test("a successful dispatch records the taskId and keeps the topic discovering", async () => {
  const { topic: next, taskId } = await startDiscovery(
    { dispatch: async () => ({ taskId: "t-1" }), bundlePath: (id) => `.smith/topics/${id}.json` },
    topic,
  );
  assert.equal(taskId, "t-1");
  assert.equal(next.status, "discovering");
  assert.equal(next.note, undefined);
});

test("a refused dispatch keeps the topic discovering and SAYS why", async () => {
  const { topic: next, taskId } = await startDiscovery(
    { dispatch: async () => ({ error: "Osvaldo is busy with: refactor auth." }), bundlePath: (id) => id },
    topic,
  );
  assert.equal(taskId, undefined);
  assert.equal(next.status, "discovering");
  assert.match(next.note!, /busy with: refactor auth/);
});

test("the brief tells the agent what it is allowed to leave out", () => {
  assert.match(discoveryBrief(topic, "p.json"), /omit/i);
});
