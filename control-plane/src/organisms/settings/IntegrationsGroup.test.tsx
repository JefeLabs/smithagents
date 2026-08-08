import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectorInstanceRecord } from "../../api/types";
import { renderWithProviders } from "../../test/renderWithProviders";
import { IntegrationsGroup } from "./IntegrationsGroup";

const VENDORS = [
  {
    id: "github",
    label: "GitHub",
    description: "Repo access.",
    fields: [{ key: "token", label: "Token", secret: true }],
    verifyExtraFields: [],
  },
  {
    id: "datadog",
    label: "Datadog",
    description: "Monitors.",
    fields: [{ key: "apiKey", label: "API key", secret: true }],
    verifyExtraFields: [],
  },
];

const jsonResponse = (body: unknown) => ({ ok: true, json: async () => body }) as Response;

/**
 * A real, stateful stand-in for the broker's connector routes: POST/DELETE mutate an
 * in-memory list, and every GET (including the ones the mutation hooks' own
 * `invalidateQueries` triggers afterward) reads from that same list — so "the new instance
 * appears" and "it disappears from the card" exercise the real invalidate-and-refetch path,
 * not a hand-rolled local merge.
 */
function stubBackend(
  opts: {
    vendors?: unknown[];
    vendorsThrow?: boolean;
    connectors?: ConnectorInstanceRecord[];
    voice?: unknown;
    deleteResponse?: (id: string) => unknown;
  } = {},
) {
  let connectors = opts.connectors ? [...opts.connectors] : [];
  const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });

    if (url.endsWith("/connectors/vendors")) {
      if (opts.vendorsThrow) throw new Error("broker unreachable");
      return jsonResponse(opts.vendors ?? VENDORS);
    }
    if (url.endsWith("/me/voice")) return jsonResponse(opts.voice ?? { stt: null, tts: null, hideInactive: false });
    if (url.endsWith("/me/connectors") && method === "GET") return jsonResponse(connectors);
    if (url.endsWith("/me/connectors") && method === "POST") {
      const saved: ConnectorInstanceRecord = {
        id: "c2",
        vendorId: body.vendorId,
        label: body.label,
        fields: { hasToken: true },
      };
      connectors = [...connectors, saved];
      return jsonResponse(saved);
    }
    const deleteMatch = /\/me\/connectors\/([^/]+)$/.exec(url);
    if (deleteMatch && method === "DELETE") {
      const id = deleteMatch[1]!;
      const response = opts.deleteResponse?.(id) ?? { ok: true };
      // A domain-level {error} means the broker never actually deleted the record — the
      // in-memory list (and the refetch that follows) must still show it.
      if (!(response as { error?: string }).error) connectors = connectors.filter((c) => c.id !== id);
      return jsonResponse(response);
    }
    throw new Error(`unexpected fetch ${url} ${method}`);
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls };
}

