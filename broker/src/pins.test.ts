import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { docSeedsInWorkspace } from "./pins.ts";

const groups = [
  { name: "frontend", expansion: ["acme-web", "labs"] },
  { name: "acme", expansion: ["acme-web", "acme-api"] },
];

describe("docSeedsInWorkspace", () => {
  it("bare workspace pin matches exactly", () => {
    assert.equal(docSeedsInWorkspace(["acme-web"], "acme-web", groups), true);
    assert.equal(docSeedsInWorkspace(["acme-web"], "acme-api", groups), false);
  });
  it("group pin flows DOWN to member workspaces (spec decision 4)", () => {
    assert.equal(docSeedsInWorkspace(["group:frontend"], "labs", groups), true);
    assert.equal(docSeedsInWorkspace(["group:frontend"], "acme-api", groups), false);
  });
  it("a deleted group's pin is skipped, never throws (spec §3)", () => {
    assert.equal(docSeedsInWorkspace(["group:gone"], "acme-web", groups), false);
  });
  it("no pins seeds nowhere; a workspace named like a group does not collide", () => {
    assert.equal(docSeedsInWorkspace(undefined, "acme-web", groups), false);
    assert.equal(docSeedsInWorkspace(["frontend"], "labs", groups), false); // bare "frontend" is a WORKSPACE name
  });
});
