import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IntegrationsGroup } from "./IntegrationsGroup";

const VENDORS = [
  {
    id: "github",
    label: "GitHub",
    description: "Repo access.",
    fields: [{ key: "token", label: "Token", secret: true }],
    verifyExtraFields: [],
  },
  {
    id: "datadog",
    label: "Datadog",
    description: "Monitors.",
    fields: [{ key: "apiKey", label: "API key", secret: true }],
    verifyExtraFields: [],
  },
];

describe("IntegrationsGroup", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders one card per vendor, each showing its description", async () => {
    render(
      <IntegrationsGroup
        listVendors={vi.fn(async () => VENDORS)}
        listConnectors={vi.fn(async () => [])}
        addConnector={vi.fn()}
        updateConnector={vi.fn()}
        deleteConnector={vi.fn()}
        verifyConnector={vi.fn()}
      />,
    );
    expect(await screen.findByText("GitHub")).toBeDefined();
    expect(await screen.findByText("Datadog")).toBeDefined();
    expect(screen.getByText(/repo access/i)).toBeDefined();
  });

  it("a vendor with a saved instance shows it with a connected status, not a bare Connect button", async () => {
    render(
      <IntegrationsGroup
        listVendors={vi.fn(async () => VENDORS)}
        listConnectors={vi.fn(async () => [
          { id: "c1", vendorId: "github", label: "personal", fields: { hasToken: true } },
        ])}
        addConnector={vi.fn()}
        updateConnector={vi.fn()}
        deleteConnector={vi.fn()}
        verifyConnector={vi.fn()}
      />,
    );
    expect(await screen.findByText("personal")).toBeDefined();
    expect(screen.getByText(/add another/i)).toBeDefined();
  });

  it("clicking Connect on a vendor with zero instances opens the connect form for that vendor", async () => {
    render(
      <IntegrationsGroup
        listVendors={vi.fn(async () => VENDORS)}
        listConnectors={vi.fn(async () => [])}
        addConnector={vi.fn()}
        updateConnector={vi.fn()}
        deleteConnector={vi.fn()}
        verifyConnector={vi.fn()}
      />,
    );
    await userEvent.click((await screen.findAllByRole("button", { name: /^connect/i }))[0]!);
    expect(await screen.findByPlaceholderText(/label/i)).toBeDefined();
  });

  it("adding a connector calls addConnector and the new instance appears without a manual page reload", async () => {
    const addConnector = vi.fn(async () => ({
      id: "c2",
      vendorId: "github",
      label: "acme-corp",
      fields: { hasToken: true },
    }));
    render(
      <IntegrationsGroup
        listVendors={vi.fn(async () => VENDORS)}
        listConnectors={vi.fn(async () => [])}
        addConnector={addConnector}
        updateConnector={vi.fn()}
        deleteConnector={vi.fn()}
        verifyConnector={vi.fn()}
      />,
    );
    await userEvent.click((await screen.findAllByRole("button", { name: /^connect/i }))[0]!);
    await userEvent.type(await screen.findByPlaceholderText(/label/i), "acme-corp");
    await userEvent.type(screen.getByPlaceholderText(/token/i), "gh-tok");
    await userEvent.click(screen.getByRole("button", { name: /^connect$/i }));
    await waitFor(() => expect(addConnector).toHaveBeenCalled());
    expect(await screen.findByText("acme-corp")).toBeDefined();
  });

  it("removing a saved instance calls deleteConnector and it disappears from the card", async () => {
    const deleteConnector = vi.fn(async () => ({ ok: true }));
    render(
      <IntegrationsGroup
        listVendors={vi.fn(async () => VENDORS)}
        listConnectors={vi.fn(async () => [
          { id: "c1", vendorId: "github", label: "personal", fields: { hasToken: true } },
        ])}
        addConnector={vi.fn()}
        updateConnector={vi.fn()}
        deleteConnector={deleteConnector}
        verifyConnector={vi.fn()}
      />,
    );
    await userEvent.click(await screen.findByRole("button", { name: /remove personal/i }));
    await waitFor(() => expect(deleteConnector).toHaveBeenCalledWith("c1"));
    await waitFor(() => expect(screen.queryByText("personal")).toBeNull());
  });

  it("a listVendors/listConnectors rejection surfaces a visible load error instead of an unhandled rejection and a silently empty grid", async () => {
    render(
      <IntegrationsGroup
        listVendors={vi.fn(async () => {
          throw new Error("broker unreachable");
        })}
        listConnectors={vi.fn(async () => [])}
        addConnector={vi.fn()}
        updateConnector={vi.fn()}
        deleteConnector={vi.fn()}
        verifyConnector={vi.fn()}
      />,
    );
    expect(await screen.findByText(/broker unreachable/i)).toBeDefined();
  });

  it("a failed delete surfaces the error and leaves the row in place, instead of discarding result.error", async () => {
    const deleteConnector = vi.fn(async () => ({ error: "delete forbidden" }));
    render(
      <IntegrationsGroup
        listVendors={vi.fn(async () => VENDORS)}
        listConnectors={vi.fn(async () => [
          { id: "c1", vendorId: "github", label: "personal", fields: { hasToken: true } },
        ])}
        addConnector={vi.fn()}
        updateConnector={vi.fn()}
        deleteConnector={deleteConnector}
        verifyConnector={vi.fn()}
      />,
    );
    await userEvent.click(await screen.findByRole("button", { name: /remove personal/i }));
    expect(await screen.findByText(/delete forbidden/i)).toBeDefined();
    expect(screen.getByText("personal")).toBeDefined();
  });

  it("deleting an instance wired into Settings → Voice warns before it goes, and proceeds on confirm", async () => {
    const deleteConnector = vi.fn(async () => ({ ok: true }));
    const getVoice = vi.fn(async () => ({ stt: { instanceId: "c1" }, tts: null, hideInactive: false }));
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(
      <IntegrationsGroup
        listVendors={vi.fn(async () => VENDORS)}
        listConnectors={vi.fn(async () => [
          { id: "c1", vendorId: "github", label: "personal", fields: { hasToken: true } },
        ])}
        getVoice={getVoice}
        addConnector={vi.fn()}
        updateConnector={vi.fn()}
        deleteConnector={deleteConnector}
        verifyConnector={vi.fn()}
      />,
    );
    await userEvent.click(await screen.findByRole("button", { name: /remove personal/i }));
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining("speech-to-text"));
    await waitFor(() => expect(deleteConnector).toHaveBeenCalledWith("c1"));
    await waitFor(() => expect(screen.queryByText("personal")).toBeNull());
    confirmSpy.mockRestore();
  });

  it("cancelling the delete-confirm leaves the instance in place and never calls deleteConnector", async () => {
    const deleteConnector = vi.fn(async () => ({ ok: true }));
    const getVoice = vi.fn(async () => ({ stt: { instanceId: "c1" }, tts: null, hideInactive: false }));
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(
      <IntegrationsGroup
        listVendors={vi.fn(async () => VENDORS)}
        listConnectors={vi.fn(async () => [
          { id: "c1", vendorId: "github", label: "personal", fields: { hasToken: true } },
        ])}
        getVoice={getVoice}
        addConnector={vi.fn()}
        updateConnector={vi.fn()}
        deleteConnector={deleteConnector}
        verifyConnector={vi.fn()}
      />,
    );
    await userEvent.click(await screen.findByRole("button", { name: /remove personal/i }));
    expect(confirmSpy).toHaveBeenCalled();
    expect(deleteConnector).not.toHaveBeenCalled();
    expect(screen.getByText("personal")).toBeDefined();
    confirmSpy.mockRestore();
  });

  it("deleting an instance not referenced by voice skips the confirm entirely", async () => {
    const deleteConnector = vi.fn(async () => ({ ok: true }));
    const getVoice = vi.fn(async () => ({ stt: null, tts: null, hideInactive: false }));
    const confirmSpy = vi.spyOn(window, "confirm");
    render(
      <IntegrationsGroup
        listVendors={vi.fn(async () => VENDORS)}
        listConnectors={vi.fn(async () => [
          { id: "c1", vendorId: "github", label: "personal", fields: { hasToken: true } },
        ])}
        getVoice={getVoice}
        addConnector={vi.fn()}
        updateConnector={vi.fn()}
        deleteConnector={deleteConnector}
        verifyConnector={vi.fn()}
      />,
    );
    await userEvent.click(await screen.findByRole("button", { name: /remove personal/i }));
    expect(confirmSpy).not.toHaveBeenCalled();
    await waitFor(() => expect(deleteConnector).toHaveBeenCalledWith("c1"));
    confirmSpy.mockRestore();
  });

  it("a connector with only one of two declared secret fields present shows 'not connected', not a false-positive 'connected'", async () => {
    const DATADOG_TWO_SECRETS = {
      id: "datadog",
      label: "Datadog",
      description: "Monitors.",
      fields: [
        { key: "apiKey", label: "API key", secret: true },
        { key: "appKey", label: "Application key", secret: true },
      ],
      verifyExtraFields: [],
    };
    render(
      <IntegrationsGroup
        listVendors={vi.fn(async () => [DATADOG_TWO_SECRETS])}
        listConnectors={vi.fn(async () => [
          // hasApiKey saved, hasAppKey never set — partially configured
          { id: "c1", vendorId: "datadog", label: "acme", fields: { hasApiKey: true } },
        ])}
        addConnector={vi.fn()}
        updateConnector={vi.fn()}
        deleteConnector={vi.fn()}
        verifyConnector={vi.fn()}
      />,
    );
    expect(await screen.findByText(/not connected/i)).toBeDefined();
    expect(screen.queryByText(/^connected$/i)).toBeNull();
  });
});
