import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkBoardT } from "../organisms/BoardStage";
import { useSocketStore } from "../stores/socketStore";
import { type Alert, computeAlerts, useAlerts } from "./alerts";
import { qk } from "./keys";

/** Minimal valid board — only the fields `computeAlerts` reads vary per case. */
function board(cards: WorkBoardT["cards"]): WorkBoardT {
  return { id: "alpha", name: "Alpha", type: "personal", columns: [], cards };
}

describe("computeAlerts", () => {
  it("everything healthy produces no alerts", () => {
    expect(computeAlerts({ connected: true, engineWarnings: {}, boards: [], boardErrors: [] })).toEqual([]);
  });

  it("an inactive engine produces one alert naming the agent", () => {
    const alerts = computeAlerts({
      connected: true,
      engineWarnings: { ana: "claude: unavailable" },
      boards: [],
      boardErrors: [],
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].text).toContain("ana");
    expect(alerts[0].target).toBe("/work/ana");
  });

  it("board errors produce one alert each", () => {
    const alerts = computeAlerts({
      connected: true,
      engineWarnings: {},
      boards: [],
      boardErrors: [
        { file: "boards.json", error: "could not load boards" },
        { file: "other.json", error: "bad json" },
      ],
    });
    expect(alerts).toHaveLength(2);
    expect(alerts.map((a) => a.text)).toEqual(["could not load boards", "bad json"]);
    expect(alerts.every((a) => a.severity === "error")).toBe(true);
  });

  it("a card with jira.lastPushError produces one alert", () => {
    const alerts = computeAlerts({
      connected: true,
      engineWarnings: {},
      boards: [
        board([
          {
            id: "c1",
            title: "Write the spec",
            columnId: "todo",
            order: 0,
            jira: { key: "X-1", url: "https://x", lastPushError: "422 from Jira" },
          },
        ]),
      ],
      boardErrors: [],
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].text).toBe("422 from Jira");
    expect(alerts[0].target).toBe("/board");
  });

  it("a card with no jira block, or jira but no lastPushError, produces nothing", () => {
    const alerts = computeAlerts({
      connected: true,
      engineWarnings: {},
      boards: [
        board([
          { id: "c1", title: "no jira", columnId: "todo", order: 0 },
          { id: "c2", title: "synced fine", columnId: "todo", order: 1, jira: { key: "X-2", url: "https://x" } },
        ]),
      ],
      boardErrors: [],
    });
    expect(alerts).toEqual([]);
  });

  it("a disconnected broker produces exactly one alert, not one per downstream failure", () => {
    const alerts = computeAlerts({
      connected: false,
      engineWarnings: { ana: "claude: unavailable" },
      boards: [],
      boardErrors: [{ file: "boards.json", error: "could not load boards" }],
    });
    expect(alerts.filter((a) => a.id === "broker-disconnected")).toHaveLength(1);
    expect(alerts).toHaveLength(1);
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

describe("useAlerts", () => {
  afterEach(() => {
    useSocketStore.setState({ connected: false });
  });

  it("joins the socket store, the boards query and the engine-warnings join into one list", async () => {
    useSocketStore.setState({ connected: true });
    const client = seededClient((c) => {
      c.setQueryData(qk.cliTools, [
        {
          cli: "claude",
          label: "claude",
          models: [],
          warmSessions: true,
          active: false,
          status: {
            detected: true,
            authOk: false,
            enabled: true,
            detail: "not logged in",
            lastCheckedAt: "2026-08-06T00:00:00.000Z",
          },
        },
      ]);
      c.setQueryData(qk.agentRecords, { agents: [{ id: "ana", engine: { cli: "claude" } }] });
      c.setQueryData(qk.boards, {
        boards: [],
        errors: [{ file: "boards.json", error: "could not load boards" }],
      });
    });
    const { result } = renderHook(() => useAlerts(), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current).toHaveLength(2));
    const ids = result.current.map((a: Alert) => a.id).sort();
    expect(ids).toEqual(["board-error-boards.json", "engine-ana"]);
  });

  it("a disconnected socket collapses everything to the one broker alert", async () => {
    useSocketStore.setState({ connected: false });
    const client = seededClient((c) => {
      c.setQueryData(qk.boards, { boards: [], errors: [{ file: "boards.json", error: "nope" }] });
    });
    const { result } = renderHook(() => useAlerts(), { wrapper: wrapper(client) });
    await waitFor(() =>
      expect(result.current).toEqual([{ id: "broker-disconnected", severity: "error", text: expect.any(String) }]),
    );
  });
});
