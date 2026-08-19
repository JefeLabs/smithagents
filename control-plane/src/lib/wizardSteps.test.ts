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
    expect([...setupStepsFor({ mode: "local" })]).toEqual(["sources", "roles", "voice", "talk", "memory"]);
  });

  it("no mode yields no sequence rather than defaulting to local", () => {
    // Defaulting would walk someone into CLI installation on a missing field.
    expect([...setupStepsFor({})]).toEqual([]);
    expect([...setupStepsFor(undefined)]).toEqual([]);
  });

  it("voice is in the sequence unconditionally on its own answer — the step ASKS, it isn't gated by an answer already given", () => {
    // Wrong impl this catches: a sequence that includes "voice" only once
    // `setup.voice` is already `true` or `false` — which would strand a user
    // who has never answered on a sequence one step short of the one the
    // progress indicator (and `resumeStep`) actually walks.
    expect([...setupStepsFor({ mode: "local" })]).toEqual(["sources", "roles", "voice", "talk", "memory"]);
    expect([...setupStepsFor({ mode: "local", voice: true })]).toEqual(["sources", "roles", "voice", "talk", "memory"]);
    expect([...setupStepsFor({ mode: "local", voice: false })]).toEqual([
      "sources",
      "roles",
      "voice",
      "talk",
      "memory",
    ]);
    // "talk" is unconditional for the same reason, and would strand a user the
    // same way: its whole job is to ASK, so a record that already carries an
    // answer must still reach the screen that asks it.
    expect([...setupStepsFor({ mode: "local", smallTalk: false, worldAware: true })]).toEqual([
      "sources",
      "roles",
      "voice",
      "talk",
      "memory",
    ]);
  });
});

describe("labels match the spec", () => {
  it("does not call the mode question Location — that is a different step", () => {
    expect(stepsFor({ mode: "local" }).map((s) => s.title)).not.toContain("Location");
  });

  it("carries the spec's own section names, in its order", () => {
    // `## Step 1 of 6 · Where I think` / `## Step 2 of 6 · What I think with`
    // / `## Step 3 of 6 · Talking out loud` — the spec's headings verbatim,
    // because the indicator is the only place a step is named to the user
    // and a paraphrase there is a second name for the same screen.
    expect(stepsFor({ mode: "local" }).map((s) => s.title)).toEqual([
      "Where I think",
      "What I think with",
      "Talking out loud",
      "How I talk",
      "Remembering, and what I may do",
    ]);
  });

  it("no longer names the two screens these replaced", () => {
    // Not redundant with the equality above: it is the assertion that FAILS
    // if a registry keeps the old entries alongside the new ones (a swap done
    // by addition rather than replacement), which the exact-order check above
    // would also catch but for a reason that reads as a copy edit rather than
    // as two dead screens still in the sequence.
    const titles = stepsFor({ mode: "local" }).map((s) => s.title);
    expect(titles).not.toContain("Subscriptions");
    expect(titles).not.toContain("Anderson");
  });
});

