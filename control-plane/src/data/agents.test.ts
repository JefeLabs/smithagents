import { describe, expect, it } from "vitest";
import { hostSeed } from "./agents";

describe("hostSeed", () => {
  it("returns null when the broker has sent no identity", () => {
    expect(hostSeed(null)).toBeNull();
  });

  it("builds a host-kind seed from the identity frame field", () => {
    expect(hostSeed({ name: "Anderson", role: "Chief of Staff", ring: "#8a93a6", listening: true })).toEqual({
      id: "host",
      name: "Anderson",
      role: "Chief of Staff",
      ring: "#8a93a6",
      listening: true,
      kind: "host",
    });
  });

  it("falls back to the identity ring when the frame omits one", () => {
    expect(hostSeed({ name: "Anderson", role: "Chief of Staff" })?.ring).toBe("#8a93a6");
  });
});
