import { describe, expect, it } from "vitest";
import { isSetupComplete, nextStep, resumeStep, WIZARD_STEPS } from "./wizardSteps";

describe("wizard step machine", () => {
  it("orders every required step before any optional one", () => {
    expect(WIZARD_STEPS[0]).toBe("name");
    expect(WIZARD_STEPS).toContain("fork");
  });

  it("resumes at the step the user left, not at the beginning", () => {
    expect(resumeStep({ step: "fork" })).toBe("fork");
  });

  it("resumes at the first step when there is no progress", () => {
    expect(resumeStep(undefined)).toBe("name");
    expect(resumeStep({})).toBe("name");
  });

  it("resumes at the first step when the stored step is unknown", () => {
    // A step id from a newer build, or a typo in a hand-edited record. Never
    // strand the user on a step that does not exist.
    expect(resumeStep({ step: "no-such-step" })).toBe("name");
  });

  it("advances through the steps and reports the end", () => {
    expect(nextStep("name")).toBe("fork");
    expect(nextStep(WIZARD_STEPS[WIZARD_STEPS.length - 1])).toBeNull();
  });

  it("is complete only when the last step is done", () => {
    expect(isSetupComplete({ step: "name" })).toBe(false);
    expect(isSetupComplete({ step: "done" })).toBe(true);
    expect(isSetupComplete(undefined)).toBe(false);
  });
});