describe("progress is honest", () => {
  it("the gate has no number at all", () => {
    expect(progressFor(PREFLIGHT, { mode: "local" })).toBeNull();
  });

  it("counts within the sequence the answers actually selected", () => {
    const p = progressFor("sources", { mode: "local" });
    expect(p).toEqual({ n: 1, of: stepsFor({ mode: "local" }).length });
  });

  it("never reports a total the sequence does not contain", () => {
    // The spec's "Step n of 6" is honest ONLY because the branch is settled at
    // the gate. A hardcoded 6 would lie for any shorter sequence.
    const of = progressFor("sources", { mode: "local" })?.of;
    expect(of).toBe(stepsFor({ mode: "local" }).length);
  });

  it("the local sequence is honestly 'Step n of 5' now that memory is in it", () => {
    // Pinned as the literal numbers, not just against `stepsFor(...).length`
    // (which the two checks above already do): a regression that dropped
    // "voice" back out of the sequence would still satisfy those against
    // itself, reporting a self-consistent but wrong "of 2".
    expect(progressFor("sources", { mode: "local" })).toEqual({ n: 1, of: 5 });
    expect(progressFor("roles", { mode: "local" })).toEqual({ n: 2, of: 5 });
    expect(progressFor("voice", { mode: "local" })).toEqual({ n: 3, of: 5 });
    expect(progressFor("talk", { mode: "local" })).toEqual({ n: 4, of: 5 });
    expect(progressFor("memory", { mode: "local" })).toEqual({ n: 5, of: 5 });
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
    expect(nextStep(PREFLIGHT, { mode: "local" })).toBe("sources");
  });

  it("cannot leave preflight with no mode chosen", () => {
    // Asserted against the with-mode case too: null-with-no-mode alone also
    // holds (for the wrong reason — an undefined PREFLIGHT and an ignored
    // setup argument) against the step model this replaces, so it would pass
    // whether or not this task's implementation exists. The contrast is what
    // discriminates.
    expect(nextStep(PREFLIGHT, {})).toBeNull();
    expect(nextStep(PREFLIGHT, { mode: "local" })).toBe("sources");
  });

  it("walks the sequence and ends at null", () => {
    // "talk" is no longer the end, exactly as "voice" stopped being it when
    // talk arrived — the regression a naive wiring of each new step produces
    // if `setupStepsFor` grows one but something upstream still treats the old
    // last step as terminal.
    expect(nextStep("sources", { mode: "local" })).toBe("roles");
    expect(nextStep("roles", { mode: "local" })).toBe("voice");
    expect(nextStep("voice", { mode: "local" })).toBe("talk");
    expect(nextStep("talk", { mode: "local" })).toBe("memory");
    expect(nextStep("memory", { mode: "local" })).toBeNull();
  });
});

describe("prevStep — the escape hatch a blocking step depends on", () => {
  it("goes back from the first setup step into preflight", () => {
    expect(prevStep("sources", { mode: "local" })).toBe(PREFLIGHT);
  });

  it("goes back within the sequence", () => {
    expect(prevStep("roles", { mode: "local" })).toBe("sources");
    expect(prevStep("voice", { mode: "local" })).toBe("roles");
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
    expect(resumeStep({ step: "sources" })).toBe(PREFLIGHT);
  });

  it("resumes a step the recorded answers actually contain", () => {
    expect(resumeStep({ mode: "local", step: "roles" })).toBe("roles");
  });

  it("resumes mid-voice — the new last step, reachable the same way any other is", () => {
    expect(resumeStep({ mode: "local", step: "voice" })).toBe("voice");
  });

  it("a preflight-era 'voice: false' does not change WHICH step resumeStep returns", () => {
    // Records from before this step existed may already carry `setup.voice`
    // — written by the OLD preflight's own voice question, or by an earlier
    // skip default (see the `Setup.voice` doc comment). `resumeStep` reads
    // `step` alone; a wrong impl that let a pre-existing boolean answer
    // divert resumption (e.g. treating an already-declined record as "done
    // with voice" and skipping straight past it) would fail this against the
    // plain mid-voice case right above it, which carries no `voice` field at
    // all and must resume identically.
    expect(resumeStep({ mode: "local", step: "voice", voice: false })).toBe("voice");
    expect(resumeStep({ mode: "local", step: "roles", voice: false })).toBe("roles");
  });

  it("restarts on a step id the sequence does not contain", () => {
    expect(resumeStep({ mode: "local", step: "not-a-step" })).toBe(PREFLIGHT);
  });

  it("sends a record left on one of the RETIRED steps back to the gate", () => {
    // The upgrade path, and the only one this swap creates: someone who was
    // mid-wizard when this build replaced the two steps has `subscriptions`
    // or `anderson` recorded on their user record. Neither renders any more,
    // so without this they would resume onto an empty panel — a heading, an
    // indicator, and no controls at all, on every reload, with the gate
    // reopening each time because setup never completes. Same clause that
    // covers "not-a-step" above; asserted separately because these two ids
    // are the ones that will actually be on disk.
    expect(resumeStep({ mode: "local", step: "subscriptions" })).toBe(PREFLIGHT);
    expect(resumeStep({ mode: "local", step: "anderson" })).toBe(PREFLIGHT);
  });
});

