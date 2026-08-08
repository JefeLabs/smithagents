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
    const { client } = renderWithProviders(<Probe />);
    client.setQueryData(qk.apiKeys, [{ id: "google" }, { id: "openai" }]);
    expect(await screen.findByTestId("count")).toHaveTextContent("2");
  });

  it("a successful mutation invalidates its list so the UI refetches", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({ ok: true, status: 200, json: async () => ({ providers: [{ id: "google" }] }) }) as unknown as Response,
      ),
    );
    const { client } = renderWithProviders(<Probe />);
    client.setQueryData(qk.apiKeys, []);
    await userEvent.click(screen.getByRole("button", { name: "save" }));
    expect(await screen.findByTestId("count")).toHaveTextContent("1");
  });
});
