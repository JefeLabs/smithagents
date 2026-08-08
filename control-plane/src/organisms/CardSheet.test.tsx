import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkBoardT, WorkCardT } from "./BoardStage";
import { CardSheet } from "./CardSheet";

const BOARD = {
  id: "acme-reactive",
  name: "Reactive",
  type: "reactive",
  workspaceId: "acme",
  columns: [{ id: "triage", name: "Triage" }],
  cards: [],
} as unknown as WorkBoardT;

const CARD = { id: "c1", title: "Alert 4412", columnId: "triage", order: 0 } as WorkCardT;

let calls: Array<{ url: string; method: string; body?: unknown }>;
beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }),
  );
});

// vitest.config.ts doesn't set test.globals, so RTL's auto-cleanup (which
// feature-detects a *global* afterEach) never registers — without this,
// each render() in this file leaks into the next test's queries.
afterEach(() => {
  cleanup();
});

const props = { board: BOARD, card: CARD, roster: [], workspaces: ["acme"], onClose: () => {}, onChanged: () => {} };

describe("CardSheet routes", () => {
  it("renders a pill per exit available from the card's column", () => {
    render(<CardSheet {...props} />);
    expect(screen.getByRole("button", { name: "To maintenance" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "To ideation" })).toBeTruthy();
  });

  it("renders no pills from a column with no exits", () => {
    render(<CardSheet {...props} card={{ ...CARD, columnId: "closed" }} />);
    expect(screen.queryByRole("button", { name: /^To / })).toBeNull();
  });

  it("POSTs the destination type to the route endpoint", async () => {
    render(<CardSheet {...props} />);
    await userEvent.click(screen.getByRole("button", { name: "To maintenance" }));
    await waitFor(() =>
      expect(calls.find((c) => c.url.endsWith("/route"))).toMatchObject({
        method: "POST",
        body: { toType: "maintenance" },
      }),
    );
  });
});

describe("CardSheet flags", () => {
  it("PATCHes the chosen flag kind without a since, which the server stamps", async () => {
    render(<CardSheet {...props} />);
    await userEvent.selectOptions(screen.getByLabelText("Flag"), "blocked");
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ flag: { kind: "blocked", reason: "" } }),
    );
  });

  it("PATCHes null to clear", async () => {
    render(<CardSheet {...props} card={{ ...CARD, flag: { kind: "blocked", since: "2026-08-01T00:00:00.000Z" } }} />);
    await userEvent.selectOptions(screen.getByLabelText("Flag"), "");
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ flag: null }));
  });
});
