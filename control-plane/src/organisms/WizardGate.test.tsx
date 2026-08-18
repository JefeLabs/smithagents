import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/broker", () => ({
  getMe: vi.fn(),
  updateMe: vi.fn(),
  // The Subscriptions and Anderson steps render the real Settings groups,
  // which fetch through this same module. Stubbed so they show their own
  // empty state rather than a load error sitting in the panel beside the
  // errors these tests actually assert on.
  getCliTools: vi.fn(),
  getApiKeys: vi.fn(),
  getBrainEngine: vi.fn(),
}));

import { getApiKeys, getBrainEngine, getCliTools, getMe, updateMe } from "../api/broker";
import type { MeRecord } from "../api/types";
import { PREFLIGHT } from "../lib/wizardSteps";
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
  (getCliTools as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (getApiKeys as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (getBrainEngine as ReturnType<typeof vi.fn>).mockResolvedValue(null);
}

function stubMeFailure() {
  (getMe as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("network error"));
}

/**
 * matchMedia is the mechanism this codebase already stubs for viewport/media
 * state (see useTheme.test.tsx's stubPrefersLight) — jsdom implements none of
 * it, and the inert default installed in test/setup.ts never matches, so a
 * suite that cares about the result stubs over it itself. WizardGate queries
 * a single fixed breakpoint, so — like useTheme's stub — this one ignores the
 * query string and just reports whether `width` falls under it.
 */
function stubViewport({ width }: { width: number }) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: width <= 768,
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  );
}

/**
 * The host root, awaited. `[data-step]` is this suite's existing idiom and the
 * whole reason the attribute sits on the host: a test can name which step is
 * showing without reaching into that step's own markup. Returned as an element
 * so a later assertion can re-read the SAME node after a step change — the host
 * div is never remounted — which is what makes `toHaveAttribute` here a
 * statement about the host rather than about a selector that happened to match.
 */
async function findHost(container: HTMLElement): Promise<HTMLElement> {
  return await waitFor(() => {
    const host = container.querySelector<HTMLElement>("[data-step]");
    if (!host) throw new Error("the wizard host has not rendered");
    return host;
  });
}

/**
 * Renders the gate over a user record described by its wizard-relevant parts,
 * and hands back the `updateMe` mock so a test can assert what the host
 * actually persisted — a step change that never reaches the server looks
 * identical on screen and resumes at the wrong step on the next reload.
 *
 * The viewport is pinned wide because every test using this helper is about
 * the desktop path; the two compact-gate tests stub their own.
 *
 * `updateMe` resolves with an empty record by default: the host's own save
 * handling reads `result.error`, so a mock returning `undefined` would fail
 * inside the promise chain rather than in the test.
 */
