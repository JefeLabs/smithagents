import assert from "node:assert/strict";
import { test } from "node:test";
import { expired, extractCandidates, ownerRole, promotable, recordMentions } from "./interests.ts";
import type { FeedState } from "./types.ts";

const EXCLUDE = ["Anderson", "Osvaldo", "jefelabs"];

test("extracts package-shaped and proper-noun tokens", () => {
  const found = extractCandidates("I keep looking at RunPod and spring-boot for this", EXCLUDE);
  assert.equal(found.includes("RunPod"), true);
  assert.equal(found.includes("spring-boot"), true);
});

test("never extracts agent names, workspace names, or common words", () => {
  const found = extractCandidates("Anderson can ask Osvaldo about jefelabs. The Thing works.", EXCLUDE);
  assert.deepEqual(found, []);
});

test("a name must be mentioned enough, across enough sessions, to promote", () => {
  let c: FeedState["candidates"] = {};
  c = recordMentions({ candidates: c }, ["RunPod"], "s1", "2026-08-01T00:00:00Z");
  c = recordMentions({ candidates: c }, ["RunPod"], "s1", "2026-08-02T00:00:00Z");
  assert.deepEqual(promotable(c, "2026-08-03T00:00:00Z"), [], "two mentions in ONE session is not enough");

  c = recordMentions({ candidates: c }, ["RunPod"], "s2", "2026-08-03T00:00:00Z");
  assert.deepEqual(promotable(c, "2026-08-03T00:00:00Z"), ["RunPod"]);
});

test("mentions spread beyond 14 days do not accumulate into a promotion", () => {
  let c: FeedState["candidates"] = {};
  c = recordMentions({ candidates: c }, ["RunPod"], "s1", "2026-07-01T00:00:00Z");
  c = recordMentions({ candidates: c }, ["RunPod"], "s2", "2026-07-02T00:00:00Z");
  c = recordMentions({ candidates: c }, ["RunPod"], "s3", "2026-08-01T00:00:00Z");
  assert.deepEqual(promotable(c, "2026-08-01T00:00:00Z"), []);
});

test("an interest unmentioned for 30 days expires", () => {
  const c: FeedState["candidates"] = {
    RunPod: {
      mentions: 9,
      sessions: ["s1", "s2"],
      firstSeen: "2026-06-01T00:00:00Z",
      lastSeen: "2026-07-01T00:00:00Z",
    },
    Tauri: { mentions: 9, sessions: ["s1", "s2"], firstSeen: "2026-08-01T00:00:00Z", lastSeen: "2026-08-10T00:00:00Z" },
  };
  assert.deepEqual(expired(c, "2026-08-11T00:00:00Z"), ["RunPod"]);
});

test("ownerRole attributes by an ordered table, first match winning", () => {
  const dep = (name: string, eco: "npm" | "maven" | "cargo") => ({ name, eco, version: "1.0.0", manifest: "m" });
  assert.equal(ownerRole(dep("react", "npm"), false), "Frontend Engineer");
  assert.equal(ownerRole(dep("org.springframework.boot:spring-boot", "maven"), false), "Backend Engineer");
  assert.equal(ownerRole(dep("tauri", "cargo"), false), "Mobile Engineer");
  assert.equal(ownerRole(dep("torch", "npm"), false), "Data / ML Engineer");
});

test("a security release is the Security Engineer's, whatever the ecosystem", () => {
  assert.equal(ownerRole({ name: "react", eco: "npm", version: "1", manifest: "m" }, true), "Security Engineer");
});

test("an unmatched dependency is unattributed — attribution never invents a speaker", () => {
  assert.equal(ownerRole({ name: "left-pad", eco: "npm", version: "1", manifest: "m" }, false), null);
});
