import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiKeyListing, CliToolListing, EnginesRecord, LocalServer, MachineFacts } from "../api/types";
import type { WizardSaveState } from "../lib/wizardSteps";
import { qk } from "../queries/keys";
import { renderWithProviders } from "../test/renderWithProviders";
import { WizardRolesStep } from "./WizardRolesStep";

/** Mirrors `isActive` (swarm/src/cli-tools.ts) as fixture math only — block
 *  confirmed negatives, `authOk: "unknown"` counts as active. Same helper, same
 *  reasoning, as WizardSourcesStep's suite. */
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
    label: cli === "claude" ? "Claude Code" : cli,
    models: [],
    warmSessions: true,
    status,
    active: status.detected && status.enabled !== false && status.authOk !== false,
  };
}

const KEY_LABELS: Record<string, string> = { anthropic: "Anthropic", google: "Google", openai: "OpenAI" };

function keyListing(id: string, verified: ApiKeyListing["verified"]): ApiKeyListing {
  return {
    id,
    label: KEY_LABELS[id] ?? id,
    description: "",
    hasKey: true,
    last4: "0000",
    verified,
    detail: null,
    lastCheckedAt: null,
  };
}

function serverListing(id: string, label: string, models: LocalServer["models"]): LocalServer {
  return { id, label, baseUrl: `http://127.0.0.1:${id === "ollama" ? 11434 : 1234}`, models };
}

/** 96 GiB — this machine's real `os.totalmem()`, per Task 1's live check. */
const NINETY_SIX_GB = 103_079_215_104;
/** 32 GiB — the number the spec's own example sentence uses. */
const THIRTY_TWO_GB = 34_359_738_368;

interface StepOpts {
  tools?: Record<string, Partial<NonNullable<CliToolListing["status"]>>>;
  keys?: Array<[string, ApiKeyListing["verified"]]>;
  servers?: LocalServer[];
  /** Seeded only when given — an absent machine probe must omit the RAM line, not guess. */
  machine?: MachineFacts;
  /** What GET /me/engines already holds, i.e. resuming this step. */
  stored?: EnginesRecord;
  onBack?: () => void;
  saveState?: WizardSaveState;
  /** What the PUT resolves to. `"refuse"` = the swarm's firm no; `"reject"` = a network failure. */
  save?: "ok" | "refuse" | "reject";
}

const REFUSAL = "Antigravity is not supported as a brain yet — only Claude Code enforces --json-schema";

function renderStep(opts: StepOpts = {}) {
  const puts: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method !== "PUT") throw new Error("no network in this test");
      puts.push(JSON.parse(String(init.body)));
      if (opts.save === "reject") throw new Error("Failed to fetch");
      return {
        ok: opts.save !== "refuse",
        status: opts.save === "refuse" ? 400 : 200,
        json: async () => (opts.save === "refuse" ? { error: REFUSAL } : { main: null, quick: null, fallback: null }),
      } as unknown as Response;
    }),
  );
  const onDone = vi.fn();
  const element = (saveState: WizardSaveState) => (
    <WizardRolesStep onDone={onDone} onBack={opts.onBack} saveState={saveState} />
  );
  const result = renderWithProviders(element(opts.saveState ?? "idle"));
  result.client.setQueryData<CliToolListing[]>(
    qk.cliTools,
    Object.entries(opts.tools ?? { claude: {} }).map(([cli, over]) => toolListing(cli, over)),
  );
  result.client.setQueryData<ApiKeyListing[]>(
    qk.apiKeys,
    (opts.keys ?? []).map(([id, verified]) => keyListing(id, verified)),
  );
  result.client.setQueryData<LocalServer[]>(qk.localModels, opts.servers ?? []);
  if (opts.machine) result.client.setQueryData<MachineFacts>(qk.machine, opts.machine);
  result.client.setQueryData<EnginesRecord>(qk.engines, opts.stored ?? { main: null, quick: null, fallback: null });
  return {
    ...result,
    onDone,
    puts,
    reportSaveState: (saveState: WizardSaveState) => result.rerender(element(saveState)),
  };
}