describe("IntegrationsGroup", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders one card per vendor, each showing its description", async () => {
    stubBackend({ connectors: [] });
    renderWithProviders(<IntegrationsGroup />);
    expect(await screen.findByText("GitHub")).toBeDefined();
    expect(await screen.findByText("Datadog")).toBeDefined();
    expect(screen.getByText(/repo access/i)).toBeDefined();
  });

  it("a vendor with a saved instance shows it with a connected status, not a bare Connect button", async () => {
    stubBackend({ connectors: [{ id: "c1", vendorId: "github", label: "personal", fields: { hasToken: true } }] });
    renderWithProviders(<IntegrationsGroup />);
    expect(await screen.findByText("personal")).toBeDefined();
    expect(screen.getByText(/add another/i)).toBeDefined();
  });

  it("clicking Connect on a vendor with zero instances opens the connect form for that vendor", async () => {
    stubBackend({ connectors: [] });
    renderWithProviders(<IntegrationsGroup />);
    await userEvent.click((await screen.findAllByRole("button", { name: /^connect/i }))[0]!);
    expect(await screen.findByPlaceholderText(/label/i)).toBeDefined();
  });

  it("adding a connector calls addConnector and the new instance appears without a manual page reload", async () => {
    const { calls } = stubBackend({ connectors: [] });
    renderWithProviders(<IntegrationsGroup />);
    await userEvent.click((await screen.findAllByRole("button", { name: /^connect/i }))[0]!);
    await userEvent.type(await screen.findByPlaceholderText(/label/i), "acme-corp");
    await userEvent.type(screen.getByPlaceholderText(/token/i), "gh-tok");
    await userEvent.click(screen.getByRole("button", { name: /^connect$/i }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/me/connectors") && c.method === "POST")).toBe(true));
    expect(await screen.findByText("acme-corp")).toBeDefined();
  });

  it("removing a saved instance calls deleteConnector and it disappears from the card", async () => {
    const { calls } = stubBackend({
      connectors: [{ id: "c1", vendorId: "github", label: "personal", fields: { hasToken: true } }],
    });
    renderWithProviders(<IntegrationsGroup />);
    await userEvent.click(await screen.findByRole("button", { name: /remove personal/i }));
    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith("/me/connectors/c1") && c.method === "DELETE")).toBe(true),
    );
    await waitFor(() => expect(screen.queryByText("personal")).toBeNull());
  });

  it("a listVendors/listConnectors rejection surfaces a visible load error instead of an unhandled rejection and a silently empty grid", async () => {
    stubBackend({ vendorsThrow: true, connectors: [] });
    renderWithProviders(<IntegrationsGroup />);
    expect(await screen.findByText(/broker unreachable/i)).toBeDefined();
  });

  it("a failed delete surfaces the error and leaves the row in place, instead of discarding result.error", async () => {
    stubBackend({
      connectors: [{ id: "c1", vendorId: "github", label: "personal", fields: { hasToken: true } }],
      deleteResponse: () => ({ error: "delete forbidden" }),
    });
    renderWithProviders(<IntegrationsGroup />);
    await userEvent.click(await screen.findByRole("button", { name: /remove personal/i }));
    expect(await screen.findByText(/delete forbidden/i)).toBeDefined();
    expect(screen.getByText("personal")).toBeDefined();
  });

  it("deleting an instance wired into Settings → Voice warns before it goes, and proceeds on confirm", async () => {
    const { calls } = stubBackend({
      connectors: [{ id: "c1", vendorId: "github", label: "personal", fields: { hasToken: true } }],
      voice: { stt: { instanceId: "c1" }, tts: null, hideInactive: false },
    });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderWithProviders(<IntegrationsGroup />);
    await userEvent.click(await screen.findByRole("button", { name: /remove personal/i }));
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining("speech-to-text"));
    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith("/me/connectors/c1") && c.method === "DELETE")).toBe(true),
    );
    await waitFor(() => expect(screen.queryByText("personal")).toBeNull());
    confirmSpy.mockRestore();
  });

  it("cancelling the delete-confirm leaves the instance in place and never calls deleteConnector", async () => {
    const { calls } = stubBackend({
      connectors: [{ id: "c1", vendorId: "github", label: "personal", fields: { hasToken: true } }],
      voice: { stt: { instanceId: "c1" }, tts: null, hideInactive: false },
    });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderWithProviders(<IntegrationsGroup />);
    await userEvent.click(await screen.findByRole("button", { name: /remove personal/i }));
    expect(confirmSpy).toHaveBeenCalled();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(screen.getByText("personal")).toBeDefined();
    confirmSpy.mockRestore();
  });

  it("deleting an instance not referenced by voice skips the confirm entirely", async () => {
    const { calls } = stubBackend({
      connectors: [{ id: "c1", vendorId: "github", label: "personal", fields: { hasToken: true } }],
      voice: { stt: null, tts: null, hideInactive: false },
    });
    const confirmSpy = vi.spyOn(window, "confirm");
    renderWithProviders(<IntegrationsGroup />);
    await userEvent.click(await screen.findByRole("button", { name: /remove personal/i }));
    expect(confirmSpy).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith("/me/connectors/c1") && c.method === "DELETE")).toBe(true),
    );
    confirmSpy.mockRestore();
  });

  it("a connector with only one of two declared secret fields present shows 'not connected', not a false-positive 'connected'", async () => {
    const DATADOG_TWO_SECRETS = {
      id: "datadog",
      label: "Datadog",
      description: "Monitors.",
      fields: [
        { key: "apiKey", label: "API key", secret: true },
        { key: "appKey", label: "Application key", secret: true },
      ],
      verifyExtraFields: [],
    };
    stubBackend({
      vendors: [DATADOG_TWO_SECRETS],
      // hasApiKey saved, hasAppKey never set — partially configured
      connectors: [{ id: "c1", vendorId: "datadog", label: "acme", fields: { hasApiKey: true } }],
    });
    renderWithProviders(<IntegrationsGroup />);
    expect(await screen.findByText(/not connected/i)).toBeDefined();
    expect(screen.queryByText(/^connected$/i)).toBeNull();
  });
});
