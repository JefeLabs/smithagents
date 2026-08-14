import type { QueryClient } from "@tanstack/react-query";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliToolListing } from "../../api/types";
import { qk } from "../../queries/keys";
import { renderWithProviders } from "../../test/renderWithProviders";
import { ResearchEngineGroup } from "./ResearchEngineGroup";

const TOOLS: CliToolListing[] = [
  {
    cli: "claude",
    label: "Claude Code",
    models: ["claude-opus", "claude-sonnet"],
    warmSessions: true,
    active: true,
    status: null,
  },
  { cli: "agy", label: "Antigravity", models: ["default"], warmSessions: false, active: true, status: null },
  { cli: "copilot", label: "GitHub Copilot", models: ["default"], warmSessions: true, active: false, status: null },
];

const jsonResponse = (body: unknown) => ({ ok: true, json: async () => body }) as Response;

function stubNoNetwork() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("no network in this test");
    }),
  );
}

/** Stubs the one PUT /me/research-engine route this component's saves ever hit. */
function stubSave(respond: unknown) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/me/research-engine") && init?.method === "PUT") return jsonResponse(respond);
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

function seed(client: QueryClient, tools: CliToolListing[], researchEngine: { cli: string; model?: string } | null) {
  client.setQueryData(qk.cliTools, tools);
  client.setQueryData(qk.researchEngine, researchEngine);
}

describe("ResearchEngineGroup", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists only engines the registry reports active", async () => {
    stubNoNetwork();
    const { client } = renderWithProviders(<ResearchEngineGroup />);
    seed(client, TOOLS, null);
    const select = (await screen.findByLabelText("Research engine")) as HTMLSelectElement;
    const labels = Array.from(select.options).map((o) => o.textContent);
    expect(labels).toContain("Claude Code");
    expect(labels).toContain("Antigravity");
    expect(labels).not.toContain("GitHub Copilot");
  });

  it("renders guidance instead of an empty select when nothing qualifies", async () => {
    stubNoNetwork();
    const { client } = renderWithProviders(<ResearchEngineGroup />);
    seed(client, [], null);
    expect(await screen.findByText(/no CLI tools are ready/i)).toBeDefined();
    expect(screen.queryByLabelText("Research engine")).toBeNull();
  });

  it("selecting an engine PUTs it and reflects the saved value", async () => {
    const fn = stubSave({ cli: "agy", model: "default" });
    const { client } = renderWithProviders(<ResearchEngineGroup />);
    seed(client, TOOLS, null);
    fireEvent.change(await screen.findByLabelText("Research engine"), { target: { value: "agy" } });
    await waitFor(() =>
      expect(fn).toHaveBeenCalledWith(
        expect.stringContaining("/me/research-engine"),
        expect.objectContaining({ method: "PUT" }),
      ),
    );
  });

  it("choosing Off PUTs null, not an empty-string cli", async () => {
    const fn = stubSave(null);
    const { client } = renderWithProviders(<ResearchEngineGroup />);
    seed(client, TOOLS, { cli: "agy", model: "default" });
    fireEvent.change(await screen.findByLabelText("Research engine"), { target: { value: "" } });
    await waitFor(() =>
      expect(fn).toHaveBeenCalledWith(
        expect.stringContaining("/me/research-engine"),
        expect.objectContaining({ method: "PUT", body: JSON.stringify(null) }),
      ),
    );
  });

  it("surfaces the server's reason and keeps the prior selection on a rejected save", async () => {
    stubSave({ error: "claude is not logged in" });
    const { client } = renderWithProviders(<ResearchEngineGroup />);
    seed(client, TOOLS, { cli: "agy", model: "default" });
    fireEvent.change(await screen.findByLabelText("Research engine"), { target: { value: "claude" } });
    await screen.findByText("claude is not logged in");
    expect((screen.getByLabelText("Research engine") as HTMLSelectElement).value).toBe("agy");
  });
});
