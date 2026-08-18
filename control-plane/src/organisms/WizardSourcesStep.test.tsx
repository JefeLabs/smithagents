import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiKeyListing, CliToolListing, LocalServer } from "../api/types";
import type { WizardSaveState } from "../lib/wizardSteps";
import { qk } from "../queries/keys";
import { renderWithProviders } from "../test/renderWithProviders";
import { WizardSourcesStep } from "./WizardSourcesStep";

/** A live broker really listens on 127.0.0.1:7790 — throw by default so an
 * un-stubbed route fails loudly, matching every other Settings-adjacent suite. */
function stubNoNetwork() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("no network in this test");
    }),
  );
}

/** A fetch that never settles — the only way to hold a query in `pending`, which
 *  is what the "still checking" case needs and a throwing stub cannot produce. */
function stubHangingNetwork() {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise<Response>(() => {})),
  );
}

/**
 * Mirrors `isActive` (swarm/src/cli-tools.ts) rather than importing it — no
 * shared package crosses the control-plane/swarm boundary, and this is only
 * fixture math: block only confirmed negatives, `authOk: "unknown"` counts
 * as active. Defaults describe an already-working tool so a caller need only
 * override what makes THIS fixture's case interesting.
 */
function toolListing(cli: string, over: Partial<NonNullable<CliToolListing["status"]>> = {}): CliToolListing {
  const status = {
    detected: true,
    authOk: true as boolean | "unknown",
    enabled: true,
    detail: "",
    lastCheckedAt: "2026-08-18T00:00:00.000Z",
    ...over,
  };
  return {
    cli,
    label: cli,
    models: [],
    warmSessions: true,
    status,
    active: status.detected && status.enabled !== false && status.authOk !== false,
  };
}

function keyListing(provider: string, over: Partial<ApiKeyListing> = {}): ApiKeyListing {
  return {
    id: provider,
    label: provider,
    description: "",
    hasKey: true,
    last4: "0000",
    verified: null,
    detail: null,
    lastCheckedAt: null,
    ...over,
  };
}

function serverListing(id: string, label: string, models: LocalServer["models"]): LocalServer {
  return { id, label, baseUrl: `http://127.0.0.1:${id === "ollama" ? 11434 : 1234}`, models };
}

function renderStep(opts: {
  tools: Record<string, Partial<NonNullable<CliToolListing["status"]>>>;
  keys?: Array<{ provider: string; label?: string; verified: boolean | "unknown" | null }>;
  /** Left undefined to leave the local probe unseeded — the query's own state
      (pending or errored) is then what the local section has to render. */
  servers?: LocalServer[];
  /** `"hang"` holds every query in `pending`; the default throws. */
  network?: "throw" | "hang";
  onBack?: () => void;
  saveState?: WizardSaveState;
  name?: string;
}) {
  if (opts.network === "hang") stubHangingNetwork();
  else stubNoNetwork();
  const onDone = vi.fn();
  const element = (saveState: WizardSaveState) => (
    <WizardSourcesStep onDone={onDone} onBack={opts.onBack} saveState={saveState} name={opts.name ?? "Edwin"} />
  );
  const result = renderWithProviders(element(opts.saveState ?? "idle"));
  result.client.setQueryData<CliToolListing[]>(
    qk.cliTools,
    Object.entries(opts.tools).map(([cli, over]) => toolListing(cli, over)),
  );
  result.client.setQueryData<ApiKeyListing[]>(
    qk.apiKeys,
    (opts.keys ?? []).map((k) => keyListing(k.provider, { label: k.label ?? k.provider, verified: k.verified })),
  );
  if (opts.servers) result.client.setQueryData<LocalServer[]>(qk.localModels, opts.servers);
  return {
    ...result,
    onDone,
    reportSaveState: (saveState: WizardSaveState) => result.rerender(element(saveState)),
  };
}

const CONTINUE = { name: /continue/i } as const;
const LOGINS = { name: /logins you already have/i } as const;
const KEYS = { name: /your own api keys/i } as const;
const LOCAL = { name: /models on your machine/i } as const;

