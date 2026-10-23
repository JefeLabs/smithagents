import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/auth", () => ({
  getMe: vi.fn(),
  login: vi.fn(),
  beginEnroll: vi.fn(),
  finishEnroll: vi.fn(),
  EnrollError: class extends Error {},
}));

// The user RECORD (GET /me) — a different resource from the identity above
// (GET /auth/me). Only the cache-separation tests below read it; the wizard's
// first step also probes the machine, so those reads are stubbed empty.
vi.mock("../api/broker", () => ({
  getMe: vi.fn(),
  updateMe: vi.fn(),
  getCliTools: vi.fn(async () => []),
  pingBrain: vi.fn(async () => ({ ok: false, reason: "not asked in this test" })),
  getApiKeys: vi.fn(async () => []),
  getLocalModels: vi.fn(async () => []),
  getMachineFacts: vi.fn(async () => ({ totalMemBytes: 34_359_738_368 })),
  getEngines: vi.fn(async () => ({ main: null, quick: null, fallback: null })),
  saveEngines: vi.fn(),
  getConnectorVendors: vi.fn(async () => []),
  getMyConnectors: vi.fn(async () => []),
  getVoiceSettings: vi.fn(async () => ({ stt: null, tts: null, enabled: false })),
  getVoiceOptions: vi.fn(async () => []),
  getTopicNames: vi.fn(async () => []),
}));

import { getMe } from "../api/auth";
import { getMe as getUserRecord } from "../api/broker";
import type { MeRecord } from "../api/types";
import { useMe } from "../queries/http";
import { qk } from "../queries/keys";
import { useAuthStore } from "../stores/authStore";
import { AuthGate } from "./AuthGate";
import { WizardGate } from "./WizardGate";

const wrap = (ui: ReactNode) => render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);

afterEach(() => {
  vi.restoreAllMocks();
  useAuthStore.getState().clearSessionLost();
});

describe("AuthGate", () => {
  it("an unreachable broker shows can't-reach (not login), then the app once it answers", async () => {
    const m = getMe as ReturnType<typeof vi.fn>;
    m.mockRejectedValueOnce(new Error("network")).mockResolvedValue({ kind: "human", local: true });
    wrap(
      <AuthGate>
        <div>the app</div>
      </AuthGate>,
    );
    await waitFor(() => expect(screen.getByText(/can't reach the broker/i)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /^sign in$/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /retry now/i }));
    await waitFor(() => expect(screen.getByText("the app")).toBeInTheDocument());
  });

  it("renders children for an open-mode broker", async () => {
    (getMe as ReturnType<typeof vi.fn>).mockResolvedValue({ kind: "human", local: true });
    wrap(
      <AuthGate>
        <div>the app</div>
      </AuthGate>,
    );
    await waitFor(() => expect(screen.getByText("the app")).toBeInTheDocument());
  });

  it("renders children when /auth/me is a human", async () => {
    (getMe as ReturnType<typeof vi.fn>).mockResolvedValue({ kind: "human", name: "edwin" });
    wrap(
      <AuthGate>
        <div>the app</div>
      </AuthGate>,
    );
    await waitFor(() => expect(screen.getByText("the app")).toBeInTheDocument());
  });

  it("renders the login screen when unauthenticated", async () => {
    (getMe as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    wrap(
      <AuthGate>
        <div>the app</div>
      </AuthGate>,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: /sign in/i })).toBeInTheDocument());
    expect(screen.queryByText("the app")).not.toBeInTheDocument();
  });

  it("drops to login when sessionLost flips, even after a good /auth/me", async () => {
    (getMe as ReturnType<typeof vi.fn>).mockResolvedValue({ kind: "human", name: "edwin" });
    wrap(
      <AuthGate>
        <div>the app</div>
      </AuthGate>,
    );
    await waitFor(() => expect(screen.getByText("the app")).toBeInTheDocument());
    useAuthStore.getState().markSessionLost();
    await waitFor(() => expect(screen.getByRole("button", { name: /sign in/i })).toBeInTheDocument());
  });
});

/**
 * `/auth/me` (who is signed in) and `GET /me` (the user record the wizard and
 * Settings read) are different resources. They once shared the cache key
 * `["me"]`, so the identity leaked into every `useMe` reader and an
 * `invalidateQueries(qk.me)` — which every wizard step fires — refetched the
 * record with AuthGate's query function, replacing it with the identity and
 * collapsing the first-run wizard after its first step.
 */
describe("AuthGate keeps the identity out of the user record (qk.me)", () => {
  const identity = { kind: "human" as const, name: "identity-not-a-record", local: true };
  const record: MeRecord = { id: "me", name: "Record Owner", connectors: [], placeholder: true };

  function renderWithClient(ui: ReactNode) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return { qc, ...render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>) };
  }

  it("a useMe reader under AuthGate only ever sees the user record, before and after invalidating qk.me", async () => {
    (getMe as ReturnType<typeof vi.fn>).mockResolvedValue(identity);
    (getUserRecord as ReturnType<typeof vi.fn>).mockResolvedValue(record);
    const seen: unknown[] = [];
    function RecordProbe() {
      const { data } = useMe();
      if (data) seen.push(data);
      return <p>record: {data?.name ?? "none"}</p>;
    }
    const { qc } = renderWithClient(
      <AuthGate>
        <RecordProbe />
      </AuthGate>,
    );
    await screen.findByText("record: Record Owner");
    await act(async () => {
      await qc.invalidateQueries({ queryKey: qk.me });
    });
    await waitFor(() => expect(qc.isFetching()).toBe(0));
    expect(screen.getByText("record: Record Owner")).toBeInTheDocument();
    expect(seen.filter((d) => (d as { name?: string }).name !== "Record Owner")).toEqual([]);
  });

  it("the first-run wizard stays open after a step invalidates qk.me", async () => {
    (getMe as ReturnType<typeof vi.fn>).mockResolvedValue(identity);
    (getUserRecord as ReturnType<typeof vi.fn>).mockResolvedValue(record);
    const { qc, container } = renderWithClient(
      <AuthGate>
        <WizardGate>
          <div>THE APP</div>
        </WizardGate>
      </AuthGate>,
    );
    await waitFor(() => expect(container.querySelector("[data-step]")).not.toBeNull());
    await act(async () => {
      await qc.invalidateQueries({ queryKey: qk.me });
    });
    await waitFor(() => expect(qc.isFetching()).toBe(0));
    expect(container.querySelector("[data-step]")).not.toBeNull();
    expect(screen.queryByText("THE APP")).not.toBeInTheDocument();
  });

  it("a failed background refetch of /auth/me keeps the app mounted once the identity is loaded", async () => {
    (getMe as ReturnType<typeof vi.fn>).mockResolvedValueOnce(identity).mockRejectedValue(new Error("network"));
    const { qc } = renderWithClient(
      <AuthGate>
        <div>the app</div>
      </AuthGate>,
    );
    await screen.findByText("the app");
    // Not awaited: AuthGate retries an unreachable broker forever, so this
    // refetch never settles. Every query is refetched so the test does not
    // depend on which key AuthGate uses.
    act(() => {
      void qc.invalidateQueries();
    });
    await waitFor(() =>
      expect(
        qc
          .getQueryCache()
          .getAll()
          .some((q) => q.state.fetchFailureCount > 0),
      ).toBe(true),
    );
    expect(screen.getByText("the app")).toBeInTheDocument();
    expect(screen.queryByText(/can't reach the broker/i)).not.toBeInTheDocument();
    qc.clear();
  });
});
