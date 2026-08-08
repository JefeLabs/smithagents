import { act, cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { qk } from "../queries/keys";
import { useSocketStore } from "../stores/socketStore";
import { renderWithProviders } from "../test/renderWithProviders";
import { MapStage } from "./MapStage";

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

describe("MapStage", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders the backbone and story stacks for the selected capability", async () => {
    stubFetch();
    renderWithProviders(<MapStage />);
    expect(await screen.findByText("Manage Candidate Tours")).toBeTruthy();
    expect(screen.getByText("Define Tour Schedule")).toBeTruthy();
    expect(screen.getByText("create tour time slots")).toBeTruthy();
  });

  it("creates a capability in the selected workspace", async () => {
    const { calls } = stubFetch();
    renderWithProviders(<MapStage />);
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
    renderWithProviders(<MapStage />);
    await screen.findByText("tour scheduling v1", { selector: ".slice-band__name" });
    expect(screen.getByText("1/2")).toBeTruthy();
  });

  it("switching workspace resets the selected capability to that workspace's own map (I5)", async () => {
    const OTHER_CAP = {
      id: "other-cap",
      name: "Other Product",
      workspaceId: "smithagents",
      activities: [{ id: "act2", name: "Different Activity", order: 0, steps: [] }],
      stories: [],
      slices: [],
    };
    stubFetch({ capabilities: { capabilities: [CAP, OTHER_CAP], errors: [] } });
    renderWithProviders(<MapStage />);
    await screen.findByText("Manage Candidate Tours");
    await userEvent.selectOptions(screen.getByLabelText("Workspace"), "smithagents");
    await waitFor(() => expect((screen.getByLabelText("Capability") as HTMLSelectElement).value).toBe("other-cap"));
    expect(screen.getByText("Different Activity")).toBeTruthy();
    expect(screen.queryByText("Manage Candidate Tours")).toBeNull();
  });

  it("switching to a workspace with no capabilities clears the map instead of showing the old one", async () => {
    stubFetch({ capabilities: { capabilities: [CAP], errors: [] } });
    renderWithProviders(<MapStage />);
    await screen.findByText("Manage Candidate Tours");
    await userEvent.selectOptions(screen.getByLabelText("Workspace"), "smithagents");
    await waitFor(() => expect(screen.queryByText("Manage Candidate Tours")).toBeNull());
    const capSelect = screen.getByLabelText("Capability") as HTMLSelectElement;
    expect(capSelect.value).toBe("");
    expect(capSelect.querySelectorAll("option").length).toBe(0);
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
    const { client } = renderWithProviders(<MapStage />);
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
});

describe("MapStage editing", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("adds a story to a step via wholesale PATCH", async () => {
    const { calls } = stubFetch();
    renderWithProviders(<MapStage />);
    await screen.findByText("Define Tour Schedule");
    await userEvent.type(screen.getAllByPlaceholderText(/add a story/i)[0], "delete tour time slots{Enter}");
    await waitFor(() => {
      const call = calls.find((c) => c.method === "PATCH" && c.url.includes("/work/capabilities/school-feature-set"));
      const stories = (call?.body as { stories?: Array<{ text: string; stepId: string }> })?.stories;
      expect(stories?.some((s) => s.text === "delete tour time slots" && s.stepId === "st1")).toBe(true);
      expect(stories?.length).toBe(4); // wholesale: existing three ride along
    });
  });

  it("fireStoryDrop moves a story between steps via wholesale PATCH", async () => {
    const { calls } = stubFetch();
    renderWithProviders(<MapStage />);
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
    renderWithProviders(<MapStage />);
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
    renderWithProviders(<MapStage />);
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

  it("creates a slice", async () => {
    const { calls } = stubFetch();
    renderWithProviders(<MapStage />);
    await screen.findByText("tour scheduling v1", { selector: ".slice-band__name" });
    await userEvent.type(screen.getByPlaceholderText(/new slice name/i), "tour scheduling v2{Enter}");
    await waitFor(() => {
      const call = calls.find((c) => c.method === "PATCH" && c.url.includes("/work/capabilities/school-feature-set"));
      const slices = (call?.body as { slices?: Array<{ name: string }> })?.slices;
      expect(slices?.some((s) => s.name === "tour scheduling v2")).toBe(true);
    });
  });
});
