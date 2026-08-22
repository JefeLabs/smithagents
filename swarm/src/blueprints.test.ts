import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { activeSections, DEFAULT_BLUEPRINTS, instantiateSections, loadBlueprintsFor } from "./blueprints.js";
import { smithPaths } from "./paths.js";

test("defaults: every blueprint declares a folder, and the shaped sections carry a shape", () => {
  const byId = new Map(DEFAULT_BLUEPRINTS.map((b) => [b.id, b]));
  assert.equal(byId.get("spec")?.folder, "specs");
  assert.equal(byId.get("er")?.folder, "specs");
  assert.equal(byId.get("sequence")?.folder, "specs");
  assert.equal(byId.get("implementation-plan")?.folder, "plans");
  assert.equal(byId.get("dashboard")?.folder, "dashboards");
  assert.equal(byId.get("er")?.sections[0].shape, "mermaid");
  assert.equal(byId.get("implementation-plan")?.sections.find((s) => s.id === "tasks")?.shape, "checklist");
});

test("loadBlueprintsFor: org files override defaults by id, workspace files override org files", async () => {
  const root = mkdtempSync(join(tmpdir(), "bp-"));
  try {
    const paths = smithPaths(root);
    mkdirSync(join(paths.orgRepo, "blueprints"), { recursive: true });
    mkdirSync(join(paths.orgRepo, "workspaces", "pg", "blueprints"), { recursive: true });
    writeFileSync(
      join(paths.orgRepo, "blueprints", "spec.json"),
      JSON.stringify({
        id: "spec",
        name: "Org Spec",
        family: "document",
        workTypes: ["feature"],
        folder: "specs",
        sections: [{ id: "overview", heading: "Overview", required: true }],
      }),
    );
    writeFileSync(
      join(paths.orgRepo, "blueprints", "adr.json"),
      JSON.stringify({
        id: "adr",
        name: "Decision record",
        workTypes: ["feature"],
        sections: [{ id: "decision", heading: "Decision" }],
      }),
    );
    writeFileSync(
      join(paths.orgRepo, "workspaces", "pg", "blueprints", "spec.json"),
      JSON.stringify({
        id: "spec",
        name: "PG Spec",
        family: "document",
        workTypes: ["feature"],
        folder: "specs",
        sections: [{ id: "overview", heading: "Overview" }],
      }),
    );
    writeFileSync(join(paths.orgRepo, "blueprints", "broken.json"), "{ nope");

    const org = await loadBlueprintsFor(paths);
    assert.equal(org.find((b) => b.id === "spec")?.name, "Org Spec");
    assert.equal(org.find((b) => b.id === "adr")?.folder, "specs", "a user file without folder defaults to specs");
    assert.equal(org.find((b) => b.id === "adr")?.family, "document");
    const ws = await loadBlueprintsFor(paths, "pg");
    assert.equal(ws.find((b) => b.id === "spec")?.name, "PG Spec");
    assert.ok(
      ws.some((b) => b.id === "dashboard"),
      "defaults survive a broken user file",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadBlueprintsFor: a workspaceName that slugs to nothing degrades to org+defaults instead of throwing", async () => {
  const root = mkdtempSync(join(tmpdir(), "bp-badname-"));
  try {
    const paths = smithPaths(root);
    mkdirSync(join(paths.orgRepo, "blueprints"), { recursive: true });
    writeFileSync(
      join(paths.orgRepo, "blueprints", "spec.json"),
      JSON.stringify({
        id: "spec",
        name: "Org Spec",
        family: "document",
        workTypes: ["feature"],
        folder: "specs",
        sections: [{ id: "overview", heading: "Overview", required: true }],
      }),
    );
    const all = await loadBlueprintsFor(paths, "!!!");
    assert.equal(all.find((b) => b.id === "spec")?.name, "Org Spec", "org override still applies");
    for (const id of ["spec", "implementation-plan", "er", "sequence", "dashboard"]) {
      assert.ok(
        all.some((b) => b.id === id),
        `default ${id} present`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadBlueprintsFor: neither org nor workspace blueprints directory exists — exactly the five defaults come back", async () => {
  const root = mkdtempSync(join(tmpdir(), "bp-nodirs-"));
  try {
    const paths = smithPaths(root);
    const org = await loadBlueprintsFor(paths);
    assert.deepEqual(org.map((b) => b.id).sort(), DEFAULT_BLUEPRINTS.map((b) => b.id).sort());
    const ws = await loadBlueprintsFor(paths, "pg");
    assert.deepEqual(ws.map((b) => b.id).sort(), DEFAULT_BLUEPRINTS.map((b) => b.id).sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadBlueprintsFor: a user file with an invalid folder or shape is skipped, not coerced", async () => {
  const root = mkdtempSync(join(tmpdir(), "bp-bad-"));
  try {
    const paths = smithPaths(root);
    mkdirSync(join(paths.orgRepo, "blueprints"), { recursive: true });
    writeFileSync(
      join(paths.orgRepo, "blueprints", "x.json"),
      JSON.stringify({ id: "x", name: "X", workTypes: ["f"], folder: "attic", sections: [] }),
    );
    writeFileSync(
      join(paths.orgRepo, "blueprints", "y.json"),
      JSON.stringify({ id: "y", name: "Y", workTypes: ["f"], sections: [{ id: "a", heading: "A", shape: "regex" }] }),
    );
    const all = await loadBlueprintsFor(paths);
    assert.ok(!all.some((b) => b.id === "x"));
    assert.ok(!all.some((b) => b.id === "y"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("instantiateSections / activeSections: per-workType activation, starters as bodies", () => {
  const spec = DEFAULT_BLUEPRINTS.find((b) => b.id === "spec")!;
  assert.equal(instantiateSections(spec, "nope"), null);
  assert.deepEqual(
    activeSections(spec, "bugfix").map((s) => s.id),
    ["overview", "repro", "approach", "non-goals", "testing"],
  );
  const er = DEFAULT_BLUEPRINTS.find((b) => b.id === "er")!;
  assert.match(instantiateSections(er, "feature")![0].body, /^```mermaid/);
});
