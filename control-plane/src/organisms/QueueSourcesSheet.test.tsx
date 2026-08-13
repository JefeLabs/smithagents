import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../test/renderWithProviders";
import { QueueSourcesSheet } from "./QueueSourcesSheet";

const RECORD = {
  name: "acme",
  default: false,
  repos: [{ name: "app", path: "/a", branch: "main" }],
  sources: [
    {
      id: "jira-plan",
      name: "PROJ tickets",
      preset: "jira",
      origin: { connectorId: "atl-1", url: "https://a.atlassian.net", query: "project = PROJ" },
      cadence: "nightly",
      transform: { mode: "map" },
      enabled: true,
    },
    {
      id: "s2",
      name: "Sentry",
      preset: "observability",
      origin: { url: "https://sentry.example/api" },
      cadence: "hourly",
      transform: { mode: "analyze" },
      enabled: true,
    },
  ],
};
const BOARD = {
  id: "acme-plan",
  name: "Plan",
  type: "plan",
  workspaceId: "acme",
  columns: [{ id: "queue", name: "Queue" }],
  cards: [],
  queue: { sourceIds: ["jira-plan"] },
};

/**
 * Local copy of the BoardStage.test.tsx pattern (:53-79), extended with the
 * `workspaces` GET/PATCH-board/PUT-workspace routes this sheet needs — it
 * calls neither `/work/boards` (list) nor `/cards`, so those branches are
 * dropped rather than carried over unused.
 */
function stubFetch(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const respond = (b: unknown, status = 200) => ({ ok: status < 400, status, json: async () => b }) as Response;
    if (url.endsWith("/workspaces") && method === "GET") return respond({ workspaces: overrides.workspaces ?? [] });
    if (url.includes("/work/boards/") && method === "PATCH") return respond(overrides.patched ?? {});
    if (url.includes("/workspaces/") && method === "PUT") return respond(overrides.saved ?? {});
    return respond({});
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("QueueSourcesSheet", () => {
  it("lists the workspace's sources with bound ones checked; toggling patches the board's sourceIds", async () => {
    const { calls } = stubFetch({ workspaces: [RECORD] });
    renderWithProviders(<QueueSourcesSheet board={BOARD as never} open onClose={() => {}} />);
    const bound = await screen.findByRole("checkbox", { name: /PROJ tickets/ });
    expect(bound).toBeChecked();
    const unbound = screen.getByRole("checkbox", { name: /Sentry/ });
    expect(unbound).not.toBeChecked();
    await userEvent.click(unbound);
    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH" && c.url.endsWith("/work/boards/acme-plan"));
      expect(patch?.body).toEqual({ queue: { sourceIds: ["jira-plan", "s2"] } });
    });
  });

  it("adding a source PUTs the whole workspace record with the new row appended", async () => {
    const { calls } = stubFetch({ workspaces: [RECORD] });
    renderWithProviders(<QueueSourcesSheet board={BOARD as never} open onClose={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /add source/i }));
    await userEvent.selectOptions(screen.getByLabelText(/preset/i), "custom");
    await userEvent.type(screen.getByLabelText(/^name/i), "Support inbox");
    await userEvent.type(screen.getByLabelText(/url/i), "https://support.example/feed");
    await userEvent.click(screen.getByRole("button", { name: /create source/i }));
    await waitFor(() => {
      const put = calls.find((c) => c.method === "PUT" && c.url.endsWith("/workspaces/acme"));
      const sources = (put?.body as { sources: Array<{ name: string }> } | undefined)?.sources;
      expect(sources).toHaveLength(3);
      expect(sources?.[2]).toMatchObject({
        name: "Support inbox",
        preset: "custom",
        cadence: "nightly",
        enabled: true,
      });
    });
  });

  it("shows where cards arrive from via routes, read-only", async () => {
    stubFetch({ workspaces: [RECORD] });
    renderWithProviders(<QueueSourcesSheet board={{ ...BOARD, type: "deliver" } as never} open onClose={() => {}} />);
    // BOARD_ROUTES_UI: plan.ready → deliver/ready. An exact match, not /plan/i — the
    // modal's own title ("Plan · queue sources", from board.name) also matches that
    // loose regex, which makes findByText throw on "multiple elements" instead of
    // resolving; this is the same requirement, disambiguated.
    expect(await screen.findByText("plan · Send to deliver")).toBeDefined();
  });

  it("personal boards (no workspaceId) render only the no-sources message", async () => {
    stubFetch({ workspaces: [RECORD] });
    renderWithProviders(
      <QueueSourcesSheet board={{ ...BOARD, workspaceId: undefined } as never} open onClose={() => {}} />,
    );
    expect(await screen.findByText(/personal boards have no context sources/i)).toBeDefined();
    expect(screen.queryByRole("button", { name: /add source/i })).toBeNull();
  });
});