describe("How I talk joins the sequence", () => {
  it("comes after voice", () => {
    // "four steps" was this test's own claim before "memory" arrived after
    // it — pinned instead against the ORDER, which is what this test is
    // actually about; the sequence's current length has its own test in
    // "Remembering joins the sequence" below.
    expect(setupStepsFor({ mode: "local" })).toEqual(["sources", "roles", "voice", "talk", "memory"]);
  });

  it("counts as step 4 of 5 — the arithmetic every step's indicator reads", () => {
    expect(progressFor("talk", { mode: "local" })).toEqual({ n: 4, of: 5 });
    expect(progressFor("voice", { mode: "local" })).toEqual({ n: 3, of: 5 });
    expect(progressFor("sources", { mode: "local" })).toEqual({ n: 1, of: 5 });
  });

  it("carries the spec's own section name", () => {
    const talk = stepsFor({ mode: "local" }).find((s) => s.id === "talk");
    expect(talk?.title).toBe("How I talk");
  });

  it("its skip states what skipping does, never a bare Skip", () => {
    const talk = stepsFor({ mode: "local" }).find((s) => s.id === "talk");
    expect(talk?.skipLabel).toMatch(/say hello properly and stick to what I know/i);
  });

  it("its skip default sets BOTH answers explicitly — chatty, and news opt-in declined", () => {
    const talk = stepsFor({ mode: "local" }).find((s) => s.id === "talk");
    // Never `{}` or a partial: setup merges server-side, so an omitted field
    // would leave an earlier run's answer standing.
    expect(talk?.skipDefault()).toEqual({ smallTalk: true, worldAware: false });
  });

  it("pick-for-me picks it up without naming it — every step's default, applied", () => {
    const setup: Record<string, unknown> = { mode: "local" };
    for (const s of stepsFor({ mode: "local" })) Object.assign(setup, s.skipDefault());
    expect(setup).toMatchObject({ smallTalk: true, worldAware: false });
  });

  it("hosted mode still selects no steps at all", () => {
    expect(setupStepsFor({ mode: "hosted" })).toEqual([]);
  });
});

describe("Remembering joins the sequence", () => {
  it("comes after talk, making the local sequence five steps", () => {
    expect(setupStepsFor({ mode: "local" })).toEqual(["sources", "roles", "voice", "talk", "memory"]);
  });

  it("counts as step 5 of 5", () => {
    expect(progressFor("memory", { mode: "local" })).toEqual({ n: 5, of: 5 });
    expect(progressFor("talk", { mode: "local" })).toEqual({ n: 4, of: 5 });
  });

  it("carries the spec's own section name", () => {
    expect(stepsFor({ mode: "local" }).find((s) => s.id === "memory")?.title).toBe("Remembering, and what I may do");
  });

  it("its skip default sets EVERY answer explicitly — remember, and all three stances", () => {
    // A partial patch would leave one answer standing from an earlier run.
    expect(
      stepsFor({ mode: "local" })
        .find((s) => s.id === "memory")
        ?.skipDefault(),
    ).toEqual({
      remember: true,
      deeperRecall: false,
      permissions: { readFiles: "ask", runCommands: "ask", browseWeb: "ask" },
    });
  });

  it("is unconditional — the step ASKS, so a record already carrying answers still reaches it", () => {
    expect(setupStepsFor({ mode: "local", remember: false })).toEqual(["sources", "roles", "voice", "talk", "memory"]);
  });
});
