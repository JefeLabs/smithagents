import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BOARD_ROUTES_UI } from "../lib/board-aggregate";
import { renderWithProviders } from "../test/renderWithProviders";
import { TerminalEffectsSheet } from "./TerminalEffectsSheet";

const BOARD = {
  id: "acme-ideation",
  name: "Ideate",
  type: "ideation",
  workspaceId: "acme",
  columns: [
    { id: "scoping", name: "Scoping" },
    { id: "killed", name: "Killed" },
  ],
  cards: [],
  terminal: { effects: [{ kind: "route", toType: "plan", toColumn: "queue" }] },
};

/**
 * Local copy of the QueueSourcesSheet.test.tsx pattern, trimmed to what this
 * sheet calls: only the board PATCH route — no workspace-records GET/PUT.
 */
function stubFetch(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const respond = (b: unknown, status = 200) => ({ ok: status < 400, status, json: async () => b }) as Response;
    if (url.includes("/work/boards/") && method === "PATCH") return respond(overrides.patched ?? {});
    return respond({});
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("TerminalEffectsSheet", () => {
  it("shows the terminal column defaulting to the last column and patches on change", async () => {
    const { calls } = stubFetch({});
    renderWithProviders(<TerminalEffectsSheet board={BOARD as never} open onClose={() => {}} />);
    const select = await screen.findByLabelText(/terminal column/i);
    expect(select).toHaveValue("killed");
    await userEvent.selectOptions(select, "scoping");
    const patch = calls.find((c) => c.method === "PATCH" && c.url.endsWith("/work/boards/acme-ideation"));
    expect(patch?.body).toEqual({ terminal: { columnId: "scoping", effects: BOARD.terminal.effects } });
  });

  it("adds a publish-jira effect with connector and project", async () => {
    const { calls } = stubFetch({});
    renderWithProviders(<TerminalEffectsSheet board={BOARD as never} open onClose={() => {}} />);
    await userEvent.selectOptions(await screen.findByLabelText(/effect kind/i), "publish-jira");
    await userEvent.type(screen.getByLabelText(/connector/i), "atl-1");
    await userEvent.type(screen.getByLabelText(/project key/i), "PROJ");
    await userEvent.click(screen.getByRole("button", { name: /add effect/i }));
    const patch = calls.find((c) => c.method === "PATCH");
    expect((patch?.body as { terminal: { effects: unknown[] } } | undefined)?.terminal?.effects).toHaveLength(2);
  });

  it("removes an effect", async () => {
    const { calls } = stubFetch({});
    renderWithProviders(<TerminalEffectsSheet board={BOARD as never} open onClose={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /remove route to plan/i }));
    const patch = calls.find((c) => c.method === "PATCH");
    expect((patch?.body as { terminal: { effects: unknown[] } } | undefined)?.terminal?.effects).toHaveLength(0);
  });

  it("route-effect add excludes the board's own type from To-type, and omits columnId when unset", async () => {
    const { calls } = stubFetch({});
    renderWithProviders(<TerminalEffectsSheet board={BOARD as never} open onClose={() => {}} />);
    await userEvent.selectOptions(await screen.findByLabelText(/effect kind/i), "route");

    // Derived from the route table itself, not hardcoded — this tracks
    // BOARD_ROUTES_UI as it evolves rather than pinning today's board list.
    // "ideation" IS a real route target (plan/reactive route into it), so
    // subtracting it here — rather than it simply never appearing in the
    // union — is what actually exercises the self-route exclusion below.
    const allTargets = new Set(Object.values(BOARD_ROUTES_UI).flatMap((exits) => exits.map((e) => e.toType)));
    const expected = [...allTargets].filter((t) => t !== BOARD.type);

    const toTypeSelect = screen.getByLabelText(/to type/i) as HTMLSelectElement;
    const optionValues = [...toTypeSelect.options].map((o) => o.value);
    expect(new Set(optionValues)).toEqual(new Set(expected));
    // Pins the ruling explicitly: a board must never offer itself as a route target.
    expect(optionValues).not.toContain("ideation");

    await userEvent.selectOptions(toTypeSelect, "deliver");
    await userEvent.type(screen.getByLabelText(/to column/i), "ready");
    await userEvent.click(screen.getByRole("button", { name: /add effect/i }));

    const patch = calls.find((c) => c.method === "PATCH");
    const body = patch?.body as { terminal: { columnId?: string; effects: unknown[] } };
    // The BOARD fixture's terminal has effects but no columnId — an
    // effects-only write must not stamp today's default column in.
    expect(body.terminal).not.toHaveProperty("columnId");
    expect(body.terminal.effects).toEqual([
      ...BOARD.terminal.effects,
      { kind: "route", toType: "deliver", toColumn: "ready" },
    ]);
  });
});
