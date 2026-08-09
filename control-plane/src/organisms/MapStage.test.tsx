import type { QueryClient } from "@tanstack/react-query";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
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
    },
    { id: "sl2", name: "analytics v1", order: 1, storyIds: [] },
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

  it("creates a capability in the selected workspace", async () => {
    const { calls } = stubFetch();
    const { client } = renderMapStage();
    seedSessionFrame(client, { workspace: "skoolscout" });
    await screen.findByText("Manage Candidate Tours");
    await userEvent.click(screen.getByRole("button", { name: /new capability/i }));
    await userEvent.type(screen.getByPlaceholderText(/capability name/i), "New Cap");
    await userEvent.click(screen.getByRole("button", { name: /create capability/i }));
    await waitFor(() => {
      const call = calls.find((c) => c.method === "POST" && c.url.endsWith("/work/capabilities"));
      expect(call?.body).toMatchObject({ name: "New Cap", workspaceId: "skoolscout" });
    });
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
    await waitFor(() => expect((screen.getByLabelText("Capability") as HTMLSelectElement).value).toBe("other-cap"));
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
    const capSelect = screen.getByLabelText("Capability") as HTMLSelectElement;
    expect(capSelect.value).toBe("");
    expect(capSelect.querySelectorAll("option").length).toBe(0);
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
    const capSelect = screen.getByLabelText("Capability") as HTMLSelectElement;
    expect(capSelect.value).toBe("");

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

    // Still cleared — the refetch must not seed a capability from skoolscout
    // while the workspace picker shows smithagents.
    expect(capSelect.value).toBe("");
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

  it("creates a slice", async () => {
    const { calls } = stubFetch();
    const { client } = renderMapStage();
    seedSessionFrame(client, { workspace: "skoolscout" });
    await screen.findByText("tour scheduling v1", { selector: ".slice-band__name" });
    await userEvent.type(screen.getByPlaceholderText(/new slice name/i), "tour scheduling v2{Enter}");
    await waitFor(() => {
      const call = calls.find((c) => c.method === "PATCH" && c.url.includes("/work/capabilities/school-feature-set"));
      const slices = (call?.body as { slices?: Array<{ name: string }> })?.slices;
      expect(slices?.some((s) => s.name === "tour scheduling v2")).toBe(true);
    });
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
});
