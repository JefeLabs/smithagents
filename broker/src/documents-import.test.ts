import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
      workspaces: WORKSPACES,
      client: {
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
      workspaces: WORKSPACES,
      client: {
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
      workspaces: WORKSPACES,
      client: { importDocument: async () => ({ id: "x" }) },
    });
    assert.deepEqual(r, { imported: [], notes: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Fix round 1 ──────────────────────────────────────────────────────────

test("importLegacyDocuments: a second run is a true no-op — nothing re-imported, nothing re-noted, nothing changed", async () => {
  const { root, documentsDir, sessionsDir } = fixture();
  try {
    const client = {
      importDocument: async (_ws: string, doc: unknown) => ({ id: `new-${(doc as { id: string }).id}` }),
    };
    const first = await importLegacyDocuments({
      documentsDir,
      sessionsDir,
      stamp: "run1",
      workspaces: WORKSPACES,
      log: () => {},
      client,
    });
    assert.equal(first.imported.length, 2);
    const archived = `${documentsDir}-archived-run1`;
    assert.ok(statSync(archived).isDirectory());

    // A real second boot's readdir hits the now-archived (missing) path —
    // that IS what idempotence means at this layer: nothing left to import.
    const second = await importLegacyDocuments({
      documentsDir,
      sessionsDir,
      stamp: "run2",
      workspaces: WORKSPACES,
      log: () => {},
      client,
    });
    assert.deepEqual(second, { imported: [], notes: [] });
    assert.ok(statSync(archived).isDirectory(), "the first archive is untouched");
    assert.throws(() => statSync(`${documentsDir}-archived-run2`), "no second archive was created");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("importLegacyDocuments: no active workspace (what main.ts's own .catch(() => []) produces when the swarm is down at boot) does not throw", async () => {
  const { root, documentsDir, sessionsDir } = fixture();
  try {
    const r = await importLegacyDocuments({
      documentsDir,
      sessionsDir,
      stamp: "s",
      log: () => {},
      workspaces: [], // simulates swarm.listWorkspaces().catch(() => []) upstream in main.ts
      client: { importDocument: async () => ({ id: "should-not-be-called" }) },
    });
    assert.deepEqual(r.imported, []);
    assert.ok(r.notes.some((n) => /d1\.json/.test(n) && /no active workspace/.test(n)));
    assert.ok(r.notes.some((n) => /d2\.json/.test(n) && /no active workspace/.test(n)));
    assert.ok(statSync(documentsDir).isDirectory(), "not archived — nothing succeeded, so the next boot retries");
    assert.deepEqual(
      JSON.parse(readFileSync(join(sessionsDir, "s1.json"), "utf8")).artifacts,
      ["d1", "d2", "keep-me"],
      "nothing remapped",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("importLegacyDocuments: a failing rename (ENOTEMPTY reproduced) rejects — the caller's own catch is what keeps the broker up", async () => {
  const { root, documentsDir, sessionsDir } = fixture();
  try {
    const archived = `${documentsDir}-archived-collide`;
    mkdirSync(archived);
    writeFileSync(join(archived, "occupied.txt"), "pre-existing content blocks rename onto this directory");
    const client = {
      importDocument: async (_ws: string, doc: unknown) => ({ id: `new-${(doc as { id: string }).id}` }),
    };
    await assert.rejects(() =>
      importLegacyDocuments({
        documentsDir,
        sessionsDir,
        stamp: "collide",
        workspaces: WORKSPACES,
        log: () => {},
        client,
      }),
    );
    // Nothing was lost: the source directory is exactly where it was, and
    // the imports/remaps that already landed before rename() threw are on
    // disk regardless — only the archive step (and this call's return
    // value) is what a retry redoes.
    assert.ok(statSync(documentsDir).isDirectory());
    assert.deepEqual(JSON.parse(readFileSync(join(sessionsDir, "s1.json"), "utf8")).artifacts, [
      "new-d1",
      "new-d2",
      "keep-me",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("importLegacyDocuments: an unwritable session file is noted and blocks archiving, not silently dropped", async () => {
  const { root, documentsDir, sessionsDir } = fixture();
  const sessionPath = join(sessionsDir, "s1.json");
  try {
    chmodSync(sessionPath, 0o444);
    const client = {
      importDocument: async (_ws: string, doc: unknown) => ({ id: `new-${(doc as { id: string }).id}` }),
    };
    const r = await importLegacyDocuments({
      documentsDir,
      sessionsDir,
      stamp: "s",
      workspaces: WORKSPACES,
      log: () => {},
      client,
    });
    assert.deepEqual(
      r.imported,
      [
        { from: "d1", to: "new-d1" },
        { from: "d2", to: "new-d2" },
      ],
      "both documents still imported",
    );
    assert.ok(r.notes.some((n) => /s1\.json/.test(n) && /not remapped/.test(n)));
    assert.ok(
      statSync(documentsDir).isDirectory(),
      "not archived — the session write failed, so the next boot retries",
    );
    assert.deepEqual(
      JSON.parse(readFileSync(sessionPath, "utf8")).artifacts,
      ["d1", "d2", "keep-me"],
      "the on-disk session is untouched, not half-written",
    );
  } finally {
    chmodSync(sessionPath, 0o644);
    rmSync(root, { recursive: true, force: true });
  }
});

test("importLegacyDocuments: two documents colliding on the same imported id are not silently merged, and the run still reaches a terminal state", async () => {
  const { root, documentsDir, sessionsDir } = fixture();
  const loserBytes = readFileSync(join(documentsDir, "d2.json"));
  const logged: string[] = [];
  try {
    const client = {
      importDocument: async (_ws: string, doc: unknown) => {
        const id = (doc as { id: string }).id;
        if (id === "d1") return { id: "shared-target" };
        // d2 derives the very same target filename as d1, within this SAME
        // run — the swarm reports it exactly like a genuine cross-boot
        // re-import (409), which is what makes the two indistinguishable
        // without this run's own idMap.
        throw Object.assign(new Error("already imported as shared-target"), { status: 409 });
      },
    };
    const r = await importLegacyDocuments({
      documentsDir,
      sessionsDir,
      stamp: "s",
      workspaces: WORKSPACES,
      log: (l) => logged.push(l),
      client,
    });
    assert.deepEqual(
      r.imported,
      [{ from: "d1", to: "shared-target" }],
      "the collision loser is not reported as imported",
    );

    // The note is LOUD, names the WINNER's id, names where the loser went, and
    // says what to do about it. It must NOT promise a retry: the derivation is
    // deterministic, so the retry never succeeds and a fourth boot printed
    // byte-identical output (final-review Important 3).
    const note = r.notes.find((n) => /d2\.json/.test(n));
    assert.ok(note, `no note about d2.json: ${JSON.stringify(r.notes)}`);
    assert.match(note, /COLLISION/);
    assert.match(note, /shared-target/, "names the winner's id");
    assert.match(note, new RegExp(`${documentsDir}-unimportable-s`), "names where the loser was set aside");
    assert.match(note, /edit its title or createdAt/, "tells the operator what to do");
    assert.doesNotMatch(note, /will retry next boot/, "a promise the code cannot keep");
    assert.ok(logged.includes(note), "and it is logged live, not only returned");

    // Terminal state: the migration completes, so the next boot is a no-op
    // rather than a byte-identical replay of this one.
    assert.ok(statSync(`${documentsDir}-archived-s`).isDirectory(), "the run completes and the directory is archived");
    assert.throws(() => statSync(documentsDir), "the source directory is gone, so the next boot re-walks nothing");

    // The loser's bytes are recoverable, EXACTLY as they were, and never in
    // the archive where they would look imported.
    const sidecar = `${documentsDir}-unimportable-s`;
    assert.deepEqual(readFileSync(join(sidecar, "d2.json")), loserBytes, "moved, byte for byte — never rewritten");
    assert.throws(() => statSync(join(`${documentsDir}-archived-s`, "d2.json")), "not swept into the archive");

    assert.deepEqual(
      JSON.parse(readFileSync(join(sessionsDir, "s1.json"), "utf8")).artifacts,
      ["shared-target", "d2", "keep-me"],
      "only the winner is remapped — the loser never reached the store",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("importLegacyDocuments: a *.json file that isn't a legacy document filename is noted, not silently swept into the archive", async () => {
  const { root, documentsDir, sessionsDir } = fixture();
  try {
    writeFileSync(join(documentsDir, "backup.json"), JSON.stringify({ not: "a legacy doc" }));
    const client = {
      importDocument: async (_ws: string, doc: unknown) => ({ id: `new-${(doc as { id: string }).id}` }),
    };
    const r = await importLegacyDocuments({
      documentsDir,
      sessionsDir,
      stamp: "s",
      workspaces: WORKSPACES,
      log: () => {},
      client,
    });
    assert.ok(r.notes.some((n) => /backup\.json/.test(n)));
    assert.deepEqual(
      r.imported,
      [
        { from: "d1", to: "new-d1" },
        { from: "d2", to: "new-d2" },
      ],
      "backup.json was never treated as a document to import",
    );
    assert.ok(statSync(join(`${documentsDir}-archived-s`, "backup.json")).isFile(), "still archived, never deleted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("importLegacyDocuments: a permanently unimportable document (400) is moved aside with a loud note; the rest of the migration completes", async () => {
  const { root, documentsDir, sessionsDir } = fixture();
  try {
    const client = {
      importDocument: async (_ws: string, doc: unknown) => {
        const id = (doc as { id: string }).id;
        if (id === "d1") throw Object.assign(new Error("Invalid blueprintId: spec"), { status: 400 });
        return { id: `new-${id}` };
      },
    };
    const r = await importLegacyDocuments({
      documentsDir,
      sessionsDir,
      stamp: "s",
      workspaces: WORKSPACES,
      log: () => {},
      client,
    });
    assert.deepEqual(
      r.imported,
      [{ from: "d2", to: "new-d2" }],
      "the unimportable document is not reported as imported",
    );
    assert.ok(r.notes.some((n) => /UNIMPORTABLE/.test(n) && /d1\.json/.test(n) && /Invalid blueprintId/.test(n)));
    const sidecar = `${documentsDir}-unimportable-s`;
    assert.ok(statSync(join(sidecar, "d1.json")).isFile(), "the bytes are recoverable in the sidecar, never deleted");
    assert.throws(
      () => statSync(join(`${documentsDir}-archived-s`, "d1.json")),
      "d1.json did not end up in the archive",
    );
    assert.ok(statSync(`${documentsDir}-archived-s`).isDirectory(), "the rest of the migration still completes");
    assert.deepEqual(
      JSON.parse(readFileSync(join(sessionsDir, "s1.json"), "utf8")).artifacts,
      ["d1", "new-d2", "keep-me"],
      "d1 stays unremapped — it was never imported",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