function renderGate({
  name = "You",
  placeholder = false,
  setup,
}: {
  name?: string;
  placeholder?: boolean;
  setup?: MeRecord["setup"];
}) {
  stubViewport({ width: 1440 });
  stubMe({ id: "me", name, connectors: [], placeholder, setup });
  const updateMeMock = updateMe as ReturnType<typeof vi.fn>;
  updateMeMock.mockResolvedValue({});
  return {
    ...wrap(
      <WizardGate>
        <div>THE APP</div>
      </WizardGate>,
    ),
    updateMe: updateMeMock,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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
    // The recorded step is only resumable together with the answers that make
    // it reachable — `resumeStep` sends a step outside the selected sequence
    // back to preflight rather than stranding the user on it.
    const { container } = renderGate({ name: "Edwin", setup: { mode: "local", step: "subscriptions" } });

    // Assert what the host itself renders (which step it selected), not that
    // step's own markup, which belongs to the step's own suite.
    await screen.findByRole("heading", { name: /welcome/i });
    expect(container.querySelector('[data-step="subscriptions"]')).not.toBeNull();
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

  it("gate: a phone never sees the local path", async () => {
    stubViewport({ width: 420 });
    stubMe({ id: "me", name: "You", connectors: [], placeholder: true });
    wrap(
      <WizardGate>
        <div>THE APP</div>
      </WizardGate>,
    );

    expect(await screen.findByText(/works on any device|coming soon/i)).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /local/i })).toBeNull();
  });

  it("gate: a desktop sees the local path", async () => {
    stubViewport({ width: 1440 });
    stubMe({ id: "me", name: "You", connectors: [], placeholder: true });
    wrap(
      <WizardGate>
        <div>THE APP</div>
      </WizardGate>,
    );

    expect(await screen.findByRole("heading", { name: /welcome/i })).toBeInTheDocument();
  });

  it("a failed save on advance surfaces an error instead of vanishing silently", async () => {
    stubMe({ id: "me", name: "You", connectors: [], placeholder: true });
    (updateMe as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("network error"));
    wrap(
      <WizardGate>
        <div>THE APP</div>
      </WizardGate>,
    );

    await screen.findByRole("heading", { name: /welcome/i });
    await userEvent.type(screen.getByLabelText(/your name/i), "Edwin");
    await userEvent.click(screen.getByRole("button", { name: /continue/i }));

    // The step still advances optimistically (blocking on the network would be
    // worse) — what must never happen is the failure going unreported.
    expect(await screen.findByText(/network error|could not save/i)).toBeInTheDocument();
  });

  it("a server-reported save failure surfaces the error and does not silently advance the step", async () => {
    // brokerFetch never throws on a non-2xx, and updateMe resolves with
    // {error} rather than rejecting for a credential failure, an origin
    // block, or a swarm-side validation error — this is that shape, not a
    // network-level rejection.
    stubMe({ id: "me", name: "You", connectors: [], placeholder: true });
    (updateMe as ReturnType<typeof vi.fn>).mockResolvedValue({ error: "origin not allowed" });
    const { container } = wrap(
      <WizardGate>
        <div>THE APP</div>
      </WizardGate>,
    );

    await screen.findByRole("heading", { name: /welcome/i });
    await userEvent.type(screen.getByLabelText(/your name/i), "Edwin");
    await userEvent.click(screen.getByRole("button", { name: /continue/i }));

    expect(await screen.findByText(/origin not allowed/i)).toBeInTheDocument();
    // Unlike a network blip, a server-reported rejection is a firm "no" — the
    // wizard doesn't creep forward on a step that it knows didn't persist.
    expect(container.querySelector('[data-step="preflight"]')).not.toBeNull();
  });

  it("shows no step indicator on a fresh install's preflight", async () => {
    const { container } = renderGate({ placeholder: true, setup: undefined });

    expect(await findHost(container)).toHaveAttribute("data-step", "preflight");
    expect(screen.queryByText("Subscriptions")).toBeNull();
  });

  it("shows no step indicator on preflight even once the answers select a sequence", async () => {
    // Strictly stronger than the fresh-install case above, which an indicator
    // driven off the answers alone would also pass: with a mode already
    // recorded the sequence is NON-empty, so the only thing that can keep the
    // indicator off the screen is preflight itself being excluded from it.
    // This is the state someone lands in by pressing Back.
    const { container } = renderGate({ name: "Edwin", setup: { mode: "local", step: PREFLIGHT } });

    expect(await findHost(container)).toHaveAttribute("data-step", "preflight");
    expect(screen.queryByText("Subscriptions")).toBeNull();
    expect(screen.queryByText("Anderson")).toBeNull();
  });

  it("does not greet by name on preflight, where the name is being asked for", async () => {
    // A record that HAS a name, and awaited: with `placeholder: true` there is
    // no name to greet with in the first place, and an un-awaited query runs
    // while /me is still loading — either one passes without the guard.
    const { container } = renderGate({ name: "Edwin", setup: { mode: "local", step: PREFLIGHT } });

    expect(await findHost(container)).toHaveAttribute("data-step", "preflight");
    expect(screen.queryByText(/Welcome,/)).toBeNull();
  });

  it("greets by name on the first setup step", async () => {
    renderGate({ name: "Edwin", setup: { mode: "local", step: "subscriptions" } });

    expect(await screen.findByText("Welcome, Edwin")).toBeInTheDocument();
  });

  it("shows only the chosen sequence in the indicator", async () => {
    renderGate({ name: "Edwin", setup: { mode: "local", step: "subscriptions" } });

    expect(await screen.findByText("Subscriptions")).toBeInTheDocument();
    expect(screen.getByText("Anderson")).toBeInTheDocument();
    // Preflight is not in it. Exact-string, so the "Welcome, Edwin" heading
    // above the indicator is not what satisfies this.
    expect(screen.queryByText("Welcome")).toBeNull();
  });

  it("enters the sequence the answer just given selects, not the one state still holds", async () => {
    const { container, updateMe } = renderGate({ placeholder: true, setup: undefined });

    const host = await findHost(container);
    await userEvent.type(screen.getByLabelText(/your name/i), "Edwin");
    await userEvent.click(screen.getByRole("button", { name: /continue/i }));

    // Read from state instead of from the patch, `mode` is still undefined at
    // this point — `setupStepsFor` returns nothing for it, so the wizard would
    // persist `done` and drop a user who has answered nothing into the app.
    expect(host).toHaveAttribute("data-step", "subscriptions");
    expect(updateMe).toHaveBeenCalledWith(
      expect.objectContaining({ setup: expect.objectContaining({ mode: "local", step: "subscriptions" }) }),
    );
  });

  it("goes back from the first setup step into preflight, and persists it", async () => {
    const { container, updateMe } = renderGate({ name: "Edwin", setup: { mode: "local", step: "subscriptions" } });

    await userEvent.click(await screen.findByRole("button", { name: /back/i }));

    expect(await findHost(container)).toHaveAttribute("data-step", "preflight");
    // Persisted, or a reload would resume at the step they just left.
    expect(updateMe).toHaveBeenCalledWith(
      expect.objectContaining({ setup: expect.objectContaining({ step: "preflight" }) }),
    );
  });

  it("a server-refused Back returns to the step it left and says why", async () => {
    // The shape a `.catch` alone never sees: brokerFetch does not throw on a
    // non-2xx, so this RESOLVES with {error}. Without the resolved-branch
    // check the screen would sit on preflight having persisted nothing, and
    // the next reload would throw the user forward again.
    const { container, updateMe } = renderGate({ name: "Edwin", setup: { mode: "local", step: "subscriptions" } });
    updateMe.mockResolvedValue({ error: "origin not allowed" });

    await userEvent.click(await screen.findByRole("button", { name: /back/i }));

    expect(await screen.findByText(/origin not allowed/i)).toBeInTheDocument();
    expect(await findHost(container)).toHaveAttribute("data-step", "subscriptions");
  });

  it("a network-level failure on Back keeps the user where they navigated, and still reports it", async () => {
    // The other shape, and deliberately NOT handled the same way: a rejection
    // is ambiguous — the write may well have landed — so the step change
    // stands, exactly as `advance` treats its own rejections. Reported either
    // way; a whole wizard's worth of unsaved work must never go unmentioned.
    const { container, updateMe } = renderGate({ name: "Edwin", setup: { mode: "local", step: "subscriptions" } });
    updateMe.mockRejectedValue(new Error("network error"));

    await userEvent.click(await screen.findByRole("button", { name: /back/i }));

    expect(await screen.findByText(/network error/i)).toBeInTheDocument();
    expect(await findHost(container)).toHaveAttribute("data-step", "preflight");
  });

  it("routes the last step to the Anderson screen", async () => {
    // The `brain` → `anderson` rename had no regression protection: a route
    // naming a step id nothing renders leaves the body EMPTY — no Continue, no
    // "Skip for now", and no Back either, since Back lives inside the step
    // component — so the user is stranded on a panel with a heading and an
    // indicator, and the gate reopens on every reload because setup never
    // completes. Asserted through the step's own prompt, which is the thing
    // that actually stops existing.
    const { container } = renderGate({ name: "Edwin", setup: { mode: "local", step: "anderson" } });

    expect(await findHost(container)).toHaveAttribute("data-step", "anderson");
    expect(await screen.findByRole("heading", { name: /set up anderson/i })).toBeInTheDocument();
  });

  it("goes back from the last step into the one before it, and persists that", async () => {
    // The other half of "every setup step can go Back". Fails if the host
    // stops passing `onBack` to the Anderson route, and equally if that step
    // stops rendering the button — this clicks the real component's own.
    const { container, updateMe } = renderGate({ name: "Edwin", setup: { mode: "local", step: "anderson" } });

    await userEvent.click(await screen.findByRole("button", { name: /back/i }));

    // Into the step BEFORE it, not all the way out to preflight.
    expect(await findHost(container)).toHaveAttribute("data-step", "subscriptions");
    expect(updateMe).toHaveBeenCalledWith(
      expect.objectContaining({ setup: expect.objectContaining({ step: "subscriptions" }) }),
    );
  });

  it("backing into preflight shows the answers already given, not a blank form", async () => {
    // Seeding is half of a guarantee whose other half is WizardPreflightStep
    // sending `mode` EXPLICITLY on every submit. Unseeded, Back lands on a
    // preflight whose name field is empty (Continue disabled until it is
    // retyped) — the explicit send exists to stop the server's merge from
    // keeping a stale answer; without seeding, resubmitting would overwrite a
    // good one instead.
    renderGate({ name: "Edwin", setup: { mode: "local", step: "subscriptions" } });

    await userEvent.click(await screen.findByRole("button", { name: /back/i }));

    expect(await screen.findByLabelText(/your name/i)).toHaveValue("Edwin");
    expect(screen.getByRole("radio", { name: /local/i })).toBeChecked();
    // The user-visible consequence of losing the name seed, asserted directly.
    expect(screen.getByRole("button", { name: /continue/i })).toBeEnabled();
  });

  it("offers no Back on preflight — it is the beginning", async () => {
    const { container } = renderGate({ placeholder: true, setup: undefined });

    await findHost(container);
    expect(screen.queryByRole("button", { name: /back/i })).toBeNull();
  });
});
