import { describe, expect, it } from "vitest";
import { joinNowVisible, modesFrom } from "./useSurfacePolicy";

describe("modesFrom", () => {
  it("parses map form with absent keys disabled", () => {
    expect(modesFrom({ channels: { tauri: "autojoin" } })).toMatchObject({
      tauri: "autojoin",
      discord: "disabled",
      "discord-voice": "disabled",
    });
  });
  it("parses legacy array: listed autojoin, unlisted disabled", () => {
    expect(modesFrom({ channels: ["discord"] })).toMatchObject({
      tauri: "disabled",
      discord: "autojoin",
      "discord-voice": "disabled",
    });
  });
  it("absent field: text autojoin, voice disabled", () => {
    expect(modesFrom({})).toMatchObject({
      tauri: "autojoin",
      discord: "autojoin",
      "discord-voice": "disabled",
    });
  });
});

describe("joinNowVisible", () => {
  it("shows only for on-request and not present", () => {
    expect(joinNowVisible("on-request", false)).toBe(true);
    expect(joinNowVisible("on-request", true)).toBe(false);
    expect(joinNowVisible("autojoin", false)).toBe(false);
    expect(joinNowVisible("disabled", false)).toBe(false);
  });
});
