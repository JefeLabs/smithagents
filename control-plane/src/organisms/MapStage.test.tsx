import type { QueryClient } from "@tanstack/react-query";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ALL_WORKSPACES } from "../lib/board-aggregate";
import { qk } from "../queries/keys";
import { useSocketStore } from "../stores/socketStore";
import { useUiStore } from "../stores/uiStore";
import { renderWithProviders } from "../test/renderWithProviders";
import { MapStage } from "./MapStage";
import { STORIES_Y, stepColumns } from "./map/layout";

const CAP = {
  id: "school-feature-set",
  name: "School Feature Set",
  workspaceId: "skoolscout",
  activities: [
    {
      id: "act1",
      name: "Manage Candidate Tours",
      order: 0,
      steps: [
        { id: "st1", name: "Define Tour Schedule", order: 0 },
        { id: "st2", name: "Analyze Tour Data", order: 1 },
      ],
    },
  ],
  stories: [
    { id: "s1", stepId: "st1", order: 0, text: "create tour time slots", done: true, verifiedBy: "manual 2026-08-07" },
    { id: "s2", stepId: "st1", order: 1, text: "edit tour time slots", done: false },
    { id: "s3", stepId: "st2", order: 0, text: "view tour analytics", done: false },
  ],
  slices: [
    {
      id: "sl1",
      name: "tour scheduling v1",
      order: 0,
      storyIds: ["s1", "s2"],
      specPath: "docs/superpowers/specs/2026-08-06-tour-scheduling-v1-design.md",
      // TWO artifacts, not one, and the second is what makes the row a row. With only
      // a spec, `artifactRowX(i, …)` is only ever called at i = 0 — so passing the
      // index at all, and the whole horizontal layout, would go unexercised.
      planPath: "docs/superpowers/plans/2026-08-08-tour-scheduling-v1.md",
    },
    { id: "sl2", name: "analytics v1", order: 1, storyIds: [] },
    // Owns nothing, so `slicesWithoutExclusiveStory` reports it — the grandfathered
    // shape the panel must MARK rather than hide. sl2 is storyless too, which is what
    // makes "marks the invalid one" a weaker claim than it looks: both are invalid, so
    // the mark is asserted on the row rather than on a count.
    { id: "sl3", name: "empty legacy", order: 2, storyIds: [] },
  ],
};

/**
 * TWO activities, which is the minimum a reorder can be observed in — and the minimum
 * for the two-gesture case, since one activity's columns cannot move relative to
 * another's until there are two. `s1` sits in act2's step so a later drop can move it
 * into act1's, across the boundary the reorder shifts.
 */
const TWO_ACT = {
  id: "two-act",
  name: "Two Activities",
  workspaceId: "skoolscout",
  activities: [
    { id: "act1", name: "First", order: 0, steps: [{ id: "st1", name: "Alpha", order: 0 }] },
    { id: "act2", name: "Second", order: 1, steps: [{ id: "st2", name: "Beta", order: 0 }] },
  ],
  stories: [{ id: "s1", stepId: "st2", order: 0, text: "a story", done: false }],
  slices: [],
};

/** What the broker returns once act2 has been dragged in front of act1. */
const REORDERED = {
  ...TWO_ACT,
  activities: [
    { id: "act2", name: "Second", order: 0, steps: [{ id: "st2", name: "Beta", order: 0 }] },
    { id: "act1", name: "First", order: 1, steps: [{ id: "st1", name: "Alpha", order: 0 }] },
  ],
};

const OTHER_CAP = {
  id: "other-cap",
  name: "Other Product",
  workspaceId: "smithagents",
  activities: [{ id: "act2", name: "Different Activity", order: 0, steps: [] }],
  stories: [],
  slices: [],
};

function stubFetch(overrides: { capabilities?: unknown } = {}) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const respond = (b: unknown, status = 200) => ({ ok: status < 400, status, json: async () => b }) as Response;
    if (url.includes("/workspaces")) return respond({ workspaces: [{ name: "skoolscout" }, { name: "smithagents" }] });
    if (url.includes("/work/capabilities") && method === "GET")
      return respond(overrides.capabilities ?? { capabilities: [CAP], errors: [] });
    if (url.endsWith("/work/capabilities") && method === "POST")
      return respond({ ...CAP, id: "new-cap", name: "New Cap" }, 201);
    if (url.includes("/spec") && method === "POST") return respond({ specPath: "docs/superpowers/specs/x.md" }, 200);
    if (url.includes("/send") && method === "POST") return respond({ id: "card1" }, 201);
    if (method === "PATCH") return respond(CAP);
    return respond({});
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls };
}

function renderMapStage() {
  return renderWithProviders(<MapStage />);
}

/**
 * Makes every PATCH fail while still recording it.
 *
 * The failing response is substituted AFTER delegating, never instead of it: the
 * stub installed by stubFetch is what pushes into `calls`, so returning early would
 * make a "was a PATCH sent?" assertion unsatisfiable no matter how the code behaved.
 */
function failEveryPatch() {
  const original = globalThis.fetch as typeof fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await original(input, init);
    if ((init?.method ?? "GET") === "PATCH") {
      return { ok: false, status: 500, json: async () => ({}) } as Response;
    }
    return res;
  });
}

/**
 * The transform xyflow writes on a node's wrapper — the only place a node's position
 * is observable from the DOM. Read as an opaque string and compared to itself before
 * and after, so the assertion says "it went back", not "it is at these pixels".
 */
function nodePosition(nodeId: string): string | undefined {
  const el = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${nodeId}"]`);
  return el?.style.transform;
}

/**
 * Seeds the pushed-query cache the way the socket store would, per
 * src/test/renderWithProviders.tsx — MapStage's workspace now follows this
 * instead of an in-stage picker, so this is how tests drive it.
 */
function seedSessionFrame(client: QueryClient, session: { workspace: string }) {
  client.setQueryData(qk.session, { id: "s0", title: "t", workspace: session.workspace, runtime: "local-in-process" });
}

