import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { DocumentsCache, docsSeedingWorkspace, makeSerialQueue, nextDefaultTitle } from "./documents-cache.ts";
import type { Doc } from "./swarm-client.ts";

function doc(id: string, workspace: string, pins: string[] = [], title = id): Doc {
  return {
    id,
    workspace,
    title,
    blueprintId: "spec",
    workType: "feature",
    effort: id,
    sections: [],
    participants: [],
    proposals: [],
    pins,
    status: "drafting",
    createdAt: "t",
    updatedAt: "t",
    problems: [],
  };
}

function harness(list: () => Promise<Doc[]>, groups: Array<{ name: string; expansion: string[] }> = []) {
  const seeded: string[] = [];
  const warnings: string[] = [];
  const seededBatches: number[] = [];
  const cache = new DocumentsCache({
    list,
    seed: (sessionId, docId) => seeded.push(`${sessionId}:${docId}`),
    groups: () => groups,
    warn: (l) => warnings.push(l),
    onSeeded: (n) => seededBatches.push(n),
  });
  return { cache, seeded, warnings, seededBatches };
}

// ── The §7 seeding predicate ───────────────────────────────────────────────

test("docsSeedingWorkspace: a workspace's own documents plus anything pinned to it, directly or through a group", () => {
  const docs = [
    doc("own", "ops"),
    doc("elsewhere", "platform"),
    doc("pinned-here", "platform", ["ops"]),
    doc("group-pinned", "platform", ["group:delivery"]),
    doc("pinned-nowhere-near", "platform", ["group:other"]),
  ];
  const groups = [
    { name: "delivery", expansion: ["ops", "web"] },
    { name: "other", expansion: ["web"] },
  ];
  assert.deepEqual(
    docsSeedingWorkspace(docs, "ops", groups).map((d) => d.id),
    ["own", "pinned-here", "group-pinned"],
  );
});

// ── I1/I2: the cache degrades on failure and never answers "empty" for "unknown" ──

test("a failed refresh keeps the last frame and does not mark the list loaded", async () => {
  let mode: "ok" | "boom" = "ok";
  const { cache, warnings } = harness(async () => {
    if (mode === "boom") throw new Error("fetch failed");
    return [doc("d1", "ops")];
  });

  assert.equal(cache.loaded, false);
  assert.equal(await cache.refresh(), true);
  assert.equal(cache.loaded, true);
  assert.deepEqual(
    cache.list().map((d) => d.id),
    ["d1"],
  );

  mode = "boom";
  assert.equal(await cache.refresh(), false);
  // Degrade, never blank: the last good frame is still what the UI gets.
  assert.deepEqual(
    cache.list().map((d) => d.id),
    ["d1"],
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /keeping the last frame: fetch failed/);
});

test("a session opened before the list has EVER loaded is deferred, not seeded empty, and is paid off on the first success", async () => {
  let mode: "boom" | "ok" = "boom";
  const { cache, seeded, warnings, seededBatches } = harness(async () => {
    if (mode === "boom") throw new Error("fetch failed");
    return [doc("d1", "ops"), doc("d2", "platform"), doc("d3", "platform", ["ops"])];
  });

  // Boot with an unreachable swarm.
  assert.equal(await cache.refresh(), false);
  assert.equal(cache.loaded, false);

  // A session created in that window must NOT be given an empty shelf as if
  // it were the answer — `artifacts` is persisted once and never re-derived.
  cache.seedSession("s1", "ops");
  assert.deepEqual(seeded, []);
  assert.equal(cache.deferredCount, 1);
  assert.match(warnings.at(-1) ?? "", /session s1 opened with no shelf/);

  // Swarm comes up.
  mode = "ok";
  assert.equal(await cache.refresh(), true);

  // The session is not permanently empty: it is seeded with its workspace's
  // own document AND the one pinned to it, exactly as if it had opened later.
  assert.deepEqual(seeded, ["s1:d1", "s1:d3"]);
  assert.equal(cache.deferredCount, 0);
  assert.deepEqual(seededBatches, [1]);
});

