import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliToolListing } from "../../api/types";
import { renderWithProviders } from "../../test/renderWithProviders";
import { CliToolsGroup, pillFor } from "./CliToolsGroup";

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
});
