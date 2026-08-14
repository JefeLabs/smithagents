import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkCardT } from "../organisms/BoardStage";
import { BoardCard, flagAge } from "./BoardCard";

const card = (over: Partial<WorkCardT> = {}): WorkCardT =>
  ({ id: "c1", title: "Opt-in UI", columnId: "in-progress", order: 0, ...over }) as WorkCardT;

describe("flagAge", () => {
  it("renders whole days, flooring, with 0d on the same day", () => {
    const now = new Date("2026-08-07T12:00:00.000Z");
    expect(flagAge("2026-08-04T10:00:00.000Z", now)).toBe("3d");
    expect(flagAge("2026-08-07T01:00:00.000Z", now)).toBe("0d");
  });
});

describe("BoardCard", () => {
  // vitest.config.ts doesn't set test.globals, so RTL's auto-cleanup (which
  // feature-detects a *global* afterEach) never registers — without this,
  // each render() in this file leaks into the next test's queries.
  afterEach(() => {
    cleanup();
  });

  it("renders no flag chip when the card is unflagged", () => {
    render(<BoardCard card={card()} onOpen={() => {}} />);
    expect(screen.queryByRole("group", { name: /blocked|at risk|waiting/i })).toBeNull();
    expect(screen.getByRole("button").className).not.toContain("has-flag");
  });

  it("renders a labelled flag chip carrying the age and reason", () => {
    render(
      <BoardCard
        card={card({ flag: { kind: "blocked", reason: "waiting on Edwin", since: "2026-08-04T10:00:00.000Z" } })}
        onOpen={() => {}}
      />,
    );
    const chip = screen.getByLabelText(/blocked/i);
    expect(chip.textContent).toMatch(/\dd/);
    expect(chip.getAttribute("title")).toBe("waiting on Edwin");
    expect(screen.getByRole("button").className).toContain("has-flag");
  });

  it("puts the flag on the left edge and the workspace tint on the fill", () => {
    render(
      <BoardCard
        card={card({ flag: { kind: "at-risk", since: "2026-08-06T10:00:00.000Z" } })}
        tint="#5fd0b0"
        onOpen={() => {}}
      />,
    );
    const el = screen.getByRole("button");
    expect(el.style.getPropertyValue("--card-tint")).toBe("#5fd0b0");
    expect(el.className).toContain("is-at-risk");
  });

  it("renders the holder chip with their step state", () => {
    render(
      <BoardCard
        card={card({ title: "auth", columnId: "review" })}
        holder={{ name: "Edwin", state: "today" }}
        onOpen={() => {}}
      />,
    );
    expect(screen.getByText("Edwin · today")).toBeDefined();
  });

  it("renders no holder chrome when nobody holds it", () => {
    const { container } = render(<BoardCard card={card({ title: "auth", columnId: "review" })} onOpen={() => {}} />);
    expect(container.querySelector(".board-card__holder")).toBeNull();
  });

  it("renders the provenance badge when given", () => {
    render(
      <BoardCard card={card({ title: "auth", columnId: "review" })} provenance="Deliver · review" onOpen={() => {}} />,
    );
    expect(screen.getByText("Deliver · review")).toBeDefined();
  });

  it("shows the stated intent under the title, and nothing when there is none", () => {
    const c = card({ title: "auth", columnId: "review" });
    const { rerender, container } = render(<BoardCard card={c} intent="chasing the flaky suite" onOpen={() => {}} />);
    expect(screen.getByText("chasing the flaky suite")).toBeDefined();
    rerender(<BoardCard card={c} onOpen={() => {}} />);
    expect(container.querySelector(".board-card__intent")).toBeNull();
  });

  it("shows the plate age chip, formatted by flagAge, and nothing when there is none", () => {
    const c = card({ title: "auth", columnId: "review" });
    const { rerender, container } = render(<BoardCard card={c} age="5d" onOpen={() => {}} />);
    expect(screen.getByText("5d")).toBeDefined();
    rerender(<BoardCard card={c} onOpen={() => {}} />);
    expect(container.querySelector(".board-card__age")).toBeNull();
  });
});
