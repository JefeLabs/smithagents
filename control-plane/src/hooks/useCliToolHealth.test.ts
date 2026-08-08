import { describe, expect, it } from "vitest";
import type { CliToolListing } from "../api/types";
import { computeEngineWarnings } from "./useCliToolHealth";

const tool = (cli: string, active: boolean, detail = ""): CliToolListing => ({
  cli,
  label: cli,
  models: [],
  warmSessions: true,
  active,
  status: active
    ? null
    : { detected: true, authOk: false, enabled: true, detail, lastCheckedAt: "2026-08-06T00:00:00.000Z" },
});

describe("computeEngineWarnings", () => {
  it("flags only agents whose engine tool is inactive, with the tool's detail", () => {
    const warnings = computeEngineWarnings(
      [tool("claude", true), tool("codex", false, "not logged in — run `codex login`")],
      [
        { id: "ignacio", engine: { cli: "claude" } },
        { id: "wilkin", engine: { cli: "codex" } },
        { id: "ghost" }, // no engine on record -> never flagged
      ],
    );
    expect(warnings).toEqual({ wilkin: "codex: not logged in — run `codex login`" });
  });
  it("empty tool list (fetch failed, nothing probed) flags nobody", () => {
    expect(computeEngineWarnings([], [{ id: "ignacio", engine: { cli: "claude" } }])).toEqual({});
  });
});
