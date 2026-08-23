import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { importLegacyDocuments } from "./documents-import.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "docimport-"));
  const documentsDir = join(root, "documents");
  const sessionsDir = join(root, "sessions");
  mkdirSync(documentsDir);
  mkdirSync(sessionsDir);
  writeFileSync(
    join(documentsDir, "d1.json"),
    JSON.stringify({
      id: "d1",
      title: "Pinned",
      blueprintId: "spec",
      workType: "feature",
      sections: [],
      participants: [],
      proposals: [],
      pins: ["group:team", "other"],
      status: "drafting",
      createdAt: "2026-08-17T13:25:18.588Z",
      updatedAt: "2026-08-17T13:25:18.639Z",
    }),
  );
  writeFileSync(
    join(documentsDir, "d2.json"),
    JSON.stringify({
      id: "d2",
      title: "Unpinned",
      blueprintId: "spec",
      workType: "feature",
      sections: [],
      participants: [],
      proposals: [],
      status: "drafting",
      createdAt: "2026-08-19T17:17:17.910Z",
      updatedAt: "2026-08-19T17:17:17.910Z",
    }),
  );
  writeFileSync(join(documentsDir, "notes.txt"), "ignored");
  writeFileSync(join(sessionsDir, "s1.json"), JSON.stringify({ id: "s1", artifacts: ["d1", "d2", "keep-me"] }));
  return { root, documentsDir, sessionsDir };
}
const WORKSPACES = [{ name: "pg", default: true }, { name: "other" }, { name: "gone", archived: true }];

test("importLegacyDocuments: first matching pin wins, else the default workspace; ids are remapped in sessions; the dir is archived", async () => {
  const { root, documentsDir, sessionsDir } = fixture();
  try {
    const calls: Array<[string, string]> = [];
    const r = await importLegacyDocuments({
      documentsDir,
      sessionsDir,
      stamp: "20260822T120000",
      log: () => {},
      client: {
        listWorkspaces: async () => WORKSPACES,
        importDocument: async (ws, doc) => {
          calls.push([ws, (doc as { id: string }).id]);
          return { id: `new-${(doc as { id: string }).id}` };
        },
      },
    });
    assert.deepEqual(calls, [
      ["other", "d1"],
      ["pg", "d2"],
    ]);
    assert.deepEqual(r.imported, [
      { from: "d1", to: "new-d1" },
      { from: "d2", to: "new-d2" },
    ]);
    assert.deepEqual(JSON.parse(readFileSync(join(sessionsDir, "s1.json"), "utf8")).artifacts, [
      "new-d1",
      "new-d2",
      "keep-me",
    ]);
    assert.ok(statSync(`${documentsDir}-archived-20260822T120000`).isDirectory());
    assert.throws(() => statSync(documentsDir));
    assert.ok(statSync(join(`${documentsDir}-archived-20260822T120000`, "notes.txt")).isFile(), "nothing deleted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("importLegacyDocuments: a 409 means already imported and still counts; any other failure leaves the directory for the next boot", async () => {
  const { root, documentsDir, sessionsDir } = fixture();
  try {
    const r = await importLegacyDocuments({
      documentsDir,
      sessionsDir,
      stamp: "s",
      log: () => {},
      client: {
        listWorkspaces: async () => WORKSPACES,
        importDocument: async (_ws, doc) => {
          if ((doc as { id: string }).id === "d1")
            throw Object.assign(new Error("already imported as 2026-08-17-1325-pinned-design"), { status: 409 });
          throw Object.assign(new Error("swarm down"), { status: 502 });
        },
      },
    });
    assert.deepEqual(r.imported, [{ from: "d1", to: "2026-08-17-1325-pinned-design" }]);
    assert.ok(r.notes.some((n) => /d2/.test(n) && /swarm down/.test(n)));
    assert.ok(statSync(documentsDir).isDirectory(), "not archived while anything is unimported");
    assert.deepEqual(
      JSON.parse(readFileSync(join(sessionsDir, "s1.json"), "utf8")).artifacts,
      ["2026-08-17-1325-pinned-design", "d2", "keep-me"],
      "what did import is remapped now",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("importLegacyDocuments: an absent documents dir is a no-op", async () => {
  const root = mkdtempSync(join(tmpdir(), "docimport-none-"));
  try {
    const r = await importLegacyDocuments({
      documentsDir: join(root, "nope"),
      sessionsDir: join(root, "sessions"),
      stamp: "s",
      log: () => {},
      client: { listWorkspaces: async () => WORKSPACES, importDocument: async () => ({ id: "x" }) },
    });
    assert.deepEqual(r, { imported: [], notes: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
