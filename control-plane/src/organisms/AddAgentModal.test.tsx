import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AddAgentModal } from "./AddAgentModal";

const PRESETS = [
  {
    id: "minerva",
    name: "Minerva",
    gender: "female",
    role: "Security Engineer",
    jobRole: "security",
    stereotype: "auditor",
    language: "en-do",
    hook: "Reads your diff like a border agent reads a passport.",
    backstory: "Treats every input as hostile because one always is.",
    persona: { style: "Clipped, precise." },
    voiceId: "v-minerva",
    ring: "#5fd0b0",
    avatar: "minerva.png",
    engine: { cli: "claude", model: "claude-opus" },
  },
  {
    id: "yesenia",
    name: "Yesenia",
    gender: "female",
    role: "Frontend Engineer",
    jobRole: "frontend",
    stereotype: "builder",
    language: "en-do",
    hook: "Ships pixels before the meeting ends.",
    backstory: "Believes a UI is finished when abuela can use it without asking.",
    persona: { style: "Fast, upbeat, concrete." },
    voiceId: "",
    ring: "#6f8dff",
    avatar: "yesenia.png",
    engine: { cli: "claude", model: "claude-opus" },
  },
];

const CATALOG = {
  stereotypes: [
    { id: "auditor", label: "The Auditor", style: "clipped", directives: "audit", reactions: { agree: ["ok"] } },
    { id: "builder", label: "The Builder", style: "fast", directives: "build", reactions: { agree: ["dale"] } },
  ],
  jobRoles: [
    { id: "security", label: "Security Engineer", directives: "guard" },
    { id: "frontend", label: "Frontend Engineer", directives: "pixels" },
  ],
  engines: [{ cli: "claude", label: "Claude Code", models: ["claude-opus"], warmSessions: true }],
  languages: [{ id: "en-do", label: "English (Dominican)", speech: "spanglish" }],
  quickQuestions: [{ id: "name", question: "What should I call you?" }],
  reactionLevels: ["agree"],
  presets: PRESETS,
  avatarGen: "api",
};

/** Routes every fetch by URL; tests override per-route. Captures POST /agents bodies. */
function stubFetch(overrides: Record<string, unknown> = {}) {
  const posted: Array<Record<string, unknown>> = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const respond = (body: unknown) => ({ ok: true, json: async () => body, blob: async () => new Blob() }) as Response;
    if (url.endsWith("/agent-catalog")) return respond(overrides.catalog ?? CATALOG);
    if (url.endsWith("/agents") && init?.method === "POST") {
      posted.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      // Pins the in-flight state for tests that assert what's disabled while a join is pending.
      if (overrides.deferJoin) return new Promise<Response>(() => {});
      return respond(overrides.created ?? { id: "x", name: "x" });
    }
    if (url.endsWith("/agents/generate")) return respond(overrides.draft ?? {});
    if (url.endsWith("/agents")) return respond(overrides.agents ?? { agents: [] });
    if (url.endsWith("/avatars/generate")) return respond(overrides.generated ?? { imageData: "QUJD" });
    if (url.includes("/voices")) return respond({ voices: [] });
    return respond({});
  });
  vi.stubGlobal("fetch", fn);
  return { fn, posted };
}

