import assert from "node:assert/strict";
import { test } from "node:test";
import { fromContextSources } from "./context-sources.ts";
import type { FeedSource } from "./types.ts";

test("jira preset becomes a jira row carrying connector, query, cadence, workspace, contextId", () => {
  const rows = fromContextSources(
    [
      {
        name: "acme",
        sources: [
          {
            id: "jira-plan",
            name: "PROJ",
            preset: "jira",
            origin: { connectorId: "atl-1", url: "https://a.atlassian.net", query: "project = PROJ" },
            cadence: "6h",
            transform: { mode: "map" },
            enabled: true,
          },
        ],
      },
    ],
    [],
  );
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.id, "ctx:acme:jira-plan");
  assert.equal(r.kind, "jira");
  assert.equal(r.locator, "https://a.atlassian.net");
  assert.equal(r.query, "project = PROJ");
  assert.equal(r.connectorId, "atl-1");
  assert.equal(r.cadence, "6h");
  assert.equal(r.workspace, "acme");
  assert.equal(r.contextId, "jira-plan");
  assert.equal(r.origin, "derived");
});

test("releases and topic presets produce no rows — their executors already exist", () => {
  const rows = fromContextSources(
    [
      {
        name: "acme",
        sources: [
          {
            id: "releases",
            name: "r",
            preset: "releases",
            origin: {},
            cadence: "nightly",
            transform: { mode: "analyze" },
            enabled: true,
          },
          {
            id: "t1",
            name: "t",
            preset: "topic",
            origin: { query: "spring boot" },
            cadence: "nightly",
            transform: { mode: "analyze" },
            enabled: true,
          },
        ],
      },
    ],
    [],
  );
  assert.deepEqual(rows, []);
});

test("disabled sources drop out; a previously dismissed row stays dismissed", () => {
  const ws = [
    {
      name: "acme",
      sources: [
        {
          id: "s1",
          name: "s1",
          preset: "custom" as const,
          origin: { url: "https://o.example/api" },
          cadence: "hourly" as const,
          transform: { mode: "analyze" as const, prompt: "watch errors" },
          enabled: true,
        },
        {
          id: "s2",
          name: "s2",
          preset: "custom" as const,
          origin: { url: "https://x.example" },
          cadence: "hourly" as const,
          transform: { mode: "analyze" as const },
          enabled: false,
        },
      ],
    },
  ];
  const existing: FeedSource[] = [
    {
      id: "ctx:acme:s1",
      label: "s1",
      kind: "http",
      locator: "https://o.example/api",
      tag: "tech",
      origin: "derived",
      enabled: true,
      dismissed: true,
    },
  ];
  const rows = fromContextSources(ws, existing);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.dismissed, true);
  assert.equal(rows[0]?.analyzePrompt, "watch errors");
});
