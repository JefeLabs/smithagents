import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "../api/broker";
import { qk } from "../queries/keys";
import { useUiStore } from "../stores/uiStore";
import { renderWithProviders } from "../test/renderWithProviders";
import { DateRangeSelect } from "./DateRangeSelect";

const SPRINT = { anchor: "2026-08-03", lengthDays: 14 };

afterEach(() => vi.restoreAllMocks());

function renderControl(opts: { workspaceSprint?: boolean; groupSprint?: boolean; lens?: string } = {}) {
  vi.spyOn(api, "getWorkspaceRecords").mockResolvedValue([
    { name: "jefelabs", default: true, repos: [], ...(opts.workspaceSprint ? { sprint: SPRINT } : {}) },
  ]);
  const { client } = renderWithProviders(<DateRangeSelect />);
  client.setQueryData(qk.session, { id: "s1", title: "t", workspace: "jefelabs", runtime: "local-in-process" });
  client.setQueryData(qk.groups, [
    {
      name: "core",
      workspaces: ["jefelabs"],
      groups: [],
      expansion: ["jefelabs"],
      ...(opts.groupSprint ? { sprint: SPRINT } : {}),
    },
  ]);
  if (opts.lens) useUiStore.setState({ activeLens: { group: opts.lens } });
  return { client };
}

describe("DateRangeSelect", () => {
  it("defaults to All time and offers the calendar periods; sprint absent without config (opt-in)", async () => {
    renderControl();
    const trigger = await screen.findByRole("button", { name: "Date range" });
    expect(trigger.textContent).toContain("All time");
    await userEvent.click(trigger);
    expect(screen.getByRole("option", { name: "Current Week" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Current Month" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Current Quarter" })).toBeTruthy();
    expect(screen.getByRole("option", { name: /custom range/i })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Current Sprint" })).toBeNull();
  });

  it("offers Current Sprint when the workspace carries a config, and picking it sets the store", async () => {
    renderControl({ workspaceSprint: true });
    await userEvent.click(await screen.findByRole("button", { name: "Date range" }));
    await waitFor(() => expect(screen.getByRole("option", { name: "Current Sprint" })).toBeTruthy());
    await userEvent.click(screen.getByRole("option", { name: "Current Sprint" }));
    expect(useUiStore.getState().dateRange).toEqual({ kind: "sprint" });
  });

  it("a group lens's sprint config also enables the option", async () => {
    renderControl({ groupSprint: true, lens: "core" });
    await userEvent.click(await screen.findByRole("button", { name: "Date range" }));
    await waitFor(() => expect(screen.getByRole("option", { name: "Current Sprint" })).toBeTruthy());
  });

  it("picking a period sets the store; the trigger shows its label", async () => {
    renderControl();
    await userEvent.click(await screen.findByRole("button", { name: "Date range" }));
    await userEvent.click(screen.getByRole("option", { name: "Current Week" }));
    expect(useUiStore.getState().dateRange).toEqual({ kind: "week" });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Date range" }).textContent).toContain("Current Week"),
    );
  });

  it("Custom range… opens the popover and Apply sets from/to", async () => {
    renderControl();
    await userEvent.click(await screen.findByRole("button", { name: "Date range" }));
    await userEvent.click(screen.getByRole("option", { name: /custom range/i }));
    await userEvent.type(screen.getByLabelText("From"), "2026-08-01");
    await userEvent.type(screen.getByLabelText("To"), "2026-08-12");
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(useUiStore.getState().dateRange).toEqual({ kind: "custom", from: "2026-08-01", to: "2026-08-12" });
  });
});
