import assert from "node:assert/strict";
import { test } from "node:test";
import { slugify, type Topic, TopicStore } from "./topics.ts";

function memoryIo() {
  const files = new Map<string, string>();
  return { files, read: (n: string) => files.get(n) ?? null, write: (n: string, b: string) => void files.set(n, b) };
}

const topic: Topic = {
  id: "spring-boot",
  name: "Spring Boot",
  status: "discovering",
  candidates: [],
  declined: [],
};

test("topics round-trip through the io seam", () => {
  const io = memoryIo();
  new TopicStore(io).put(topic);
  assert.deepEqual(new TopicStore(io).all(), [topic]);
});

test("put replaces by id rather than duplicating", () => {
  const store = new TopicStore(memoryIo());
  store.put(topic);
  store.put({ ...topic, status: "pending", note: "no file written" });
  assert.equal(store.all().length, 1);
  assert.equal(store.get("spring-boot")!.status, "pending");
  assert.equal(store.get("spring-boot")!.note, "no file written");
});

test("get of an unknown topic is null, not a throw", () => {
  assert.equal(new TopicStore(memoryIo()).get("nope"), null);
});

test("remove drops it", () => {
  const store = new TopicStore(memoryIo());
  store.put(topic);
  store.remove("spring-boot");
  assert.deepEqual(store.all(), []);
});

test("a corrupt file reads as empty rather than bricking the broker", () => {
  const io = memoryIo();
  io.files.set("topics.json", "{not json");
  assert.deepEqual(new TopicStore(io).all(), []);
});

test("slugify makes a stable id from a human name", () => {
  assert.equal(slugify("Spring Boot"), "spring-boot");
  assert.equal(slugify("  Node.js  "), "node-js");
  assert.equal(slugify("C++"), "c");
  assert.equal(slugify(""), "topic");
});
