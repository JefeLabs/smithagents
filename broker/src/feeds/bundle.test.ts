import assert from "node:assert/strict";
import { test } from "node:test";
import { parseBundle } from "./bundle.ts";

const GOOD = JSON.stringify({
  candidates: [
    {
      kind: "site",
      url: "https://spring.io/blog.atom",
      label: "Spring blog",
      evidence: "feed in <head>",
      lastActivity: "2026-08-09",
    },
    {
      kind: "github",
      url: "https://github.com/spring-projects/spring-boot",
      label: "spring-boot",
      evidence: "1.2k releases",
    },
  ],
});

test("a well-formed bundle yields its candidates", () => {
  const { candidates, note } = parseBundle(GOOD);
  assert.equal(candidates.length, 2);
  assert.equal(note, undefined);
  assert.equal(candidates[0]!.kind, "site");
  assert.equal(candidates[1]!.label, "spring-boot");
});

test("a missing file is a note, not a throw", () => {
  const { candidates, note } = parseBundle(null);
  assert.deepEqual(candidates, []);
  assert.match(note!, /no bundle file/i);
});

test("malformed JSON is a note naming the problem", () => {
  const { candidates, note } = parseBundle("{not json");
  assert.deepEqual(candidates, []);
  assert.match(note!, /could not be read/i);
});

test("an empty bundle is a note — the agent found nothing", () => {
  const { candidates, note } = parseBundle(JSON.stringify({ candidates: [] }));
  assert.deepEqual(candidates, []);
  assert.match(note!, /found no sources/i);
});

test("an UNSAFE candidate url is dropped and recorded — an agent-supplied url is untrusted", () => {
  const { candidates, note } = parseBundle(
    JSON.stringify({
      candidates: [
        { kind: "site", url: "http://169.254.169.254/latest/", label: "metadata", evidence: "x" },
        { kind: "site", url: "https://spring.io/blog.atom", label: "blog", evidence: "y" },
      ],
    }),
  );
  assert.deepEqual(
    candidates.map((c) => c.label),
    ["blog"],
  );
  assert.match(note!, /169\.254\.169\.254/);
});

test("an unknown kind is dropped rather than stored as junk", () => {
  const { candidates } = parseBundle(
    JSON.stringify({ candidates: [{ kind: "telepathy", url: "https://x.test/a", label: "l", evidence: "e" }] }),
  );
  assert.deepEqual(candidates, []);
});

test("candidates missing a url or kind are dropped", () => {
  const { candidates } = parseBundle(
    JSON.stringify({ candidates: [{ kind: "site", label: "no url", evidence: "e" }, { url: "https://x.test" }] }),
  );
  assert.deepEqual(candidates, []);
});

test('missing evidence becomes empty rather than undefined, so the UI never renders "undefined"', () => {
  const { candidates } = parseBundle(
    JSON.stringify({ candidates: [{ kind: "site", url: "https://x.test/a", label: "l" }] }),
  );
  assert.equal(candidates[0]!.evidence, "");
});
