import assert from "node:assert/strict";
import { test } from "node:test";
import { LocalMemory, type MemoryEntry, tokenize } from "./memory.ts";

function makeMemory(seed: MemoryEntry[] = []) {
  let saved = [...seed];
  const store = {
    load: () => [...saved],
    save: (entries: MemoryEntry[]) => {
      saved = [...entries];
    },
  };
  return { memory: new LocalMemory(store), saved: () => saved };
}

test("tokenize drops stopwords and folds accents", () => {
  assert.deepEqual(tokenize("The sesión is with you"), ["sesion"]);
});

test("remember persists; the same key in the same scope updates instead of duplicating", () => {
  const { memory, saved } = makeMemory();
  memory.remember({ key: "pr-style", text: "Edwin prefers draft PRs", scope: { workspace: "jefelabs" } });
  memory.remember({
    key: "pr-style",
    text: "Edwin prefers draft PRs with a task summary",
    scope: { workspace: "jefelabs" },
  });
  assert.equal(saved().length, 1);
  assert.match(saved()[0]!.text, /task summary/);
});

test("same key in a DIFFERENT scope is a separate memory", () => {
  const { memory, saved } = makeMemory();
  memory.remember({ key: "branch", text: "builds off main", scope: { workspace: "jefelabs" } });
  memory.remember({ key: "branch", text: "builds off develop", scope: { workspace: "skoolscout" } });
  assert.equal(saved().length, 2);
});

test("recall ranks by term overlap and returns the relevant entry", () => {
  const { memory } = makeMemory();
  memory.remember({ key: "pr-style", text: "Edwin prefers draft pull requests for review", scope: { workspace: "w" } });
  memory.remember({ key: "lunch", text: "the crew takes lunch at noon", scope: { workspace: "w" } });
  const hits = memory.recall({ text: "how should we open a pull request?", scope: { workspace: "w" } });
  assert.equal(hits[0]?.key, "pr-style");
  assert.ok(!hits.some((h) => h.key === "lunch"), "unrelated memory stays out");
});

test("scope isolation: a session note never leaks into another session", () => {
  const { memory } = makeMemory();
  memory.remember({
    key: "secret-plan",
    text: "we are rewriting the composer",
    scope: { workspace: "w", session: "s1" },
  });
  const own = memory.recall({ text: "composer rewrite", scope: { workspace: "w", session: "s1" } });
  const other = memory.recall({ text: "composer rewrite", scope: { workspace: "w", session: "s2" } });
  assert.equal(own.length, 1);
  assert.equal(other.length, 0);
});

test("workspace facts reach every session inside that workspace, but not other workspaces", () => {
  const { memory } = makeMemory();
  memory.remember({ key: "branch", text: "this workspace builds off main", scope: { workspace: "jefelabs" } });
  assert.equal(
    memory.recall({ text: "which branch do we build off", scope: { workspace: "jefelabs", session: "any" } }).length,
    1,
  );
  assert.equal(
    memory.recall({ text: "which branch do we build off", scope: { workspace: "other", session: "any" } }).length,
    0,
  );
});

test("forget removes only the addressed scope", () => {
  const { memory, saved } = makeMemory();
  memory.remember({ key: "branch", text: "main", scope: { workspace: "a" } });
  memory.remember({ key: "branch", text: "develop", scope: { workspace: "b" } });
  assert.equal(memory.forget("branch", { workspace: "a" }), true);
  assert.equal(memory.forget("branch", { workspace: "zzz" }), false);
  assert.deepEqual(
    saved().map((e) => e.text),
    ["develop"],
  );
});

test("recall survives a restart — the store is the source of truth", () => {
  const { memory, saved } = makeMemory();
  memory.remember({ key: "voice", text: "Manuel speaks with a warm Dominican accent", scope: {} });
  const reopened = new LocalMemory({ load: () => saved(), save: () => {} });
  assert.equal(reopened.recall({ text: "what accent does Manuel have", scope: {} })[0]?.key, "voice");
});

test('morphology does not defeat recall: "branches" answers "branch"', () => {
  const { memory } = makeMemory();
  memory.remember({
    key: "branching-source",
    text: "Always cut branches from main, never from develop.",
    scope: { workspace: "w" },
  });
  const hits = memory.recall({
    text: "which branch should a new feature branch come off of?",
    scope: { workspace: "w" },
  });
  assert.equal(hits[0]?.key, "branching-source");
});
