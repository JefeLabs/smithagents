import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentSeed } from "../data/agents";
import { AgentRoster } from "./AgentRoster";

const HOST: AgentSeed = { id: "host", name: "Anderson", role: "Chief of Staff", ring: "#8a93a6", kind: "host" };
const CREW: AgentSeed[] = [
  { id: "ignacio", name: "Ignacio", role: "Builder", ring: "#6f8dff" },
  { id: "minerva", name: "Minerva", role: "Researcher", ring: "#e0a15a" },
];

describe("AgentRoster host slot", () => {
  beforeAll(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
      clear: () => storage.clear(),
    });
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("pins the host above the crew list, outside the sortable roster", () => {
    const { container } = render(<AgentRoster agents={[HOST, ...CREW]} onAdd={vi.fn()} />);
    const hostSlot = container.querySelector(".roster-host");
    expect(hostSlot?.textContent).toContain("Anderson");
    // The host circle lives outside the .roster sortable list…
    expect(container.querySelector(".roster .roster-host")).toBeNull();
    // …and the crew circles render inside it, without the host.
    const roster = container.querySelector(".roster");
    expect(roster?.textContent).toContain("Ignacio");
    expect(roster?.textContent).not.toContain("Anderson");
    // Host precedes the crew label in document order.
    const label = container.querySelector(".rail__label");
    expect(hostSlot && label && hostSlot.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("labels the crew section 'crew' and keeps the add button when the crew is empty", () => {
    const { container } = render(<AgentRoster agents={[HOST]} onAdd={vi.fn()} />);
    expect(container.querySelector(".rail__label")?.textContent).toBe("crew");
    expect(container.querySelector("button.add")).not.toBeNull();
    expect(container.querySelectorAll(".roster-item").length).toBe(0);
  });

  it("renders no host slot when no host entry is passed (identity null)", () => {
    const { container } = render(<AgentRoster agents={CREW} onAdd={vi.fn()} />);
    expect(container.querySelector(".roster-host")).toBeNull();
    expect(container.querySelector(".rail__label")?.textContent).toBe("crew");
  });

  it("keeps the host out of the saved roster order", () => {
    localStorage.setItem("smith.rosterOrder", JSON.stringify(["minerva", "ignacio"]));
    const { container } = render(<AgentRoster agents={[HOST, ...CREW]} onAdd={vi.fn()} />);
    const names = [...container.querySelectorAll(".roster .agent-avatar-anchor")].map((n) => n.textContent ?? "");
    expect(names[0]).toContain("Minerva");
    expect(names[1]).toContain("Ignacio");
  });
});
