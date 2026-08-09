import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliToolListing } from "../api/types";
import { computeEngineWarnings, useEngineWarnings } from "./health";
import { qk } from "./keys";

afterEach(() => vi.unstubAllGlobals());

const tool = (cli: string, active: boolean, detail = ""): CliToolListing => ({
  cli,
  label: cli,
  models: [],
  warmSessions: true,
  active,
  status: active
    ? null
    : { detected: true, authOk: false, enabled: true, detail, lastCheckedAt: "2026-08-06T00:00:00.000Z" },
});

describe("computeEngineWarnings", () => {
  it("flags only agents whose engine tool is inactive, with the tool's detail", () => {
    const warnings = computeEngineWarnings(
      [tool("claude", true), tool("codex", false, "not logged in — run `codex login`")],
      [
        { id: "ignacio", engine: { cli: "claude" } },
        { id: "wilkin", engine: { cli: "codex" } },
        { id: "ghost" }, // no engine on record -> never flagged
      ],
    );
    expect(warnings).toEqual({ wilkin: "codex: not logged in — run `codex login`" });
  });
  it("empty tool list (fetch failed, nothing probed) flags nobody", () => {
    expect(computeEngineWarnings([], [{ id: "ignacio", engine: { cli: "claude" } }])).toEqual({});
  });
});

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

function seededClient(seed: (c: QueryClient) => void) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: Infinity } },
  });
  seed(client);
  return client;
}

describe("useEngineWarnings", () => {
  it("joins the tool registry against the AGENT RECORDS, which are the only side carrying `engine`", async () => {
    // The roster frame (qk.roster) is a view model with no `engine` field, so a
    // join written against it would return {} here and the badges would vanish
    // with nothing failing. Seeding roster with the same ids and NO engine is
    // what makes this test able to tell the two sources apart.
    const client = seededClient((c) => {
      c.setQueryData(qk.cliTools, [tool("codex", false, "not logged in")]);
      c.setQueryData(qk.agentRecords, { agents: [{ id: "wilkin", engine: { cli: "codex" } }] });
      c.setQueryData(qk.roster, { agents: [{ id: "wilkin", name: "Wilkin" }], identity: null });
    });
    const { result } = renderHook(() => useEngineWarnings(), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current).toEqual({ wilkin: "codex: not logged in" }));
  });

  it("flags nobody while either half of the join is still unknown", async () => {
    // Tools present, records not yet: a warning here would be invented, not read.
    const client = seededClient((c) => {
      c.setQueryData(qk.cliTools, [tool("codex", false, "not logged in")]);
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("broker unreachable");
      }),
    );
    const { result } = renderHook(() => useEngineWarnings(), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current).toEqual({}));
  });
});
