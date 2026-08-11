import assert from "node:assert/strict";
import { test } from "node:test";
import { approve, sourceFor } from "./approve.ts";
import type { Candidate, Topic } from "./topics.ts";

const site: Candidate = { kind: "site", url: "https://spring.io/blog.atom", label: "Spring blog", evidence: "e" };
const gh: Candidate = {
  kind: "github",
  url: "https://github.com/spring-projects/spring-boot",
  label: "spring-boot",
  evidence: "e",
};
const yt: Candidate = { kind: "youtube", url: "https://www.youtube.com/channel/UC123", label: "chan", evidence: "e" };
const x: Candidate = { kind: "x", url: "https://x.com/springboot", label: "@springboot", evidence: "e" };

const topic: Topic = {
  id: "spring-boot",
  name: "Spring Boot",
  status: "pending",
  candidates: [site, gh, yt, x],
  declined: [],
};

test("a site candidate becomes an rss source tagged tech", () => {
  const s = sourceFor(topic, site)!;
  assert.equal(s.kind, "rss");
  assert.equal(s.tag, "tech");
  assert.equal(s.locator, "https://spring.io/blog.atom");
  assert.equal(s.topicId, "spring-boot");
  assert.match(s.reason!, /Spring Boot discovery/);
});

test("a github candidate becomes a RELEASE source pointed at the atom feed", () => {
  const s = sourceFor(topic, gh)!;
  assert.equal(s.tag, "release");
  assert.equal(s.locator, "https://github.com/spring-projects/spring-boot/releases.atom");
});

test("a youtube channel becomes its feed url, not the page url", () => {
  assert.equal(sourceFor(topic, yt)!.locator, "https://www.youtube.com/feeds/videos.xml?channel_id=UC123");
});

test("an x candidate becomes an x source carrying the bare handle", () => {
  const s = sourceFor(topic, x)!;
  assert.equal(s.kind, "x");
  assert.equal(s.locator, "springboot");
});

test("approve keeps only what was ticked, and DECLINES the rest for good", () => {
  const { topic: next, sources } = approve(topic, [site.url, gh.url]);
  assert.deepEqual(sources.map((s) => s.label).sort(), ["Spring blog", "spring-boot"]);
  assert.deepEqual(next.declined.sort(), [x.url, yt.url].sort());
  assert.equal(next.status, "active");
  assert.deepEqual(next.candidates, [], "approved candidates stop being pending");
});

test("approving a github source records the baseline, so history is never carded", () => {
  const { baselines } = approve(topic, [gh.url], "4.0.0");
  assert.deepEqual(baselines, { "spring-projects/spring-boot": "4.0.0" });
});

test("no baseline given still records one, because zero is not a version", () => {
  const { baselines } = approve(topic, [gh.url]);
  assert.equal(Object.keys(baselines).length, 1);
});

test("approving nothing leaves the topic pending rather than pretending it is active", () => {
  const { topic: next, sources } = approve(topic, []);
  assert.deepEqual(sources, []);
  assert.equal(next.status, "pending");
  assert.match(next.note!, /nothing approved/i);
});

test("a previously declined url stays declined after another approval round", () => {
  const withDeclined = { ...topic, declined: ["https://old.test/gone"] };
  const { topic: next } = approve(withDeclined, [site.url]);
  assert.equal(next.declined.includes("https://old.test/gone"), true);
});
