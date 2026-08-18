import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiKeyListing, CliToolListing } from "../api/types";
import type { WizardSaveState } from "../lib/wizardSteps";
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
  /** Passed through so this side of the host's Back prop is covered too — the
      host's own suite covers the other side. */
  onBack?: () => void;
  /** The host's own write state. Defaults to the resting one. */
  saveState?: WizardSaveState;
}) {
  stubNoNetwork();
  const onDone = vi.fn();
  const element = (saveState: WizardSaveState) => (
    <WizardSubscriptionsStep onDone={onDone} onBack={opts.onBack} saveState={saveState} />
  );
  const result = renderWithProviders(element(opts.saveState ?? "idle"));
  result.client.setQueryData<CliToolListing[]>(
    qk.cliTools,
    Object.entries(opts.tools).map(([cli, over]) => toolListing(cli, over)),
  );
  result.client.setQueryData<ApiKeyListing[]>(
    qk.apiKeys,
    (opts.keys ?? []).map((k) => keyListing(k.provider, { verified: k.verified })),
  );
  return {
    ...result,
    onDone,
    /** What the host does when its own write settles. */
    reportSaveState: (saveState: WizardSaveState) => result.rerender(element(saveState)),
  };
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

  it("hands Back to the host, and never gates it behind Continue's own condition", async () => {
    // The user this matters for is the one Continue is disabled FOR: nothing
    // validates, so the only way out of this gate is backwards.
    const onBack = vi.fn();
    const { onDone } = renderStep({ tools: { codex: { detected: false, failure: "missing" } }, onBack });

    const back = await screen.findByRole("button", { name: /back/i });
    expect(screen.getByRole("button", { name: /continue/i })).toBeDisabled();
    expect(back).toBeEnabled();

    await userEvent.click(back);
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onDone).not.toHaveBeenCalled();
  });

  it("makes Back inert while the host's own write is in flight, so it cannot race it", async () => {
    // The window: `advance` moves the on-screen step IMMEDIATELY and lets its
    // PUT run in the background, so this step is on screen and clickable while
    // the write that brought the user here — PUT {mode, step:"subscriptions"} —
    // is still unresolved. A Back clicked in it fires PUT {step:"preflight"}
    // against that write, and if the two land out of order the server holds
    // `subscriptions` while the screen shows preflight: the next reload
    // silently undoes the Back. Same window the last step's `handedOff` was
    // added to close, one step earlier, and the same mechanism closes it.
    //
    // Both halves are needed: the first fails for a Back that is never
    // disabled, the second for one that is simply always disabled.
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
    // A refused or rejected write is over: there is nothing left to race, and
    // this is exactly the moment someone wants out. `"failed"` must not be
    // lumped in with `"saving"` by a guard that only checks "not idle".
    const onBack = vi.fn();
    renderStep({ tools: { codex: { detected: false, failure: "missing" } }, onBack, saveState: "failed" });

    const back = await screen.findByRole("button", { name: /back/i });
    expect(back).toBeEnabled();
    await userEvent.click(back);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("offers no Back when the host passes none", async () => {
    renderStep({ tools: { claude: { detected: true, authOk: true, enabled: true } } });
    await screen.findByRole("button", { name: /continue/i });
    expect(screen.queryByRole("button", { name: /back/i })).toBeNull();
  });

  it("leads the footer with Back, in DOM and so in tab order", async () => {
    renderStep({ tools: { claude: { detected: true, authOk: true, enabled: true } }, onBack: vi.fn() });
    await screen.findByRole("button", { name: /continue/i });

    const labels = screen.getAllByRole("button").map((b) => b.textContent);
    expect(labels.indexOf("Back")).toBeLessThan(labels.indexOf("Continue"));
  });
});
