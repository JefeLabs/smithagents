import assert from "node:assert/strict";
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
