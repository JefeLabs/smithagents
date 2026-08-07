import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  it("two rapid clicks before the first setDockerEnabled resolves — called exactly once", async () => {
    let resolveFirst: ((v: { docker: { enabled: boolean } }) => void) | undefined;
    const setDockerEnabled = vi.fn(
      () =>
        new Promise<{ docker: { enabled: boolean } }>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const props = make({ setDockerEnabled });
    render(<ContainersGroup {...props} />);
    const checkbox = (await screen.findByLabelText(/docker/i)) as HTMLInputElement;

    // Two clicks fired back to back, before the first request has a chance to resolve — the
    // second must be a no-op (disabled checkbox + belt-and-suspenders guard in toggle()).
    fireEvent.click(checkbox);
    fireEvent.click(checkbox);
    expect(setDockerEnabled).toHaveBeenCalledTimes(1);

    resolveFirst?.({ docker: { enabled: true } });
    await waitFor(() => expect(checkbox.checked).toBe(true));
    expect(setDockerEnabled).toHaveBeenCalledTimes(1);
  });

  it("Verify surfaces a failure and re-enables the button when verifyContainers rejects", async () => {
    const verifyContainers = vi.fn(async () => {
      throw new Error("network down");
    });
    const props = make({ verifyContainers });
    render(<ContainersGroup {...props} />);
    const button = (await screen.findByRole("button", { name: /verify/i })) as HTMLButtonElement;
    await userEvent.click(button);
    await waitFor(() => expect(props.verifyContainers).toHaveBeenCalled());
    expect(await screen.findByText(/verify failed — broker unreachable/i)).toBeDefined();
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe("verify");
  });
});
