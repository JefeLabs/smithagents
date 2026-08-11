import assert from "node:assert/strict";
import { test } from "node:test";
import { type Claim, deriveLeader, pickLeader, type Rankable, rankOf } from "./leadership.ts";

const m = (id: string, ...roles: string[]): Rankable => ({ id, roles });

test("the ladder orders coordination above technical seniority", () => {
  assert.ok(rankOf(["Product Manager"]) < rankOf(["leader"]));
  assert.ok(rankOf(["leader"]) < rankOf(["architect"]));
  assert.ok(rankOf(["architect"]) < rankOf(["senior"]));
  assert.ok(rankOf(["senior"]) < rankOf(["developer"]));
});

test("a Scrum Master ranks with Product Manager, so the persona can be added later without touching routing", () => {
  assert.equal(rankOf(["Scrum Master"]), rankOf(["Product Manager"]));
});

test("matching is case-insensitive and reads either role vocabulary", () => {
  assert.equal(rankOf(["PRODUCT MANAGER"]), rankOf(["product manager"]));
  assert.equal(rankOf(["Architect"]), rankOf(["architect"]));
});

test("an agent ranks by its BEST role across both vocabularies", () => {
  // A Product Manager who is also a squad developer ranks as a Product Manager.
  assert.equal(rankOf(["Product Manager", "developer"]), rankOf(["Product Manager"]));
});

test("an unknown role ranks last and never throws", () => {
  assert.equal(rankOf(["Underwater Basket Weaver"]), 99);
  assert.equal(rankOf([]), 99);
  assert.equal(rankOf(["Frontend Engineer"]), 99);
});

test("deriveLeader picks the highest-ranked member", () => {
  assert.equal(deriveLeader([m("a", "developer"), m("b", "Product Manager"), m("c", "senior")]), "b");
});

test("deriveLeader breaks ties on the order it was given (roster order), so the answer is stable", () => {
  assert.equal(deriveLeader([m("a", "senior"), m("b", "senior")]), "a");
  assert.equal(deriveLeader([m("b", "senior"), m("a", "senior")]), "b");
});

test("deriveLeader of nobody is null", () => {
  assert.equal(deriveLeader([]), null);
});

test("pickLeader takes the strongest willing claim", () => {
  const claims: Claim[] = [
    { agent: "a", willing: false, confidence: 0.2, reason: "I'd rather build" },
    { agent: "b", willing: true, confidence: 0.9, reason: "coordination is my job" },
    { agent: "c", willing: true, confidence: 0.4, reason: "I could" },
  ];
  assert.deepEqual(pickLeader(claims, [m("a", "senior"), m("b", "developer"), m("c", "architect")]), {
    leader: "b",
    method: "vote",
  });
});

test("a confidence tie breaks on the rank ladder, not on claim order", () => {
  const claims: Claim[] = [
    { agent: "a", willing: true, confidence: 0.8, reason: "x" },
    { agent: "b", willing: true, confidence: 0.8, reason: "y" },
  ];
  // b outranks a, so b wins despite a claiming first.
  assert.deepEqual(pickLeader(claims, [m("a", "developer"), m("b", "Product Manager")]), {
    leader: "b",
    method: "vote",
  });
});

test("nobody willing falls to the ladder and SAYS so", () => {
  const claims: Claim[] = [
    { agent: "a", willing: false, confidence: 0, reason: "no" },
    { agent: "b", willing: false, confidence: 0, reason: "no" },
  ];
  assert.deepEqual(pickLeader(claims, [m("a", "developer"), m("b", "Architect")]), { leader: "b", method: "rank" });
});

test("no claims at all (model unavailable) falls to the ladder", () => {
  assert.deepEqual(pickLeader([], [m("a", "developer"), m("b", "senior")]), { leader: "b", method: "rank" });
});

test("a claim from someone who is not a member is ignored", () => {
  const claims: Claim[] = [{ agent: "ghost", willing: true, confidence: 1, reason: "let me in" }];
  assert.deepEqual(pickLeader(claims, [m("a", "senior")]), { leader: "a", method: "rank" });
});
