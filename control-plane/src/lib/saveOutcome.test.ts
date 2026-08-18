import { describe, expect, it } from "vitest";
import { classifySave } from "./saveOutcome";

describe("classifySave", () => {
  it("a resolved body with no error is a success", async () => {
    expect(await classifySave(async () => ({ main: null }))).toEqual({ kind: "ok" });
  });

  it("a resolved {error} is a REFUSAL, carrying the server's own sentence", async () => {
    // The distinction that matters: brokerFetch never throws on a non-2xx, so
    // a server saying no arrives here as a perfectly ordinary resolved promise.
    // A caller that only wired `.catch` would treat this as a success.
    expect(await classifySave(async () => ({ error: "only Claude Code enforces --json-schema" }))).toEqual({
      kind: "refused",
      message: "only Claude Code enforces --json-schema",
    });
  });

  it("a thrown failure is a REJECTION, which is a different thing", async () => {
    expect(
      await classifySave(async () => {
        throw new Error("Failed to fetch");
      }),
    ).toEqual({ kind: "rejected", message: "Failed to fetch" });
  });

  it("a literal null body is a success, not a crash", async () => {
    // Several of these routes answer literal `null` on a successful CLEAR. A
    // bare `.error` on it throws a TypeError inside the very handler meant to
    // catch failures — the trap the broker's own PUT handlers document, which
    // hangs the client rather than failing it.
    expect(await classifySave(async () => null)).toEqual({ kind: "ok" });
  });

  it("an error the server sent empty still fails, with something to read", async () => {
    const outcome = await classifySave(async () => ({ error: "" }));
    expect(outcome.kind).toBe("refused");
    expect(outcome).toHaveProperty("message", expect.stringMatching(/\S/));
  });
});