describe("MapStage", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders the backbone and story stacks for the selected capability", async () => {
    stubFetch();
    const { client } = renderMapStage();
    seedSessionFrame(client, { workspace: "skoolscout" });
    expect(await screen.findByText("Manage Candidate Tours")).toBeTruthy();
    expect(screen.getByText("Define Tour Schedule")).toBeTruthy();
    expect(screen.getByText("create tour time slots")).toBeTruthy();
  });

  it("creates a capability in the selected workspace, from the row's blank card", async () => {
    // SAME GUARANTEE, new control. This pinned that creating a capability POSTs the
    // typed name against the CURRENT workspace — the workspace half is the part worth
    // keeping, since it is derived from the session rather than from any control on
    // this screen. It used to go through a "+ new capability" toggle, a panel and a
    // "create capability" button; all three are gone and the blank card replaces them.
    const { calls } = stubFetch();
    const { client } = renderMapStage();
    seedSessionFrame(client, { workspace: "skoolscout" });
    await screen.findByText("Manage Candidate Tours");
    await userEvent.type(screen.getByPlaceholderText("Capability name"), "New Cap{Enter}");
    await waitFor(() => {
      const call = calls.find((c) => c.method === "POST" && c.url.endsWith("/work/capabilities"));
      expect(call?.body).toMatchObject({ name: "New Cap", workspaceId: "skoolscout" });
    });
  });

  it("orders the capability row by `order`, putting unordered legacy ones last", async () => {
    // `order` is optional because the broker's is: a capability file written before
    // ordering existed carries none. Those must not sort to the FRONT, which is what a
    // bare `(a.order ?? 0) - (b.order ?? 0)` would do to every one of them at once.
    const legacy = { ...OTHER_CAP, id: "legacy", name: "Legacy", workspaceId: "skoolscout" };
    const second = { ...OTHER_CAP, id: "second", name: "Second", workspaceId: "skoolscout", order: 1 };
    const first = { ...OTHER_CAP, id: "first", name: "First", workspaceId: "skoolscout", order: 0 };
    stubFetch({ capabilities: { capabilities: [legacy, second, first], errors: [] } });
    const { client } = renderMapStage();
    seedSessionFrame(client, { workspace: "skoolscout" });
    await screen.findByText("First");
    expect([...document.querySelectorAll(".map-capability:not(.is-blank)")].map((c) => c.textContent)).toEqual([
      "First",
      "Second",
      "Legacy",
    ]);
  });

  it("reordering writes only the capabilities whose order actually changed", async () => {
    // A capability is its own FILE, so a dense renumber is a write per capability rather
    // than one write for the array. Moving a card one place must therefore cost two
    // PATCHes, not one per capability in the row.
    const a = { ...OTHER_CAP, id: "a", name: "Aye", workspaceId: "skoolscout", order: 0 };
    const b = { ...OTHER_CAP, id: "b", name: "Bee", workspaceId: "skoolscout", order: 1 };
    const c = { ...OTHER_CAP, id: "c", name: "Cee", workspaceId: "skoolscout", order: 2 };
    const { calls } = stubFetch({ capabilities: { capabilities: [a, b, c], errors: [] } });
    const { client } = renderMapStage();
    seedSessionFrame(client, { workspace: "skoolscout" });
    await screen.findByText("Bee");

    const cards = [...document.querySelectorAll(".map-capability:not(.is-blank)")];
    const transfer = { data: {} as Record<string, string>, effectAllowed: "", dropEffect: "" };
    const dataTransfer = {
      ...transfer,
      setData: (k: string, v: string) => {
        transfer.data[k] = v;
      },
      getData: (k: string) => transfer.data[k] ?? "",
    };
    // Drag "Bee" onto "Aye": Bee takes slot 0 and Aye slides to 1. "Cee" stays at 2 and
    // must not be written.
    fireEvent.dragStart(cards[1], { dataTransfer });
    fireEvent.drop(cards[0], { dataTransfer });

    await waitFor(() => {
      const patched = calls.filter((call) => call.method === "PATCH");
      expect(patched.map((call) => [call.url.split("/").pop(), (call.body as { order?: number }).order])).toEqual([
        ["b", 0],
        ["a", 1],
      ]);
    });
  });

  it("creates nothing when the blank capability card is committed empty", async () => {
    // The rule's other half, which the old panel enforced with `if (!capName)` and
    // BlankCard now enforces for all four levels. Worth an assertion here because this
    // is the level that just changed hands.
    const { calls } = stubFetch();
    const { client } = renderMapStage();
    seedSessionFrame(client, { workspace: "skoolscout" });
    await screen.findByText("Manage Candidate Tours");
    await userEvent.type(screen.getByPlaceholderText("Capability name"), "   {Enter}");
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/work/capabilities"))).toBe(false);
  });

  it("shows slice bands with done fractions", async () => {
    stubFetch();
    const { client } = renderMapStage();
    seedSessionFrame(client, { workspace: "skoolscout" });
    await screen.findByText("tour scheduling v1", { selector: ".slice-band__name" });
    expect(screen.getByText("1/2")).toBeTruthy();
  });

  it("the session moving to another workspace resets the selected capability to that workspace's own map (I5)", async () => {
    stubFetch({ capabilities: { capabilities: [CAP, OTHER_CAP], errors: [] } });
    const { client } = renderMapStage();
    seedSessionFrame(client, { workspace: "skoolscout" });
    await screen.findByText("Manage Candidate Tours");
    seedSessionFrame(client, { workspace: "smithagents" });
    // The picker's `value` became the selected CARD. Same guarantee: after a workspace
    // switch the active capability is the new workspace's own, not a survivor of the
    // old one — which is what the reset effect exists for.
    await waitFor(() =>
      expect(document.querySelector(".map-capability.is-selected")?.textContent).toBe("Other Product"),
    );
    // AWAITED, where it used to be synchronous. The picker and the canvas settle on
    // different ticks: the select is plain React, while a node reaches the DOM only
    // after xyflow has adopted the re-seeded array into its own store. That was true
    // before too — the assertion passed on an extra render pass it did not ask for,
    // which `edges={[]}` supplied by handing xyflow a fresh array identity on every
    // single render. Task 5 passes a memoized set instead, so the free pass is gone.
    // Same assertion, one tick later; the sibling test below already awaited it.
    await waitFor(() => expect(screen.getByText("Different Activity")).toBeTruthy());
    expect(screen.queryByText("Manage Candidate Tours")).toBeNull();
  });

  it("the session moving to a workspace with no capabilities clears the map instead of showing the old one", async () => {
    stubFetch({ capabilities: { capabilities: [CAP], errors: [] } });
    const { client } = renderMapStage();
    seedSessionFrame(client, { workspace: "skoolscout" });
    await screen.findByText("Manage Candidate Tours");
    seedSessionFrame(client, { workspace: "smithagents" });
    await waitFor(() => expect(screen.queryByText("Manage Candidate Tours")).toBeNull());
    // The select's empty value and its zero options, in the row's terms: nothing is
    // selected, and the row offers nothing to select. The second half is the one that
    // pins the workspace filter — the other workspace's capability still exists in the
    // query, and must not be on offer here.
    expect(document.querySelector(".map-capability.is-selected")).toBeNull();
    expect(document.querySelectorAll(".map-capability:not(.is-blank)").length).toBe(0);
    // …and the blank card survives an empty workspace, or there would be no way to
    // create the first capability in it.
    expect(screen.getByPlaceholderText("Capability name")).toBeTruthy();
  });

  it("an explicit single-workspace view overrides the session's workspace", async () => {
    // No UI sets a single-element viewedWorkspaces yet (same as BoardStage's
    // aggregate view) — driven directly, exercising the store's documented
    // "Board and Map" contract from the Map side.
    stubFetch({ capabilities: { capabilities: [CAP, OTHER_CAP], errors: [] } });
    const { client } = renderMapStage();
    seedSessionFrame(client, { workspace: "skoolscout" });
    await screen.findByText("Manage Candidate Tours");
    act(() => useUiStore.getState().setViewedWorkspaces(new Set(["smithagents"])));
    await waitFor(() => expect(screen.getByText("Different Activity")).toBeTruthy());
    expect(screen.queryByText("Manage Candidate Tours")).toBeNull();
  });

  it("viewing several workspaces (or all) has no single map to prefer, so it falls back to the session", async () => {
    stubFetch({ capabilities: { capabilities: [CAP, OTHER_CAP], errors: [] } });
    const { client } = renderMapStage();
    seedSessionFrame(client, { workspace: "skoolscout" });
    await screen.findByText("Manage Candidate Tours");
    // "smithagents" first, "skoolscout" (the session's) second: Set iteration
    // is insertion order, so a wrong implementation that picks the first
    // element of a multi-entry view would show OTHER_CAP here instead — this
    // ordering is what makes the assertion below actually discriminate.
    act(() => useUiStore.getState().setViewedWorkspaces(new Set(["smithagents", "skoolscout"])));
    // Still skoolscout's map — a 2-workspace view doesn't name a single one.
    expect(screen.getByText("Manage Candidate Tours")).toBeTruthy();
    expect(screen.queryByText("Different Activity")).toBeNull();
    act(() => useUiStore.getState().setViewedWorkspaces(ALL_WORKSPACES));
    expect(screen.getByText("Manage Candidate Tours")).toBeTruthy();
    expect(screen.queryByText("Different Activity")).toBeNull();
  });
});

