import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/broker", () => ({ getMe: vi.fn() }));

import { getMe } from "../api/broker";
import type { MeRecord } from "../api/types";
import { WizardGate } from "./WizardGate";

// retry: false — one of these tests rejects the query deliberately, and the
// default retry/backoff would blow past findBy's timeout before isError flips.
const wrap = (ui: ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}>
      {ui}
    </QueryClientProvider>,
  );

function stubMe(me: MeRecord) {
  (getMe as ReturnType<typeof vi.fn>).mockResolvedValue(me);
}

function stubMeFailure() {
  (getMe as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("network error"));
}

afterEach(() => vi.restoreAllMocks());

describe("WizardGate", () => {
  it("shows the wizard on a fresh install (no user record)", async () => {
    stubMe({ id: "me", name: "You", connectors: [], placeholder: true });
    wrap(
      <WizardGate>
        <div>THE APP</div>
      </WizardGate>,
    );

    expect(await screen.findByRole("heading", { name: /welcome/i })).toBeInTheDocument();
    expect(screen.queryByText("THE APP")).toBeNull();
  });

  it("shows the app for a real user who finished setup", async () => {
    stubMe({ id: "me", name: "Edwin", connectors: [], placeholder: false, setup: { step: "done" } });
    wrap(
      <WizardGate>
        <div>THE APP</div>
      </WizardGate>,
    );

    expect(await screen.findByText("THE APP")).toBeInTheDocument();
  });

  it("does NOT treat a real user named 'You' as a fresh install", async () => {
    // The exact case the old wire shape could not distinguish.
    stubMe({ id: "me", name: "You", connectors: [], placeholder: false, setup: { step: "done" } });
    wrap(
      <WizardGate>
        <div>THE APP</div>
      </WizardGate>,
    );

    expect(await screen.findByText("THE APP")).toBeInTheDocument();
  });

  it("shows the app for a pre-existing user with no setup field at all", async () => {
    // From before this feature: placeholder is false and there is no `setup`
    // key at all. isSetupComplete(undefined) is false, so a naive
    // `!isSetupComplete(me.setup)` check on its own would wrongly reopen the
    // wizard for every install that predates it. Must fall through to the app.
    stubMe({ id: "me", name: "Edwin", connectors: [], placeholder: false });
    wrap(
      <WizardGate>
        <div>THE APP</div>
      </WizardGate>,
    );

    expect(await screen.findByText("THE APP")).toBeInTheDocument();
  });

  it("resumes an unfinished setup at the step the user left", async () => {
    stubMe({ id: "me", name: "Edwin", connectors: [], placeholder: false, setup: { step: "fork" } });
    const { container } = wrap(
      <WizardGate>
        <div>THE APP</div>
      </WizardGate>,
    );

    // Assert what the host itself renders (which step it selected), not the
    // fork step's own markup — WizardForkStep's radio group belongs to Task 3.
    await screen.findByRole("heading", { name: /welcome/i });
    expect(container.querySelector('[data-step="fork"]')).not.toBeNull();
  });

  it("shows the app rather than stranding the user when /me cannot be reached", async () => {
    // A failed probe is informative, never fatal. Blocking the whole app behind a
    // failed GET /me would be worse than skipping the wizard.
    stubMeFailure();
    wrap(
      <WizardGate>
        <div>THE APP</div>
      </WizardGate>,
    );

    expect(await screen.findByText("THE APP")).toBeInTheDocument();
  });
});
