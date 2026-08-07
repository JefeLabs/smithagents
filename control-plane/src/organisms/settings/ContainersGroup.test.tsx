import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContainersGroup } from "./ContainersGroup";

function make(overrides: Partial<Parameters<typeof ContainersGroup>[0]> = {}) {
  return {
    getContainers: vi.fn(async () => ({ docker: { enabled: false } })),
    setDockerEnabled: vi.fn(async (enabled: boolean) => ({ docker: { enabled } })),
    verifyContainers: vi.fn(async () => ({ ok: true, detail: "Docker daemon reachable" })),
    ...overrides,
  };
}

describe("ContainersGroup", () => {
  afterEach(() => {
    cleanup();
  });

  it("loads and shows the toggle state", async () => {
    const props = make({ getContainers: vi.fn(async () => ({ docker: { enabled: true } })) });
    render(<ContainersGroup {...props} />);
    await waitFor(() => expect(props.getContainers).toHaveBeenCalled());
    const checkbox = (await screen.findByLabelText(/docker/i)) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
  });

  it("toggling calls setDockerEnabled and reflects the response", async () => {
    const props = make();
    render(<ContainersGroup {...props} />);
    const checkbox = (await screen.findByLabelText(/docker/i)) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    await userEvent.click(checkbox);
    await waitFor(() => expect(props.setDockerEnabled).toHaveBeenCalledWith(true));
    await waitFor(() => expect(checkbox.checked).toBe(true));
  });

  it("Verify shows the detail on an ok result", async () => {
    const props = make({ verifyContainers: vi.fn(async () => ({ ok: true, detail: "Docker daemon reachable" })) });
    render(<ContainersGroup {...props} />);
    await userEvent.click(await screen.findByRole("button", { name: /verify/i }));
    await waitFor(() => expect(props.verifyContainers).toHaveBeenCalled());
    expect(await screen.findByText("Docker daemon reachable")).toBeDefined();
  });

  it("Verify shows the detail on a failure result", async () => {
    const props = make({ verifyContainers: vi.fn(async () => ({ ok: false, detail: "Docker daemon not running" })) });
    render(<ContainersGroup {...props} />);
    await userEvent.click(await screen.findByRole("button", { name: /verify/i }));
    expect(await screen.findByText("Docker daemon not running")).toBeDefined();
  });

  it("enabling never requires or triggers a verify — toggle and verify are independent", async () => {
    const props = make();
    render(<ContainersGroup {...props} />);
    const checkbox = (await screen.findByLabelText(/docker/i)) as HTMLInputElement;
    await userEvent.click(checkbox);
    await waitFor(() => expect(props.setDockerEnabled).toHaveBeenCalledWith(true));
    expect(props.verifyContainers).not.toHaveBeenCalled();
  });

  it("renders as a provider list with docker as the only row", async () => {
    const props = make();
    const { container } = render(<ContainersGroup {...props} />);
    await waitFor(() => expect(props.getContainers).toHaveBeenCalled());
    const rows = container.querySelectorAll(".connector-card");
    expect(rows.length).toBe(1);
    expect(rows[0]?.textContent).toContain("Docker");
  });
});