describe("MapStage + socket store wiring", () => {
  /** Minimal WebSocket stand-in — only what socketStore.connect()/onmessage need. */
  class FakeSocket {
    static last: FakeSocket | null = null;
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    readyState = 0;
    constructor(_url: string) {
      FakeSocket.last = this;
    }
    close() {}
  }

  afterEach(() => {
    cleanup();
    useSocketStore.getState().disconnect();
    FakeSocket.last = null;
    vi.unstubAllGlobals();
  });

  it("a capability-updated frame invalidates the capabilities collection and triggers a real refetch", async () => {
    // Replaces the deleted lastCapabilityUpdate seq counter: Task 6's
    // socketStore invalidates qk.capabilities, and because MapStage observes
    // that key via useCapabilities(), the invalidate alone produces a second
    // GET — no prop, no manual refetch() call.
    vi.stubGlobal("WebSocket", FakeSocket);
    const { calls } = stubFetch();
    const { client } = renderMapStage();
    seedSessionFrame(client, { workspace: "skoolscout" });
    await screen.findByText("Manage Candidate Tours");
    const fetched = () => calls.filter((c) => c.url.includes("/work/capabilities") && c.method === "GET").length;
    const before = fetched();
    const spy = vi.spyOn(client, "invalidateQueries");

    useSocketStore.getState().connect(client);
    await act(async () => {
      FakeSocket.last?.onmessage?.({
        data: JSON.stringify({ type: "capability-updated", capabilityId: "school-feature-set" }),
      });
    });

    expect(spy).toHaveBeenCalledWith({ queryKey: qk.capabilities });
    await waitFor(() => expect(fetched()).toBe(before + 1));
  });

  it("a capability-updated frame for another workspace's capability does not un-clear an empty workspace (F1)", async () => {
    // I5 already nulls activeId when the selected workspace has no
    // capabilities. Collection-level invalidation means ANY capability
    // update — even one that belongs to a workspace the user isn't looking
    // at — now triggers a refetch of the same collection, so the seeding
    // effect must not treat that null activeId as "still unseeded" and grab
    // caps[0] from a different workspace.
    vi.stubGlobal("WebSocket", FakeSocket);
    const overrides: { capabilities?: unknown } = { capabilities: { capabilities: [CAP], errors: [] } };
    const { calls } = stubFetch(overrides);
    const { client } = renderMapStage();
    seedSessionFrame(client, { workspace: "skoolscout" });
    await screen.findByText("Manage Candidate Tours");

    // "smithagents" has no capabilities of its own — I5 clears the map.
    seedSessionFrame(client, { workspace: "smithagents" });
    await waitFor(() => expect(screen.queryByText("Manage Candidate Tours")).toBeNull());
    expect(document.querySelector(".map-capability.is-selected")).toBeNull();

    // The refetch must return genuinely different data — TanStack's
    // structural sharing would otherwise keep the same `data` reference and
    // never re-run the seeding effect at all, making this pass vacuously.
    overrides.capabilities = {
      capabilities: [
        { ...CAP, stories: [...CAP.stories, { id: "s9", stepId: "st1", order: 2, text: "new", done: false }] },
      ],
      errors: [],
    };

    useSocketStore.getState().connect(client);
    const fetched = () => calls.filter((c) => c.url.includes("/work/capabilities") && c.method === "GET").length;
    const before = fetched();
    await act(async () => {
      FakeSocket.last?.onmessage?.({
        data: JSON.stringify({ type: "capability-updated", capabilityId: "school-feature-set" }),
      });
    });
    await waitFor(() => expect(fetched()).toBeGreaterThan(before));

    // Still cleared — the refetch must not seed a capability from skoolscout while the
    // row is showing smithagents. (The picker this used to read is gone; the selected
    // card is the same fact.)
    expect(document.querySelector(".map-capability.is-selected")).toBeNull();
    expect(screen.queryByText("Manage Candidate Tours")).toBeNull();
  });
});

