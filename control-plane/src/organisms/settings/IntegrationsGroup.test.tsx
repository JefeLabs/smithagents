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
});
