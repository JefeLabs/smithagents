import { QueryClient } from "@tanstack/react-query";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../test/renderWithProviders";
import { useApiKeys, useLocalModels, useMachineFacts, useSaveApiKey, useSaveEngines } from "./http";
import { qk } from "./keys";

afterEach(() => vi.unstubAllGlobals());

/** Records the URL the hook actually requested, plus what it unwrapped. */
function LocalModelsProbe() {
  const { data } = useLocalModels();
  return <span data-testid="servers">{data === undefined ? "pending" : data.map((s) => s.id).join(",")}</span>;
}

function MachineProbe() {
  const { data } = useMachineFacts();
  return <span data-testid="mem">{data ? String(data.totalMemBytes) : "pending"}</span>;
}

function EnginesProbe() {
  const save = useSaveEngines();
  return (
    <button
      type="button"
      onClick={() => save.mutate({ main: { kind: "cli", provider: "claude" }, quick: null, fallback: null })}
    >
      save engines
    </button>
  );
}

function Probe() {
  const { data = [] } = useApiKeys();
  const save = useSaveApiKey();
  return (
    <div>
      <span data-testid="count">{data.length}</span>
      <button type="button" onClick={() => save.mutate({ id: "google", key: "sk-1" })}>
        save
      </button>
    </div>
  );
}

describe("http queries", () => {
  it("reads from the cache when it is seeded", async () => {
    // No fetch stub is set up on purpose — staleTime: Infinity plus seeding before
    // render means the mounted query already has fresh data and never calls
    // queryFn. If that ever regresses, the thrown error makes it fail loudly
    // instead of silently racing a real request against 127.0.0.1:7790.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("no network in this test");
      }),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: Infinity } },
    });
    client.setQueryData(qk.apiKeys, [{ id: "google" }, { id: "openai" }]);
    renderWithProviders(<Probe />, { client });
    expect(await screen.findByTestId("count")).toHaveTextContent("2");
  });

  it("a successful mutation writes its result into the list cache", async () => {
    // GET and PUT resolve to different bodies so only a working onSuccess
    // (not the mount-time query racing the click) can move the count 0 -> 1.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_url: string, init?: RequestInit) =>
          ({
            ok: true,
            status: 200,
            json: async () => (init?.method === "PUT" ? { providers: [{ id: "google" }] } : { providers: [] }),
          }) as unknown as Response,
      ),
    );
    renderWithProviders(<Probe />);
    expect(await screen.findByTestId("count")).toHaveTextContent("0");
    await userEvent.click(screen.getByRole("button", { name: "save" }));
    expect(await screen.findByTestId("count")).toHaveTextContent("1");
  });

  it("useLocalModels asks the BROKER for /local-models and unwraps its envelope", async () => {
    // The cross-package trap this project has already shipped once: the route
    // lives on the swarm, the broker only PROXIES it, and a client aimed at the
    // swarm's own port answers nothing in the browser — which looks exactly
    // like "no model server is running". Asserting the URL is the only thing
    // that tells those two apart, since every component test stubs fetch.
    // `_url` is declared so `fetchMock.mock.calls[0][0]` is a typed tuple
    // element rather than an index into `[]` — the same TS2493 two other
    // suites in this repo carry unfixed.
    const fetchMock = vi.fn(
      async (_url: string) =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ servers: [{ id: "lmstudio", models: [] }] }),
        }) as unknown as Response,
    );
    vi.stubGlobal("fetch", fetchMock);
    renderWithProviders(<LocalModelsProbe />);

    expect(await screen.findByText("lmstudio")).toBeInTheDocument();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:7790/local-models");
  });

  it("useMachineFacts asks the BROKER for /machine", async () => {
    // Same cross-package trap as /local-models above: `machineFacts()` is a
    // swarm module, the broker only proxies the route, and the browser never
    // talks to 7777. A client aimed at the wrong port answers nothing, which
    // the wizard renders as "I don't know how much RAM you have" — an honest-
    // looking omission with a wiring bug behind it.
    const fetchMock = vi.fn(
      async (_url: string) =>
        ({ ok: true, status: 200, json: async () => ({ totalMemBytes: 103079215104 }) }) as unknown as Response,
    );
    vi.stubGlobal("fetch", fetchMock);
    renderWithProviders(<MachineProbe />);

    // findByText, not findByTestId + toHaveTextContent: the probe renders
    // "pending" synchronously, so the element is found on the first tick and
    // the assertion would run against the pre-fetch state.
    expect(await screen.findByText("103079215104")).toBeInTheDocument();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:7790/machine");
  });

  it("useSaveEngines PUTs the three roles to the BROKER's /me/engines, fallback null included", async () => {
    // The route is new on the swarm AND new on the broker's proxy. Every
    // component test stubs fetch, so asserting the URL is the only thing that
    // tells a wired route from an unreachable one — and the body assertion is
    // the other half: a `fallback: null` that does not survive serialisation
    // becomes an omission, which the swarm merges as "keep the old engine".
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ main: null, quick: null, fallback: null }),
        }) as unknown as Response,
    );
    vi.stubGlobal("fetch", fetchMock);
    renderWithProviders(<EnginesProbe />);
    await userEvent.click(screen.getByRole("button", { name: "save engines" }));

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("http://127.0.0.1:7790/me/engines");
    expect(init?.method).toBe("PUT");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect("fallback" in body).toBe(true);
    expect(body.fallback).toBeNull();
  });
});
