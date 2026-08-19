import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Setup } from "../lib/wizardSteps";
import { renderWithProviders } from "../test/renderWithProviders";
import { WizardTalkStep } from "./WizardTalkStep";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** One handler per `METHOD /path`, so an unexpected call is a loud failure. */
function stubRoutes(routes: Record<string, (body: unknown) => unknown>) {
  const calls: Array<{ key: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const key = `${init?.method ?? "GET"} ${new URL(url, "http://x").pathname}`;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ key, body });
      const handler = routes[key];
      if (!handler) throw new Error(`no stub for ${key}`);
      return new Response(JSON.stringify(await handler(body)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return calls;
}

const yes = (name: RegExp) => screen.getByRole("radio", { name });

describe("WizardTalkStep", () => {
  it("opens chatty and world-unaware, with no topic entry and no key field anywhere", () => {
    renderWithProviders(<WizardTalkStep onDone={() => {}} />);

    expect(yes(/say hello properly/i)).toBeChecked();
    expect(yes(/stick to what I already know/i)).toBeChecked();
    expect(screen.queryByRole("textbox", { name: /topic/i })).toBeNull();
    // The ruling: feeds are keyless. A key field here would be a dead end.
    expect(screen.queryByLabelText(/key/i)).toBeNull();
  });

  it("sends BOTH answers explicitly, even when both are the defaults", async () => {
    const user = userEvent.setup();
    const patches: Array<{ setup: Setup }> = [];
    renderWithProviders(<WizardTalkStep onDone={(p) => patches.push(p)} />);

    await user.click(screen.getByRole("button", { name: /continue/i }));

    // Omitting a field would let a stale value from an earlier run stand,
    // because the server MERGES setup. This is the answer-flip bug class.
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0].setup).toMatchObject({ smallTalk: true, worldAware: false });
  });

  it("sends smallTalk:false explicitly when the human declines small talk", async () => {
    const user = userEvent.setup();
    const patches: Array<{ setup: Setup }> = [];
    renderWithProviders(<WizardTalkStep onDone={(p) => patches.push(p)} />);

    await user.click(yes(/straight to the point/i));
    await user.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0].setup).toMatchObject({ smallTalk: false, worldAware: false });
  });

  it("answering yes to the world reveals topic entry; enter adds a chip, click removes it", async () => {
    const user = userEvent.setup();
    renderWithProviders(<WizardTalkStep onDone={() => {}} />);

    await user.click(yes(/keep up with/i));
    const entry = screen.getByRole("textbox", { name: /topic/i });

    await user.type(entry, "rust releases{Enter}");
    expect(screen.getByRole("button", { name: /remove rust releases/i })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /remove rust releases/i }));
    expect(screen.queryByRole("button", { name: /remove rust releases/i })).toBeNull();
  });

  it("posts each entered topic before finishing", async () => {
    const user = userEvent.setup();
    const calls = stubRoutes({ "POST /topics": () => ({ id: "t1" }) });
    const patches: Array<{ setup: Setup }> = [];
    renderWithProviders(<WizardTalkStep onDone={(p) => patches.push(p)} />);

    await user.click(yes(/keep up with/i));
    await user.type(screen.getByRole("textbox", { name: /topic/i }), "rust releases{Enter}");
    await user.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => expect(patches).toHaveLength(1));
    expect(calls.filter((c) => c.key === "POST /topics")).toHaveLength(1);
    expect(patches[0].setup).toMatchObject({ smallTalk: true, worldAware: true });
  });

  it("yes with NO topics is valid — the digest alone — and posts nothing", async () => {
    const user = userEvent.setup();
    const calls = stubRoutes({});
    const patches: Array<{ setup: Setup }> = [];
    renderWithProviders(<WizardTalkStep onDone={(p) => patches.push(p)} />);

    await user.click(yes(/keep up with/i));
    await user.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => expect(patches).toHaveLength(1));
    expect(calls).toHaveLength(0);
    expect(patches[0].setup).toMatchObject({ worldAware: true });
  });

  it("a failed topic post never strands: it says so and offers a way onward", async () => {
    const user = userEvent.setup();
    stubRoutes({
      "POST /topics": () => {
        throw new Error("swarm is down");
      },
    });
    const patches: Array<{ setup: Setup }> = [];
    renderWithProviders(<WizardTalkStep onDone={(p) => patches.push(p)} />);

    await user.click(yes(/keep up with/i));
    await user.type(screen.getByRole("textbox", { name: /topic/i }), "rust releases{Enter}");
    await user.click(screen.getByRole("button", { name: /continue/i }));

    // It must SAY what happened, not fail silently.
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/topic/i));
    expect(patches).toHaveLength(0);

    // And there must be a way forward that does not require the write to work.
    await user.click(screen.getByRole("button", { name: /continue without/i }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0].setup).toMatchObject({ smallTalk: true, worldAware: true });
  });

  it("a NON-2xx topic post is a failure too — brokerFetch resolves rather than throwing", async () => {
    const user = userEvent.setup();
    // The realistic shape: the server answers, unhappily. An unchecked
    // response here would report a silent success and lose the topic.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "nope" }), { status: 500 })),
    );
    const patches: Array<{ setup: Setup }> = [];
    renderWithProviders(<WizardTalkStep onDone={(p) => patches.push(p)} />);

    await user.click(yes(/keep up with/i));
    await user.type(screen.getByRole("textbox", { name: /topic/i }), "rust releases{Enter}");
    await user.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/topic/i));
    expect(patches).toHaveLength(0);
  });

  it("a resumed record seeds both answers and shows existing topics without re-posting them", async () => {
    const user = userEvent.setup();
    const calls = stubRoutes({});
    const patches: Array<{ setup: Setup }> = [];
    renderWithProviders(
      <WizardTalkStep
        initialSmallTalk={false}
        initialWorldAware={true}
        initialTopics={["rust releases"]}
        onDone={(p) => patches.push(p)}
      />,
    );

    expect(yes(/straight to the point/i)).toBeChecked();
    expect(yes(/keep up with/i)).toBeChecked();
    expect(screen.getByRole("button", { name: /remove rust releases/i })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /continue/i }));
    await waitFor(() => expect(patches).toHaveLength(1));
    // Already on the server — posting it again would duplicate it.
    expect(calls.filter((c) => c.key === "POST /topics")).toHaveLength(0);
  });
});
