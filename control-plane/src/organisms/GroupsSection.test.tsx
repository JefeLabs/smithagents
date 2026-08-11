import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GroupT } from "../api/types";
import { GroupsSection } from "./GroupsSection";

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

  it("delete calls onDelete with the group name", async () => {
    const onDelete = vi.fn().mockResolvedValue({});
    render(<GroupsSection groups={[g("frontend")]} workspaces={[]} onSave={vi.fn()} onDelete={onDelete} />);
    await userEvent.click(screen.getByRole("button", { name: "Remove frontend" }));
    await waitFor(() => expect(onDelete).toHaveBeenCalledExactlyOnceWith("frontend"));
  });
});
