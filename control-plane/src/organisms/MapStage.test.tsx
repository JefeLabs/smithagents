import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    render(<MapStage open lastCapabilityUpdate={null} onClose={vi.fn()} />);
    expect(await screen.findByText("Manage Candidate Tours")).toBeTruthy();
    expect(screen.getByText("Define Tour Schedule")).toBeTruthy();
    expect(screen.getByText("create tour time slots")).toBeTruthy();
  });

  it("creates a capability in the selected workspace", async () => {
    const { calls } = stubFetch();
    render(<MapStage open lastCapabilityUpdate={null} onClose={vi.fn()} />);
    await screen.findByText("Manage Candidate Tours");
    await userEvent.click(screen.getByRole("button", { name: /new capability/i }));
    await userEvent.type(screen.getByPlaceholderText(/capability name/i), "New Cap");
    await userEvent.click(screen.getByRole("button", { name: /create capability/i }));
    await waitFor(() => {
      const call = calls.find((c) => c.method === "POST" && c.url.endsWith("/work/capabilities"));
      expect(call?.body).toMatchObject({ name: "New Cap", workspaceId: "skoolscout" });
    });
  });

  it("refetches when lastCapabilityUpdate names the open capability", async () => {
    const { calls } = stubFetch();
    const { rerender } = render(<MapStage open lastCapabilityUpdate={null} onClose={vi.fn()} />);
    await screen.findByText("Manage Candidate Tours");
    const before = calls.filter((c) => c.url.includes("/work/capabilities") && c.method === "GET").length;
    rerender(<MapStage open lastCapabilityUpdate={{ capabilityId: "school-feature-set", seq: 1 }} onClose={vi.fn()} />);
    await waitFor(() =>
      expect(calls.filter((c) => c.url.includes("/work/capabilities") && c.method === "GET").length).toBeGreaterThan(
        before,
      ),
    );
  });

  it("shows slice bands with done fractions", async () => {
    stubFetch();
    render(<MapStage open lastCapabilityUpdate={null} onClose={vi.fn()} />);
    await screen.findByText("tour scheduling v1");
    expect(screen.getByText("1/2")).toBeTruthy();
  });
});
