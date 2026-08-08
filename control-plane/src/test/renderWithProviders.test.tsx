import { useQuery } from "@tanstack/react-query";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithProviders } from "./renderWithProviders";

/** Fetches for real — proves the provider is wired and hooks can run. */
function FetchProbe() {
  const { data } = useQuery({ queryKey: ["probe"], queryFn: async () => "live" });
  return <div>{data ?? "pending"}</div>;
}

/**
 * Never fetches, so setQueryData is the only writer. Seeding a key whose fetch
 * is still in flight does NOT preempt it — the fetch's success handler lands
 * afterward and overwrites the seeded value. This probe mirrors how the pushed
 * queries (session, transcript) actually behave, and removes the race rather
 * than trying to out-run it.
 */
function SeededProbe() {
  const { data } = useQuery({ queryKey: ["probe"], queryFn: async () => "live", enabled: false });
  return <div>{data ?? "pending"}</div>;
}

describe("renderWithProviders", () => {
  it("supplies a QueryClient so hooks can run", async () => {
    renderWithProviders(<FetchProbe />);
    expect(await screen.findByText("live")).toBeInTheDocument();
  });

  it("hands back the client so tests can seed the cache", async () => {
    const { client } = renderWithProviders(<SeededProbe />);
    client.setQueryData(["probe"], "seeded");
    expect(await screen.findByText("seeded")).toBeInTheDocument();
  });

  it("isolates caches between renders", async () => {
    const first = renderWithProviders(<SeededProbe />);
    first.client.setQueryData(["probe"], "first");
    const second = renderWithProviders(<SeededProbe />);
    expect(second.client.getQueryData(["probe"])).toBeUndefined();
  });
});
