import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/broker", () => ({
  getMe: vi.fn(),
  updateMe: vi.fn(),
  // Both setup steps probe this machine, and the sources step renders the
  // real Settings key screen, which fetches through this same module. Stubbed
  // so each shows its own empty state rather than a load error sitting in the
  // panel beside the errors these tests actually assert on. A factory mock
  // replaces the WHOLE module, so anything the rendered tree calls has to be
  // named here — an omission surfaces as "not a function" inside a query,
  // which react-query swallows into an error state rather than a failure.
  getCliTools: vi.fn(),
  getApiKeys: vi.fn(),
  getLocalModels: vi.fn(),
  getMachineFacts: vi.fn(),
  getEngines: vi.fn(),
  // The roles step's own save. Present here because the LAST step's handoff
  // can only be reached through it — see the terminal-save tests at the
  // bottom of this suite.
  saveEngines: vi.fn(),
  // The voice step's own reads — it calls all four unconditionally on mount
  // (the "yes" apparatus is conditionally RENDERED, not conditionally
  // fetched), so every test that reaches step "voice" needs these named here
  // regardless of which answer it exercises.
  getConnectorVendors: vi.fn(),
  getMyConnectors: vi.fn(),
  getVoiceSettings: vi.fn(),
  getVoiceOptions: vi.fn(),
}));

import {
  getApiKeys,
  getCliTools,
  getConnectorVendors,
  getEngines,
  getLocalModels,
  getMachineFacts,
  getMe,
  getMyConnectors,
  getVoiceOptions,
  getVoiceSettings,
  saveEngines,
  updateMe,
} from "../api/broker";
import type { CliToolListing, MeRecord } from "../api/types";
import { PREFLIGHT, SETUP_DONE, stepsFor } from "../lib/wizardSteps";
import { WizardGate } from "./WizardGate";

// retry: false — one of these tests rejects the query deliberately, and the
// default retry/backoff would blow past findBy's timeout before isError flips.
const wrap = (ui: ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}>
      {ui}
    </QueryClientProvider>,
  );

