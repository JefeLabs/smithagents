import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BROKER_BASE, httpUrl } from "../api/origin";
import type { ApiKeyListing, BrainEngineRecord, CliToolListing } from "../api/types";
import { qk } from "../queries/keys";
import { renderWithProviders } from "../test/renderWithProviders";
import { WizardBrainStep } from "./WizardBrainStep";

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

const jsonResponse = (body: unknown) => ({ ok: true, json: async () => body }) as Response;

/**
 * The exact URL a save must go to. Host-aware on purpose: the earlier
 * `url.endsWith("/me/brain-engine")` matched ANY host, so this suite passed
 * identically whether the route existed on the broker (7790, where
 * `brokerFetch` sends it) or only on the swarm (7777, where it actually
 * lived) — which is precisely how a wizard that could never complete shipped
 * green. Matching the whole URL means a client re-pointed at another host
 * fails here instead of in a user's browser. The broker's own route arm is
 * covered where it belongs, in broker/src/text-channel.test.ts.
 */
const BRAIN_ENGINE_URL = httpUrl("/me/brain-engine");

/** Stubs the one PUT /me/brain-engine route this component's saves ever hit. */
function stubSave(respond: unknown) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === BRAIN_ENGINE_URL && init?.method === "PUT") return jsonResponse(respond);
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** Mirrors WizardSubscriptionsStep.test.tsx's toolListing — only `active` matters here. */
function toolListing(cli: string, over: Partial<CliToolListing> = {}): CliToolListing {
  return { cli, label: cli, models: [], warmSessions: true, status: null, active: true, ...over };
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

function renderBrainStep(opts: {
  tools: Record<string, Partial<CliToolListing>>;
  keys?: Array<{ provider: string; verified: boolean | "unknown" | null }>;
  current?: BrainEngineRecord | null;
}) {
  stubNoNetwork();
  const onDone = vi.fn();
  const result = renderWithProviders(<WizardBrainStep onDone={onDone} />);
  result.client.setQueryData<CliToolListing[]>(
    qk.cliTools,
    Object.entries(opts.tools).map(([cli, over]) => toolListing(cli, over)),
  );
  result.client.setQueryData<ApiKeyListing[]>(
    qk.apiKeys,
    (opts.keys ?? []).map((k) => keyListing(k.provider, { verified: k.verified })),
  );
  result.client.setQueryData<BrainEngineRecord | null>(qk.brainEngine, opts.current ?? null);
  return { ...result, onDone };
}

describe("WizardBrainStep", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("defaults to the strongest validated option, so the step is a confirmation", async () => {
    renderBrainStep({ tools: { claude: { active: true } }, keys: [{ provider: "anthropic", verified: true }] });
    expect(await screen.findByRole("radio", { name: /claude/i })).toBeChecked();
  });

  it("offers a verified API key when no CLI can back the brain", async () => {
    renderBrainStep({ tools: {}, keys: [{ provider: "gemini", verified: true }] });
    expect(await screen.findByRole("radio", { name: /gemini/i })).toBeEnabled();
  });

  it("does not offer an unverified key as if it worked", async () => {
    // reality-before-preference, the same rule ApiKeysGroup and
    // ResearchEngineGroup already apply — an unverified key is stored, not
    // proven, and offering it as a checked/selectable option would claim
    // more than is true. A verified sibling forces the render past the
    // "nothing to pick" branch, so the absence below is a real filter proof
    // rather than an assertion that would also pass before the cache seeds.
    renderBrainStep({
      tools: {},
      keys: [
        { provider: "anthropic", verified: "unknown" },
        { provider: "gemini", verified: true },
      ],
    });
    expect(await screen.findByRole("radio", { name: /gemini/i })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /anthropic/i })).toBeNull();
  });

  it("surfaces the server's refusal rather than hiding the option", async () => {
    // buildBrainEngineUpdate refuses some engines with a reason. Silently omitting
    // them leaves the user unable to learn why their tool isn't offered.
    renderBrainStep({ tools: { codex: { active: true } } });
    await userEvent.click(await screen.findByRole("radio", { name: /codex/i }));
    stubSave({ error: "Codex is not supported as a brain yet — only Claude Code enforces --json-schema" });
    await userEvent.click(screen.getByRole("button", { name: /continue/i }));
    expect(await screen.findByText(/claude|--json-schema/i)).toBeInTheDocument();
  });

  it("a refused save keeps the picked option selected, not lost to a remount", async () => {
    // Plan 1's named precondition: the host rolls a rejected step back to a
    // remounted component with only its original prop. This step never even
    // reaches that path on a refusal (onDone is not called), so the pick —
    // still local state on the same mounted component — survives untouched.
    renderBrainStep({ tools: { codex: { active: true } } });
    await userEvent.click(await screen.findByRole("radio", { name: /codex/i }));
    stubSave({ error: "Codex is not supported as a brain yet — only Claude Code enforces --json-schema" });
    await userEvent.click(screen.getByRole("button", { name: /continue/i }));
    await screen.findByText(/claude|--json-schema/i);
    expect(screen.getByRole("radio", { name: /codex/i })).toBeChecked();
  });

  it("a successful save advances the wizard without re-deciding anything for the host", async () => {
    const { onDone } = renderBrainStep({ tools: { claude: { active: true } } });
    stubSave({ kind: "cli", provider: "claude" });
    await userEvent.click(await screen.findByRole("radio", { name: /claude/i }));
    await userEvent.click(screen.getByRole("button", { name: /continue/i }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith({ setup: {} }));
  });

  it("continue still advances when nothing can back the brain — Anderson has a safe fallback", async () => {
    const { onDone } = renderBrainStep({ tools: {} });
    await userEvent.click(await screen.findByRole("button", { name: /continue/i }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith({ setup: {} }));
  });

  it("saves to the BROKER base — the host that has to own the route", async () => {
    // Asserted, not assumed: the route existed only on the swarm while the
    // client sent here, and nothing in this suite could tell the difference.
    // If a later change re-points this call at another host, this fails here
    // rather than stranding a fresh install in the wizard.
    renderBrainStep({ tools: { claude: { active: true } } });
    const fetchSpy = stubSave({ kind: "cli", provider: "claude" });
    await userEvent.click(await screen.findByRole("radio", { name: /claude/i }));
    await userEvent.click(screen.getByRole("button", { name: /continue/i }));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(BRAIN_ENGINE_URL);
    expect(BRAIN_ENGINE_URL).toContain(BROKER_BASE);
  });

  it("a user whose ONLY option the server refuses can still finish the step", async () => {
    // The discriminating case the empty-tools test above cannot reach: a
    // codex-only install passes the Subscriptions step on its one active CLI,
    // then Brain offers exactly that one candidate, pre-checked, and the
    // server refuses it. RadioButtonGroup has no deselect, there is no second
    // candidate and no Back — without an escape here the wizard is impassable
    // and the app never opens. "Nothing working is a stop, but never a dead
    // end" (plan Global Constraint).
    const { onDone } = renderBrainStep({ tools: { codex: { active: true } } });
    await userEvent.click(await screen.findByRole("radio", { name: /codex/i }));
    stubSave({ error: "Codex is not supported as a brain yet — only Claude Code enforces --json-schema" });
    await userEvent.click(screen.getByRole("button", { name: /continue/i }));
    await screen.findByText(/--json-schema/i);
    await userEvent.click(screen.getByRole("button", { name: /skip for now/i }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith({ setup: {} }));
  });

  it("the refusal stays on screen next to the escape — the user learns why, then moves on", async () => {
    const { onDone } = renderBrainStep({ tools: { codex: { active: true } } });
    await userEvent.click(await screen.findByRole("radio", { name: /codex/i }));
    stubSave({ error: "Codex is not supported as a brain yet — only Claude Code enforces --json-schema" });
    await userEvent.click(screen.getByRole("button", { name: /continue/i }));
    const refusal = await screen.findByText(/--json-schema/i);
    expect(screen.getByRole("button", { name: /skip for now/i })).toBeInTheDocument();
    expect(refusal).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("a network failure opens the same escape — brokerFetch rejects there instead of resolving with {error}", async () => {
    // The two failure shapes are NOT interchangeable: brokerFetch never throws
    // on a non-2xx, so a server refusal RESOLVES with `{error}` while a dead
    // broker REJECTS. Both must leave the user a way out; only the first is
    // covered by the test above.
    const { onDone } = renderBrainStep({ tools: { codex: { active: true } } });
    await userEvent.click(await screen.findByRole("radio", { name: /codex/i }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("Failed to fetch");
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: /continue/i }));
    await screen.findByText(/failed to fetch/i);
    await userEvent.click(screen.getByRole("button", { name: /skip for now/i }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith({ setup: {} }));
  });

  it("offers no escape before anything has failed — the step is still a confirmation, not a skip", async () => {
    renderBrainStep({ tools: { claude: { active: true } } });
    await screen.findByRole("radio", { name: /claude/i });
    expect(screen.queryByRole("button", { name: /skip for now/i })).toBeNull();
  });
});