describe("MapStage editing", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("adds a story to a step via wholesale PATCH", async () => {
    const { calls } = stubFetch();
    const { client } = renderMapStage();
    seedSessionFrame(client, { workspace: "skoolscout" });
    await screen.findByText("Define Tour Schedule");
    await userEvent.type(screen.getAllByPlaceholderText(/add a story/i)[0], "delete tour time slots{Enter}");
    await waitFor(() => {
      const call = calls.find((c) => c.method === "PATCH" && c.url.includes("/work/capabilities/school-feature-set"));
      const stories = (call?.body as { stories?: Array<{ text: string; stepId: string }> })?.stories;
      expect(stories?.some((s) => s.text === "delete tour time slots" && s.stepId === "st1")).toBe(true);
      expect(stories?.length).toBe(4); // wholesale: existing three ride along
    });
  });

  // The other two levels of the SAME wiring. nodes.test.tsx proves the three blank
  // components call `onCommit`; these prove `decorate` actually supplies one at each
  // level. A level it forgot would not no-op — `onCommit` is invoked unguarded, so it
  // throws — and only the story level was covered before.
  it("the blank ACTIVITY card creates an activity", async () => {
    const { calls } = stubFetch();
    const { client } = renderMapStage();
    seedSessionFrame(client, { workspace: "skoolscout" });
    await screen.findByText("Manage Candidate Tours");
    await userEvent.type(screen.getByPlaceholderText(/add an activity/i), "Run Enrolment{Enter}");
    await waitFor(() => {
      const call = calls.find((c) => c.method === "PATCH" && c.url.includes("/work/capabilities/school-feature-set"));
      const activities = (call?.body as { activities?: Array<{ name: string; steps: unknown[] }> })?.activities;
      expect(activities?.some((a) => a.name === "Run Enrolment" && a.steps.length === 0)).toBe(true);
      expect(activities?.length).toBe(2); // wholesale: the existing one rides along
    });
  });

  it("the blank STEP card creates a step in ITS OWN activity", async () => {
    const { calls } = stubFetch();
    const { client } = renderMapStage();
    seedSessionFrame(client, { workspace: "skoolscout" });
    await screen.findByText("Manage Candidate Tours");
    // One blank step card per activity; CAP has one activity, so this is act1's.
    await userEvent.type(screen.getByPlaceholderText(/add a step/i), "Confirm Attendance{Enter}");
    await waitFor(() => {
      const call = calls.find((c) => c.method === "PATCH" && c.url.includes("/work/capabilities/school-feature-set"));
      const body = call?.body as { activities?: Array<{ id: string; steps: Array<{ name: string }> }> };
      const act = body?.activities?.[0];
      expect(act?.id).toBe("act1");
      expect(act?.steps.map((s) => s.name)).toEqual([
        "Define Tour Schedule",
        "Analyze Tour Data",
        "Confirm Attendance",
      ]);
    });
  });

  it("fireStoryDrop moves a story between steps via wholesale PATCH", async () => {
    const { calls } = stubFetch();
    const { client } = renderMapStage();
    seedSessionFrame(client, { workspace: "skoolscout" });
    await screen.findByText("Define Tour Schedule");
    const { fireStoryDrop } = await import("./MapStage");
    await fireStoryDrop("s2", "st2", 0);
    await waitFor(() => {
      const call = calls.find((c) => c.method === "PATCH" && c.url.includes("/work/capabilities/school-feature-set"));
      const moved = (call?.body as { stories?: Array<{ id: string; stepId: string }> })?.stories?.find(
        (s) => s.id === "s2",
      );
      expect(moved?.stepId).toBe("st2");
    });
  });

  it("assigning a story to a slice keeps storyIds disjoint", async () => {
    const { calls } = stubFetch();
    const { client } = renderMapStage();
    seedSessionFrame(client, { workspace: "skoolscout" });
    await screen.findByText("create tour time slots");
    // Each story renders a slice select; move s1 from sl1 to sl2.
    await userEvent.selectOptions(screen.getAllByLabelText(/slice for/i)[0], "sl2");
    await waitFor(() => {
      const call = calls.find((c) => c.method === "PATCH" && c.url.includes("/work/capabilities/school-feature-set"));
      const slices = (call?.body as { slices?: Array<{ id: string; storyIds: string[] }> })?.slices;
      expect(slices?.find((s) => s.id === "sl1")?.storyIds).toEqual(["s2"]);
      expect(slices?.find((s) => s.id === "sl2")?.storyIds).toEqual(["s1"]);
    });
  });

  it("slice actions: generate spec POSTs; delivery send gated until specPath; sends post the target", async () => {
    const { calls } = stubFetch();
    const { client } = renderMapStage();
    seedSessionFrame(client, { workspace: "skoolscout" });
    await screen.findByText("tour scheduling v1", { selector: ".slice-band__name" });
    // sl2 has no specPath: generate visible, delivery send disabled with reason.
    expect(screen.getByRole("button", { name: /generate spec for analytics v1/i })).toBeTruthy();
    const deliveryBtn = screen.getByRole("button", { name: /send analytics v1 to delivery/i }) as HTMLButtonElement;
    expect(deliveryBtn.disabled).toBe(true);
    expect(deliveryBtn.title).toMatch(/spec/i);
    await userEvent.click(screen.getByRole("button", { name: /generate spec for analytics v1/i }));
    await waitFor(() =>
      expect(calls.some((c) => c.url.includes("/slices/sl2/spec") && c.method === "POST")).toBe(true),
    );
    // sl1 has a specPath: delivery send enabled and posts the target.
    await userEvent.click(screen.getByRole("button", { name: /send tour scheduling v1 to delivery/i }));
    await waitFor(() => {
      const call = calls.find((c) => c.url.includes("/slices/sl1/send"));
      expect(call?.body).toMatchObject({ target: "delivery" });
    });
  });

  it("a rejected move reports false rather than resolving undefined", async () => {
    const { calls } = stubFetch();
    failEveryPatch();
    const { client } = renderMapStage();
    seedSessionFrame(client, { workspace: "skoolscout" });
    await screen.findByText("Define Tour Schedule");
    const { fireStoryDrop } = await import("./MapStage");
    // fireStoryDrop reaches moveStory, NOT the drag-stop path — this pins the boolean
    // the snap-back depends on. The snap-back itself is the next two tests.
    const moved = await fireStoryDrop("s2", "st2", 0);
    expect(moved).toBe(false);
    expect(calls.some((c) => c.method === "PATCH")).toBe(true);
  });

  it("dragging an activity reorders the backbone and renumbers order densely", async () => {
    const { calls } = stubFetch({ capabilities: { capabilities: [TWO_ACT], errors: [] } });
    const { client } = renderMapStage();
    seedSessionFrame(client, { workspace: "skoolscout" });
    await screen.findByText("Second");
    const { fireNodeDragStop } = await import("./MapStage");
    // act2's card dropped on act1's left edge — the first slot.
    await act(async () => {
      await fireNodeDragStop("activity:act2", { x: 0, y: 0 });
    });
    await waitFor(() => {
      const patches = calls.filter((c) => c.method === "PATCH");
      const call = patches[patches.length - 1];
      const activities = (call?.body as { activities?: Array<{ id: string; order: number }> })?.activities;
      // Dense and 0-based, not a swap of two order values.
      expect(activities?.map((a) => [a.id, a.order])).toEqual([
        ["act2", 0],
        ["act1", 1],
      ]);
    });
  });

  it("dragging a step onto another activity's column moves it to that activity", async () => {
    // Cross-activity is a real edit: a step belongs to an activity, so dropping one
    // under a different heading is the user saying it belongs there now. Both parents
    // are rewritten, because a step lives inside its own activity's `steps` array.
    const { calls } = stubFetch({ capabilities: { capabilities: [TWO_ACT], errors: [] } });
    const { client } = renderMapStage();
    seedSessionFrame(client, { workspace: "skoolscout" });
    await screen.findByText("Second");
    const { fireNodeDragStop } = await import("./MapStage");
    const st2x = stepColumns(TWO_ACT.activities).find((c) => c.stepId === "st2")?.x ?? 0;
    await act(async () => {
      await fireNodeDragStop("step:st1", { x: st2x, y: 40 });
    });
    await waitFor(() => {
      const patches = calls.filter((c) => c.method === "PATCH");
      const call = patches[patches.length - 1];
      const activities = (call?.body as { activities?: Array<{ id: string; steps: Array<{ id: string }> }> })
        ?.activities;
      expect(activities?.find((a) => a.id === "act1")?.steps.map((s) => s.id)).toEqual([]);
      expect(activities?.find((a) => a.id === "act2")?.steps.map((s) => s.id)).toEqual(["st1", "st2"]);
    });
  });

  it("a step dropped on a blank column writes nothing and snaps back", async () => {
    // The trailing composer is a slot no record can take. Without this guard a reorder
    // could displace the "add a step" card, which is the affordance itself.
    const { calls } = stubFetch({ capabilities: { capabilities: [TWO_ACT], errors: [] } });
    const { client } = renderMapStage();
    seedSessionFrame(client, { workspace: "skoolscout" });
    await screen.findByText("Second");
    const { fireNodeDragStop } = await import("./MapStage");
    const before = nodePosition("step:st1");
    const blankX = nodePosition("new:step:act1");
    expect(blankX).toBeTruthy();
    const x = Number(/translate\((-?[\d.]+)px/.exec(blankX ?? "")?.[1]);
    await act(async () => {
      await fireNodeDragStop("step:st1", { x, y: 40 });
    });
    expect(nodePosition("step:st1")).toBe(before);
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("a story still lands where aimed AFTER a reorder has moved the columns", async () => {
    // THE TWO-GESTURE CASE, which is the one a single-gesture test cannot reach: a
    // reorder changes every column's x, and the story resolution has to read the new
    // geometry rather than the geometry it was mounted with. Aimed at a position that
    // means DIFFERENT steps before and after the reorder, so stale columns resolve to
    // the wrong one rather than merely to a stale-looking number.
    const overrides: { capabilities?: unknown } = { capabilities: { capabilities: [TWO_ACT], errors: [] } };
    const { calls } = stubFetch(overrides);
    const { client } = renderMapStage();
    seedSessionFrame(client, { workspace: "skoolscout" });
    await screen.findByText("Second");

    const cols = stepColumns(TWO_ACT.activities);
    const st2xBefore = cols.find((c) => c.stepId === "st2")?.x ?? 0;
    // Gesture 1: swap the activities. The refetch returns the reordered model, which is
    // what moves st1 to where st2 used to be.
    overrides.capabilities = { capabilities: [REORDERED], errors: [] };
    const { fireNodeDragStop } = await import("./MapStage");
    await act(async () => {
      await fireNodeDragStop("activity:act2", { x: 0, y: 0 });
    });
    // Wait for the reorder to reach the canvas: st1 now sits where st2 used to be.
    await waitFor(() => {
      const st1 = nodePosition("step:st1");
      expect(st1).toContain(`translate(${st2xBefore}px`);
    });

    // Gesture 2: drop the story at that same x. Before the reorder it meant st2; now it
    // means st1, and that is what it must resolve to.
    await act(async () => {
      await fireNodeDragStop("s1", { x: st2xBefore, y: STORIES_Y });
    });
    await waitFor(() => {
      const patches = calls.filter((c) => c.method === "PATCH");
      const call = patches[patches.length - 1];
      const moved = (call?.body as { stories?: Array<{ id: string; stepId: string }> })?.stories?.find(
        (s) => s.id === "s1",
      );
      expect(moved?.stepId).toBe("st1");
    });
  });

  // The two re-seed branches, reached through fireNodeDragStop. Both are the same
  // shape: the node is displaced to a drop point, the drop does not stick, and the
  // node must return to the position layoutMap derives for it — otherwise the canvas
  // shows a move that never happened. Neither branch was executed by any test before.
  it("a drop outside the grid returns the node to its derived position and writes nothing", async () => {
    const { calls } = stubFetch();
    const { client } = renderMapStage();
    seedSessionFrame(client, { workspace: "skoolscout" });
    await screen.findByText("Define Tour Schedule");
    const { fireNodeDragStop } = await import("./MapStage");
    const before = nodePosition("s2");
    // Far left of the first column: cellAt rejects it, so there is no cell to write to.
    await act(async () => {
      await fireNodeDragStop("s2", { x: -5000, y: STORIES_Y });
    });
    expect(nodePosition("s2")).toBe(before);
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("a rejected move returns the node to its derived position", async () => {
    stubFetch();
    failEveryPatch();
    const { client } = renderMapStage();
    seedSessionFrame(client, { workspace: "skoolscout" });
    await screen.findByText("Define Tour Schedule");
    const { fireNodeDragStop } = await import("./MapStage");
    const before = nodePosition("s2");
    // A VALID cell — st2's column, first slot. The drop resolves, the PATCH fails, and
    // the model never changes, so the seeding effect cannot put the node back: only
    // the explicit re-seed can.
    const st2x = stepColumns(CAP.activities).find((c) => c.stepId === "st2")?.x ?? 0;
    await act(async () => {
      await fireNodeDragStop("s2", { x: st2x, y: STORIES_Y });
    });
    expect(nodePosition("s2")).toBe(before);
    await waitFor(() => expect(screen.getByText(/update failed/i)).toBeTruthy());
  });

  it("clicking a slice band reveals its chain and dims the rest", async () => {
    stubFetch();
    const { client } = renderMapStage();
    seedSessionFrame(client, { workspace: "skoolscout" });
    await screen.findByText("tour scheduling v1", { selector: ".slice-band__name" });

    // At rest there is no anchor and no artifact node.
    expect(document.querySelector(".map-slice-anchor")).toBeNull();
    expect(document.querySelector(".map-artifact")).toBeNull();

    await userEvent.click(screen.getByText("tour scheduling v1", { selector: ".slice-band__name" }));

    // sl1 has a specPath, so a spec artifact materializes; sl1 owns s1 and s2.
    await waitFor(() => expect(document.querySelector(".map-slice-anchor")).not.toBeNull());
    expect(document.querySelector(".map-artifact--spec")).not.toBeNull();
    // s3 belongs to no slice, so it dims.
    await waitFor(() => {
      const s3 = screen.getByText("view tour analytics").closest(".map-story");
      expect(s3?.classList.contains("is-dimmed")).toBe(true);
    });
    // …and s1, which the slice owns, does not.
    expect(screen.getByText("create tour time slots").closest(".map-story")?.classList.contains("is-dimmed")).toBe(
      false,
    );
    // s2 IS THE ONE THAT DISCRIMINATES, and the other two cannot. s1 is the fixture's
    // only done:true story and is also in-slice, so against s1 and s3 alone "dim what
    // the slice does not own" and "dim what is not done" agree exactly — swap the
    // filter for `!story.done` and this test still passes. That is not a far-fetched
    // mutation: `done` is read three lines away to build the anchor's fraction. s2 is
    // owned by sl1 and done:false, so it is dimmed by the wrong rule and lit by the
    // right one.
    expect(screen.getByText("edit tour time slots").closest(".map-story")?.classList.contains("is-dimmed")).toBe(false);
  });

  it("lays the artifacts out as a ROW — same y, different x", async () => {
    // The numbers belong to layout.test.ts, which owns artifactRowX/artifactRowY as
    // pure functions. What only this test can see is whether MapStage actually PASSES
    // THE INDEX through: emit `artifactRowX(0, rowX)` for every artifact and every
    // other assertion in this file still passes while all four cards stack on the
    // exact same point. jsdom lays nothing out, but xyflow writes each node's position
    // into an inline transform, and that needs no stylesheet to read.
    stubFetch();
    const { client } = renderMapStage();
    seedSessionFrame(client, { workspace: "skoolscout" });
    await screen.findByText("tour scheduling v1", { selector: ".slice-band__name" });
    await userEvent.click(screen.getByText("tour scheduling v1", { selector: ".slice-band__name" }));

    await waitFor(() => expect(document.querySelectorAll(".map-artifact").length).toBe(2));
    const at = [...document.querySelectorAll(".map-artifact")].map((card) => {
      const node = card.closest(".react-flow__node") as HTMLElement | null;
      const match = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(node?.style.transform ?? "");
      if (!match) throw new Error(`no transform on artifact node: ${node?.style.transform}`);
      return { x: Number(match[1]), y: Number(match[2]) };
    });
    expect(at[0].y).toBe(at[1].y);
    expect(at[1].x).toBeGreaterThan(at[0].x);
  });

  it("clicking a story title reveals its chain as a stack, and does not dim the map", async () => {
    // The two reveals answer different questions and must not look alike: the band asks
    // "what is in this release" and dims everything outside it; a story asks "where is
    // THIS one specced", which is narrow enough that restyling the map would be noise.
    stubFetch();
    const { client } = renderMapStage();
    seedSessionFrame(client, { workspace: "skoolscout" });
    // TWO jsdom accommodations here, both artifacts of the canvas rather than defects,
    // and both verified to behave correctly in a real browser.
    //
    // getByText, NOT getByRole, even though the title is a real <button>: xyflow marks a
    // node `visibility: hidden` until it has measured it, and jsdom never lays anything
    // out, so every card on the canvas is invisible to accessibility queries here — 21
    // hidden buttons against 12 visible ones. Every other test in this file queries
    // canvas content the same way.
    //
    // fireEvent, NOT userEvent: the title IS the drag handle, so a full pointer sequence
    // reaches xyflow's d3-drag, whose `nodrag` helper dereferences `event.view.document`
    // — and the view is null on events user-event synthesizes. It throws OUTSIDE the
    // assertion, so the suite reports every test passing and then exits 1. fireEvent
    // dispatches the click alone, which is the gesture under test.
    await screen.findByText("create tour time slots");
    fireEvent.click(screen.getByText("create tour time slots"));

    await waitFor(() => expect(document.querySelector(".map-slice-anchor")).not.toBeNull());
    expect(document.querySelector(".map-story.is-selected")).not.toBeNull();
    expect(document.querySelector(".map-story.is-dimmed")).toBeNull();

    // A STACK, not a row: sl1's anchor and its two artifacts share an x and differ in y.
    const at = [...document.querySelectorAll(".map-slice-anchor, .map-artifact")].map((card) => {
      const match = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(
        (card.closest(".react-flow__node") as HTMLElement | null)?.style.transform ?? "",
      );
      if (!match) throw new Error("no transform on a revealed card");
      return { x: Number(match[1]), y: Number(match[2]) };
    });
    expect(at.length).toBe(3);
    expect(new Set(at.map((p) => p.x)).size).toBe(1);
    expect(new Set(at.map((p) => p.y)).size).toBe(at.length);
  });

  it("a story in no slice says so rather than doing nothing", async () => {
    // s3 belongs to no slice, and most real stories look like s3. A control that
    // silently does nothing on its commonest target teaches people it is broken.
    stubFetch();
    const { client } = renderMapStage();
    seedSessionFrame(client, { workspace: "skoolscout" });
    await screen.findByText("view tour analytics");
    fireEvent.click(screen.getByText("view tour analytics"));

    await waitFor(() => expect(document.querySelector(".map-artifact--backlog")).not.toBeNull());
    expect(screen.getByText("not in a slice yet")).toBeTruthy();
    expect(document.querySelector(".map-slice-anchor")).toBeNull();
  });

  it("selecting a story replaces a band reveal rather than stacking on it", async () => {
    // One selection, so the scopes are mutually exclusive by construction — but the
    // band's dimming and edges have to actually go away, which is a property of the
    // effect's branches rather than of the hook.
    stubFetch();
    const { client } = renderMapStage();
    seedSessionFrame(client, { workspace: "skoolscout" });
    await screen.findByText("tour scheduling v1", { selector: ".slice-band__name" });
    await userEvent.click(screen.getByText("tour scheduling v1", { selector: ".slice-band__name" }));
    await waitFor(() => expect(document.querySelector(".map-story.is-dimmed")).not.toBeNull());

    fireEvent.click(screen.getByText("create tour time slots"));
    await waitFor(() => expect(document.querySelector(".map-story.is-selected")).not.toBeNull());
    expect(document.querySelector(".map-story.is-dimmed")).toBeNull();
  });

  it("clicking the same slice band again clears the reveal", async () => {
    stubFetch();
    const { client } = renderMapStage();
    seedSessionFrame(client, { workspace: "skoolscout" });
    const band = await screen.findByText("tour scheduling v1", { selector: ".slice-band__name" });
    await userEvent.click(band);
    await waitFor(() => expect(document.querySelector(".map-slice-anchor")).not.toBeNull());
    await userEvent.click(band);
    await waitFor(() => expect(document.querySelector(".map-slice-anchor")).toBeNull());
    expect(document.querySelector(".map-artifact")).toBeNull();
    expect(document.querySelector(".map-story.is-dimmed")).toBeNull();
  });
  /**
   * The panel's assertions read the CARD, not the node wrapper. `decorate` puts `dimmed`
   * into node DATA and the card renders `is-dimmed` from it — the `[data-id]` wrapper
   * xyflow owns never carries the class, so a wrapper-based assertion fails against a
   * correct implementation. Same selector the slice-band dim test above uses.
   */
  it("lists every slice with its story count", async () => {
    stubFetch();
    const { client } = renderMapStage();
    seedSessionFrame(client, { workspace: "skoolscout" });
    const panel = await screen.findByRole("region", { name: "Slices" });
    expect(within(panel).getByText("tour scheduling v1")).toBeDefined();
    expect(within(panel).getByText("2")).toBeDefined();
  });

  it("hovering a slice dims every story it does not own", async () => {
    stubFetch();
    const { client } = renderMapStage();
    seedSessionFrame(client, { workspace: "skoolscout" });
    const panel = await screen.findByRole("region", { name: "Slices" });
    await userEvent.hover(within(panel).getByText("tour scheduling v1"));

    // s3 is in no slice, so it dims.
    await waitFor(() => {
      expect(screen.getByText("view tour analytics").closest(".map-story")?.classList.contains("is-dimmed")).toBe(true);
    });
    expect(screen.getByText("create tour time slots").closest(".map-story")?.classList.contains("is-dimmed")).toBe(
      false,
    );
    // s2 DISCRIMINATES, for the same reason it does in the slice-band test: it is the
    // only story that is owned by sl1 AND not done, so "dim what the slice does not own"
    // and "dim what is not done" disagree on it and nowhere else.
    expect(screen.getByText("edit tour time slots").closest(".map-story")?.classList.contains("is-dimmed")).toBe(false);

    await userEvent.unhover(within(panel).getByText("tour scheduling v1"));
    await waitFor(() => expect(document.querySelector(".map-story.is-dimmed")).toBeNull());
  });

  it("marks a grandfathered slice that owns nothing", async () => {
    stubFetch();
    const { client } = renderMapStage();
    seedSessionFrame(client, { workspace: "skoolscout" });
    const panel = await screen.findByRole("region", { name: "Slices" });
    expect(within(panel).getByText("empty legacy").closest("li")?.getAttribute("data-invalid")).toBe("true");
    // And the slice that DOES own something is not marked — without this the test passes
    // against an implementation that marks every row.
    expect(within(panel).getByText("tour scheduling v1").closest("li")?.getAttribute("data-invalid")).toBeNull();
  });

  it("collapses to a header carrying the count, and hides the list", async () => {
    stubFetch();
    const { client } = renderMapStage();
    seedSessionFrame(client, { workspace: "skoolscout" });
    const panel = await screen.findByRole("region", { name: "Slices" });
    const toggle = within(panel).getByRole("button", { name: /collapse slices/i });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    await userEvent.click(toggle);
    expect(within(panel).queryByText("tour scheduling v1")).toBeNull();
    expect(within(panel).getByText("3")).toBeDefined();
    expect(within(panel).getByRole("button", { name: /expand slices/i })).toBeDefined();
  });

  it("collapsing clears any hover highlight rather than stranding it", async () => {
    stubFetch();
    const { client } = renderMapStage();
    seedSessionFrame(client, { workspace: "skoolscout" });
    const panel = await screen.findByRole("region", { name: "Slices" });
    await userEvent.hover(within(panel).getByText("tour scheduling v1"));
    await waitFor(() => expect(document.querySelector(".map-story.is-dimmed")).not.toBeNull());

    // The list UNMOUNTS, and an unmounted element fires no onMouseLeave. Without an
    // explicit clear the map stays dimmed against a slice that is no longer on screen
    // to un-hover.
    await userEvent.click(within(panel).getByRole("button", { name: /collapse slices/i }));
    await waitFor(() => expect(document.querySelector(".map-story.is-dimmed")).toBeNull());
  });
  /**
   * Selection, driven the way a user drives it: Shift held (React Flow tracks
   * `multiSelectionKeyCode` through a document-level key listener, not through the click
   * event) and the click landing on the story's TITLE — the same 44% of the card that
   * reveals. That routes through the title's shift-decline, so these tests fail if the
   * two gestures ever start eating each other.
   *
   * Nodes are found by `data-id` rather than by role: xyflow marks unmeasured nodes
   * `visibility: hidden`, and jsdom measures nothing, so `getByRole` cannot see them.
   */
  function selectStories(ids: string[]) {
    fireEvent.keyDown(document, { key: "Shift", shiftKey: true });
    for (const id of ids) {
      const handle = document.querySelector(`.react-flow__node[data-id="${id}"] .map-story__handle`);
      if (!handle) throw new Error(`no story node ${id} on the canvas`);
      fireEvent.click(handle, { shiftKey: true });
    }
    fireEvent.keyUp(document, { key: "Shift" });
  }

  const blockedText = () => document.querySelector(".slice-panel__blocked")?.textContent ?? "";

  it("creating a slice from the selection sends one PATCH with the whole array", async () => {
    const { calls } = stubFetch();
    const { client } = renderMapStage();
    seedSessionFrame(client, { workspace: "skoolscout" });
    const panel = await screen.findByRole("region", { name: "Slices" });
    // s2 is ALREADY in sl1 and s3 is in none. Overlapping is the point of the feature, and
    // sl1 keeps s1 so nothing is stripped — so this is a write the rule allows.
    selectStories(["s2", "s3"]);

    const create = await within(panel).findByText(/slice from 2 selected/i);
    expect((create.closest("button") as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(create);
    await userEvent.type(screen.getByPlaceholderText("Name this slice…"), "analytics v2{Enter}");

    await waitFor(() => {
      expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
    });
    const body = calls.find((c) => c.method === "PATCH")?.body as { slices: Array<Record<string, unknown>> };
    // WHOLESALE: the existing three ride along, or the server would read their absence as
    // a deletion.
    expect(body.slices).toHaveLength(4);
    expect(body.slices[3]).toMatchObject({ name: "analytics v2", storyIds: ["s2", "s3"] });
  });

  it("disables the button and names the slice a selection would strip", async () => {
    stubFetch();
    const { client } = renderMapStage();
    seedSessionFrame(client, { workspace: "skoolscout" });
    const panel = await screen.findByRole("region", { name: "Slices" });
    // sl1 owns s1 AND s2 exclusively, so taking BOTH is what strips it — taking one alone
    // leaves it the other. Measured against blockedBy rather than assumed.
    selectStories(["s1", "s2"]);

    const create = await within(panel).findByText(/slice from 2 selected/i);
    expect((create.closest("button") as HTMLButtonElement).disabled).toBe(true);
    // Asserted on the MESSAGE, not on the panel: "tour scheduling v1" also appears in the
    // list row above, so a panel-wide text query passes no matter what the message says.
    await waitFor(() => expect(blockedText()).toMatch(/is the only story tour scheduling v1 owns/i));
    expect(blockedText()).toContain("create tour time slots");
    // The slice being created is blocked here too, and it has no name yet — if it reached
    // the sentence there would be a hole where a name should be.
    expect(blockedText()).not.toMatch(/,\s+owns/);
  });

  it("blames the selection, not a neighbour, when only the NEW slice would be invalid", async () => {
    stubFetch();
    const { client } = renderMapStage();
    seedSessionFrame(client, { workspace: "skoolscout" });
    const panel = await screen.findByRole("region", { name: "Slices" });
    // s1 is already in sl1, and sl1 keeps s2 — so nothing is taken from anyone and the new
    // slice is the only casualty. There is no victim to name.
    selectStories(["s1"]);

    const create = await within(panel).findByText(/slice from 1 selected/i);
    expect((create.closest("button") as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(blockedText()).toMatch(/already belongs to another slice/i));
    expect(blockedText()).not.toMatch(/is the only story/i);
  });

  it("offers nothing when nothing is selected", async () => {
    stubFetch();
    const { client } = renderMapStage();
    seedSessionFrame(client, { workspace: "skoolscout" });
    const panel = await screen.findByRole("region", { name: "Slices" });
    expect(within(panel).queryByText(/slice from/i)).toBeNull();
  });

  it("the New slice name box is gone — selection is the only way a slice is born", async () => {
    stubFetch();
    const { client } = renderMapStage();
    seedSessionFrame(client, { workspace: "skoolscout" });
    await screen.findByRole("region", { name: "Slices" });
    expect(screen.queryByPlaceholderText("New slice name…")).toBeNull();
  });

  it("a reveal does not clear the selection", async () => {
    stubFetch();
    const { client } = renderMapStage();
    seedSessionFrame(client, { workspace: "skoolscout" });
    const panel = await screen.findByRole("region", { name: "Slices" });
    selectStories(["s1", "s2"]);
    expect(await within(panel).findByText(/slice from 2 selected/i)).toBeDefined();

    // Revealing rebuilds every node from the model, which is exactly what wipes React
    // Flow's own `selected` flags — the selection has to be written back.
    //
    // fireEvent, not userEvent: a story node is draggable, so userEvent's fuller pointer
    // sequence reaches d3-drag's `nodrag`, which dereferences `event.view.document` and
    // throws under jsdom. The throw is UNHANDLED, so the suite reports 44 passed and
    // still exits 1.
    fireEvent.click(screen.getByText("view tour analytics"));
    await waitFor(() => expect(document.querySelector(".map-slice-anchor, .map-artifact")).not.toBeNull());
    expect(within(panel).getByText(/slice from 2 selected/i)).toBeDefined();
  });

  it("shift-clicking a story title adds it rather than revealing", async () => {
    stubFetch();
    const { client } = renderMapStage();
    seedSessionFrame(client, { workspace: "skoolscout" });
    const panel = await screen.findByRole("region", { name: "Slices" });
    selectStories(["s1"]);
    expect(await within(panel).findByText(/slice from 1 selected/i)).toBeDefined();

    selectStories(["s2"]);
    expect(await within(panel).findByText(/slice from 2 selected/i)).toBeDefined();
    // …and it did NOT reveal: no chain opened for the story that was shift-clicked.
    expect(document.querySelector(".map-slice-anchor")).toBeNull();
  });

  it("keeps the create control reachable while the panel is collapsed", async () => {
    stubFetch();
    const { client } = renderMapStage();
    seedSessionFrame(client, { workspace: "skoolscout" });
    const panel = await screen.findByRole("region", { name: "Slices" });
    selectStories(["s1", "s2"]);
    await within(panel).findByText(/slice from 2 selected/i);

    await userEvent.click(within(panel).getByRole("button", { name: /collapse slices/i }));
    expect(within(panel).queryByText("tour scheduling v1")).toBeNull();
    expect(within(panel).getByText(/slice from 2 selected/i)).toBeDefined();
  });
  it("clears the selection after a successful create", async () => {
    stubFetch();
    const { client } = renderMapStage();
    seedSessionFrame(client, { workspace: "skoolscout" });
    const panel = await screen.findByRole("region", { name: "Slices" });
    selectStories(["s2", "s3"]);
    await userEvent.click(await within(panel).findByText(/slice from 2 selected/i));
    await userEvent.type(screen.getByPlaceholderText("Name this slice…"), "analytics v2{Enter}");

    // Leaving the stories selected re-proposes them against a world that now contains the
    // slice they went into — so the panel would name the slice JUST CREATED as the victim
    // of the selection that created it, one action after a success.
    await waitFor(() => expect(within(panel).queryByText(/slice from/i)).toBeNull());
    expect(document.querySelector(".slice-panel__blocked")).toBeNull();
  });

  it("Escape abandons naming and gives the button back", async () => {
    stubFetch();
    const { client } = renderMapStage();
    seedSessionFrame(client, { workspace: "skoolscout" });
    const panel = await screen.findByRole("region", { name: "Slices" });
    selectStories(["s3"]);
    await userEvent.click(await within(panel).findByText(/slice from 1 selected/i));
    const input = screen.getByPlaceholderText("Name this slice…");

    await userEvent.type(input, "half a name{Escape}");
    expect(screen.queryByPlaceholderText("Name this slice…")).toBeNull();
    // The selection survives — Escape abandons the NAME, not the stories.
    expect(within(panel).getByText(/slice from 1 selected/i)).toBeDefined();
  });
  it("commits the stories the button counted, not whatever is selected when Enter lands", async () => {
    const { calls } = stubFetch();
    const { client } = renderMapStage();
    seedSessionFrame(client, { workspace: "skoolscout" });
    const panel = await screen.findByRole("region", { name: "Slices" });
    selectStories(["s3"]);
    await userEvent.click(await within(panel).findByText(/slice from 1 selected/i));

    // Naming swaps the button for an input but does NOT lock the canvas, so the selection
    // can still move underneath it. Everything the panel validated — the count, the
    // blocked check, the message — was computed for the OLD selection.
    selectStories(["s2"]);
    await userEvent.type(screen.getByPlaceholderText("Name this slice…"), "frozen{Enter}");

    await waitFor(() => expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1));
    const body = calls.find((c) => c.method === "PATCH")?.body as { slices: Array<{ storyIds: string[] }> };
    // s3 alone — what "+ slice from 1 selected" promised — and not s2, which arrived after.
    expect(body.slices[3].storyIds).toEqual(["s3"]);
  });

  it("a rejected write keeps the selection rather than clearing it", async () => {
    stubFetch();
    failEveryPatch();
    const { client } = renderMapStage();
    seedSessionFrame(client, { workspace: "skoolscout" });
    const panel = await screen.findByRole("region", { name: "Slices" });
    selectStories(["s3"]);
    await userEvent.click(await within(panel).findByText(/slice from 1 selected/i));
    await userEvent.type(screen.getByPlaceholderText("Name this slice…"), "doomed{Enter}");

    // Nothing was created, so clearing would cost the user the write AND the selection.
    await waitFor(() => expect(within(panel).getByText(/slice from 1 selected/i)).toBeDefined());
    expect(document.querySelectorAll(".react-flow__node.selected")).toHaveLength(1);
  });
});