test("once loaded, seeding is immediate and later refreshes do not re-seed old sessions", async () => {
  const { cache, seeded, seededBatches } = harness(async () => [doc("d1", "ops")]);
  await cache.refresh();

  cache.seedSession("s1", "ops");
  assert.deepEqual(seeded, ["s1:d1"]);
  assert.equal(cache.deferredCount, 0);

  // A second successful refresh must not replay the drain — a session's shelf
  // is seeded once, at birth.
  await cache.refresh();
  assert.deepEqual(seeded, ["s1:d1"]);
  assert.deepEqual(seededBatches, []);
});

test("a session opened while the list is unknown is deferred even if an EARLIER session was seeded normally", async () => {
  // Guard against the obvious wrong implementation: a flag that flips back.
  let mode: "ok" | "boom" = "ok";
  const { cache, seeded } = harness(async () => {
    if (mode === "boom") throw new Error("down");
    return [doc("d1", "ops")];
  });
  await cache.refresh();
  cache.seedSession("s1", "ops");
  mode = "boom";
  await cache.refresh(); // fails; `loaded` must STAY true — the list is known, just not fresh
  cache.seedSession("s2", "ops");
  assert.deepEqual(seeded, ["s1:d1", "s2:d1"]);
  assert.equal(cache.deferredCount, 0);
});

// ── The read-path refresh that must never block a caller ───────────────────

test("refreshInBackground returns immediately and calls back only once the list has actually changed", async () => {
  let disk = [doc("d1", "ops", [], "v1")];
  const { cache } = harness(async () => disk);
  await cache.refresh();

  const fired: string[][] = [];
  const onFresh = () => fired.push(cache.list().map((d) => d.title));

  // Nothing changed on disk: a burst of connections must not produce a burst
  // of broadcasts.
  for (let i = 0; i < 5; i += 1) cache.refreshInBackground(onFresh);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(fired, []);

  // An external edit — a hand edit, a merged instance branch.
  disk = [{ ...doc("d1", "ops", [], "edited"), updatedAt: "t2" }];
  cache.refreshInBackground(onFresh);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(fired, [["edited"]]);
});

test("refreshInBackground does not block its caller, and a hung read never calls back", async () => {
  // The regression this guards: awaiting the read on a client's critical path
  // meant a swarm that accepts but never answers blocked the caller forever.
  const { cache } = harness(() => new Promise<Doc[]>(() => {}));
  let calledBack = false;
  const before = Date.now();
  cache.refreshInBackground(() => {
    calledBack = true;
  });
  assert.ok(Date.now() - before < 50, "refreshInBackground must return in the same turn");
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(calledBack, false);
  assert.equal(cache.loaded, false); // and it is still "unknown", not "empty"
});

