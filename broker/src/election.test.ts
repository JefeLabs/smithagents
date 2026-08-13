import assert from "node:assert/strict";
import { test } from "node:test";
import { type AskFactory, type Candidate, makeClaimAsk, parseClaim, runElection } from "./election.ts";

const cand = (id: string, role: string, squadRole?: string): Candidate => ({
  id,
  name: id.toUpperCase(),
  role,
  directives: `You are ${id}.`,
  squadRole,
});

/** Scripts one reply per agent id, keyed off the directives it was seeded with. */
function scripted(replies: Record<string, string>): AskFactory & { seen: string[] } {
  const seen: string[] = [];
  const ask = async ({ system, prompt }: { agentId: string; system: string; prompt: string }) => {
    seen.push(system);
    const who = Object.keys(replies).find((id) => system.includes(id));
    if (!who) throw new Error(`no script for system: ${system}`);
    void prompt;
    return replies[who]!;
  };
  return Object.assign(ask, { seen });
}

test("the strongest willing claim wins", async () => {
  const ask = scripted({
    josefina: '{"willing": true, "confidence": 0.9, "reason": "coordination is my job"}',
    osvaldo: '{"willing": false, "confidence": 0.2, "reason": "I would rather build"}',
  });
  const result = await runElection(ask, { name: "onboarding" }, [
    cand("josefina", "Product Manager"),
    cand("osvaldo", "Backend Engineer", "senior"),
  ]);
  assert.equal(result.leader, "josefina");
  assert.equal(result.method, "vote");
  assert.equal(result.claims.length, 2);
});

test("each member is asked in ISOLATION — its own directives, nobody else's claim", async () => {
  const ask = scripted({
    josefina: '{"willing": true, "confidence": 0.9, "reason": "mine"}',
    osvaldo: '{"willing": true, "confidence": 0.1, "reason": "ok"}',
  });
  await runElection(ask, { name: "onboarding" }, [
    cand("josefina", "Product Manager"),
    cand("osvaldo", "Backend Engineer"),
  ]);
  assert.equal(ask.seen.length, 2);
  assert.ok(ask.seen[0]!.includes("josefina") && !ask.seen[0]!.includes("osvaldo"));
  assert.ok(ask.seen[1]!.includes("osvaldo") && !ask.seen[1]!.includes("josefina"));
});

test("everyone declining falls to the ladder and reports method rank", async () => {
  const ask = scripted({
    josefina: '{"willing": false, "confidence": 0, "reason": "no"}',
    osvaldo: '{"willing": false, "confidence": 0, "reason": "no"}',
  });
  const result = await runElection(ask, { name: "onboarding" }, [
    cand("osvaldo", "Backend Engineer", "senior"),
    cand("josefina", "Product Manager"),
  ]);
  assert.equal(result.leader, "josefina"); // the ladder, not roster order
  assert.equal(result.method, "rank");
});

test("a malformed reply is a decline, and the election still resolves", async () => {
  const ask = scripted({
    josefina: "I think I would be great at this, honestly",
    osvaldo: '{"willing": true, "confidence": 0.5, "reason": "sure"}',
  });
  const result = await runElection(ask, { name: "onboarding" }, [
    cand("josefina", "Product Manager"),
    cand("osvaldo", "Backend Engineer"),
  ]);
  assert.equal(result.leader, "osvaldo");
  assert.equal(result.claims.find((c) => c.agent === "josefina")?.willing, false);
});

test("one member throwing does not sink the election", async () => {
  const ask: AskFactory = async ({ system }) => {
    if (system.includes("josefina")) throw new Error("rate limited");
    return '{"willing": true, "confidence": 0.6, "reason": "ok"}';
  };
  const result = await runElection(ask, { name: "onboarding" }, [
    cand("josefina", "Product Manager"),
    cand("osvaldo", "Backend Engineer"),
  ]);
  assert.equal(result.leader, "osvaldo");
});

test("the model being wholly unavailable falls to the ladder — never leaderless", async () => {
  const ask: AskFactory = async () => {
    throw new Error("no api key");
  };
  const result = await runElection(ask, { name: "onboarding" }, [
    cand("osvaldo", "Backend Engineer", "developer"),
    cand("josefina", "Product Manager"),
  ]);
  assert.equal(result.leader, "josefina");
  assert.equal(result.method, "rank");
});

test("parseClaim clamps confidence into 0..1 and coerces willing", () => {
  assert.equal(parseClaim("a", '{"willing": true, "confidence": 4, "reason": "x"}').confidence, 1);
  assert.equal(parseClaim("a", '{"willing": true, "confidence": -2, "reason": "x"}').confidence, 0);
  assert.equal(parseClaim("a", '{"willing": "yes", "confidence": 0.5, "reason": "x"}').willing, true);
});

test("parseClaim finds JSON inside chatter", () => {
  const claim = parseClaim("a", 'Sure! {"willing": true, "confidence": 0.7, "reason": "I coordinate"} hope that helps');
  assert.equal(claim.willing, true);
  assert.equal(claim.confidence, 0.7);
});

test("parseClaim keeps the raw text as the reason when it cannot parse, for debugging", () => {
  const claim = parseClaim("a", "absolutely not");
  assert.equal(claim.willing, false);
  assert.equal(claim.confidence, 0);
  assert.match(claim.reason, /absolutely not/);
});

test("makeClaimAsk: a swarm reply wins and the broker is never asked", async () => {
  const brokerCalls: string[] = [];
  const ask = makeClaimAsk({
    swarmOneShot: async (agentId) => ({ reply: `{"willing": true, "confidence": 0.8, "reason": "${agentId} says yes"}` }),
    brokerAsk: async ({ system }) => {
      brokerCalls.push(system);
      return "never";
    },
  });
  const raw = await ask({ agentId: "sage", system: "persona", prompt: "lead?" });
  assert.match(raw, /sage says yes/);
  assert.equal(brokerCalls.length, 0);
});

test("makeClaimAsk: notApiAgent falls back to the broker ask with the member's own persona", async () => {
  const ask = makeClaimAsk({
    swarmOneShot: async () => ({ notApiAgent: true }),
    brokerAsk: async ({ system, prompt }) => `broker(${system})[${prompt.slice(0, 4)}]`,
  });
  assert.equal(await ask({ agentId: "osvaldo", system: "builder persona", prompt: "lead?" }), "broker(builder persona)[lead]");
});

test("makeClaimAsk: any other swarm failure propagates — no second paid ask, and runElection records the reason", async () => {
  const brokerCalls: string[] = [];
  const ask = makeClaimAsk({
    swarmOneShot: async () => {
      throw new Error("Anthropic refused the turn over credits or rate limits — top up the account, then retry");
    },
    brokerAsk: async () => {
      brokerCalls.push("asked");
      return "never";
    },
  });
  await assert.rejects(() => ask({ agentId: "sage", system: "s", prompt: "p" }), /top up the account/);
  assert.equal(brokerCalls.length, 0);
  // Through runElection, that failure becomes a decline carrying the reason.
  const result = await runElection(ask, { name: "g" }, [
    { id: "sage", name: "Sage", role: "Advisor", directives: "d" },
    { id: "ana", name: "Ana", role: "Product Manager", directives: "d" },
  ]);
  assert.ok(result.claims.every((c) => !c.willing && /top up|unreachable/.test(c.reason)));
  assert.equal(result.method, "rank"); // the ladder still floors a leader
  assert.equal(result.leader, "ana");
});
