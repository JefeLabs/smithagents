import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliToolListing } from "../../api/types";
import { qk } from "../../queries/keys";
import { renderWithProviders } from "../../test/renderWithProviders";
import { CliToolsGroup, guidanceFor, pillFor } from "./CliToolsGroup";

const listing = (status: CliToolListing["status"], active = false): CliToolListing => ({
  cli: "claude",
  label: "Claude Code",
  models: ["claude-opus"],
  warmSessions: true,
  status,
  active,
});

const st = (over: Partial<NonNullable<CliToolListing["status"]>> = {}) => ({
  detected: true,
  authOk: true as const,
  enabled: true,
  detail: "",
  lastCheckedAt: "2026-08-06T00:00:00.000Z",
  ...over,
});

describe("pillFor — precedence: reality before preference (spec §6)", () => {
  it("null status -> not checked", () => {
    expect(pillFor(listing(null, true)).label).toBe("not checked");
  });
  it("not installed beats everything, even disabled", () => {
    expect(pillFor(listing(st({ detected: false, enabled: false }))).label).toBe("not installed");
  });
  it("needs login beats disabled", () => {
    expect(pillFor(listing(st({ authOk: false, enabled: false }))).label).toBe("needs login");
  });
  it("disabled when only the toggle is off", () => {
    expect(pillFor(listing(st({ enabled: false }))).label).toBe("disabled");
  });
  it("active otherwise, including authOk unknown", () => {
    expect(pillFor(listing(st(), true)).label).toBe("active");
    expect(pillFor(listing(st({ authOk: "unknown" }), true)).label).toBe("active");
  });
});

/** A live broker really listens on 127.0.0.1:7790 — throw by default so an
 * un-stubbed route fails loudly, matching ApiKeysGroup.test.tsx's own copy. */
function stubNoNetwork() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("no network in this test");
    }),
  );
}

const toolListing = (cli: string, over: Partial<NonNullable<CliToolListing["status"]>> = {}): CliToolListing => ({
  cli,
  label: cli,
  models: [],
  warmSessions: true,
  status: st(over),
  active: false,
});

function renderCliTools(opts: { tools: Record<string, Partial<NonNullable<CliToolListing["status"]>>> }) {
  stubNoNetwork();
  const result = renderWithProviders(<CliToolsGroup />);
  result.client.setQueryData<CliToolListing[]>(
    qk.cliTools,
    Object.entries(opts.tools).map(([cli, over]) => toolListing(cli, over)),
  );
  return result;
}

