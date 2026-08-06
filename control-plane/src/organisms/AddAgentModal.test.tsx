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
  avatarGen: true,
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
      return respond(overrides.created ?? { id: "x", name: "x" });
    }
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
});