function stubMe(me: MeRecord, tools: CliToolListing[] = []) {
  (getMe as ReturnType<typeof vi.fn>).mockResolvedValue(me);
  (getCliTools as ReturnType<typeof vi.fn>).mockResolvedValue(tools);
  (getApiKeys as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  // Nothing running and nothing known: this suite is about the host, and a
  // machine with local servers or a RAM figure would only add copy to the two
  // steps it renders. Their own suites cover both.
  (getLocalModels as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (getMachineFacts as ReturnType<typeof vi.fn>).mockResolvedValue({ totalMemBytes: 34_359_738_368 });
  (getEngines as ReturnType<typeof vi.fn>).mockResolvedValue({ main: null, quick: null, fallback: null });
  // Succeeds by default: the failure these tests are about is the HOST's own
  // `PUT /me`, which only happens once the step's own save has gone through.
  (saveEngines as ReturnType<typeof vi.fn>).mockResolvedValue({ main: null, quick: null, fallback: null });
  // This machine's real, empty state (the plan's own "already true" table) —
  // no vendors, no saved keys, no voice assigned, no cast to preview. The
  // voice step's OWN suite covers what each of these populated looks like;
  // this one is about the host around it, on the answer ("Not right now")
  // that needs none of them to be non-empty.
  (getConnectorVendors as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (getMyConnectors as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (getVoiceSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ stt: null, tts: null, enabled: false });
  (getVoiceOptions as ReturnType<typeof vi.fn>).mockResolvedValue([]);
}

/**
 * Mirrors WizardRolesStep.test.tsx's own fixture math, and unlike the version
 * this replaced it carries a real `status`: the sources step prints one line
 * per CLI from it, and a `null` status renders "I haven't checked this one
 * yet" beside a ✓ rather than the signed-in line these tests read past.
 */
function toolListing(cli: string): CliToolListing {
  return {
    cli,
    label: cli,
    models: [],
    warmSessions: true,
    status: { detected: true, authOk: true, enabled: true, detail: "", lastCheckedAt: "2026-08-18T00:00:00.000Z" },
    active: true,
  };
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
  tools = [],
}: {
  name?: string;
  placeholder?: boolean;
  setup?: MeRecord["setup"];
  /** Active CLIs the roles step can offer as engine candidates. Only `claude`
      is ever offered (it mirrors the swarm's own BRAIN_CLI_ALLOWLIST), so a
      fixture naming anything else deliberately produces an empty picker. */
  tools?: CliToolListing[];
}) {
  stubViewport({ width: 1440 });
  stubMe({ id: "me", name, connectors: [], placeholder, setup }, tools);
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

    expect(await screen.findByRole("heading", { name: /hello! my name is anderson/i })).toBeInTheDocument();
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
    const { container } = renderGate({ name: "Edwin", setup: { mode: "local", step: "sources" } });

    // Asserted through `data-step` — what the HOST itself selected — rather
    // than through that step's own markup, which belongs to the step's own
    // suite. Awaited via `findHost`, because /me resolves a tick after mount
    // and an unawaited query would pass against a splash that renders no
    // `[data-step]` at all... which is what this used to do, indirectly, by
    // awaiting the host greeting that no longer exists.
    expect(await findHost(container)).toHaveAttribute("data-step", "sources");
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

    expect(await screen.findByRole("heading", { name: /hello! my name is anderson/i })).toBeInTheDocument();
  });

  it("a failed save on advance surfaces an error instead of vanishing silently", async () => {
    stubMe({ id: "me", name: "You", connectors: [], placeholder: true });
    (updateMe as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("network error"));
    wrap(
      <WizardGate>
        <div>THE APP</div>
      </WizardGate>,
    );

    await screen.findByRole("heading", { name: /hello! my name is anderson/i });
    await userEvent.type(screen.getByLabelText(/what shall i call you/i), "Edwin");
    await userEvent.click(screen.getByRole("button", { name: /nice to meet you/i }));

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

    await screen.findByRole("heading", { name: /hello! my name is anderson/i });
    await userEvent.type(screen.getByLabelText(/what shall i call you/i), "Edwin");
    await userEvent.click(screen.getByRole("button", { name: /nice to meet you/i }));

    expect(await screen.findByText(/origin not allowed/i)).toBeInTheDocument();
    // Unlike a network blip, a server-reported rejection is a firm "no" — the
    // wizard doesn't creep forward on a step that it knows didn't persist.
    expect(container.querySelector('[data-step="preflight"]')).not.toBeNull();
  });

  it("shows no step indicator on a fresh install's preflight", async () => {
    const { container } = renderGate({ placeholder: true, setup: undefined });

    expect(await findHost(container)).toHaveAttribute("data-step", "preflight");
    expect(screen.queryByText("Where I think")).toBeNull();
  });

  it("shows no step indicator on preflight even once the answers select a sequence", async () => {
    // Strictly stronger than the fresh-install case above, which an indicator
    // driven off the answers alone would also pass: with a mode already
    // recorded the sequence is NON-empty, so the only thing that can keep the
    // indicator off the screen is preflight itself being excluded from it.
    // This is the state someone lands in by pressing Back.
    const { container } = renderGate({ name: "Edwin", setup: { mode: "local", step: PREFLIGHT } });

    expect(await findHost(container)).toHaveAttribute("data-step", "preflight");
    expect(screen.queryByText("Where I think")).toBeNull();
    expect(screen.queryByText("What I think with")).toBeNull();
  });

  it("does not greet by name on preflight, where the name is being asked for", async () => {
    // A record that HAS a name, and awaited: with `placeholder: true` there is
    // no name to greet with in the first place, and an un-awaited query runs
    // while /me is still loading — either one passes without the guard.
    const { container } = renderGate({ name: "Edwin", setup: { mode: "local", step: PREFLIGHT } });

    expect(await findHost(container)).toHaveAttribute("data-step", "preflight");
    expect(screen.queryByText(/Welcome,/)).toBeNull();
  });

  it("the gate contributes no heading of its own — Anderson's introduction is the only h1", async () => {
    // Strictly stronger than the test above, and deliberately not another
    // `/Welcome,/` query: the bare word "Welcome" passes that one, and the
    // bare word is exactly what this removes. Seeded WITH a name so the host
    // would have had one to render.
    //
    // Both assertions are load-bearing, because either alone is satisfied by
    // a regression the other catches: counting the h1s alone passes if the
    // generic heading is the survivor and Anderson's line the one demoted,
    // and naming the survivor alone passes with the host's heading still
    // rendered above it — which is the state this screen was actually in.
    const { container } = renderGate({ name: "Edwin", setup: { mode: "local", step: PREFLIGHT } });

    expect(await findHost(container)).toHaveAttribute("data-step", "preflight");
    const headings = container.querySelectorAll("h1");
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent(/hello! my name is anderson/i);
  });

  it("greets nobody on a setup step — the question is the first thing said", async () => {
    // The user's ruling, walked in the live app: the host's
    // `<h1>Welcome, {name}</h1>` rendered at 26px/700 directly above
    // Anderson's actual question at `<h2>`, so a generic greeting outranked
    // the person on every single step. He already said hello at the gate.
    //
    // Both halves are load-bearing. The name query alone passes for a host
    // that keeps a bare "Welcome" — which is exactly the state the GATE was
    // in before Task 8 of Plan 1, so it is a regression this codebase has
    // already shipped once — and the bare-word query alone passes for one
    // that still greets by name.
    const { container } = renderGate({ name: "Edwin", setup: { mode: "local", step: "sources" } });

    expect(await findHost(container)).toHaveAttribute("data-step", "sources");
    expect(screen.queryByText("Welcome, Edwin")).toBeNull();
    expect(screen.queryByText("Welcome")).toBeNull();
  });

  it("leaves a setup step with NO h1, and never by promoting the question to fill it", async () => {
    // The deliberate consequence of the ruling above, pinned so nothing
    // "fixes" it back: the greeting is not demoted to `<h2>` and re-shown, and
    // no question is promoted to `<h1>` to keep the slot filled. Anderson's
    // question stays `<h2>` — his words — and simply becomes the first and
    // largest thing on the screen.
    //
    // The h2 count is what stops this passing on a step that renders nothing
    // at all, and it is also what keeps `headingLevel="h2"` load-bearing:
    // ApiKeysGroup DEFAULTS to `<h1>`, so a lost prop would both re-introduce
    // an h1 here and put a reused Settings title above Anderson's question in
    // the outline — the same inversion, one level down.
    const { container } = renderGate({ name: "Edwin", setup: { mode: "local", step: "sources" } });

    expect(
      await screen.findByRole("heading", { name: /where should i get my thinking from, edwin\?/i }),
    ).toHaveProperty("tagName", "H2");
    expect(container.querySelectorAll("h1")).toHaveLength(0);
    expect(container.querySelectorAll("h2").length).toBeGreaterThan(0);
  });

  it("shows only the chosen sequence in the indicator", async () => {
    renderGate({ name: "Edwin", setup: { mode: "local", step: "sources" } });

    expect(await screen.findByText("Where I think")).toBeInTheDocument();
    expect(screen.getByText("What I think with")).toBeInTheDocument();
    // Preflight is not in it, under either of the names it has ever had.
    expect(screen.queryByText("Welcome")).toBeNull();
    expect(screen.queryByText(PREFLIGHT)).toBeNull();
  });

  it("shows honest progress and a skip control that states its default, not the bare word", async () => {
    renderGate({ name: "Edwin", setup: { mode: "local", step: "sources" } });

    expect(await screen.findByText("Step 1 of 4")).toBeInTheDocument();
    const skip = screen.getByRole("button", { name: /skip/i });
    // Discriminates the same way wizardSteps.test.ts's own check does, one
    // layer up: a control merely labelled "Skip" would satisfy a name-only
    // query but fail this — it has to say what skipping DOES.
    expect(skip.textContent?.trim().toLowerCase()).not.toBe("skip");
  });

  it("hangs Skip off the progress line rather than on a line of its own", async () => {
    // Skip used to render as an accent pill on a line of its own between
    // `Step n of N` and the panel heading — measured 48px above it, so the
    // first control on the step, and the only one visible without scrolling
    // past the question, was the one that declines it. jsdom cannot measure
    // that. What it CAN hold is the structure the placement rests on, and
    // both halves are asserted because each alone is weak: sharing the row
    // passes with Skip rendered BEFORE the number, and the ordering passes
    // with the two sitting in separate containers.
    renderGate({ name: "Edwin", setup: { mode: "local", step: "sources" } });

    const skip = await screen.findByRole("button", { name: /skip/i });
    const row = skip.closest(".wizard-gate__progress");
    expect(row).not.toBeNull();
    expect(row?.textContent).toMatch(/^Step 1 of 4/);
  });

  it("Skip cannot race the write that put the user on the step", async () => {
    // Same window `advance` opens for the steps' own Back (see the test near
    // the end of this file): the step changes immediately and its PUT runs
    // behind it, so Subscriptions is on screen with a live Skip while
    // PUT {mode, step:"sources"} is still in flight. Held open here
    // rather than left a millisecond wide.
    //
    // Worth its own test because the control is no longer a HeroUI `Button`:
    // `isDisabled` became the native `disabled` attribute, and dimming alone
    // would satisfy the eye while leaving both the pointer and the keyboard
    // live — the exact aria-disabled-vs-disabled split this branch has
    // already been bitten by once.
    let settle: (value: unknown) => void = () => {};
    const { container, updateMe } = renderGate({ placeholder: true, setup: undefined });
    await findHost(container);
    updateMe.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );

    await userEvent.type(screen.getByLabelText(/what shall i call you/i), "Edwin");
    await userEvent.click(screen.getByRole("button", { name: /nice to meet you/i }));

    expect(await findHost(container)).toHaveAttribute("data-step", "sources");
    expect(screen.getByRole("button", { name: /skip/i })).toBeDisabled();

    // A window, not a ban — the moment the write lands, Skip is live again.
    settle({});
    await waitFor(() => expect(screen.getByRole("button", { name: /skip/i })).toBeEnabled());
  });

  it("skip applies the step's stated default through the same advance path a real answer takes", async () => {
    // Not a second write path: this asserts the skip lands as a normal PUT
    // {setup} through `advance`, carrying an EXPLICIT key beyond the `step`
    // advance always stamps — a `{}` patch would still move `step` forward
    // and could look identical to a passing test that only checked the step
    // changed, which is exactly the empty-patch failure mode the brief rules
    // out.
    const { container, updateMe } = renderGate({ name: "Edwin", setup: { mode: "local", step: "sources" } });

    await userEvent.click(await screen.findByRole("button", { name: /skip/i }));

    expect(await findHost(container)).toHaveAttribute("data-step", "roles");
    expect(updateMe).toHaveBeenCalledWith(
      expect.objectContaining({ setup: expect.objectContaining({ sourcesSkipped: true, step: "roles" }) }),
    );
  });

  it("the host's Skip on voice sends an EXPLICIT voice: false, and advances to talk", async () => {
    // The same path as the sources test above, on the step this plan adds —
    // and the one place `skipDefault()` returning `{}` would be invisible in
    // every OTHER check (`stepsFor`'s own registry test only checks the keys
    // are non-empty), because `step` still advances either way. This asserts
    // the actual VALUE. Voice is no longer terminal — "talk" now sits after
    // it — so this Skip advances rather than finishing, and the terminal write
    // is asserted on talk below.
    const { container, updateMe } = renderGate({ name: "Edwin", setup: { mode: "local", step: "voice" } });

    await userEvent.click(await screen.findByRole("button", { name: /skip/i }));

    // It ADVANCES now rather than staying put: skipping the last step finishes
    // in place, but voice is no longer the last step.
    expect(await findHost(container)).toHaveAttribute("data-step", "talk");
    expect(updateMe).toHaveBeenCalledWith(
      expect.objectContaining({ setup: expect.objectContaining({ voice: false, step: "talk" }) }),
    );
  });

  it("the host's Skip on talk sends BOTH answers explicitly, and finishes setup", async () => {
    // Talk is the new last step, so its Skip is the one that reaches
    // SETUP_DONE. Both fields asserted by VALUE: a `skipDefault()` returning a
    // partial patch would leave one answer standing from an earlier run and be
    // invisible everywhere else, because `step` advances either way.
    const { container, updateMe } = renderGate({ name: "Edwin", setup: { mode: "local", step: "talk" } });

    await userEvent.click(await screen.findByRole("button", { name: /skip/i }));

    expect(await findHost(container)).toHaveAttribute("data-step", "talk");
    expect(updateMe).toHaveBeenCalledWith(
      expect.objectContaining({
        setup: expect.objectContaining({ smallTalk: true, worldAware: false, step: SETUP_DONE }),
      }),
    );
  });

  it("resumes mid-voice with a preflight-era 'voice: false' as previously declined, not never asked", async () => {
    // Records from before this step existed may already carry `setup.voice`
    // — written by the OLD preflight's own voice question, or by an earlier
    // skip default (see the `Setup.voice` doc comment in wizardSteps.ts).
    // `resumeStep` lands on "voice" regardless (pinned in wizardSteps.test.ts
    // — this is the integration half); what this pins is that the step then
    // renders with "Not right now" already the seeded answer rather than
    // crashing or misreading the boolean, the concrete user-visible meaning
    // of "previously declined" for a user who reopens the wizard mid-voice.
    const { container } = renderGate({ name: "Edwin", setup: { mode: "local", step: "voice", voice: false } });

    expect(await findHost(container)).toHaveAttribute("data-step", "voice");
    expect(await screen.findByRole("radio", { name: /not right now/i })).toBeChecked();
  });

  it("enters the sequence the answer just given selects, not the one state still holds", async () => {
    const { container, updateMe } = renderGate({ placeholder: true, setup: undefined });

    const host = await findHost(container);
    await userEvent.type(screen.getByLabelText(/what shall i call you/i), "Edwin");
    await userEvent.click(screen.getByRole("button", { name: /nice to meet you/i }));

    // Read from state instead of from the patch, `mode` is still undefined at
    // this point — `setupStepsFor` returns nothing for it, so the wizard would
    // persist `done` and drop a user who has answered nothing into the app.
    expect(host).toHaveAttribute("data-step", "sources");
    expect(updateMe).toHaveBeenCalledWith(
      expect.objectContaining({ setup: expect.objectContaining({ mode: "local", step: "sources" }) }),
    );
  });

  it("goes back from the first setup step into preflight, and persists it", async () => {
    const { container, updateMe } = renderGate({ name: "Edwin", setup: { mode: "local", step: "sources" } });

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
    const { container, updateMe } = renderGate({ name: "Edwin", setup: { mode: "local", step: "sources" } });
    updateMe.mockResolvedValue({ error: "origin not allowed" });

    await userEvent.click(await screen.findByRole("button", { name: /back/i }));

    expect(await screen.findByText(/origin not allowed/i)).toBeInTheDocument();
    expect(await findHost(container)).toHaveAttribute("data-step", "sources");
  });

  it("a network-level failure on Back keeps the user where they navigated, and still reports it", async () => {
    // The other shape, and deliberately NOT handled the same way: a rejection
    // is ambiguous — the write may well have landed — so the step change
    // stands, exactly as `advance` treats its own rejections. Reported either
    // way; a whole wizard's worth of unsaved work must never go unmentioned.
    const { container, updateMe } = renderGate({ name: "Edwin", setup: { mode: "local", step: "sources" } });
    updateMe.mockRejectedValue(new Error("network error"));

    await userEvent.click(await screen.findByRole("button", { name: /back/i }));

    expect(await screen.findByText(/network error/i)).toBeInTheDocument();
    expect(await findHost(container)).toHaveAttribute("data-step", "preflight");
  });

  it("routes the roles screen", async () => {
    // A route naming a step id nothing renders leaves the body EMPTY — no
    // Continue, no escape, and no Back either, since Back lives inside the
    // step component — so the user is stranded on a panel with an indicator
    // and nothing else, and the gate reopens on every reload because setup
    // never completes. That shipped once already on the `brain` → `anderson`
    // rename, which is why this route has its own test; this swap renames
    // BOTH ids at once, so it is the same exposure twice over. Asserted
    // through the step's own question, which is the thing that actually stops
    // existing.
    const { container } = renderGate({ name: "Edwin", setup: { mode: "local", step: "roles" } });

    expect(await findHost(container)).toHaveAttribute("data-step", "roles");
    // The step's own distinctive question, not a substring any other step's
    // copy shares — the sources step's "Where should I get my thinking from,
    // Edwin?" is on screen at another step in this same suite and does not
    // match this pattern.
    expect(
      await screen.findByRole("heading", { name: /which of these should i use, and for what\?/i }),
    ).toBeInTheDocument();
  });

  it("routes the NEW last step to the voice screen", async () => {
    // Same exposure as the roles test above, on the id this plan adds: a
    // `voice` entered into `setupStepsFor` with no matching render branch
    // here would strand a user who just answered roles on a panel with an
    // indicator and nothing else — the empty-body dead end this codebase has
    // already shipped once on a step rename, now on a step INSERTION instead.
    const { container } = renderGate({ name: "Edwin", setup: { mode: "local", step: "voice" } });

    expect(await findHost(container)).toHaveAttribute("data-step", "voice");
    expect(
      await screen.findByRole("heading", { level: 2, name: "Would you like to talk to me out loud?" }),
    ).toBeInTheDocument();
  });

  it("goes back from roles into sources, and persists that", async () => {
    // The other half of "every setup step can go Back". Fails if the host
    // stops passing `onBack` to the roles route, and equally if that step
    // stops rendering the button — this clicks the real component's own.
    const { container, updateMe } = renderGate({ name: "Edwin", setup: { mode: "local", step: "roles" } });

    await userEvent.click(await screen.findByRole("button", { name: /back/i }));

    // Into the step BEFORE it, not all the way out to preflight.
    expect(await findHost(container)).toHaveAttribute("data-step", "sources");
    expect(updateMe).toHaveBeenCalledWith(
      expect.objectContaining({ setup: expect.objectContaining({ step: "sources" }) }),
    );
  });

  it("goes back from the NEW last step (voice) into roles, and persists that", async () => {
    // The same contract, on the step that now actually sits at the end of the
    // sequence — `onBack` is computed generically from `prevStep`, so this is
    // what actually discriminates a host that stopped wiring it through past
    // roles, which the test above cannot: roles keeps a Back regardless.
    const { container, updateMe } = renderGate({ name: "Edwin", setup: { mode: "local", step: "voice" } });

    await userEvent.click(await screen.findByRole("button", { name: /back/i }));

    expect(await findHost(container)).toHaveAttribute("data-step", "roles");
    expect(updateMe).toHaveBeenCalledWith(
      expect.objectContaining({ setup: expect.objectContaining({ step: "roles" }) }),
    );
  });

  it("advances from roles into voice, now that roles is no longer the last step in the sequence", async () => {
    // The wiring this whole plan is about, proven end to end: `nextStep`
    // saying "voice" comes after "roles" is only half the contract — the
    // other half is that a REAL answer on roles actually lands the user
    // there rather than on the empty panel a route with no render branch
    // produces (see "routes the NEW last step to the voice screen" above,
    // which pins the render branch on its own; this pins the TRANSITION into
    // it). `patch.setup.step` is asserted directly, not inferred from
    // `data-step` alone, because an optimistic UI can show the right screen
    // for the wrong reason — a host that hardcoded `setStep("voice")` on
    // roles' `onDone` would pass the `data-step` half of this test and fail
    // only the write.
    const { container, updateMe } = renderGate({
      name: "Edwin",
      setup: { mode: "local", step: "roles" },
      tools: [toolListing("claude")],
    });
    await screen.findByRole("combobox", { name: "My main brain" });

    await userEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(await findHost(container)).toHaveAttribute("data-step", "voice");
    await waitFor(() =>
      expect(updateMe).toHaveBeenCalledWith(
        expect.objectContaining({ setup: expect.objectContaining({ step: "voice" }) }),
      ),
    );
  });

  it("backing into preflight shows the answers already given, not a blank form", async () => {
    // Seeding is half of a guarantee whose other half is WizardGateStep
    // sending `mode` EXPLICITLY on every submit. Unseeded, Back lands on a
    // preflight whose name field is empty (Continue disabled until it is
    // retyped) — the explicit send exists to stop the server's merge from
    // keeping a stale answer; without seeding, resubmitting would overwrite a
    // good one instead.
    renderGate({ name: "Edwin", setup: { mode: "local", step: "sources" } });

    await userEvent.click(await screen.findByRole("button", { name: /back/i }));

    expect(await screen.findByLabelText(/what shall i call you/i)).toHaveValue("Edwin");
    // The user-visible consequence of losing the name seed, asserted directly.
    expect(screen.getByRole("button", { name: /nice to meet you/i })).toBeEnabled();
    // The MODE seed is asserted in the test below instead, not here: a record
    // that reaches this screen by pressing Back necessarily has mode "local"
    // (no other mode has a step to come back from), and "local" is also
    // WizardGateStep's own default — so `expect(machine).toBeChecked()` here
    // would hold whether or not the seed is passed or read at all.
  });

  it("hands preflight the mode already recorded, not the step's own default", async () => {
    // The discriminating half of `initialMode={mode}`. "hosted" is the only
    // value that differs from the step's default, and it IS reachable here:
    // `setupStepsFor("hosted")` is empty, so `resumeStep` sends every hosted
    // record — whatever step it names — back to preflight. Fails both for a
    // host that stops passing the prop and for a step that stops reading it.
    const { container } = renderGate({ name: "Edwin", setup: { mode: "hosted", step: "roles" } });

    expect(await findHost(container)).toHaveAttribute("data-step", "preflight");
    expect(await screen.findByRole("radio", { name: /on your machine/i })).not.toBeChecked();
  });

  it("applies every step's stated default and finishes", async () => {
    // Composed from `stepsFor`, the SAME registry `skip` reads — not a
    // second, hand-rolled list. If a step's default changes, this follows
    // it; a hardcoded copy here would silently stop matching what the
    // button actually applies. `.at(-1)` rather than the only call: the
    // point being verified is what the button's write ultimately contains,
    // however many writes it took to get there.
    const { updateMe } = renderGate({ placeholder: true, setup: undefined });
    await userEvent.type(await screen.findByLabelText(/what shall i call you/i), "Edwin");
    await userEvent.click(screen.getByRole("button", { name: /just pick sensible things for me/i }));

    // `lastCall`, not `.calls.at(-1)`: this repo's `tsc` lib target has no
    // `Array.prototype.at`, and `.calls.at(-1)` is exactly the shape that
    // trips it — `lastCall` says the same thing without it.
    const patch = updateMe.mock.lastCall?.[0];
    expect(patch.name).toBe("Edwin");
    expect(patch.setup.step).toBe(SETUP_DONE);
    for (const s of stepsFor({ mode: "local" })) {
      for (const [k, v] of Object.entries(s.skipDefault() ?? {})) {
        expect(patch.setup[k]).toEqual(v);
      }
    }
  });

  it("still needs a name — it picks the other things, not that one", async () => {
    renderGate({ placeholder: true, setup: undefined });
    expect(await screen.findByRole("button", { name: /just pick sensible things for me/i })).toBeDisabled();
  });

  it("offers no Back on preflight — it is the beginning", async () => {
    // Kept, and labelled, because it does NOT test what its name suggests.
    //
    // It pins a real user-visible contract — the first screen has no way
    // backwards — but that contract is satisfied by WizardGateStep's own
    // markup (it renders no Back under any props), not by the host's
    // `prevStep(step, answers) ? goBack : undefined`. So it cannot fail for a
    // host that computes `onBack` wrongly in the permissive direction.
    // Measured, not assumed:
    //
    //   - const onBack = prevStep(step, answers) ? goBack : undefined;
    //   + const onBack = goBack;
    //   → this suite still passes, in full
    //
    // No honest test of that gate exists yet, and manufacturing one would mean
    // manufacturing reachability. `prevStep` returns null ONLY for preflight
    // (pinned in wizardSteps.test.ts), and preflight is the one step the host
    // never passes `onBack` to — so the `undefined` branch is computed and
    // discarded, dead twice over. The gate still belongs there for the reason
    // its own comment gives; the Voice step is the first thing that can make
    // it reachable, and it should arrive with the test that discriminates.
    //
    // The opposite mutation IS covered: an `onBack` that is always undefined
    // fails "goes back from the first setup step into preflight, and persists
    // it", which clicks the real button.
    const { container } = renderGate({ placeholder: true, setup: undefined });

    await findHost(container);
    expect(screen.queryByRole("button", { name: /back/i })).toBeNull();
  });

  // The two below are the only tests in the repo that span the host and the
  // LAST step together, and that is the point: neither side can see this
  // failure alone. WizardRolesStep's own suite mocks `onDone`, so the host's
  // save never happens there; this suite exercised a refused save only at
  // preflight, where the step is swapped out and the question cannot arise.
  // The last step is different — `nextStep` returns null, so nothing swaps and
  // the step stays mounted, inert, behind a write that has already failed.

  it("Back on the first setup step cannot race the write that put the user there", async () => {
    // The host-side half of the same window, one step before the last one.
    // `advance` moves the step immediately and lets its PUT run in the
    // background, so Subscriptions is on screen — with a live Back — while
    // PUT {mode, step:"sources"} is still unresolved. This write never
    // settles until the test says so, which is what makes that window
    // observable rather than a millisecond wide.
    let settle: (value: unknown) => void = () => {};
    const { container, updateMe } = renderGate({ placeholder: true, setup: undefined });
    await findHost(container);
    updateMe.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );

    await userEvent.type(screen.getByLabelText(/what shall i call you/i), "Edwin");
    await userEvent.click(screen.getByRole("button", { name: /nice to meet you/i }));

    expect(await findHost(container)).toHaveAttribute("data-step", "sources");
    expect(screen.getByRole("button", { name: /back/i })).toBeDisabled();

    // A window, not a ban: the moment that write lands, Back is live again.
    settle({});
    await waitFor(() => expect(screen.getByRole("button", { name: /back/i })).toBeEnabled());
  });

  it("the chip cannot race it either — and it is the control with nothing to slow it down", async () => {
    // Back is guarded; the chip sits directly above it and was not. It is the
    // one control that can reach preflight from ANY post-preflight step, and
    // on the FIRST setup step `clears` is empty, so `requestEdit` skips the
    // confirm dialog entirely and calls `onEdit` on the bare click. Left live,
    // that is `PUT {step:"preflight"}` fired against an unresolved
    // `PUT {step:"sources"}` — and `resumeStep` reads whichever the
    // server ends up holding, not what is on screen, so the losing order
    // throws the user forward past the very answers the chip went back for.
    let settle: (value: unknown) => void = () => {};
    const { container, updateMe } = renderGate({ placeholder: true, setup: undefined });
    await findHost(container);
    // This suite's mocks are module-level and nothing auto-clears them between
    // tests (no `clearMocks` in the vite config), so a call COUNT — which is
    // what makes this a race test rather than a styling one — has to start
    // from a known zero. The same reason the last-step tests below clear it.
    updateMe.mockClear();
    updateMe.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );

    await userEvent.type(screen.getByLabelText(/what shall i call you/i), "Edwin");
    await userEvent.click(screen.getByRole("button", { name: /nice to meet you/i }));

    expect(await findHost(container)).toHaveAttribute("data-step", "sources");
    const chip = () => screen.getByRole("button", { name: /anderson · on your machine/i });
    expect(chip()).toBeDisabled();

    // Not merely dimmed: no dialog, no second write, and the step does not
    // move. Asserting the call count is what makes this a race test rather
    // than a styling one.
    await userEvent.click(chip());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(updateMe).toHaveBeenCalledTimes(1);
    expect(await findHost(container)).toHaveAttribute("data-step", "sources");

    // A window, not a ban — same as Back beside it.
    settle({});
    await waitFor(() => expect(chip()).toBeEnabled());
  });

  it("a refused save on the last step leaves the footer something to click", async () => {
    // Retargeted again — roles → voice → talk. Each time a step is appended,
    // `nextStep` stops returning null for the old last one, so this race moves
    // with the terminal step rather than staying where it was written. "talk"
    // is reachable on its own defaults (chatty, no news), so it needs no
    // fixture setup to reach a live Continue.
    //
    // The refusal shape: `brokerFetch` never throws on a non-2xx, so an origin
    // block, a credential failure, or swarm-side validation all RESOLVE with
    // `{error}`. If Back and Continue are inert too, the last screen of
    // first-run setup has nothing clickable on it at all, and only a page
    // reload nothing mentions gets the user out.
    const { container, updateMe } = renderGate({ name: "Edwin", setup: { mode: "local", step: "talk" } });
    await screen.findByRole("radio", { name: /stick to what I already know/i });

    updateMe.mockResolvedValue({ error: "origin not allowed" });
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByText(/origin not allowed/i)).toBeInTheDocument();
    // Still here — this is what makes the last step unlike every other one.
    expect(await findHost(container)).toHaveAttribute("data-step", "talk");
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Back" })).toBeEnabled();

    // Enabled is not the same as live: in this codebase a button can read as
    // enabled and still eat the click (aria-disabled ⇒ pointer-events: none).
    // The retry has to actually reach the server. This one never settles, so
    // the state below is the retry's write still in flight.
    updateMe.mockClear();
    updateMe.mockReturnValue(new Promise(() => {}));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() =>
      expect(updateMe).toHaveBeenCalledWith(
        expect.objectContaining({ setup: expect.objectContaining({ step: "done" }) }),
      ),
    );
    // And the race the whole inert mechanism exists for is closed AGAIN on the
    // retry — a fix that simply stops re-inerting after the first failure
    // passes everything above this line and re-opens exactly the window
    // `handedOff` was added to close.
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
  });

  it("the gate's own shortcut cannot be followed by a second, contradicting write", async () => {
    // The other half of the same finding. `pickForMe` calls `advance(patch,
    // true)`, and `finish` makes `next` null — so `if (next) setStep(next)`
    // never runs and the gate step STAYS MOUNTED, both controls live, behind
    // an unresolved `PUT {step:"done"}`. Clicking the primary next to it then
    // fires `PUT {step:"sources"}` against it: if `done` lands last the
    // gate closes with the screen still on preflight, and if `sources` does,
    // setup reopens one moment after it finished.
    let settle: (value: unknown) => void = () => {};
    const { container, updateMe } = renderGate({ placeholder: true, setup: undefined });
    await findHost(container);
    // See the chip test above: module-level mocks, nothing auto-clears them,
    // and the call count is the whole point of this test.
    updateMe.mockClear();
    updateMe.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );

    await userEvent.type(screen.getByLabelText(/what shall i call you/i), "Edwin");
    await userEvent.click(screen.getByRole("button", { name: /just pick sensible things for me/i }));

    // Still here — that is what makes this step unlike the ones that advance.
    expect(await findHost(container)).toHaveAttribute("data-step", PREFLIGHT);
    const go = () => screen.getByRole("button", { name: /nice to meet you/i });
    expect(go()).toBeDisabled();
    expect(screen.getByRole("button", { name: /just pick sensible things for me/i })).toBeDisabled();

    await userEvent.click(go());
    expect(updateMe).toHaveBeenCalledTimes(1);

    settle({});
    await waitFor(() => expect(go()).toBeEnabled());
  });

  it("a REFUSED 'pick sensible things for me' leaves the gate something to click", async () => {
    // The dead end the guard above must not create, and not a hypothetical
    // one: this feature has already shipped exactly this bug on the LAST step,
    // where a refused save found the footer inert behind a write that was
    // already over. The gate has the same shape for the same reason — `finish`
    // computes no next step, so nothing swaps this screen out — and it is the
    // FIRST screen of first-run setup, with no Back and no other control on it
    // at all. Inert past the refusal means a page reload nothing mentions.
    //
    // The refusal shape specifically: `brokerFetch` never throws on a non-2xx,
    // so an origin block or a swarm-side validation error RESOLVES with
    // `{error}` rather than rejecting.
    const { container, updateMe } = renderGate({ placeholder: true, setup: undefined });
    await findHost(container);
    updateMe.mockClear();
    updateMe.mockResolvedValue({ error: "origin not allowed" });

    await userEvent.type(screen.getByLabelText(/what shall i call you/i), "Edwin");
    await userEvent.click(screen.getByRole("button", { name: /just pick sensible things for me/i }));

    expect(await screen.findByText(/origin not allowed/i)).toBeInTheDocument();
    expect(await findHost(container)).toHaveAttribute("data-step", PREFLIGHT);
    expect(screen.getByRole("button", { name: /nice to meet you/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /just pick sensible things for me/i })).toBeEnabled();
    // Only the step rolls back, never the answer — the name is still there to
    // retry with rather than typed a second time.
    expect(screen.getByLabelText(/what shall i call you/i)).toHaveValue("Edwin");

    // Enabled is not the same as live: the retry has to actually reach the
    // server. This write never settles, so what follows is the retry in flight.
    updateMe.mockClear();
    updateMe.mockReturnValue(new Promise(() => {}));
    await userEvent.click(screen.getByRole("button", { name: /just pick sensible things for me/i }));

    await waitFor(() => expect(updateMe).toHaveBeenCalledTimes(1));
    // And the race is closed AGAIN on the retry — a guard that simply stops
    // re-arming after the first failure passes everything above this line and
    // reopens exactly the window it was added to close.
    expect(screen.getByRole("button", { name: /nice to meet you/i })).toBeDisabled();
  });

  it("a REJECTED one does too — the other shape, and not interchangeable", async () => {
    // `advance`'s two branches are different code: a rejection takes `.catch`,
    // which never calls `setStep`. A guard wired to re-arm in only one of them
    // passes the test above and leaves this user just as stuck. Same pairing,
    // same reason, as the two last-step tests below.
    const { container, updateMe } = renderGate({ placeholder: true, setup: undefined });
    await findHost(container);
    updateMe.mockClear();
    updateMe.mockRejectedValue(new Error("network error"));

    await userEvent.type(screen.getByLabelText(/what shall i call you/i), "Edwin");
    await userEvent.click(screen.getByRole("button", { name: /just pick sensible things for me/i }));

    expect(await screen.findByText(/network error/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /just pick sensible things for me/i })).toBeEnabled();

    // The primary is the escape that matters on this shape — a rejection is
    // ambiguous, the write may well have landed, so walking the setup rather
    // than retrying the shortcut is the sensible move. Live, not just visible.
    updateMe.mockResolvedValue({});
    await userEvent.click(screen.getByRole("button", { name: /nice to meet you/i }));
    expect(await findHost(container)).toHaveAttribute("data-step", "sources");
  });

  it("the step's own escape records the SAME 'skipped' the progress-row Skip does", async () => {
    // The two escapes on this one screen, side by side after a refused save.
    // `rolesSkipped` exists so "skipped" and "never asked" stay
    // distinguishable — the roles step writes its answers to `/me/engines`,
    // not to `setup`, so a way off it that saved nothing has nothing else to
    // leave behind — and the escape used to hand back a bare `{setup: {}}`,
    // so a user whose save the server refused finished byte-identical to
    // someone who deliberately picked three engines. Nothing reads the flag
    // yet, which is exactly why this has to be pinned here rather than found
    // later.
    //
    // Task 4's dropdown filtering is why the fixture is `claude` rather than
    // the codex-only machine this test used to describe: an unofferable CLI
    // now yields NO candidates at all, so the step never saves and the
    // refusal cannot be reached. The refusal that remains is the one
    // filtering cannot remove — the server saying no at save time.
    //
    // Asserted against the registry's own `skipDefault()`, never a literal
    // `rolesSkipped: true`: the requirement is that a field added to a step's
    // skip default cannot leave one of the two paths behind, and a hardcoded
    // expectation here would stop discriminating the moment that happens.
    const { updateMe } = renderGate({
      name: "Edwin",
      setup: { mode: "local", step: "roles" },
      tools: [toolListing("claude")],
    });
    await screen.findByRole("combobox", { name: "My main brain" });

    (saveEngines as ReturnType<typeof vi.fn>).mockResolvedValue({ error: "claude is not supported as a brain yet" });
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText(/not supported as a brain/i);

    updateMe.mockClear();
    await userEvent.click(screen.getByRole("button", { name: "Continue without setting these" }));
    await waitFor(() => expect(updateMe).toHaveBeenCalled());

    const expected =
      stepsFor({ mode: "local" })
        .find((d) => d.id === "roles")
        ?.skipDefault() ?? {};
    // Positive control: a registry lookup that missed would leave the loop
    // below empty and pass this test on nothing at all.
    expect(Object.keys(expected).length).toBeGreaterThan(0);
    const patch = updateMe.mock.lastCall?.[0];
    for (const [k, v] of Object.entries(expected)) {
      expect(patch.setup[k]).toEqual(v);
    }
    // Still advances into the sequence's next step, not a retreat — the
    // escape moves setup forward like any other way off this step. "voice",
    // not `SETUP_DONE`: roles is no longer the last step this plan inserts
    // "voice" after, and a stale `SETUP_DONE` expectation here is exactly the
    // kind of assertion that would keep passing on a host that forgot to
    // route the new step at all, because the write it checks never depended
    // on anything rendering.
    expect(patch.setup.step).toBe("voice");
  });

  it("a rejected save on the last step leaves the footer something to click too", async () => {
    // Moved from "roles" to "voice", same reasoning as the refused-save test
    // above: roles is no longer terminal, so `advance`'s `if (next)
    // setStep(next)` now DOES fire for it regardless of how the write
    // settles — see "advances from roles into voice..." below, which pins
    // that transition directly. This test's actual subject — nothing swaps
    // the screen at all, so the footer has to stay clickable on its own —
    // only still arises where `next` is genuinely null, which is now here.
    //
    // The shape itself is still NOT interchangeable with the refused one: a
    // network failure rejects rather than resolving, and it takes `advance`'s
    // `.catch` branch, which — unlike the resolved branch — never calls
    // `setStep`. A fix wired only into the resolved branch passes that test
    // and leaves this user just as stuck.
    const { container, updateMe } = renderGate({ name: "Edwin", setup: { mode: "local", step: "talk" } });
    await screen.findByRole("radio", { name: /stick to what I already know/i });

    updateMe.mockRejectedValue(new Error("network error"));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByText(/network error/i)).toBeInTheDocument();
    expect(await findHost(container)).toHaveAttribute("data-step", "talk");
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();

    // Back is the escape that matters on this shape — a rejection is
    // ambiguous, the write may well have landed, so retrying it is not the
    // only sensible move — and it has to be live, not merely visible.
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(await findHost(container)).toHaveAttribute("data-step", "voice");
  });

  // --- The footer's own ranking --------------------------------------------

  it("ranks Back below Continue rather than beside it as an equal pill", async () => {
    // Walked in the live app: Back and Continue rendered as two identical
    // full-width stacked pills, so the way OUT of a question read exactly as
    // heavy as the way through it. Task 8 of Plan 1 settled this on the gate
    // — the shortcut dropped to quiet text beside the one filled control —
    // and the setup steps never got the same treatment.
    //
    // jsdom has no layout, so the weight itself is not measurable here. What
    // is, and what the styling rests on, is that exactly ONE control in the
    // footer is a HeroUI pill and it is the primary: `.wizard-gate__footer
    // [data-slot="button"]` is the hook the fill, height and radius hang off,
    // and Back carries the same hand-styled quiet class the gate's shortcut
    // already uses. Asserted on all THREE steps, because the treatment lives
    // in each step's own footer rather than in the host.
    for (const step of ["sources", "roles", "voice"] as const) {
      const { unmount } = renderGate({ name: "Edwin", setup: { mode: "local", step } });
      const back = await screen.findByRole("button", { name: "Back" });
      const footer = back.closest(".wizard-gate__footer");
      expect(footer).not.toBeNull();
      expect(back).toHaveClass("wizard-gate__quiet");
      const pills = footer?.querySelectorAll('[data-slot="button"]') ?? [];
      expect(pills).toHaveLength(1);
      expect(pills[0]).toHaveTextContent("Continue");
      unmount();
    }
  });
});