describe("WizardSourcesStep", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  // --- The spec's own copy -------------------------------------------------

  it("asks the spec's question in Anderson's voice, by the host's name", async () => {
    // Wrong impls this catches: any heading that hardcodes a name, omits
    // {name}, or paraphrases the question. The name is a non-default fixture
    // so a component that ignored the prop and printed "Edwin" still fails.
    renderStep({ tools: { claude: {} }, name: "Kathia" });
    expect(
      await screen.findByRole("heading", { name: /where should i get my thinking from, kathia\?/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("Pick as many as you like — I'll use whichever suits each job.")).toBeInTheDocument();
  });

  it("offers the spec's three sources, each with its own tail, as checkboxes", async () => {
    // Wrong impls this catches: a radio/fork instead of a multi-select (no
    // `checkbox` role at all), a source silently dropped, or a label that keeps
    // the bold half and loses the tail after the em dash. Exact strings, so a
    // paraphrase fails.
    renderStep({ tools: { claude: {} } });
    expect(await screen.findByRole("checkbox", { name: "Logins you already have — nothing to paste" })).toBeVisible();
    expect(screen.getByRole("checkbox", { name: "Your own API keys — Anthropic · Google" })).toBeVisible();
    expect(
      screen.getByRole("checkbox", {
        name: "Models on your machine — I'll download them, and nothing leaves your computer",
      }),
    ).toBeVisible();
  });

  // --- Pre-checked logins --------------------------------------------------

  it("arrives with logins already checked when this machine has a usable one", async () => {
    // Half one of the pre-check contract. On its own this would also pass for
    // a component that hardcodes `defaultChecked` — which is exactly what the
    // next test rules out, so the two must be read as a pair.
    renderStep({ tools: { claude: {} } });
    expect(await screen.findByRole("checkbox", LOGINS)).toBeChecked();
    expect(screen.getByRole("checkbox", KEYS)).not.toBeChecked();
    expect(screen.getByRole("checkbox", LOCAL)).not.toBeChecked();
  });

  it("leaves logins unchecked when nothing on this machine is usable", async () => {
    // Half two: the pre-check must be DERIVED from the probe, not a constant.
    // A hardcoded `defaultChecked` passes the test above and fails here.
    renderStep({ tools: { codex: { detected: false, failure: "missing" } } });
    await screen.findByRole("checkbox", LOGINS);
    expect(screen.getByRole("checkbox", LOGINS)).not.toBeChecked();
  });

  it("keeps an unchecked box unchecked after the probe answers", async () => {
    // The pre-check is a DEFAULT, not a continuous mirror of the data. A naive
    // `useEffect(() => setChecked(usable), [usable])` re-ticks the box under
    // the user's hand on the next refetch; this fails for that and passes for
    // an override-once model.
    const { client } = renderStep({ tools: { claude: {} } });
    await userEvent.click(await screen.findByRole("checkbox", LOGINS));
    expect(screen.getByRole("checkbox", LOGINS)).not.toBeChecked();

    // A refetch lands with the same usable tool — the user's "no" must survive it.
    client.setQueryData<CliToolListing[]>(qk.cliTools, [toolListing("claude"), toolListing("codex")]);
    expect(await screen.findByText(/codex/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", LOGINS)).not.toBeChecked();
  });

  // --- The logins list -----------------------------------------------------

  it("lists every CLI with its state, in the spec's shape — undetected ones included", async () => {
    // The spec's own two examples, verbatim. Wrong impls this catches: a list
    // that hides what isn't installed (the second assertion), one that renders
    // only labels with no state, and one that drops the ✓/✗ marks.
    renderStep({ tools: { claude: {}, codex: { detected: false, failure: "missing" } } });
    expect(await screen.findByText("✓ claude — you're signed in")).toBeInTheDocument();
    expect(screen.getByText("✗ codex — not installed")).toBeInTheDocument();
  });

  it("shows an undetected CLI without counting it as a usable source", async () => {
    // The "shown but not counted" pair in one assertion set: a component that
    // gated on `tools.length` rather than on usability renders the same list
    // and fails the second half.
    renderStep({ tools: { codex: { detected: false, failure: "missing" } } });
    expect(await screen.findByText("✗ codex — not installed")).toBeInTheDocument();
    expect(screen.getByRole("button", CONTINUE)).toBeDisabled();
  });

  it("counts copilot's and agy's permanent 'unknown' auth as signed in enough to continue", async () => {
    // Neither has an auth probe at all (swarm/src/cli-tools.ts), so both are
    // PERMANENTLY `authOk: "unknown"`. An implementation that required
    // `authOk === true` strands them forever — the bug this rule exists for.
    renderStep({ tools: { copilot: { authOk: "unknown", detail: "" } } });
    expect(await screen.findByRole("checkbox", LOGINS)).toBeChecked();
    expect(screen.getByRole("button", CONTINUE)).toBeEnabled();
  });

  // --- The gate ------------------------------------------------------------

  it("cannot continue while nothing is usable", async () => {
    renderStep({ tools: { codex: { detected: false, failure: "missing" } } });
    expect(await screen.findByRole("button", CONTINUE)).toBeDisabled();
  });

  it("continues on one usable login", async () => {
    renderStep({ tools: { claude: {} } });
    expect(await screen.findByRole("button", CONTINUE)).toBeEnabled();
  });

  it("re-disables Continue once every source is unchecked", async () => {
    // The multi-select's own gate: usable-and-CHOSEN, not merely usable. An
    // implementation that gated on the probe alone and used the checkboxes as
    // decoration passes every test above this one and fails here.
    renderStep({ tools: { claude: {} } });
    expect(await screen.findByRole("button", CONTINUE)).toBeEnabled();

    await userEvent.click(screen.getByRole("checkbox", LOGINS));
    expect(screen.getByRole("button", CONTINUE)).toBeDisabled();
  });

  it("sources accumulate rather than replace each other", async () => {
    // "Multi-select, not a fork." Logins is deliberately turned OFF first: an
    // implementation that drops the other answers when one is picked (a fork,
    // or a `setChoice(() => ({[kind]: on}))` that discards the rest of the map)
    // would let logins fall back to its pre-tick default and silently re-tick
    // it here. Asserting the pre-ticked box merely STAYS ticked cannot see
    // that, because the default and the kept answer agree.
    renderStep({ tools: { claude: {} }, keys: [{ provider: "anthropic", label: "Anthropic", verified: true }] });
    await userEvent.click(await screen.findByRole("checkbox", LOGINS));
    await userEvent.click(screen.getByRole("checkbox", KEYS));
    await userEvent.click(screen.getByRole("checkbox", LOCAL));

    expect(screen.getByRole("checkbox", KEYS)).toBeChecked();
    expect(screen.getByRole("checkbox", LOCAL)).toBeChecked();
    expect(screen.getByRole("checkbox", LOGINS)).not.toBeChecked();
  });

  it("a disabled Continue is genuinely unclickable, not just visually dimmed", async () => {
    // The `aria-disabled` trap this project has hit twice: it leaves a control
    // keyboard-reachable and activatable under this stylesheet. `toBeDisabled()`
    // checks the real IDL property and user-event no-ops the click the way a
    // browser would, so the click is the proof, not the attribute alone.
    const { onDone } = renderStep({ tools: { codex: { detected: false, failure: "missing" } } });
    const button = await screen.findByRole("button", CONTINUE);
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(onDone).not.toHaveBeenCalled();
  });

  it("clicking an enabled Continue advances the wizard", async () => {
    const { onDone } = renderStep({ tools: { claude: {} } });
    await userEvent.click(await screen.findByRole("button", CONTINUE));
    expect(onDone).toHaveBeenCalledOnce();
  });

  // --- Keys ----------------------------------------------------------------

  it("offers only the two providers something can actually consume", async () => {
    // The user's ruling: nothing in this codebase consumes an OpenAI key, and
    // OpenRouter is not registered at all. Rendering the bare Settings group
    // shows all three registry providers and fails the third assertion.
    renderStep({
      tools: {},
      keys: [
        { provider: "anthropic", label: "Anthropic", verified: null },
        { provider: "openai", label: "OpenAI", verified: null },
        { provider: "google", label: "Google", verified: null },
      ],
    });
    await userEvent.click(await screen.findByRole("checkbox", KEYS));
    expect(screen.getByText("Anthropic")).toBeInTheDocument();
    expect(screen.getByText("Google")).toBeInTheDocument();
    expect(screen.queryByText("OpenAI")).toBeNull();
  });

  it("borrows Settings' own key screen, verify button included, not a second implementation", async () => {
    // Proves the reuse the brief asks for: `verify`/`remove` are ApiKeysGroup's
    // own controls and appear only when a key is stored. A bespoke paste-only
    // field would render the input and fail on these.
    renderStep({ tools: {}, keys: [{ provider: "anthropic", label: "Anthropic", verified: "unknown" }] });
    await userEvent.click(await screen.findByRole("checkbox", KEYS));
    expect(screen.getByRole("button", { name: "verify" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "remove" })).toBeInTheDocument();
  });

  it("keeps the reused group's title at h2 — nothing here outranks Anderson's question", async () => {
    // `headingLevel`. ApiKeysGroup titles itself with an <h1> by default,
    // which is right in Settings and wrong here: the host renders NO <h1> on a
    // setup step at all (see WizardGate), so an <h1> from the reused group
    // would be the only top-level heading on the screen, and it would be a
    // Settings section title sitting above the question Anderson just asked.
    renderStep({ tools: { claude: {} }, keys: [{ provider: "anthropic", label: "Anthropic", verified: null }] });
    await userEvent.click(await screen.findByRole("checkbox", KEYS));
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    expect(screen.getAllByRole("heading", { level: 2 }).length).toBeGreaterThan(1);
  });

  it("speaks in Anderson's voice, not Settings', over Settings' own component", async () => {
    // The reuse is right — ApiKeysGroup owns save/verify/remove and the error
    // surfacing, and a wizard-only copy would drift — but its DEFAULT copy is
    // the system talking in the middle of a screen where Anderson is asking,
    // and it advertises a consumer ("accelerates avatar generation") this
    // wizard has never mentioned. Contextual props, the same treatment
    // `headingLevel` already demonstrates.
    renderStep({ tools: { claude: {} }, keys: [{ provider: "anthropic", label: "Anthropic", verified: null }] });
    await userEvent.click(await screen.findByRole("checkbox", KEYS));
    expect(screen.getByRole("heading", { name: "Your keys" })).toBeInTheDocument();
    expect(screen.getByText(/I'll check it right now/)).toBeInTheDocument();
    // The two halves of Settings' own copy that read worst here, named so this
    // fails on a lost prop rather than on a rewritten blurb.
    expect(screen.queryByText(/avatar generation/)).toBeNull();
    expect(screen.queryByRole("heading", { name: "api keys" })).toBeNull();
  });

  it("continues on a verified key with no CLI at all", async () => {
    renderStep({ tools: {}, keys: [{ provider: "anthropic", label: "Anthropic", verified: true }] });
    await userEvent.click(await screen.findByRole("checkbox", KEYS));
    expect(screen.getByRole("button", CONTINUE)).toBeEnabled();
  });

  it("a verified key for a provider this step does not offer does not open the gate", async () => {
    // OpenAI's card is filtered out above, so a gate that counted any verified
    // key would open on a source the user cannot see on this screen — and would
    // then hand Step 2 a provider the server refuses for every role. The fixture
    // is deliberately the ONLY key on the machine.
    renderStep({ tools: {}, keys: [{ provider: "openai", label: "OpenAI", verified: true }] });
    await userEvent.click(await screen.findByRole("checkbox", KEYS));
    expect(screen.getByRole("button", CONTINUE)).toBeDisabled();
  });

  it("a stored but unverified key does not open the gate", async () => {
    // Reality before preference: "a key is on this machine" is not "a key works".
    renderStep({ tools: {}, keys: [{ provider: "anthropic", label: "Anthropic", verified: "unknown" }] });
    await userEvent.click(await screen.findByRole("checkbox", KEYS));
    expect(screen.getByRole("button", CONTINUE)).toBeDisabled();
  });

  // --- Local models --------------------------------------------------------

  it("says plainly that nothing is running, and offers nothing false", async () => {
    // The honesty case. Wrong impls this catches: a section that renders an
    // empty list with no sentence at all (first assertion), one that invites
    // the user to "pick a model" with none to pick (second), and one that
    // treats an absent server as a usable source (third).
    renderStep({ tools: {}, servers: [] });
    await userEvent.click(await screen.findByRole("checkbox", LOCAL));
    expect(screen.getByText(/can't find a model server running on this machine/i)).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: /models/i })).toBeNull();
    expect(screen.getByRole("button", CONTINUE)).toBeDisabled();
  });

  it("does not claim nothing is running while the check is still in flight", async () => {
    // A pending probe and an empty one are different answers. An implementation
    // that reads `data ?? []` reports "nothing running" before it has looked —
    // and on a slow probe that is a lie the user acts on.
    renderStep({ tools: {}, network: "hang" });
    await userEvent.click(await screen.findByRole("checkbox", LOCAL));
    expect(screen.queryByText(/can't find a model server running on this machine/i)).toBeNull();
    expect(screen.getByText(/checking this machine/i)).toBeInTheDocument();
  });

  it("does not claim nothing is running when the check itself failed", async () => {
    // Same distinction on the other side: an unreachable broker is "I could not
    // look", never "there is nothing here".
    renderStep({ tools: {} });
    await userEvent.click(await screen.findByRole("checkbox", LOCAL));
    expect(await screen.findByText(/couldn't check this machine/i)).toBeInTheDocument();
    expect(screen.queryByText(/can't find a model server running on this machine/i)).toBeNull();
  });

  it("lists what is actually installed, and invents no size for a model that reports none", async () => {
    // Every real `sizeBytes` is null today — the OpenAI-compatible /v1/models
    // does not report one. The last assertion is on the row's WHOLE text, not
    // on a guessed spelling of the wrong answer: `null` coerced through a
    // formatter comes out as "0 B", "0 MB", "0 bytes" or "NaN" depending on
    // the formatter, and a query naming only some of those lets the others
    // through (it did — this is the assertion that let a mutation survive).
    renderStep({
      tools: {},
      servers: [
        serverListing("lmstudio", "LM Studio", [
          { id: "qwen3.6-27b", sizeBytes: null },
          { id: "openai/gpt-oss-20b", sizeBytes: null },
        ]),
      ],
    });
    await userEvent.click(await screen.findByRole("checkbox", LOCAL));
    expect(screen.getByText("LM Studio")).toBeInTheDocument();
    expect(screen.getByText("openai/gpt-oss-20b")).toBeInTheDocument();
    const row = screen.getByText("qwen3.6-27b").closest("li");
    expect(row?.textContent).toBe("qwen3.6-27b");
  });

  it("shows a size when the server does report one", async () => {
    // The other half of the rule above: "never invent one" must not have been
    // implemented as "never show one", which would silently drop a real size
    // the moment a server starts reporting it.
    renderStep({
      tools: {},
      servers: [serverListing("ollama", "Ollama", [{ id: "llama3", sizeBytes: 4_700_000_000 }])],
    });
    await userEvent.click(await screen.findByRole("checkbox", LOCAL));
    expect(screen.getByText(/4\.7 GB/)).toBeInTheDocument();
  });

  it("continues on a running server that actually holds a model", async () => {
    renderStep({
      tools: {},
      servers: [serverListing("lmstudio", "LM Studio", [{ id: "qwen3.6-27b", sizeBytes: null }])],
    });
    await userEvent.click(await screen.findByRole("checkbox", LOCAL));
    expect(screen.getByRole("button", CONTINUE)).toBeEnabled();
  });

  it("a server holding no models is not a usable source", async () => {
    // Step 2 asks which model to think with. A server answering with an empty
    // list has nothing to offer it, so passing this gate on the server's mere
    // presence walks the user into a dropdown with no options.
    renderStep({ tools: {}, servers: [serverListing("lmstudio", "LM Studio", [])] });
    await userEvent.click(await screen.findByRole("checkbox", LOCAL));
    expect(screen.getByRole("button", CONTINUE)).toBeDisabled();
    expect(screen.getByText(/isn't holding any models/i)).toBeInTheDocument();
  });

  // --- Back, and the host's write ------------------------------------------

  it("hands Back to the host, and never gates it behind Continue's own condition", async () => {
    // The user this matters for is the one Continue is disabled FOR: nothing is
    // usable, so the only way out of this gate is backwards.
    const onBack = vi.fn();
    const { onDone } = renderStep({ tools: { codex: { detected: false, failure: "missing" } }, onBack });

    const back = await screen.findByRole("button", { name: /back/i });
    expect(screen.getByRole("button", CONTINUE)).toBeDisabled();
    expect(back).toBeEnabled();

    await userEvent.click(back);
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onDone).not.toHaveBeenCalled();
  });

  it("makes Back inert while the host's own write is in flight, then live again", async () => {
    // `advance` moves the on-screen step immediately and lets its PUT run in the
    // background, so this step is clickable while the write that brought the
    // user here is unresolved. Both halves are needed: the first fails for a
    // Back that is never disabled, the second for one that is always disabled.
    const onBack = vi.fn();
    const { reportSaveState } = renderStep({
      tools: { codex: { detected: false, failure: "missing" } },
      onBack,
      saveState: "saving",
    });

    expect(await screen.findByRole("button", { name: /back/i })).toBeDisabled();

    reportSaveState("idle");
    const back = screen.getByRole("button", { name: /back/i });
    expect(back).toBeEnabled();
    await userEvent.click(back);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("leaves Back live when the host's write FAILED — that is the state a retreat is for", async () => {
    // A refused write is over: nothing is left to race, and this is exactly when
    // someone wants out. `"failed"` must not be lumped in with `"saving"` by a
    // guard that only checks "not idle".
    const onBack = vi.fn();
    renderStep({ tools: { codex: { detected: false, failure: "missing" } }, onBack, saveState: "failed" });

    const back = await screen.findByRole("button", { name: /back/i });
    expect(back).toBeEnabled();
    await userEvent.click(back);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("offers no Back when the host passes none", async () => {
    renderStep({ tools: { claude: {} } });
    await screen.findByRole("button", CONTINUE);
    expect(screen.queryByRole("button", { name: /back/i })).toBeNull();
  });

  it("leads the footer with Back, in DOM and so in tab order", async () => {
    renderStep({ tools: { claude: {} }, onBack: vi.fn() });
    await screen.findByRole("button", CONTINUE);
    const labels = screen.getAllByRole("button").map((b) => b.textContent);
    expect(labels.indexOf("Back")).toBeLessThan(labels.indexOf("Continue"));
  });

  it("ranks the footer: one filled pill, and it is Continue", async () => {
    // Back DECLINES the question; only Continue answers it. Shipped as two
    // identical full-width pills they read as a choice between equals, which
    // is what the user found walking the live app — and it is the same
    // inversion Task 8 of Plan 1 had already settled on the gate. jsdom cannot
    // measure weight, but it can hold what the weight rests on: the HeroUI
    // pill hook `[data-slot="button"]` appears exactly once in the footer, on
    // the primary, and Back carries the hand-styled quiet class instead.
    renderStep({ tools: { claude: {} }, onBack: vi.fn() });
    const back = await screen.findByRole("button", { name: "Back" });

    const footer = back.closest(".wizard-gate__footer");
    expect(footer).not.toBeNull();
    expect(back).toHaveClass("wizard-gate__quiet");
    const pills = footer?.querySelectorAll('[data-slot="button"]') ?? [];
    expect(pills).toHaveLength(1);
    expect(pills[0]).toHaveTextContent("Continue");
  });
});
