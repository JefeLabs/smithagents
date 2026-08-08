import { QueryClient } from "@tanstack/react-query";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../test/renderWithProviders";
import { useApiKeys, useSaveApiKey } from "./http";
import { qk } from "./keys";

afterEach(() => vi.unstubAllGlobals());

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
});
