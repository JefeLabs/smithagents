import assert from "node:assert/strict";
import { test } from "node:test";
import { FeedStore } from "./store.ts";
import type { FeedItem, FeedSource } from "./types.ts";

function memoryIo() {
  const files = new Map<string, string>();
  return { files, read: (n: string) => files.get(n) ?? null, write: (n: string, b: string) => void files.set(n, b) };
}

const item = (id: string, publishedAt: string): FeedItem => ({
  id,
  sourceId: "s1",
  tag: "news",
  title: id,
  publishedAt,
  summary: "",
});

const source: FeedSource = {
  id: "s1",
  label: "Diario Libre",
  kind: "rss",
  locator: "https://example.test/rss",
  tag: "news",
  origin: "manual",
  enabled: true,
};

test("sources round-trip through the io seam", () => {
  const io = memoryIo();
  const store = new FeedStore(io);
  store.putSource(source);
  assert.deepEqual(new FeedStore(io).sources(), [source]);
});

test("putSource replaces by id rather than duplicating", () => {
  const store = new FeedStore(memoryIo());
  store.putSource(source);
  store.putSource({ ...source, enabled: false });
  assert.equal(store.sources().length, 1);
  assert.equal(store.sources()[0]!.enabled, false);
});

test("addItems returns only what was new — re-fetching a feed adds nothing", () => {
  const store = new FeedStore(memoryIo());
  const first = store.addItems([item("a", "2026-08-11T00:00:00Z"), item("b", "2026-08-11T01:00:00Z")]);
  assert.equal(first.length, 2);
  const second = store.addItems([item("a", "2026-08-11T00:00:00Z"), item("c", "2026-08-11T02:00:00Z")]);
  assert.deepEqual(
    second.map((i) => i.id),
    ["c"],
  );
  assert.equal(store.items().length, 3);
});

test("trimming drops items older than 30 days", () => {
  const store = new FeedStore(memoryIo(), { now: () => new Date("2026-08-11T00:00:00Z") });
  store.addItems([item("old", "2026-06-01T00:00:00Z"), item("fresh", "2026-08-10T00:00:00Z")]);
  assert.deepEqual(
    store.items().map((i) => i.id),
    ["fresh"],
  );
});

test("trimming caps at 500 items, keeping the newest", () => {
  const store = new FeedStore(memoryIo(), { now: () => new Date("2026-08-11T00:00:00Z") });
  const many = Array.from({ length: 520 }, (_, i) =>
    item(`i${i}`, new Date(Date.parse("2026-08-01T00:00:00Z") + i * 60_000).toISOString()),
  );
  store.addItems(many);
  assert.equal(store.items().length, 500);
  assert.equal(
    store.items().some((i) => i.id === "i0"),
    false,
    "the oldest go first",
  );
  assert.equal(
    store.items().some((i) => i.id === "i519"),
    true,
  );
});

test("markSpoken and markCarded stamp the item and survive a reload", () => {
  const io = memoryIo();
  const store = new FeedStore(io);
  store.addItems([item("rel", "2026-08-11T00:00:00Z")]);
  store.markSpoken(["rel"], "2026-08-11T09:00:00Z");
  store.markCarded("rel", "2026-08-11T09:00:01Z");
  const reloaded = new FeedStore(io).items()[0]!;
  assert.equal(reloaded.spokenAt, "2026-08-11T09:00:00Z");
  assert.equal(reloaded.cardedAt, "2026-08-11T09:00:01Z");
});

test("a corrupt file reads as empty rather than throwing — a bad write must not brick the broker", () => {
  const io = memoryIo();
  io.files.set("sources.json", "{not json");
  assert.deepEqual(new FeedStore(io).sources(), []);
});

test("a RELEASE survives age trimming — release feeds are sparse, and a version is not stale news", () => {
  const store = new FeedStore(memoryIo(), { now: () => new Date("2026-08-11T00:00:00Z") });
  store.addItems([
    { ...item("old-news", "2026-06-01T00:00:00Z"), tag: "news" },
    {
      ...item("old-release", "2026-06-01T00:00:00Z"),
      tag: "release",
      release: { name: "spring-boot", version: "4.1.0", bump: "minor", security: false },
    },
  ]);
  assert.deepEqual(
    store.items().map((i) => i.id),
    ["old-release"],
    "the news went, the release stayed",
  );
});