const MAIN = "My main brain";
const QUICK = "Quick little things";
const FALLBACK = "If something's unavailable";
const ROLES = [MAIN, QUICK, FALLBACK] as const;
const NOTHING = "nothing — I'll just tell you";
// Exact names, not /continue/i: the escape button's label CONTAINS "Continue",
// so a loose matcher goes ambiguous the moment a save fails — and would do it
// in whichever test happened to be looking, not the one that cares.
const CONTINUE = "Continue";
const ESCAPE = "Continue without setting these";

/** Every option the named dropdown offers, in order, by its exact rendered text. */
function optionsOf(role: string): string[] {
  return within(screen.getByRole("combobox", { name: role }))
    .getAllByRole("option")
    .map((o) => o.textContent ?? "");
}

/** Scoped to the named dropdown — all three offer the same option labels. */
function pick(role: string, label: string) {
  const select = screen.getByRole("combobox", { name: role });
  return userEvent.selectOptions(select, within(select).getByRole("option", { name: label }));
}

describe("WizardRolesStep", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  // --- The spec's own copy -------------------------------------------------

  it("asks the spec's question, at h2 — the page's h1 is the host's", async () => {
    renderStep();
    expect(await screen.findByRole("heading", { level: 2 })).toHaveTextContent(
      /^Which of these should I use, and for what\?$/,
    );
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
  });

  it("names the three roles in the spec's words", async () => {
    renderStep();
    for (const role of ROLES) expect(await screen.findByRole("combobox", { name: role })).toBeInTheDocument();
  });

  it('the fallback\'s "nothing" is a real option, and what is selected before the user answers', async () => {
    renderStep();
    const fallback = await screen.findByRole("combobox", { name: FALLBACK });
    expect(within(fallback).getByRole("option", { name: NOTHING })).toBeInTheDocument();
    expect(fallback).toHaveValue("none");
  });

  // --- Only what the server will accept ------------------------------------

  it("offers exactly what the server accepts — a refusable option never appears in ANY dropdown", async () => {
    // codex/opencode/agy are installed and signed in, and an OpenAI key is
    // genuinely verified. Every one of them is refused by the swarm for every
    // role (BRAIN_CLI_ALLOWLIST is claude alone; API_BRAIN_PROVIDERS is
    // anthropic/gemini), and offering a refusable option is what trapped a
    // codex-only user in the step this replaces.
    //
    // Asserted as the WHOLE list rather than as the absence of names this test
    // happened to think of: a `queryByText` per villain proves nothing about
    // the one nobody listed, and would also pass an implementation that offered
    // nothing at all.
    renderStep({
      tools: { claude: {}, codex: {}, opencode: {}, agy: {} },
      keys: [
        ["openai", true],
        ["anthropic", true],
      ],
    });
    await screen.findByRole("combobox", { name: MAIN });
    expect(optionsOf(MAIN)).toEqual(["claude (login)", "Anthropic (key)"]);
    expect(optionsOf(QUICK)).toEqual(["claude (login)", "Anthropic (key)"]);
    // The fallback offers the same set plus its own "nothing" — the extra
    // entry is a value, not an origin.
    expect(optionsOf(FALLBACK)).toEqual([NOTHING, "claude (login)", "Anthropic (key)"]);
  });

  it("a key that is not VERIFIED is not offered — stored is not the same as working", async () => {
    for (const state of [null, false, "unknown"] as const) {
      renderStep({ tools: { claude: {} }, keys: [["anthropic", state]] });
      await screen.findByRole("combobox", { name: MAIN });
      expect(optionsOf(MAIN), `verified: ${String(state)}`).toEqual(["claude (login)"]);
      cleanup();
    }
  });

  it("an inactive login is not offered", async () => {
    renderStep({ tools: { claude: { authOk: false } }, keys: [["anthropic", true]] });
    await screen.findByRole("combobox", { name: MAIN });
    expect(optionsOf(MAIN)).toEqual(["Anthropic (key)"]);
  });

  it("a verified GOOGLE key offers the brain provider the server actually names — gemini", async () => {
    // The registry's provider ids are anthropic/openai/google; the swarm's
    // API_BRAIN_PROVIDERS are anthropic/gemini. The step this replaces looked
    // for a key whose id was "gemini", which the registry has never had, so a
    // verified Google key silently offered nothing. The mapping is the fix.
    const { puts } = renderStep({ tools: {}, keys: [["google", true]] });
    await screen.findByRole("combobox", { name: MAIN });
    expect(optionsOf(MAIN)).toEqual(["Google (key)"]);
    await userEvent.click(screen.getByRole("button", { name: CONTINUE }));
    expect((puts[0] as { main: unknown }).main).toEqual({ kind: "api", provider: "gemini" });
  });

  // --- Mixed, not grouped --------------------------------------------------

  it("lists all configured sources together in ONE flat list — never grouped by origin", async () => {
    renderStep({
      tools: { claude: {} },
      keys: [["anthropic", true]],
      servers: [serverListing("lmstudio", "LM Studio", [{ id: "qwen3.6-27b", sizeBytes: null }])],
    });
    await screen.findByRole("combobox", { name: MAIN });
    for (const role of ROLES) {
      const select = screen.getByRole("combobox", { name: role });
      expect(select.querySelectorAll("optgroup"), `${role} groups its options`).toHaveLength(0);
    }
    expect(optionsOf(MAIN)).toEqual(["claude (login)", "Anthropic (key)", "qwen3.6-27b (local)"]);
  });

  // --- Local picks show size, when there IS a size -------------------------

  it("a local model whose size the server does not report shows its name and NOTHING else", async () => {
    // Every real `sizeBytes` is null today — the OpenAI-compatible /v1/models
    // does not carry one. The assertion is on the option's WHOLE text, not on
    // the absence of a guessed spelling of a wrong answer: a suite that asserts
    // `queryByText(/0 B|NaN/)` is null lets "0 MB" through, which is exactly
    // what happened one task ago.
    renderStep({
      tools: {},
      servers: [serverListing("lmstudio", "LM Studio", [{ id: "qwen3.6-27b", sizeBytes: null }])],
    });
    await screen.findByRole("combobox", { name: MAIN });
    expect(optionsOf(MAIN)).toEqual(["qwen3.6-27b (local)"]);
  });

  it("a local model whose size IS reported shows it", async () => {
    renderStep({
      tools: {},
      servers: [serverListing("ollama", "Ollama", [{ id: "llama3:8b", sizeBytes: 4_700_000_000 }])],
    });
    await screen.findByRole("combobox", { name: MAIN });
    expect(optionsOf(MAIN)).toEqual(["llama3:8b — 4.7 GB (local)"]);
  });

  it("shows no download progress, because no download was started", async () => {
    renderStep({
      tools: {},
      servers: [serverListing("lmstudio", "LM Studio", [{ id: "qwen3.6-27b", sizeBytes: null }])],
    });
    await screen.findByRole("combobox", { name: MAIN });
    expect(screen.queryAllByRole("progressbar")).toHaveLength(0);
  });

  // --- The RAM line: advice, never a gate ----------------------------------

  it("says how much RAM this machine has, in the spec's sentence", async () => {
    renderStep({ machine: { totalMemBytes: THIRTY_TWO_GB } });
    expect(
      await screen.findByText("You've got 32GB of RAM, so I've leaned toward models that'll feel quick."),
    ).toBeInTheDocument();
    cleanup();
    renderStep({ machine: { totalMemBytes: NINETY_SIX_GB } });
    expect(
      await screen.findByText("You've got 96GB of RAM, so I've leaned toward models that'll feel quick."),
    ).toBeInTheDocument();
  });

  it("omits the sentence entirely when the machine probe has not answered — never a guessed number", async () => {
    renderStep();
    await screen.findByRole("combobox", { name: MAIN });
    // /of RAM/ rather than a guess at the wrong number's spelling: it catches
    // "0GB", "undefinedGB" and "NaNGB" alike, because all three still say it.
    expect(screen.queryByText(/of RAM/)).toBeNull();
  });

  it("continues perfectly well with no RAM figure — advice, not a gate", async () => {
    const { onDone, puts } = renderStep({ tools: { claude: {} } });
    await screen.findByRole("combobox", { name: MAIN });
    await userEvent.click(screen.getByRole("button", { name: CONTINUE }));
    expect(puts).toHaveLength(1);
    expect(onDone).toHaveBeenCalledWith({ setup: {} });
  });

  // --- Saving: every role explicit, every time -----------------------------

  it("sends all three roles as PRESENT keys — an omitted one would keep the old answer", async () => {
    const { puts } = renderStep({
      tools: { claude: {} },
      keys: [["anthropic", true]],
      servers: [serverListing("lmstudio", "LM Studio", [{ id: "qwen3.6-27b", sizeBytes: null }])],
    });
    await screen.findByRole("combobox", { name: MAIN });
    await pick(QUICK, "qwen3.6-27b (local)");
    await pick(FALLBACK, "Anthropic (key)");
    await userEvent.click(screen.getByRole("button", { name: CONTINUE }));
    expect(puts[0]).toEqual({
      main: { kind: "cli", provider: "claude" },
      quick: { kind: "local", provider: "lmstudio", baseUrl: "http://127.0.0.1:1234", model: "qwen3.6-27b" },
      fallback: { kind: "api", provider: "anthropic" },
    });
  });

  it('"nothing" is SENT, not omitted — the flip that would otherwise keep the old engine', async () => {
    // The bug class this closes is the voice-flip one this codebase already
    // fixed once. The save merges server-side, so a user who picks a fallback,
    // then changes their mind to "nothing", and whose change is recorded as an
    // absent field, keeps the engine they just rejected.
    const { puts } = renderStep({
      tools: { claude: {} },
      keys: [["anthropic", true]],
      stored: { main: null, quick: null, fallback: { kind: "api", provider: "anthropic" } },
    });
    await screen.findByRole("combobox", { name: FALLBACK });
    expect(screen.getByRole("combobox", { name: FALLBACK })).toHaveValue("api:anthropic");
    await pick(FALLBACK, NOTHING);
    await userEvent.click(screen.getByRole("button", { name: CONTINUE }));
    const body = puts[0] as Record<string, unknown>;
    expect("fallback" in body).toBe(true);
    expect(body.fallback).toBeNull();
  });

  it("the quick role follows the main brain until it is answered — and is still sent explicitly", async () => {
    const { puts } = renderStep({ tools: { claude: {} }, keys: [["anthropic", true]] });
    await screen.findByRole("combobox", { name: MAIN });
    await pick(MAIN, "Anthropic (key)");
    expect(screen.getByRole("combobox", { name: QUICK })).toHaveValue("api:anthropic");
    await userEvent.click(screen.getByRole("button", { name: CONTINUE }));
    expect((puts[0] as { quick: unknown }).quick).toEqual({ kind: "api", provider: "anthropic" });
  });

  it("a stored answer is what the step resumes to", async () => {
    renderStep({
      tools: { claude: {} },
      keys: [["anthropic", true]],
      stored: {
        main: { kind: "api", provider: "anthropic" },
        quick: { kind: "cli", provider: "claude" },
        fallback: null,
      },
    });
    await screen.findByRole("combobox", { name: MAIN });
    expect(screen.getByRole("combobox", { name: MAIN })).toHaveValue("api:anthropic");
    expect(screen.getByRole("combobox", { name: QUICK })).toHaveValue("cli:claude");
    expect(screen.getByRole("combobox", { name: FALLBACK })).toHaveValue("none");
  });

  it("hands the step over only once the save has landed — never before", async () => {
    // The half that matters is the NEGATIVE one: an implementation that calls
    // onDone first and saves in the background passes the positive assertion
    // exactly as well, and would walk the user off a screen whose write is
    // about to be refused. The hanging stub is what tells the two apart.
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) =>
        init?.method === "PUT" ? new Promise<Response>(() => {}) : Promise.reject(new Error("no network")),
      ),
    );
    const pending = vi.fn();
    const { client } = renderWithProviders(<WizardRolesStep onDone={pending} />);
    client.setQueryData<CliToolListing[]>(qk.cliTools, [toolListing("claude")]);
    client.setQueryData<ApiKeyListing[]>(qk.apiKeys, []);
    client.setQueryData<LocalServer[]>(qk.localModels, []);
    client.setQueryData<EnginesRecord>(qk.engines, { main: null, quick: null, fallback: null });
    await screen.findByRole("combobox", { name: MAIN });
    await userEvent.click(screen.getByRole("button", { name: CONTINUE }));
    expect(pending).not.toHaveBeenCalled();
    cleanup();

    const { onDone } = renderStep({ tools: { claude: {} } });
    await screen.findByRole("combobox", { name: MAIN });
    await userEvent.click(screen.getByRole("button", { name: CONTINUE }));
    expect(onDone).toHaveBeenCalledWith({ setup: {} });
  });

  // --- Never a dead end ----------------------------------------------------

  it("a REFUSED save shows the server's own sentence and does not move on", async () => {
    const { onDone } = renderStep({ tools: { claude: {} }, save: "refuse" });
    await screen.findByRole("combobox", { name: MAIN });
    await userEvent.click(screen.getByRole("button", { name: CONTINUE }));
    expect(await screen.findByText(REFUSAL)).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("a REJECTED save says so too — brokerFetch only throws on a network failure", async () => {
    renderStep({ tools: { claude: {} }, save: "reject" });
    await screen.findByRole("combobox", { name: MAIN });
    await userEvent.click(screen.getByRole("button", { name: CONTINUE }));
    expect(await screen.findByText(/Failed to fetch/)).toBeInTheDocument();
  });

  it("after a failed save there is still a way out, and it reaches the app", async () => {
    // Filtering removes the CAUSE of the dead end that trapped a codex-only
    // user, but a server can still refuse at save time — a broker that is down,
    // a cli logged out between the probe and the click. Without this the user
    // is on a wizard step whose only forward action fails every time.
    const { onDone } = renderStep({ tools: { claude: {} }, save: "refuse" });
    await screen.findByRole("combobox", { name: MAIN });
    expect(screen.queryByRole("button", { name: ESCAPE })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: CONTINUE }));
    await userEvent.click(await screen.findByRole("button", { name: ESCAPE }));
    expect(onDone).toHaveBeenCalledWith({ setup: {} });
  });

  it("nothing to pick is not a dead end either", async () => {
    const { onDone, puts } = renderStep({ tools: { claude: { detected: false } } });
    expect(
      await screen.findByText(
        "Nothing validated yet to pick from — I'll fall back to a built-in default until you add a CLI or key.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: CONTINUE }));
    // Nothing to save, so nothing is sent — but the step still hands over.
    expect(puts).toHaveLength(0);
    expect(onDone).toHaveBeenCalledWith({ setup: {} });
  });

  // --- The in-flight guards ------------------------------------------------

  it("Back is inert only while the host's write is actually in flight", async () => {
    const onBack = vi.fn();
    const { reportSaveState } = renderStep({ tools: { claude: {} }, onBack, saveState: "saving" });
    const back = await screen.findByRole("button", { name: "Back" });
    expect(back).toBeDisabled();
    // "failed" is a write that is OVER and did not land — nothing left to race,
    // and a footer that stays shut past that point is the worse dead end.
    reportSaveState("failed");
    expect(screen.getByRole("button", { name: "Back" })).toBeEnabled();
  });

  it("Continue cannot be clicked twice into the same save", async () => {
    // The stub never settles, so the first click leaves the save in flight.
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) =>
        init?.method === "PUT" ? new Promise<Response>(() => {}) : Promise.reject(new Error("no network")),
      ),
    );
    const onDone = vi.fn();
    const { client } = renderWithProviders(<WizardRolesStep onDone={onDone} />);
    client.setQueryData<CliToolListing[]>(qk.cliTools, [toolListing("claude")]);
    client.setQueryData<ApiKeyListing[]>(qk.apiKeys, []);
    client.setQueryData<LocalServer[]>(qk.localModels, []);
    client.setQueryData<EnginesRecord>(qk.engines, { main: null, quick: null, fallback: null });
    await screen.findByRole("combobox", { name: MAIN });
    const button = screen.getByRole("button", { name: CONTINUE });
    await userEvent.click(button);
    expect(button).toBeDisabled();
  });
});
