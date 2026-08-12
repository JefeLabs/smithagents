import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GroupT } from "../api/types";
import { GroupsSection, wouldCycleWith } from "./GroupsSection";

const g = (name: string, workspaces: string[] = [], groups: string[] = []): GroupT => ({
  name,
  workspaces,
  groups,
  expansion: workspaces,
});

describe("GroupsSection", () => {
  afterEach(() => cleanup());

  it("lists existing groups", () => {
    render(
      <GroupsSection
        groups={[g("frontend", ["acme"]), g("core")]}
        workspaces={["acme"]}
        onSave={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByText("frontend")).toBeTruthy();
    expect(screen.getByText("core")).toBeTruthy();
  });

  it("creates a group with picked member workspaces and groups", async () => {
    const onSave = vi.fn().mockResolvedValue({});
    render(<GroupsSection groups={[g("core")]} workspaces={["acme", "labs"]} onSave={onSave} onDelete={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /new group/i }));
    await userEvent.type(screen.getByRole("textbox", { name: "Group name" }), "frontend");
    await userEvent.click(screen.getByRole("checkbox", { name: "acme" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "core" }));
    await userEvent.click(screen.getByRole("button", { name: "save group" }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledExactlyOnceWith(
        { name: "frontend", description: undefined, color: undefined, workspaces: ["acme"], groups: ["core"] },
        true,
      ),
    );
  });

  it("the member-groups picker omits the group being edited — it cannot contain itself directly", async () => {
    render(
      <GroupsSection groups={[g("frontend"), g("core")]} workspaces={["acme"]} onSave={vi.fn()} onDelete={vi.fn()} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Edit frontend" }));
    expect(screen.queryByRole("checkbox", { name: "frontend" })).toBeNull();
    expect(screen.getByRole("checkbox", { name: "core" })).toBeTruthy();
  });

  it("a cycle rejection from the server surfaces inline", async () => {
    const onSave = vi.fn().mockResolvedValue({ error: "group would contain itself" });
    render(<GroupsSection groups={[g("frontend")]} workspaces={[]} onSave={onSave} onDelete={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Edit frontend" }));
    await userEvent.click(screen.getByRole("button", { name: "save group" }));
    expect(await screen.findByText("group would contain itself")).toBeTruthy();
  });

  it("editing saves with isNew=false and the immutable name", async () => {
    const onSave = vi.fn().mockResolvedValue({});
    render(
      <GroupsSection groups={[g("frontend", ["acme"])]} workspaces={["acme"]} onSave={onSave} onDelete={vi.fn()} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Edit frontend" }));
    expect((screen.getByRole("textbox", { name: "Group name" }) as HTMLInputElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "save group" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][1]).toBe(false);
    expect(onSave.mock.calls[0][0].name).toBe("frontend");
  });

  it("autoStart opens the create form on mount — member pickers in view (Edwin, 2026-08-12)", async () => {
    const onAutoStarted = vi.fn();
    render(
      <GroupsSection
        groups={[g("core")]}
        workspaces={["acme"]}
        onSave={vi.fn()}
        onDelete={vi.fn()}
        autoStart
        onAutoStarted={onAutoStarted}
      />,
    );
    expect(await screen.findByRole("textbox", { name: "Group name" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "acme" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "core" })).toBeTruthy();
    expect(onAutoStarted).toHaveBeenCalled();
  });

  it("Sprint Filter ON + day + length saves a derived weekday anchor; OFF saves no sprint", async () => {
    const onSave = vi.fn().mockResolvedValue({});
    render(<GroupsSection groups={[]} workspaces={["acme"]} onSave={onSave} onDelete={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /new group/i }));
    await userEvent.type(screen.getByRole("textbox", { name: "Group name" }), "frontend");
    await userEvent.click(screen.getByLabelText("Sprint Filter"));
    // Shared FormSelect (react-aria), not a native select: open, pick Monday.
    await userEvent.click(screen.getByRole("button", { name: /sprint starts on/i }));
    await userEvent.click(await screen.findByRole("option", { name: "Monday" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Sprint length (days)" }), "14");
    await userEvent.click(screen.getByRole("button", { name: "save group" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const sprint = onSave.mock.calls[0][0].sprint;
    expect(sprint.lengthDays).toBe(14);
    expect(new Date(`${sprint.anchor}T12:00:00`).getDay()).toBe(1); // a Monday
    onSave.mockClear();
    cleanup();
    render(<GroupsSection groups={[]} workspaces={["acme"]} onSave={onSave} onDelete={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /new group/i }));
    await userEvent.type(screen.getByRole("textbox", { name: "Group name" }), "plain");
    await userEvent.click(screen.getByRole("button", { name: "save group" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0].sprint).toBeUndefined();
  });

  it("Sprint Filter ON with a missing day REFUSES the save with an inline error", async () => {
    const onSave = vi.fn().mockResolvedValue({});
    render(<GroupsSection groups={[]} workspaces={[]} onSave={onSave} onDelete={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /new group/i }));
    await userEvent.type(screen.getByRole("textbox", { name: "Group name" }), "frontend");
    await userEvent.click(screen.getByLabelText("Sprint Filter"));
    await userEvent.type(screen.getByLabelText("Sprint length (days)"), "14");
    await userEvent.click(screen.getByRole("button", { name: "save group" }));
    expect(await screen.findByText(/needs a start day/i)).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("editing a group with a sprint shows the toggle ON with its day and length", async () => {
    render(
      <GroupsSection
        groups={[{ ...g("frontend"), sprint: { anchor: "2026-08-03", lengthDays: 14 } }]}
        workspaces={[]}
        onSave={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Edit frontend" }));
    expect((screen.getByLabelText("Sprint Filter") as HTMLInputElement).checked).toBe(true);
    // The shared FormSelect trigger shows the recovered weekday (Aug 3 2026 = Monday).
    expect(screen.getByRole("button", { name: /sprint starts on/i }).textContent).toContain("Monday");
    expect((screen.getByRole("textbox", { name: "Sprint length (days)" }) as HTMLInputElement).value).toBe("14");
  });

  it("member-groups picker offers everything EXCEPT cycle-makers (self and its ancestors)", async () => {
    const parent = g("parent", [], ["frontend"]);
    const grandparent = g("grand", [], ["parent"]);
    render(
      <GroupsSection
        groups={[g("frontend"), parent, grandparent, g("core")]}
        workspaces={["acme"]}
        onSave={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Edit frontend" }));
    expect(screen.queryByRole("checkbox", { name: "frontend" })).toBeNull(); // self
    expect(screen.queryByRole("checkbox", { name: "parent" })).toBeNull(); // contains frontend
    expect(screen.queryByRole("checkbox", { name: "grand" })).toBeNull(); // contains it transitively
    expect(screen.getByRole("checkbox", { name: "core" })).toBeTruthy(); // legal add
  });

  it("wouldCycleWith walks membership transitively", () => {
    const groups = [g("a", [], ["b"]), g("b", [], ["c"]), g("c"), g("x")];
    expect(wouldCycleWith("a", "c", groups)).toBe(true); // a reaches c
    expect(wouldCycleWith("x", "c", groups)).toBe(false);
    expect(wouldCycleWith("c", "c", groups)).toBe(true); // self
  });

  it("delete calls onDelete with the group name", async () => {
    const onDelete = vi.fn().mockResolvedValue({});
    render(<GroupsSection groups={[g("frontend")]} workspaces={[]} onSave={vi.fn()} onDelete={onDelete} />);
    await userEvent.click(screen.getByRole("button", { name: "Remove frontend" }));
    await waitFor(() => expect(onDelete).toHaveBeenCalledExactlyOnceWith("frontend"));
  });
});
