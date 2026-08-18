import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiKeyListing, CliToolListing } from "../api/types";
import { qk } from "../queries/keys";
import { renderWithProviders } from "../test/renderWithProviders";
import { WizardSubscriptionsStep } from "./WizardSubscriptionsStep";

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
    lastCheckedAt: "2026-08-17T00:00:00.000Z",
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

function renderStep(opts: {
  tools: Record<string, Partial<NonNullable<CliToolListing["status"]>>>;
  keys?: Array<{ provider: string; verified: boolean | "unknown" | null }>;
}) {
  stubNoNetwork();
  const onDone = vi.fn();
  const result = renderWithProviders(<WizardSubscriptionsStep onDone={onDone} />);
  result.client.setQueryData<CliToolListing[]>(
    qk.cliTools,
    Object.entries(opts.tools).map(([cli, over]) => toolListing(cli, over)),
  );
  result.client.setQueryData<ApiKeyListing[]>(
    qk.apiKeys,
    (opts.keys ?? []).map((k) => keyListing(k.provider, { verified: k.verified })),
  );
  return { ...result, onDone };
}

describe("WizardSubscriptionsStep", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("the wizard step cannot continue while nothing validates", async () => {
    renderStep({ tools: { codex: { detected: false, failure: "missing" } } });
    expect(await screen.findByRole("button", { name: /continue/i })).toBeDisabled();
  });

  it("one working tool unblocks continue", async () => {
    renderStep({ tools: { claude: { detected: true, authOk: true, enabled: true } } });
    expect(await screen.findByRole("button", { name: /continue/i })).toBeEnabled();
  });

  it("a verified API key unblocks continue with no CLI at all", async () => {
    // The spec's second route out. Someone with no CLIs must still get past this step.
    renderStep({ tools: {}, keys: [{ provider: "anthropic", verified: true }] });
    expect(await screen.findByRole("button", { name: /continue/i })).toBeEnabled();
  });

  it("an unverified key alone does not unblock continue", async () => {
    // Distinguishes "a key is stored" from "a key actually works" — the same
    // reality-before-preference rule the CLI side already applies.
    renderStep({ tools: {}, keys: [{ provider: "anthropic", verified: "unknown" }] });
    expect(await screen.findByRole("button", { name: /continue/i })).toBeDisabled();
  });

  it("clicking an enabled continue advances the wizard", async () => {
    const { onDone } = renderStep({ tools: { claude: { detected: true, authOk: true, enabled: true } } });
    await userEvent.click(await screen.findByRole("button", { name: /continue/i }));
    expect(onDone).toHaveBeenCalledOnce();
  });

  it("a disabled continue is genuinely unclickable, not just visually dimmed", async () => {
    // The disabled-Continue trap this project has hit twice: `aria-disabled`
    // alone leaves a control keyboard-reachable and activatable under this
    // stylesheet. `toBeDisabled()` checks the real `disabled` IDL property,
    // and user-event v14 no-ops a click on a genuinely disabled element the
    // same way a real browser would — so the click below is the actual proof,
    // not the attribute check alone.
    const { onDone } = renderStep({ tools: { codex: { detected: false, failure: "missing" } } });
    const button = await screen.findByRole("button", { name: /continue/i });
    expect(button).toBeDisabled();

    await userEvent.click(button);
    expect(onDone).not.toHaveBeenCalled();
  });

  it("copilot and agy's permanent 'unknown' auth still counts as a working tool", async () => {
    // Task 2's investigated conclusion: copilot has no probe beyond an OAuth
    // browser flow, agy has no auth command at all — both ALWAYS report
    // authOk: 'unknown'. 'unknown' is active (block only confirmed
    // negatives), so this must not permanently strand a copilot/agy-only
    // install on this step.
    renderStep({ tools: { copilot: { detected: true, authOk: "unknown", enabled: true } } });
    expect(await screen.findByRole("button", { name: /continue/i })).toBeEnabled();
  });

  it("borrows the permanent CliToolsGroup, guidance included, not a wizard-only clone", async () => {
    renderStep({
      tools: {
        codex: { detected: false, failure: "missing" },
        claude: { detected: true, authOk: true, enabled: true },
      },
    });
    // Same class-aware guidance CliToolsGroup renders in Settings — proves
    // this step is the real screen, not a re-implementation. (No link: per
    // Edwin's ruling, `missing` names the problem and stops — see
    // CliToolsGroup.tsx's guidanceFor.)
    expect(await screen.findByText(/install codex/i)).toBeInTheDocument();
  });
});
