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

  it("no longer offers Escalate to Agenda — the route was retired", () => {
    render(<CardSheet {...props} />);
    expect(screen.queryByRole("button", { name: "Escalate to Agenda" })).toBeNull();
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

describe("CardSheet stories", () => {
  const WITH_STORIES = {
    ...CARD,
    stories: [
      { id: "st-alpha", text: "user can log in", done: false },
      { id: "st-beta", text: "reload keeps session", done: true, verifiedBy: "manual 2026-08-01" },
    ],
  } as WorkCardT;

  /** The single PATCH the save button produced, with its story list typed. */
  async function savedStories(): Promise<Array<{ id: string; text: string; done: boolean; verifiedBy?: string }>> {
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1));
    const body = calls.find((c) => c.method === "PATCH")?.body as
      | { stories: Array<{ id: string; text: string; done: boolean; verifiedBy?: string }> }
      | undefined;
    if (!body) throw new Error("no PATCH was sent");
    return body.stories;
  }

  it("save round-trips each story's OWN id, not the list widget's row key", async () => {
    // The story list is a field array whose row key is also called `id`, so a row key
    // leaking into the payload in place of the real story id is a silent, plausible
    // failure — and these ids are what a map-linked card is matched on server-side.
    render(<CardSheet {...props} card={WITH_STORIES} />);
    const stories = await savedStories();
    expect(stories.map((s) => s.id)).toEqual(["st-alpha", "st-beta"]);
  });

  it("removing a story drops that one and leaves the rest, ids intact", async () => {
    render(<CardSheet {...props} card={WITH_STORIES} />);
    await userEvent.click(screen.getByRole("button", { name: "Remove story: user can log in" }));
    const stories = await savedStories();
    expect(stories.map((s) => [s.id, s.text])).toEqual([["st-beta", "reload keeps session"]]);
  });

  it("toggling a story off clears its verifiedBy while keeping the story's id", async () => {
    render(<CardSheet {...props} card={WITH_STORIES} />);
    // The second story starts done+verified; unchecking must drop the stamp.
    const boxes = screen.getAllByRole("checkbox");
    await userEvent.click(boxes[1] as HTMLInputElement);
    const stories = await savedStories();
    expect(stories[1]).toMatchObject({ id: "st-beta", done: false });
    expect(stories[1]?.verifiedBy).toBeUndefined();
  });

  it("points: hand-written rows edit and save; the head sums with unset as 0", async () => {
    render(<CardSheet {...props} card={WITH_STORIES} />);
    await userEvent.type(screen.getByLabelText("Points for user can log in"), "3");
    expect(screen.getByText("3 pts")).toBeTruthy(); // st-beta unset -> counts 0
    const stories = (await savedStories()) as Array<{ id: string; points?: number }>;
    expect(stories[0]?.points).toBe(3);
    expect(stories[1]?.points).toBeUndefined();
  });

  it("points: a capability-linked card shows read-only mirrors, no inputs", () => {
    const linked = {
      ...WITH_STORIES,
      capabilityRef: { capabilityId: "cap1", sliceId: "sl1" },
      stories: [{ id: "st-alpha", text: "user can log in", done: false, points: 5 }],
    } as WorkCardT;
    render(<CardSheet {...props} card={linked} />);
    expect(screen.getByText("5")).toBeTruthy();
    expect(screen.getByText("5 pts")).toBeTruthy();
    expect(screen.queryByLabelText(/points for/i)).toBeNull();
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

  it("resets the reason on clear, so a later re-pick doesn't carry a stale reason", async () => {
    render(
      <CardSheet
        {...props}
        card={{ ...CARD, flag: { kind: "blocked", reason: "waiting on Edwin", since: "2026-08-01T00:00:00.000Z" } }}
      />,
    );
    await userEvent.selectOptions(screen.getByLabelText("Flag"), "");
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ flag: null }));
    await userEvent.selectOptions(screen.getByLabelText("Flag"), "at-risk");
    await waitFor(() => {
      const patches = calls.filter((c) => c.method === "PATCH");
      expect(patches[patches.length - 1]?.body).toEqual({ flag: { kind: "at-risk", reason: "" } });
    });
  });

  it("save persists the flag's kind and current reason together with title/notes/stories, without since", async () => {
    render(
      <CardSheet
        {...props}
        card={{ ...CARD, flag: { kind: "blocked", reason: "", since: "2026-08-01T00:00:00.000Z" } }}
      />,
    );
    await userEvent.type(screen.getByPlaceholderText("Why?"), "waiting on Edwin");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1));
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({
      title: "Alert 4412",
      notes: "",
      stories: [],
      flag: { kind: "blocked", reason: "waiting on Edwin" },
    });
  });

  it("changing the flag select fires exactly one PATCH — no revert from a blurred reason input", async () => {
    render(
      <CardSheet
        {...props}
        card={{ ...CARD, flag: { kind: "blocked", reason: "waiting on Edwin", since: "2026-08-01T00:00:00.000Z" } }}
      />,
    );
    await userEvent.click(screen.getByPlaceholderText("Why?"));
    await userEvent.selectOptions(screen.getByLabelText("Flag"), "at-risk");
    await waitFor(() => expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1));
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({
      flag: { kind: "at-risk", reason: "waiting on Edwin" },
    });
  });
});
