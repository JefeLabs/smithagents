import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { qk } from "../../queries/keys";
import { renderWithProviders } from "../../test/renderWithProviders";
import { ContainersGroup } from "./ContainersGroup";

const jsonResponse = (body: unknown) => ({ ok: true, json: async () => body }) as Response;

function stubNoNetwork() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("no network in this test");
    }),
  );
}

/** Routes /containers (PUT) and /containers/verify (POST); tests override per scenario. */
function stubFetch(overrides: { put?: unknown; verify?: unknown } = {}) {
  const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith("/containers/verify") && init?.method === "POST") {
      return jsonResponse(overrides.verify ?? { ok: true, detail: "Docker daemon reachable" });
    }
    if (url.endsWith("/containers") && init?.method === "PUT") {
      return jsonResponse(overrides.put ?? { docker: { enabled: true } });
    }
    throw new Error(`unexpected fetch ${url} ${init?.method ?? "GET"}`);
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls };
}

describe("ContainersGroup", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("loads and shows the toggle state", async () => {
    stubNoNetwork();
    const { client } = renderWithProviders(<ContainersGroup />);
    client.setQueryData(qk.containers, { docker: { enabled: true } });
    const checkbox = (await screen.findByLabelText(/docker/i)) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
  });

  it("toggling calls setDockerEnabled and reflects the response", async () => {
    const { fn } = stubFetch({ put: { docker: { enabled: true } } });
    const { client } = renderWithProviders(<ContainersGroup />);
    client.setQueryData(qk.containers, { docker: { enabled: false } });
    const checkbox = (await screen.findByLabelText(/docker/i)) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    await userEvent.click(checkbox);
    await waitFor(() =>
      expect(fn).toHaveBeenCalledWith(
        expect.stringContaining("/containers"),
        expect.objectContaining({ method: "PUT" }),
      ),
    );
    await waitFor(() => expect(checkbox.checked).toBe(true));
  });

  it("Verify shows the detail on an ok result", async () => {
    stubFetch({ verify: { ok: true, detail: "Docker daemon reachable" } });
    const { client } = renderWithProviders(<ContainersGroup />);
    client.setQueryData(qk.containers, { docker: { enabled: false } });
    await userEvent.click(await screen.findByRole("button", { name: /verify/i }));
    expect(await screen.findByText("Docker daemon reachable")).toBeDefined();
  });

  it("Verify shows the detail on a failure result", async () => {
    stubFetch({ verify: { ok: false, detail: "Docker daemon not running" } });
    const { client } = renderWithProviders(<ContainersGroup />);
    client.setQueryData(qk.containers, { docker: { enabled: false } });
    await userEvent.click(await screen.findByRole("button", { name: /verify/i }));
    expect(await screen.findByText("Docker daemon not running")).toBeDefined();
  });

  it("enabling never requires or triggers a verify — toggle and verify are independent", async () => {
    const { calls } = stubFetch({ put: { docker: { enabled: true } } });
    const { client } = renderWithProviders(<ContainersGroup />);
    client.setQueryData(qk.containers, { docker: { enabled: false } });
    const checkbox = (await screen.findByLabelText(/docker/i)) as HTMLInputElement;
    await userEvent.click(checkbox);
    await waitFor(() => expect(checkbox.checked).toBe(true));
    expect(calls.some((c) => c.url.endsWith("/containers/verify"))).toBe(false);
  });

  it("renders as a provider list with docker as the only row", async () => {
    stubNoNetwork();
    const { client, container } = renderWithProviders(<ContainersGroup />);
    client.setQueryData(qk.containers, { docker: { enabled: false } });
    await screen.findByLabelText(/docker/i);
    const rows = container.querySelectorAll(".connector-card");
    expect(rows.length).toBe(1);
    expect(rows[0]?.textContent).toContain("Docker");
  });

  it("two rapid clicks before the first setDockerEnabled resolves — called exactly once", async () => {
    let resolveFirst: ((v: Response) => void) | undefined;
    let putCalls = 0;
    const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/containers") && init?.method === "PUT") {
        putCalls++;
        return new Promise<Response>((resolve) => {
          resolveFirst = resolve;
        });
      }
      // The background GET refetch on mount — kept benign (matches the seeded data) so it
      // never puts the query into an error state that could mask the assertion below.
      if (url.endsWith("/containers")) return jsonResponse({ docker: { enabled: false } });
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fn);
    const { client } = renderWithProviders(<ContainersGroup />);
    client.setQueryData(qk.containers, { docker: { enabled: false } });
    const checkbox = (await screen.findByLabelText(/docker/i)) as HTMLInputElement;

    // Two clicks fired back to back, before the first request has a chance to resolve — the
    // second must be a no-op (disabled checkbox + belt-and-suspenders guard in toggle()).
    fireEvent.click(checkbox);
    fireEvent.click(checkbox);
    await waitFor(() => expect(resolveFirst).toBeDefined());
    expect(putCalls).toBe(1);

    resolveFirst?.(jsonResponse({ docker: { enabled: true } }));
    await waitFor(() => expect(checkbox.checked).toBe(true));
    expect(putCalls).toBe(1);
  });

  it("Verify surfaces a failure and re-enables the button when verifyContainers rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/containers/verify")) throw new Error("network down");
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
    const { client } = renderWithProviders(<ContainersGroup />);
    client.setQueryData(qk.containers, { docker: { enabled: false } });
    const button = (await screen.findByRole("button", { name: /verify/i })) as HTMLButtonElement;
    await userEvent.click(button);
    expect(await screen.findByText(/verify failed — broker unreachable/i)).toBeDefined();
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe("verify");
  });
});