test("refreshInBackground on a failed read neither calls back nor blanks the frame", async () => {
  let mode: "ok" | "boom" = "ok";
  const { cache, warnings } = harness(async () => {
    if (mode === "boom") throw new Error("fetch failed");
    return [doc("d1", "ops", [], "v1")];
  });
  await cache.refresh();
  mode = "boom";
  let calledBack = false;
  cache.refreshInBackground(() => {
    calledBack = true;
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calledBack, false);
  assert.deepEqual(
    cache.list().map((d) => d.title),
    ["v1"],
  );
  assert.match(warnings.at(-1) ?? "", /keeping the last frame/);
});

/**
 * Run one script in a CHILD node under `--unhandled-rejections=strict`.
 *
 * `refreshInBackground` is fire-and-forget, so nothing awaits its chain: an
 * escaping rejection is an UNHANDLED rejection, and Node's default mode for
 * those is `throw` — the broker process dies. Only a real process boundary
 * proves it does not, and only a child can be given the flag. In-process this
 * would be masked by the test runner's own rejection handling.
 */
function runInStrictChild(body: string): { status: number | null; stdout: string; stderr: string } {
  const cacheModule = new URL("./documents-cache.ts", import.meta.url).href;
  const r = spawnSync(
    process.execPath,
    [
      "--unhandled-rejections=strict",
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      `
      import { DocumentsCache } from ${JSON.stringify(cacheModule)};
      const docs = (title) => [{
        id: "d1", workspace: "ops", title, blueprintId: "spec", workType: "feature", effort: "e",
        sections: [], participants: [], proposals: [], pins: [], status: "drafting",
        createdAt: "t", updatedAt: title, problems: [],
      }];
      ${body}
    `,
    ],
    { encoding: "utf8", cwd: new URL("..", import.meta.url).pathname },
  );
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

test("refreshInBackground: a throwing onFresh does not kill the process, and the cache still works afterwards", () => {
  const child = runInStrictChild(`
    let disk = docs("v1");
    const cache = new DocumentsCache({
      list: async () => disk,
      seed: () => {},
      groups: () => [],
      warn: (line) => { if (line.includes("background refresh")) console.log("SWALLOWED"); },
    });
    await cache.refresh();

    disk = docs("v2");
    cache.refreshInBackground(() => { throw new Error("callback blew up"); });
    await new Promise((r) => setTimeout(r, 50));

    // Still usable for the NEXT connection — the queue is not wedged and the
    // failed callback's read still landed.
    disk = docs("v3");
    await new Promise((resolve) => {
      cache.refreshInBackground(() => { console.log("STILL WORKS:" + cache.list()[0].title); resolve(); });
    });
    console.log("ALIVE");
  `);
  assert.equal(child.status, 0, `child exited ${child.status}\n${child.stderr}`);
  assert.match(child.stdout, /SWALLOWED/, "the throw must be logged, not silently dropped");
  assert.match(child.stdout, /STILL WORKS:v3/, "the cache must still refresh and call back afterwards");
  assert.match(child.stdout, /ALIVE/, "the process must reach the end of the script");
  assert.doesNotMatch(child.stderr, /callback blew up/, "the error must not escape as an unhandled rejection");
});

// ── M3: the pin/unpin read-modify-write guard ──────────────────────────────

test("makeSerialQueue runs operations one at a time, so two concurrent read-modify-writes cannot lose one", async () => {
  const serialize = makeSerialQueue();
  // Stands in for the document: read it, await a turn, write the whole array.
  let pins: string[] = [];
  const order: string[] = [];
  const pin = (target: string) =>
    serialize(async () => {
      const read = [...pins];
      order.push(`read ${target}`);
      await new Promise((r) => setTimeout(r, 5)); // the window a second caller would slip into
      pins = [...new Set([...read, target])];
      order.push(`wrote ${target}`);
    });

  await Promise.all([pin("ops"), pin("platform")]);

  assert.deepEqual(pins.sort(), ["ops", "platform"]);
  // Strictly interleaved would be read/read/wrote/wrote — this must not be.
  assert.deepEqual(order, ["read ops", "wrote ops", "read platform", "wrote platform"]);
});

test("makeSerialQueue is not wedged by a rejected operation, and rejections reach their own caller", async () => {
  const serialize = makeSerialQueue();
  const boom = serialize(async () => {
    throw new Error("nope");
  });
  await assert.rejects(boom, /nope/);
  assert.equal(await serialize(async () => "after"), "after");
});

// ── M4: defaulted titles are numbered; typed titles never are ──────────────

test("nextDefaultTitle numbers from 1 and skips names already taken", () => {
  assert.equal(nextDefaultTitle("Design Spec", []), "Design Spec 1");
  assert.equal(nextDefaultTitle("Design Spec", ["Design Spec 1"]), "Design Spec 2");
  assert.equal(nextDefaultTitle("Design Spec", ["Design Spec 1", "Design Spec 2"]), "Design Spec 3");
  // A gap is filled rather than skipped past — the number disambiguates, it is not an id.
  assert.equal(nextDefaultTitle("Design Spec", ["Design Spec 2"]), "Design Spec 1");
  // Unrelated titles, including the bare blueprint name, do not consume a number.
  assert.equal(nextDefaultTitle("Design Spec", ["Login rework", "Design Spec"]), "Design Spec 1");
});
