import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  type DelegationClaims,
  delegationKey,
  mintDelegationToken,
  scopeDelegatedTask,
  verifyDelegationToken,
} from "./delegation-token.js";

const claims: DelegationClaims = {
  task: "t1",
  workspace: "acme",
  repo: "web",
  branch: "dev",
  runtime: "docker",
  depth: 0,
};
const key = delegationKey("admin-secret");

test("mint/verify: a token round-trips its claims", () => {
  assert.deepEqual(verifyDelegationToken(key, mintDelegationToken(key, claims)), claims);
});

test("verify: refuses a changed payload, a foreign key, another prefix, garbage, and no key", () => {
  const [, , sig] = mintDelegationToken(key, claims).split(".");
  const forged = `sdt1.${Buffer.from(JSON.stringify({ ...claims, runtime: "tmux" })).toString("base64url")}.${sig}`;
  assert.equal(verifyDelegationToken(key, forged), null);
  assert.equal(verifyDelegationToken(delegationKey("other"), mintDelegationToken(key, claims)), null);
  assert.equal(verifyDelegationToken(key, mintDelegationToken(key, claims).replace("sdt1.", "sdt0.")), null);
  assert.equal(verifyDelegationToken(key, "sdt1.%%%.x"), null);
  assert.equal(verifyDelegationToken(undefined, mintDelegationToken(key, claims)), null);
});

test("scope: fills workspace/repo/branch/runtime from the claims and keeps only metadata.source", () => {
  const r = scopeDelegatedTask(claims, {
    prompt: "p",
    agent: "claude",
    priority: "high",
    location: "local",
    context: { files: ["a.ts"], repository: "", branch: "" },
    metadata: { source: "smith-delegate", workCardRef: { boardId: "b", cardId: "c" }, composedAgentId: "x" },
  });
  assert.deepEqual(r, {
    ok: true,
    body: {
      prompt: "p",
      agent: "claude",
      runtime: "docker",
      context: { files: ["a.ts"], repository: "", workspace: "acme", repo: "web", branch: "dev" },
      metadata: { source: "smith-delegate" },
    },
  });
});

test("scope: naming another workspace, repo or runtime is refused, not overridden", () => {
  const base = { prompt: "p", agent: "claude" as const, context: { files: [], repository: "", branch: "" } };
  assert.deepEqual(scopeDelegatedTask(claims, { ...base, context: { ...base.context, workspace: "other" } }), {
    ok: false,
    error: 'this task can only delegate within workspace "acme"',
  });
  assert.deepEqual(scopeDelegatedTask(claims, { ...base, context: { ...base.context, repo: "api" } }), {
    ok: false,
    error: 'this task can only delegate within repo "web"',
  });
  assert.deepEqual(scopeDelegatedTask(claims, { ...base, runtime: "tmux" }), {
    ok: false,
    error: "sub-tasks run on this task's runtime (docker)",
  });
});

test("scope: a task three levels down cannot delegate again", () => {
  const base = { prompt: "p", agent: "claude" as const, context: { files: [], repository: "", branch: "" } };
  assert.equal(scopeDelegatedTask({ ...claims, depth: 2 }, base).ok, true);
  assert.deepEqual(scopeDelegatedTask({ ...claims, depth: 3 }, base), {
    ok: false,
    error: "delegation depth limit (3) reached",
  });
});

test("scope: a delegated body keeps only the whitelisted fields", () => {
  const input = {
    taskId: "x",
    agentName: "n",
    model: "m",
    profile: { name: "a", role: "b", directives: "c" },
    pullRequest: { autoCreate: true },
    delegation: { parentTaskId: "z", depth: 0 },
    createdAt: "now",
    sneaky: 1,
    prompt: "p",
    agent: "claude",
    context: { files: ["a"], repository: "r", branch: "", repoPath: "/etc", extra: true },
    metadata: { source: "s", other: 1 },
  } as unknown as Parameters<typeof scopeDelegatedTask>[1];
  assert.deepEqual(scopeDelegatedTask(claims, input), {
    ok: true,
    body: {
      prompt: "p",
      agent: "claude",
      runtime: "docker",
      context: { files: ["a"], repository: "r", workspace: "acme", repo: "web", branch: "dev" },
      metadata: { source: "s" },
    },
  });
});

function signed(payloadObj: unknown): string {
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString("base64url");
  const sig = createHmac("sha256", key).update(`sdt1.${payload}`).digest("base64url");
  return `sdt1.${payload}.${sig}`;
}

test("verify: refuses non-canonical signature encodings", () => {
  const token = mintDelegationToken(key, claims);
  assert.deepEqual(verifyDelegationToken(key, token), claims);
  assert.equal(verifyDelegationToken(key, `${token}=`), null);
  // 32 bytes -> 43 chars; the last char carries 4 unused bits, so some other
  // last char decodes to the same bytes.
  const sig = token.split(".")[2] as string;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const orig = Buffer.from(sig, "base64url");
  const variant = [...alphabet]
    .map((c) => sig.slice(0, -1) + c)
    .find((v) => v !== sig && Buffer.from(v, "base64url").equals(orig));
  assert.ok(variant, "a same-bytes variant exists");
  assert.equal(verifyDelegationToken(key, token.replace(sig, variant as string)), null);
});

test("verify: returns only the known claim fields", () => {
  const v = verifyDelegationToken(key, signed({ ...claims, admin: true }));
  assert.deepEqual(v, claims);
  assert.equal("admin" in (v as object), false);
  const minted = mintDelegationToken(key, { ...claims, admin: true } as unknown as typeof claims);
  const body = JSON.parse(Buffer.from(minted.split(".")[1] as string, "base64url").toString());
  assert.equal("admin" in body, false);
});

test("delegationKey: an empty admin token throws", () => {
  assert.throws(() => delegationKey(""), /delegationKey: the admin token must be non-empty/);
});

test("mint: known-answer vector pins prefix, key derivation and signed string", () => {
  const k = delegationKey("kat-admin-token");
  const c: DelegationClaims = { task: "t", workspace: "w", repo: "r", branch: "b", runtime: "tmux", depth: 1 };
  assert.equal(
    mintDelegationToken(k, c),
    "sdt1.eyJ0YXNrIjoidCIsIndvcmtzcGFjZSI6InciLCJyZXBvIjoiciIsImJyYW5jaCI6ImIiLCJydW50aW1lIjoidG11eCIsImRlcHRoIjoxfQ.0fHAYERNEVprBfN9GbifT-__E6Cyd4y7jG5gn9EH7cI",
  );
});

test("verify: a correctly signed token with an invalid claims shape is refused", () => {
  for (const bad of [{ depth: -1 }, { depth: 1.5 }, { runtime: "host" }, { task: "" }]) {
    assert.equal(verifyDelegationToken(key, signed({ ...claims, ...bad })), null);
  }
});

test("scope: absent claim shows (default); depth outranks scope mismatches", () => {
  const base = { prompt: "p", agent: "claude" as const, context: { files: [], repository: "", branch: "" } };
  const { workspace: _w, ...noWs } = claims;
  assert.deepEqual(scopeDelegatedTask(noWs, { ...base, context: { ...base.context, workspace: "x" } }), {
    ok: false,
    error: 'this task can only delegate within workspace "(default)"',
  });
  assert.deepEqual(
    scopeDelegatedTask({ ...claims, depth: 3 }, { ...base, context: { ...base.context, workspace: "x" } }),
    {
      ok: false,
      error: "delegation depth limit (3) reached",
    },
  );
});
