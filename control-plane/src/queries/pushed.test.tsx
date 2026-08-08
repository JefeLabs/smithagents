import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../test/renderWithProviders";
import { qk } from "./keys";
import { useRoster, useSession, useSessionKnown, useSessions, useTranscript, useWorkspaces } from "./pushed";

afterEach(() => vi.unstubAllGlobals());

/**
 * Every pushed query is skipToken — it must never fetch, ever. Stubbing
 * `fetch` to throw means an accidental swap back to a real queryFn fails
 * these tests loudly instead of silently racing (and maybe winning
 * against) the live broker on 127.0.0.1:7790.
 */
function stubFetchThrows() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("no network in this test");
    }),
  );
}

function Probe() {
  const { data } = useSession();
  const known = useSessionKnown();
  return <div data-testid="state">{!known ? "unknown" : !data ? "known-zero" : data.id}</div>;
}

describe("pushed queries", () => {
  it("starts unknown — never fetches, so it cannot resolve on its own", async () => {
    stubFetchThrows();
    renderWithProviders(<Probe />);
    expect(await screen.findByTestId("state")).toHaveTextContent("unknown");
  });

  it("distinguishes a confirmed zero-session state from not-heard-yet", async () => {
    stubFetchThrows();
    const { client } = renderWithProviders(<Probe />);
    client.setQueryData(qk.session, null);
    expect(await screen.findByTestId("state")).toHaveTextContent("known-zero");
  });

  it("reports the active session id once a frame lands", async () => {
    stubFetchThrows();
    const { client } = renderWithProviders(<Probe />);
    client.setQueryData(qk.session, { id: "s1", title: "t", workspace: "w", runtime: "local-in-process" });
    expect(await screen.findByTestId("state")).toHaveTextContent("s1");
  });

  it("sessions, workspaces, transcript and roster stay pending until seeded, then read back what landed", async () => {
    stubFetchThrows();

    function OthersProbe() {
      const sessions = useSessions();
      const workspaces = useWorkspaces();
      const transcript = useTranscript();
      const roster = useRoster();
      return (
        <div>
          <span data-testid="sessions">{sessions.status === "pending" ? "pending" : sessions.data?.length}</span>
          <span data-testid="workspaces">
            {workspaces.status === "pending" ? "pending" : workspaces.data?.join(",")}
          </span>
          <span data-testid="transcript">{transcript.status === "pending" ? "pending" : transcript.data?.length}</span>
          <span data-testid="roster">{roster.status === "pending" ? "pending" : roster.data?.agents.length}</span>
        </div>
      );
    }

    const { client } = renderWithProviders(<OthersProbe />);
    expect(await screen.findByTestId("sessions")).toHaveTextContent("pending");
    expect(screen.getByTestId("workspaces")).toHaveTextContent("pending");
    expect(screen.getByTestId("transcript")).toHaveTextContent("pending");
    expect(screen.getByTestId("roster")).toHaveTextContent("pending");

    client.setQueryData(qk.sessions, [
      { id: "s1", title: "t", workspace: "w", updatedAt: "now", active: true, runtime: "local-in-process" },
    ]);
    client.setQueryData(qk.workspaces, ["default"]);
    client.setQueryData(qk.transcript, [{ id: 1, role: "user", text: "hi" }]);
    client.setQueryData(qk.roster, { agents: [], identity: null });

    expect(await screen.findByTestId("sessions")).toHaveTextContent("1");
    expect(screen.getByTestId("workspaces")).toHaveTextContent("default");
    expect(screen.getByTestId("transcript")).toHaveTextContent("1");
    expect(screen.getByTestId("roster")).toHaveTextContent("0");
  });
});
