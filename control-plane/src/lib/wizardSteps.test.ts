import { describe, expect, it } from "vitest";
import { nextStep, PREFLIGHT, prevStep, progressFor, resumeStep, setupStepsFor, stepsFor } from "./wizardSteps";

describe("preflight", () => {
  it("is one screen, not a list of steps", () => {
    expect(PREFLIGHT).toBe("preflight");
  });

  it("is never part of the sequence it selects", () => {
    expect([...setupStepsFor({ mode: "local" })]).not.toContain(PREFLIGHT);
  });
});

describe("the sequence derives from the answers", () => {
  it("local mode yields the local sequence", () => {
    expect([...setupStepsFor({ mode: "local" })]).toEqual(["subscriptions", "anderson"]);
  });

  it("no mode yields no sequence rather than defaulting to local", () => {
    // Defaulting would walk someone into CLI installation on a missing field.
    expect([...setupStepsFor({})]).toEqual([]);
    expect([...setupStepsFor(undefined)]).toEqual([]);
  });

  it("the voice answer is carried but adds no step in this plan", () => {
    // The Voice screen is a later plan. Until it exists, a sequence entry for
    // it would be a dead route — but the ANSWER must already round-trip.
    expect([...setupStepsFor({ mode: "local", voice: true })]).toEqual(["subscriptions", "anderson"]);
  });
});

describe("labels match the spec", () => {
  it("does not call the mode question Location — that is a different step", () => {
    expect(stepsFor({ mode: "local" }).map((s) => s.title)).not.toContain("Location");
  });

  it("names Configure Anderson, not Brain", () => {
    expect(stepsFor({ mode: "local" }).find((s) => s.id === "anderson")?.title).toBe("Anderson");
  });
});

describe("progress is honest", () => {
  it("the gate has no number at all", () => {
    expect(progressFor(PREFLIGHT, { mode: "local" })).toBeNull();
  });

  it("counts within the sequence the answers actually selected", () => {
    const p = progressFor("subscriptions", { mode: "local" });
    expect(p).toEqual({ n: 1, of: stepsFor({ mode: "local" }).length });
  });

  it("never reports a total the sequence does not contain", () => {
    // The spec's "Step n of 6" is honest ONLY because the branch is settled at
    // the gate. A hardcoded 6 would lie for any shorter sequence.
    const of = progressFor("subscriptions", { mode: "local" })?.of;
    expect(of).toBe(stepsFor({ mode: "local" }).length);
  });
});

describe("skip applies a stated default", () => {
  it("every step after the gate has one", () => {
    for (const s of stepsFor({ mode: "local" })) {
      expect(s.skipLabel.trim()).not.toBe("");
      expect(s.skipLabel.toLowerCase()).not.toBe("skip"); // it must STATE the default
      expect(s.skipDefault()).toBeTypeOf("object");
    }
  });

  it("a skip default sends explicit values, never an empty patch", () => {
    // Setup merges, so `{}` silently keeps whatever was there — which is not
    // "the default", it is "whatever happened before".
    for (const s of stepsFor({ mode: "local" })) {
      expect(Object.keys(s.skipDefault() ?? {}).length).toBeGreaterThan(0);
    }
  });
});

describe("nextStep", () => {
  it("leaves preflight for the first step of the chosen sequence", () => {
    expect(nextStep(PREFLIGHT, { mode: "local" })).toBe("subscriptions");
  });

  it("cannot leave preflight with no mode chosen", () => {
    // Asserted against the with-mode case too: null-with-no-mode alone also
    // holds (for the wrong reason — an undefined PREFLIGHT and an ignored
    // setup argument) against the step model this replaces, so it would pass
    // whether or not this task's implementation exists. The contrast is what
    // discriminates.
    expect(nextStep(PREFLIGHT, {})).toBeNull();
    expect(nextStep(PREFLIGHT, { mode: "local" })).toBe("subscriptions");
  });

  it("walks the sequence and ends at null", () => {
    expect(nextStep("subscriptions", { mode: "local" })).toBe("anderson");
    expect(nextStep("anderson", { mode: "local" })).toBeNull();
  });
});

describe("prevStep — the escape hatch a blocking step depends on", () => {
  it("goes back from the first setup step into preflight", () => {
    expect(prevStep("subscriptions", { mode: "local" })).toBe(PREFLIGHT);
  });

  it("goes back within the sequence", () => {
    expect(prevStep("anderson", { mode: "local" })).toBe("subscriptions");
  });

  it("cannot go back from preflight — it is the beginning", () => {
    expect(prevStep(PREFLIGHT, { mode: "local" })).toBeNull();
  });
});

describe("resumeStep", () => {
  it("starts at preflight with no record", () => {
    expect(resumeStep(undefined)).toBe(PREFLIGHT);
  });

  it("returns to preflight for a setup step saved with no mode", () => {
    expect(resumeStep({ step: "subscriptions" })).toBe(PREFLIGHT);
  });

  it("resumes a step the recorded answers actually contain", () => {
    expect(resumeStep({ mode: "local", step: "anderson" })).toBe("anderson");
  });

  it("restarts on a step id the sequence does not contain", () => {
    expect(resumeStep({ mode: "local", step: "not-a-step" })).toBe(PREFLIGHT);
  });
});