describe("CliToolsGroup", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("a load rejection surfaces a visible error instead of a silently empty grid", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("broker unreachable");
      }),
    );
    renderWithProviders(<CliToolsGroup />);
    expect(await screen.findByText(/could not load cli tools — /i)).toBeDefined();
  });

  describe("class-aware guidance (spec: name the right problem, not one collapsed 'unavailable')", () => {
    it("tells a missing tool to install, not to log in", async () => {
      renderCliTools({ tools: { codex: { detected: false, failure: "missing", detail: "binary not found on PATH" } } });
      // `findByText` requires a UNIQUE match — the brief's original
      // `/not found|install/i` alternation stops being unique the moment a
      // real "install" link exists alongside the pre-existing "not found"
      // detail line (two distinct, both-correct elements), so this is split
      // into its two unambiguous halves rather than weakened.
      expect(await screen.findByText(/not found/i)).toBeInTheDocument();
      expect(screen.queryByText(/log ?in/i)).toBeNull();
      // Strengthened: the two lines above already pass off the PRE-EXISTING
      // detail rendering alone (CliToolsGroup has always echoed `detail`
      // beside the pill) — they would hold even with zero guidance code
      // added. Prove a real fix-it affordance landed: a way to actually go
      // install it, and nothing resembling a login command.
      expect(screen.getByRole("link", { name: /install/i })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /copy/i })).toBeNull();
    });

    it("tells a logged-out tool to log in, not to install", async () => {
      renderCliTools({
        tools: {
          codex: {
            detected: true,
            authOk: false,
            failure: "unauthenticated",
            detail: "not logged in — run `codex login`",
          },
        },
      });
      // Exact string, not a regex substring — the brief's own `/codex
      // login/i` alternation is ambiguous here (it matches BOTH the
      // pre-existing detail sentence and the new isolated copy snippet
      // below); an exact match only ever matches an element whose ENTIRE
      // text is that string, which is the isolated snippet and nothing else.
      expect(await screen.findByText("codex login")).toBeInTheDocument();
      expect(screen.queryByText(/install/i)).toBeNull();
      // Strengthened: prove the exact command is offered as its OWN copyable
      // snippet, not merely present somewhere inside the longer detail
      // sentence — and that nothing invites an install instead.
      expect(screen.getByRole("button", { name: /copy/i })).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: /install/i })).toBeNull();
    });

    it("copying the login command puts the exact command on the clipboard", async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
      renderCliTools({
        tools: {
          codex: {
            detected: true,
            authOk: false,
            failure: "unauthenticated",
            detail: "not logged in — run `codex login`",
          },
        },
      });
      await userEvent.click(await screen.findByRole("button", { name: /copy/i }));
      expect(writeText).toHaveBeenCalledWith("codex login");
    });

    it("an unknown-auth tool is not presented as broken", async () => {
      // 'unknown' counts as ACTIVE. Showing it as a failure would tell users
      // to fix a tool that works — the inverse of the misdiagnosis this step
      // exists to end.
      renderCliTools({ tools: { opencode: { detected: true, authOk: "unknown", detail: "auth list unavailable" } } });
      await screen.findByText(/auth list unavailable/i);
      expect(screen.queryByRole("alert")).toBeNull();
      // Strengthened: no `failure` class is ever set alongside 'unknown' auth
      // (cli-tools.ts's own invariant), so NO fix-it affordance should render
      // either — not just "no alert".
      expect(screen.queryByRole("link")).toBeNull();
      expect(screen.queryByRole("button", { name: /copy/i })).toBeNull();
    });

    it("a billing-blocked tool links out to the vendor instead of offering a login command", async () => {
      // Forward compatibility only — no probe in this codebase sets 'billing'
      // today (cli-tools.ts's own doc comment). Exercised via a hand-built
      // fixture, same as the wizard's disabled-key test below.
      renderCliTools({
        tools: {
          codex: { detected: true, authOk: false, failure: "billing", detail: "workspace deactivated — billing" },
        },
      });
      expect(await screen.findByRole("link", { name: /billing/i })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /copy/i })).toBeNull();
    });

    it("a policy-blocked tool shows the reason with no generic fix offered", async () => {
      renderCliTools({
        tools: {
          copilot: {
            detected: true,
            authOk: false,
            failure: "policy",
            detail: "signed in as the wrong account — org policy blocks it",
          },
        },
      });
      // The baseline detail line, unchanged, and the new guidance note are
      // deliberately DIFFERENT text (see guidanceFor's policy case) so
      // neither collides with the other under a unique-match query.
      expect(await screen.findByText(/org policy blocks it/i)).toBeInTheDocument();
      expect(screen.getByText(/no generic fix/i)).toBeInTheDocument();
      expect(screen.queryByRole("link")).toBeNull();
      expect(screen.queryByRole("button", { name: /copy/i })).toBeNull();
    });
  });

  describe("guidanceFor — pure, exported for direct testing (mirrors pillFor's own pattern)", () => {
    const listing = (status: CliToolListing["status"]): CliToolListing => ({
      cli: "codex",
      label: "Codex",
      models: [],
      warmSessions: true,
      status,
      active: false,
    });

    it("no confirmed failure -> no guidance, even with no status at all", () => {
      expect(guidanceFor(listing(st({ authOk: "unknown" })))).toBeNull();
      expect(guidanceFor(listing(null))).toBeNull();
    });

    it("missing -> names the binary and links out, never a fabricated install command", () => {
      const g = guidanceFor(listing(st({ detected: false, failure: "missing", detail: "codex not found on PATH" })));
      expect(g?.code).toBeUndefined();
      expect(g?.linkHref).toMatch(/^https:\/\//);
    });

    it("unauthenticated -> extracts the exact backtick-quoted command from detail", () => {
      const g = guidanceFor(
        listing(st({ authOk: false, failure: "unauthenticated", detail: "not logged in — run `codex login`" })),
      );
      expect(g?.code).toBe("codex login");
      expect(g?.linkHref).toBeUndefined();
    });

    it("billing -> links out, no command to copy", () => {
      const g = guidanceFor(listing(st({ authOk: false, failure: "billing", detail: "workspace deactivated" })));
      expect(g?.code).toBeUndefined();
      expect(g?.linkHref).toBeDefined();
    });

    it("policy -> says there is no generic fix, without repeating the detail already shown above it", () => {
      const g = guidanceFor(listing(st({ authOk: false, failure: "policy", detail: "org policy blocks it" })));
      expect(g?.linkHref).toBeUndefined();
      expect(g?.code).toBeUndefined();
      expect(g?.note).toMatch(/no generic fix/i);
    });
  });
});
