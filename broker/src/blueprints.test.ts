import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { instantiateSections, loadBlueprints } from "./blueprints.ts";

test("defaults ship spec and implementation-plan", () => {
  const bps = loadBlueprints(join(tmpdir(), "no-such-dir"));
  assert.deepEqual(bps.map((b) => b.id).sort(), ["implementation-plan", "spec"]);
});

test("user files merge over defaults by id and add new ids", () => {
  const dir = mkdtempSync(join(tmpdir(), "bp-"));
  writeFileSync(
    join(dir, "spec.json"),
    JSON.stringify({
      id: "spec",
      name: "My Spec",
      workTypes: ["feature"],
      sections: [{ id: "only", heading: "Only" }],
    }),
  );
  writeFileSync(
    join(dir, "adr.json"),
    JSON.stringify({
      id: "adr",
      name: "ADR",
      workTypes: ["decision"],
      sections: [{ id: "context", heading: "Context" }],
    }),
  );
  const bps = loadBlueprints(dir);
  const spec = bps.find((b) => b.id === "spec");
  assert.equal(spec?.name, "My Spec");
  assert.equal(spec?.sections.length, 1);
  assert.ok(bps.some((b) => b.id === "adr"));
});

test("a malformed user file is skipped, defaults survive", () => {
  const dir = mkdtempSync(join(tmpdir(), "bp-"));
  writeFileSync(join(dir, "broken.json"), "{not json");
  const bps = loadBlueprints(dir);
  assert.ok(bps.some((b) => b.id === "spec"));
});

test("instantiateSections activates conditional sections per workType", () => {
  const bp = {
    id: "x",
    name: "X",
    family: "document" as const,
    workTypes: ["feature", "bugfix"],
    sections: [
      { id: "a", heading: "Always" },
      { id: "b", heading: "Bugfix only", when: { workType: ["bugfix"] } },
      { id: "f", heading: "Feature only", when: { workType: ["feature"] } },
    ],
  };
  assert.deepEqual(
    instantiateSections(bp, "bugfix")?.map((s) => s.id),
    ["a", "b"],
  );
  assert.deepEqual(
    instantiateSections(bp, "feature")?.map((s) => s.id),
    ["a", "f"],
  );
});

test("instantiateSections rejects an undeclared workType", () => {
  const bp = {
    id: "x",
    name: "X",
    family: "document" as const,
    workTypes: ["feature"],
    sections: [{ id: "a", heading: "A" }],
  };
  assert.equal(instantiateSections(bp, "bugfix"), null);
});

test("instantiated sections start with empty bodies", () => {
  const bp = {
    id: "x",
    name: "X",
    family: "document" as const,
    workTypes: ["feature"],
    sections: [{ id: "a", heading: "A" }],
  };
  assert.deepEqual(instantiateSections(bp, "feature"), [{ id: "a", heading: "A", body: "" }]);
});

test("default blueprints declare a family; spec and plan are documents", () => {
  const bps = loadBlueprints(join(tmpdir(), "no-such-dir"));
  assert.equal(bps.find((b) => b.id === "spec")?.family, "document");
  assert.equal(bps.find((b) => b.id === "implementation-plan")?.family, "document");
  // Every blueprint must declare a family (no undefined leaks to the UI grouping).
  assert.ok(bps.every((b) => b.family === "document" || b.family === "diagram"));
});

test("a user blueprint file without family defaults to document", () => {
  const dir = mkdtempSync(join(tmpdir(), "bp-"));
  writeFileSync(
    join(dir, "custom.json"),
    JSON.stringify({ id: "custom", name: "Custom", workTypes: ["feature"], sections: [{ id: "s", heading: "S" }] }),
  );
  const bp = loadBlueprints(dir).find((b) => b.id === "custom");
  assert.equal(bp?.family, "document");
});
