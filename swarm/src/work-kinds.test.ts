import assert from "node:assert/strict";
import { test } from "node:test";
import { allPresetIds, columnLabel, DEFAULT_WORK_KIND, WORK_KINDS, workKindFor } from "./work-kinds.js";

test("work kinds are data keyed by id, not a union", () => {
  // Seven domains today, and the list grew from three in one conversation. A new
  // kind must be a data edit, never a code change.
  for (const id of ["product", "marketing", "sales", "consulting", "content", "creator", "trading"]) {
    assert.ok(WORK_KINDS[id], `${id} is a work kind`);
    assert.equal(WORK_KINDS[id].id, id, "the record key and the id agree");
    assert.ok(WORK_KINDS[id].label.length > 0, `${id} has a human label`);
  }
});

test("workKindFor: an unknown kind falls back to product, never to nothing", () => {
  assert.equal(workKindFor("no-such-kind").id, DEFAULT_WORK_KIND);
  assert.equal(workKindFor(undefined).id, DEFAULT_WORK_KIND);
  assert.equal(workKindFor("").id, DEFAULT_WORK_KIND);
});

test("workKindFor: a known kind is returned as itself", () => {
  assert.equal(workKindFor("marketing").id, "marketing");
});

test("columnLabel: each kind renames the four software columns", () => {
  const cases: Array<[string, string, string]> = [
    ["product", "complete", "Merged"],
    ["marketing", "define", "Brief"],
    ["marketing", "complete", "Live"],
    ["sales", "define", "Discovery"],
    ["sales", "complete", "Closed-won"],
    ["consulting", "breakdown", "Work packages"],
    ["content", "design", "Outline"],
    ["creator", "define", "Hook"],
    ["trading", "define", "Thesis"],
  ];
  for (const [kindId, columnId, expected] of cases) {
    const label = columnLabel(workKindFor(kindId), { id: columnId, name: "FALLBACK" });
    assert.equal(label, expected, `${kindId}.${columnId}`);
  }
});

test("columnLabel: a missing label degrades ONE cell, not the board", () => {
  const partial = { id: "partial", label: "Partial", columns: { define: "Brief" }, presets: [] };
  assert.equal(columnLabel(partial, { id: "define", name: "Spec" }), "Brief");
  // No entry for `design` — fall back to the template's own name rather than
  // rendering an empty column header.
  assert.equal(columnLabel(partial, { id: "design", name: "Tech design" }), "Tech design");
  assert.equal(columnLabel(partial, { id: "queue", name: "Queue" }), "Queue");
});

test("allPresetIds: the union of every kind's presets, plus custom", () => {
  const ids = allPresetIds();
  assert.ok(ids.has("custom"), "custom is always available");
  assert.ok(ids.has("jira"), "from product");
  assert.ok(ids.has("tickers"), "from trading");
  assert.ok(ids.has("tiktok"), "from creator");
  assert.ok(!ids.has("definitely-not-a-preset"));
});