describe("AddAgentModal chooser", () => {
  beforeEach(() => stubFetch());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("create mode opens on the chooser with every preset card plus Create custom", async () => {
    stubFetch();
    render(<AddAgentModal open onClose={vi.fn()} />);
    expect(await screen.findByText("Minerva")).toBeTruthy();
    expect(screen.getByText("Yesenia")).toBeTruthy();
    expect(screen.getByText("The Auditor")).toBeTruthy();
    expect(screen.getByText(/create custom/i)).toBeTruthy();
    expect(screen.queryByLabelText(/name/i)).toBeNull(); // wizard not shown yet
  });

  it("one-click join posts the full preset body with explicit id, avatarPreset and ring", async () => {
    const { posted } = stubFetch();
    const onCreated = vi.fn();
    render(<AddAgentModal open onClose={vi.fn()} onCreated={onCreated} />);
    await userEvent.click(await screen.findByText("Minerva"));
    await userEvent.click(screen.getByRole("button", { name: /join team/i }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("Minerva"));
    expect(posted[0]).toMatchObject({
      id: "minerva",
      name: "Minerva",
      stereotype: "auditor",
      jobRole: "security",
      avatarPreset: "minerva",
      avatarRing: "#5fd0b0",
      voice: { voiceId: "v-minerva" },
    });
  });

  it("a preset already on the roster is marked and cannot join again", async () => {
    stubFetch({ agents: { agents: [{ id: "minerva", name: "Minerva" }] } });
    render(<AddAgentModal open onClose={vi.fn()} />);
    expect(await screen.findByText(/on the team/i)).toBeTruthy();
    await userEvent.click(screen.getByText("Yesenia"));
    expect(screen.getByRole("button", { name: /join team/i })).toBeTruthy();
  });

  it("a preset whose CLI is inactive warns on its card and blocks join, but customize stays enabled", async () => {
    stubFetch({
      catalog: {
        ...CATALOG,
        engines: [
          {
            cli: "claude",
            label: "Claude Code",
            models: ["claude-opus"],
            warmSessions: true,
            active: false,
            statusDetail: "not logged in — run `claude login`",
          },
        ],
      },
    });
    render(<AddAgentModal open onClose={vi.fn()} />);
    expect((await screen.findAllByText(/cli unavailable/i)).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByText("Minerva"));
    expect((screen.getByRole("button", { name: /join team/i }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /customize/i }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText(/not logged in/i)).toBeTruthy();
  });

  it("Customize prefills the wizard from the preset", async () => {
    stubFetch();
    render(<AddAgentModal open onClose={vi.fn()} />);
    await userEvent.click(await screen.findByText("Minerva"));
    await userEvent.click(screen.getByRole("button", { name: /customize/i }));
    await userEvent.click(screen.getByRole("button", { name: /next/i })); // Setup -> Persona
    expect((screen.getByLabelText(/^name$/i) as HTMLInputElement).value).toBe("Minerva");
    expect((screen.getByLabelText(/backstory/i) as HTMLTextAreaElement).value).toContain("hostile");
  });

  it("Create custom enters the blank wizard", async () => {
    stubFetch();
    render(<AddAgentModal open onClose={vi.fn()} />);
    await userEvent.click(await screen.findByText(/create custom/i));
    expect(await screen.findByText(/job role/i)).toBeTruthy();
  });

  it("edit mode skips the chooser entirely", async () => {
    stubFetch({
      agents: {
        agents: [{ id: "minerva", name: "Minerva", role: "Security", engine: { cli: "claude", model: "claude-opus" } }],
      },
    });
    render(<AddAgentModal open onClose={vi.fn()} editingId="minerva" />);
    expect(await screen.findByText(/job role/i)).toBeTruthy();
    expect(screen.queryByText(/join team/i)).toBeNull();
  });

  it("edit mode prefills every step from the STORED record — persona, setup pickers, voice, reactions, answers", async () => {
    // The whole edit prefill is one reset() now. Nothing else asserts what it lands on, so
    // a field quietly dropped from that object would show up as a blank box the user
    // silently saves over.
    stubFetch({
      agents: {
        agents: [
          {
            id: "minerva",
            name: "Minerva",
            role: "Security Engineer",
            backstory: "Treats every input as hostile.",
            gender: "female",
            language: "en-do",
            stereotype: "auditor",
            jobRole: "security",
            engine: { cli: "claude", model: "claude-opus" },
            voice: { voiceId: "v-minerva" },
            reactions: { agree: ["claro"] },
            quickAnswers: { name: "Call me Minerva." },
          },
        ],
      },
    });
    render(<AddAgentModal open onClose={vi.fn()} editingId="minerva" />);
    // Step 0 — Setup pickers, all catalog-backed. The prefill needs two fetches (catalog,
    // then the stored record), so the first assertion waits for the reset to land.
    await waitFor(() => expect((screen.getByLabelText(/job role/i) as HTMLSelectElement).value).toBe("security"));
    expect((screen.getByLabelText(/^cli$/i) as HTMLSelectElement).value).toBe("claude");
    expect((screen.getByLabelText(/^model$/i) as HTMLSelectElement).value).toBe("claude-opus");
    expect((screen.getByLabelText(/personality/i) as HTMLSelectElement).value).toBe("auditor");
    expect((screen.getByLabelText(/primary language/i) as HTMLSelectElement).value).toBe("en-do");

    await userEvent.click(screen.getByRole("button", { name: /next/i })); // -> Persona
    expect((screen.getByLabelText(/^name$/i) as HTMLInputElement).value).toBe("Minerva");
    expect((screen.getByLabelText(/^title$/i) as HTMLInputElement).value).toBe("Security Engineer");
    expect((screen.getByLabelText(/backstory/i) as HTMLTextAreaElement).value).toContain("hostile");
    expect(screen.getByRole("button", { name: "female" }).className).toContain("is-picked");

    await userEvent.click(screen.getByRole("button", { name: /next/i })); // -> Voice
    expect((screen.getByLabelText(/paste a voice id/i) as HTMLInputElement).value).toBe("v-minerva");

    await userEvent.click(screen.getByRole("button", { name: /next/i })); // -> Reactions
    expect((screen.getByLabelText(/agrees/i) as HTMLInputElement).value).toBe("claro");

    await userEvent.click(screen.getByRole("button", { name: /next/i })); // -> Answers
    expect((screen.getByLabelText(/what should i call you/i) as HTMLInputElement).value).toBe("Call me Minerva.");
  });

  it("a Reactions/Answers step walked past untouched submits no blank lines", async () => {
    // Registering an input seeds its key, so without the blank filter every skipped level
    // would post as an empty reaction line and swarm would store it as a real one.
    const { posted } = stubFetch();
    render(<AddAgentModal open onClose={vi.fn()} />);
    await userEvent.click(await screen.findByText(/create custom/i));
    await userEvent.click(screen.getByRole("button", { name: /next/i })); // -> Persona
    await userEvent.type(screen.getByLabelText(/^name$/i), "Nena");
    await userEvent.click(screen.getByRole("button", { name: /next/i })); // -> Voice
    await userEvent.click(screen.getByRole("button", { name: /next/i })); // -> Reactions
    // Type into the one reaction level the catalog offers, then blank it back out.
    await userEvent.type(screen.getByLabelText(/agrees/i), "dale");
    await userEvent.clear(screen.getByLabelText(/agrees/i));
    await userEvent.click(screen.getByRole("button", { name: /next/i })); // -> Answers (untouched)
    await userEvent.click(screen.getByRole("button", { name: /create agent/i }));
    await waitFor(() => expect(posted.length).toBe(1));
    expect(posted[0].reactions).toEqual({});
    expect(posted[0].quickAnswers).toEqual({});
  });

  it("Reactions and Answers that ARE filled in still post, one line per level", async () => {
    const { posted } = stubFetch();
    render(<AddAgentModal open onClose={vi.fn()} />);
    await userEvent.click(await screen.findByText(/create custom/i));
    await userEvent.click(screen.getByRole("button", { name: /next/i }));
    await userEvent.type(screen.getByLabelText(/^name$/i), "Nena");
    await userEvent.click(screen.getByRole("button", { name: /next/i }));
    await userEvent.click(screen.getByRole("button", { name: /next/i }));
    await userEvent.type(screen.getByLabelText(/agrees/i), "dale que va");
    await userEvent.click(screen.getByRole("button", { name: /next/i }));
    await userEvent.type(screen.getByLabelText(/what should i call you/i), "Nena, please.");
    await userEvent.click(screen.getByRole("button", { name: /create agent/i }));
    await waitFor(() => expect(posted.length).toBe(1));
    expect(posted[0].reactions).toEqual({ agree: ["dale que va"] });
    expect(posted[0].quickAnswers).toEqual({ name: "Nena, please." });
  });

  it("Create custom starts blank even after an abandoned Customize from a previous open", async () => {
    stubFetch();
    const onClose = vi.fn();
    const { rerender } = render(<AddAgentModal open onClose={onClose} />);
    await userEvent.click(await screen.findByText("Minerva"));
    await userEvent.click(screen.getByRole("button", { name: /customize/i }));
    await userEvent.click(screen.getByRole("button", { name: /next/i })); // Setup -> Persona
    expect(((await screen.findByLabelText(/^name$/i)) as HTMLInputElement).value).toBe("Minerva");

    // Close without submitting — the modal stays mounted, so this state persists.
    rerender(<AddAgentModal open={false} onClose={onClose} />);
    rerender(<AddAgentModal open onClose={onClose} />);

    await userEvent.click(await screen.findByText(/create custom/i));
    await userEvent.click(screen.getByRole("button", { name: /next/i })); // Setup -> Persona
    expect((screen.getByLabelText(/^name$/i) as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText(/backstory/i) as HTMLTextAreaElement).value).toBe("");
  });

  it("a name typed into a blank wizard is gone after close and reopen", async () => {
    // HomePage renders this modal unconditionally and toggles `open`, so it never
    // unmounts and useForm's per-mount defaults run exactly once for the life of the
    // page. The open-effect's reset is the only thing standing between a half-typed
    // agent and the next person who opens the modal.
    stubFetch();
    const onClose = vi.fn();
    const { rerender } = render(<AddAgentModal open onClose={onClose} />);
    await userEvent.click(await screen.findByText(/create custom/i));
    await userEvent.click(screen.getByRole("button", { name: /next/i })); // Setup -> Persona
    await userEvent.type(screen.getByLabelText(/^name$/i), "Radhamés");
    expect((screen.getByLabelText(/^name$/i) as HTMLInputElement).value).toBe("Radhamés");

    rerender(<AddAgentModal open={false} onClose={onClose} />);
    rerender(<AddAgentModal open onClose={onClose} />);

    await userEvent.click(await screen.findByText(/create custom/i));
    await userEvent.click(screen.getByRole("button", { name: /next/i }));
    expect((screen.getByLabelText(/^name$/i) as HTMLInputElement).value).toBe("");
  });

  it("a Customize on a later open does not inherit the previous open's generated portrait or directives", async () => {
    // Isolates the open-effect's `if (!editingId) resetWizardFields()`. The
    // Create-custom path can't: enterCustomWizard() calls resetWizardFields() itself, so
    // that test stays green with the open-effect line deleted. Customize is the path with
    // no reset of its own — customizePreset sets generatedStyle but never clears
    // generatedDirectives, and never touches avatarData/editingAvatar. Without the
    // open-effect line, both survive into the next open and the customized agent is
    // created carrying another persona's portrait and directives.
    const { posted } = stubFetch({ draft: { name: "Draft", directives: "STALE DIRECTIVES FROM A PRIOR OPEN" } });
    const onClose = vi.fn();
    const { rerender } = render(<AddAgentModal open onClose={onClose} />);

    // Open 1: blank wizard, generate a persona (sets generatedDirectives) and a portrait
    // (sets avatarData), then abandon it.
    await userEvent.click(await screen.findByText(/create custom/i));
    await userEvent.click(screen.getByRole("button", { name: /next/i })); // -> Persona
    await userEvent.click(screen.getByRole("button", { name: /generate the rest with AI/i }));
    await waitFor(() => expect((screen.getByLabelText(/^name$/i) as HTMLInputElement).value).toBe("Draft"));
    await userEvent.click(screen.getByRole("button", { name: /generate portrait/i }));
    expect(await screen.findByRole("button", { name: /reroll the portrait/i })).toBeTruthy();

    rerender(<AddAgentModal open={false} onClose={onClose} />);
    rerender(<AddAgentModal open onClose={onClose} />);

    // Open 2: Customize a preset and create it.
    await userEvent.click(await screen.findByText("Minerva"));
    await userEvent.click(screen.getByRole("button", { name: /customize/i }));
    await userEvent.click(screen.getByRole("button", { name: /next/i })); // -> Persona
    // NB: the avatar block shows "reroll" either way here — customizePreset sets
    // avatarPresetRef, so the block has a value regardless of whether stale avatarData
    // survived. Only the submitted payload distinguishes the two, so that is what is
    // asserted below.
    await userEvent.click(screen.getByRole("button", { name: /next/i })); // -> Voice
    await userEvent.click(screen.getByRole("button", { name: /next/i })); // -> Reactions
    await userEvent.click(screen.getByRole("button", { name: /next/i })); // -> Answers
    await userEvent.click(screen.getByRole("button", { name: /create agent/i }));
    await waitFor(() => expect(posted.length).toBe(1));

    expect(posted[0].avatarData).toBeUndefined();
    expect(posted[0].avatarPreset).toBe("minerva");
    expect(posted[0].directives).toBe("guard"); // Minerva's jobRole directives, not the stale draft's
  });

  it("wizard reset defaults the CLI to the first active engine, not catalog.engines[0]", async () => {
    stubFetch({
      catalog: {
        ...CATALOG,
        engines: [
          { cli: "codex", label: "Codex", models: ["codex-1"], warmSessions: false, active: false },
          { cli: "claude", label: "Claude Code", models: ["claude-opus"], warmSessions: true },
        ],
      },
    });
    const onClose = vi.fn();
    const { rerender } = render(<AddAgentModal open onClose={onClose} />);
    await userEvent.click(await screen.findByText("Minerva"));
    await userEvent.click(screen.getByRole("button", { name: /customize/i }));
    await screen.findByLabelText(/^cli$/i); // Setup step, mid-customize

    // Close without submitting, reopen — resetWizardFields runs again on Create custom below.
    rerender(<AddAgentModal open={false} onClose={onClose} />);
    rerender(<AddAgentModal open onClose={onClose} />);

    await userEvent.click(await screen.findByText(/create custom/i));
    const cliSelect = (await screen.findByLabelText(/^cli$/i)) as HTMLSelectElement;
    expect(cliSelect.value).toBe("claude");
  });

  it("Next gates per STEP, not per form: Setup advances with the name still blank, Persona does not", async () => {
    // The wizard's gate is deliberately NOT formState.isValid. A whole-form check would
    // see step 1's empty `name` while the user is on step 0 and disable the only control
    // that could take them to the field that fixes it — an unreachable wizard, with no
    // error and no type failure. This pins the per-step semantics directly rather than
    // leaning on the other tests that merely happen to click through.
    stubFetch();
    render(<AddAgentModal open onClose={vi.fn()} />);
    await userEvent.click(await screen.findByText(/create custom/i));
    const next = () => screen.getByRole("button", { name: /next/i }) as HTMLButtonElement;
    // Step 0 (Setup): engine, model and language come from the catalog; `name` is blank.
    await screen.findByLabelText(/^cli$/i);
    expect(next().disabled).toBe(false);
    await userEvent.click(next());
    // Step 1 (Persona): now the blank name IS the gate.
    expect((screen.getByLabelText(/^name$/i) as HTMLInputElement).value).toBe("");
    expect(next().disabled).toBe(true);
    await userEvent.type(screen.getByLabelText(/^name$/i), "Nena");
    await waitFor(() => expect(next().disabled).toBe(false));
  });

  it("customize without a rename posts the preset's canonical id", async () => {
    const { posted } = stubFetch();
    render(<AddAgentModal open onClose={vi.fn()} />);
    await userEvent.click(await screen.findByText("Minerva"));
    await userEvent.click(screen.getByRole("button", { name: /customize/i }));
    await userEvent.click(screen.getByRole("button", { name: /next/i })); // Setup -> Persona
    await userEvent.click(screen.getByRole("button", { name: /next/i })); // Persona -> Voice
    await userEvent.click(screen.getByRole("button", { name: /next/i })); // Voice -> Reactions
    await userEvent.click(screen.getByRole("button", { name: /next/i })); // Reactions -> Answers
    await userEvent.click(screen.getByRole("button", { name: /create agent/i }));
    await waitFor(() => expect(posted.length).toBe(1));
    expect(posted[0].id).toBe("minerva");
  });

  it("customize with a rename does not send an id — the server slugs the new name", async () => {
    const { posted } = stubFetch();
    render(<AddAgentModal open onClose={vi.fn()} />);
    await userEvent.click(await screen.findByText("Minerva"));
    await userEvent.click(screen.getByRole("button", { name: /customize/i }));
    await userEvent.click(screen.getByRole("button", { name: /next/i })); // -> Persona
    await userEvent.clear(screen.getByLabelText(/^name$/i));
    await userEvent.type(screen.getByLabelText(/^name$/i), "Minerva Dos");
    await userEvent.click(screen.getByRole("button", { name: /next/i }));
    await userEvent.click(screen.getByRole("button", { name: /next/i }));
    await userEvent.click(screen.getByRole("button", { name: /next/i }));
    await userEvent.click(screen.getByRole("button", { name: /create agent/i }));
    await waitFor(() => expect(posted.length).toBe(1));
    expect(posted[0].id).toBeUndefined();
  });

  it("customize and Create custom are disabled while a join is in flight", async () => {
    stubFetch({ deferJoin: true });
    render(<AddAgentModal open onClose={vi.fn()} />);
    await userEvent.click(await screen.findByText("Minerva"));
    await userEvent.click(screen.getByRole("button", { name: /join team/i }));
    const joining = (await screen.findByRole("button", { name: /joining/i })) as HTMLButtonElement;
    const customize = screen.getByRole("button", { name: /customize/i }) as HTMLButtonElement;
    const createCustom = screen.getByRole("button", { name: /create custom/i }) as HTMLButtonElement;
    expect(joining.disabled).toBe(true);
    expect(customize.disabled).toBe(true);
    expect(createCustom.disabled).toBe(true);
  });
});

describe("AddAgentModal avatar generator", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  async function openBlankWizardAtPersona() {
    render(<AddAgentModal open onClose={vi.fn()} />);
    await userEvent.click(await screen.findByText(/create custom/i));
    await userEvent.click(await screen.findByRole("button", { name: /next/i })); // Setup -> Persona
  }

  it("generates a portrait, flips to reroll, and submits avatarData without the data-uri prefix", async () => {
    const { posted } = stubFetch();
    await openBlankWizardAtPersona();
    await userEvent.type(screen.getByLabelText(/^name$/i), "Nena");
    await userEvent.click(screen.getByRole("button", { name: /generate portrait/i }));
    expect(await screen.findByRole("button", { name: /reroll the portrait/i })).toBeTruthy();
    // walk to the last step and create
    await userEvent.click(screen.getByRole("button", { name: /next/i })); // Voice
    await userEvent.click(screen.getByRole("button", { name: /next/i })); // Reactions
    await userEvent.click(screen.getByRole("button", { name: /next/i })); // Answers
    await userEvent.click(screen.getByRole("button", { name: /create agent/i }));
    await waitFor(() => expect(posted.length).toBe(1));
    expect(posted[0].avatarData).toBe("QUJD");
    expect(posted[0].avatarPreset).toBeUndefined();
  });

  it("generation failure shows the error and never blocks saving", async () => {
    const { posted } = stubFetch({ generated: { error: "Gemini returned no image — try again" } });
    await openBlankWizardAtPersona();
    await userEvent.type(screen.getByLabelText(/^name$/i), "Nena");
    await userEvent.click(screen.getByRole("button", { name: /generate portrait/i }));
    expect(await screen.findByText(/no image/i)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /next/i }));
    await userEvent.click(screen.getByRole("button", { name: /next/i }));
    await userEvent.click(screen.getByRole("button", { name: /next/i }));
    await userEvent.click(screen.getByRole("button", { name: /create agent/i }));
    await waitFor(() => expect(posted.length).toBe(1));
    expect(posted[0].avatarData).toBeUndefined();
  });

  it("avatarGen null hides the generate button", async () => {
    stubFetch({ catalog: { ...CATALOG, avatarGen: null } });
    await openBlankWizardAtPersona();
    expect(screen.queryByRole("button", { name: /generate portrait/i })).toBeNull();
  });

  it("customized preset keeps its committed art: submit carries avatarPreset, not avatarData", async () => {
    const { posted } = stubFetch();
    render(<AddAgentModal open onClose={vi.fn()} />);
    await userEvent.click(await screen.findByText("Minerva"));
    await userEvent.click(screen.getByRole("button", { name: /customize/i }));
    await userEvent.click(screen.getByRole("button", { name: /next/i })); // -> Persona
    await userEvent.clear(screen.getByLabelText(/^name$/i));
    await userEvent.type(screen.getByLabelText(/^name$/i), "Minerva Dos");
    await userEvent.click(screen.getByRole("button", { name: /next/i }));
    await userEvent.click(screen.getByRole("button", { name: /next/i }));
    await userEvent.click(screen.getByRole("button", { name: /next/i }));
    await userEvent.click(screen.getByRole("button", { name: /create agent/i }));
    await waitFor(() => expect(posted.length).toBe(1));
    expect(posted[0].avatarPreset).toBe("minerva");
    expect(posted[0].avatarRing).toBe("#5fd0b0");
    expect(posted[0].avatarData).toBeUndefined();
  });
});
