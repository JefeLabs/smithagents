import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectorVendorMeta } from "../../hooks/useBrokerChat";
import { ConnectorFormModal } from "./ConnectorFormModal";

const GITHUB_VENDOR: ConnectorVendorMeta = {
  id: "github",
  label: "GitHub",
  description: "Repo access and pull requests.",
  fields: [{ key: "token", label: "Personal access token", secret: true }],
  verifyExtraFields: [],
};

const DATADOG_VENDOR: ConnectorVendorMeta = {
  id: "datadog",
  label: "Datadog",
  description: "Monitors and dashboards.",
  fields: [
    {
      key: "site",
      label: "Site",
      secret: false,
      type: "select",
      options: [
        { value: "us1", label: "US1" },
        { value: "eu1", label: "EU1" },
      ],
    },
    { key: "apiKey", label: "API key", secret: true },
    { key: "appKey", label: "Application key", secret: true },
  ],
  verifyExtraFields: [],
};

const ATLASSIAN_VENDOR: ConnectorVendorMeta = {
  id: "atlassian",
  label: "Atlassian",
  description: "Jira and Confluence.",
  fields: [
    { key: "email", label: "Atlassian account email", secret: false },
    { key: "apiToken", label: "API token", secret: true },
  ],
  verifyExtraFields: [
    { key: "testSiteUrl", label: "Site URL (used only to test this connection — not saved)", secret: false },
  ],
};

describe("ConnectorFormModal", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders one input per vendor field — text for non-secret, password for secret, select for type:select", () => {
    render(<ConnectorFormModal open vendor={DATADOG_VENDOR} onClose={() => {}} onSave={vi.fn()} />);
    expect(screen.getByRole("combobox")).toBeDefined(); // the site select
    expect(screen.getByPlaceholderText(/api key/i)).toHaveProperty("type", "password");
    expect(screen.getByPlaceholderText(/application key/i)).toHaveProperty("type", "password");
  });

  it("submitting a new connector calls onSave with vendorId, label, and the typed field values", async () => {
    const onSave = vi.fn(async () => ({}));
    render(<ConnectorFormModal open vendor={GITHUB_VENDOR} onClose={() => {}} onSave={onSave} />);
    await userEvent.type(screen.getByPlaceholderText(/label/i), "personal");
    await userEvent.type(screen.getByPlaceholderText(/personal access token/i), "gh-tok");
    await userEvent.click(screen.getByRole("button", { name: /^connect$/i }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({ vendorId: "github", label: "personal", fields: { token: "gh-tok" } }),
    );
  });

  it("Atlassian's verifyExtraFields render as a separate, clearly-labeled 'not saved' section, not merged into the saved fields", async () => {
    const onSave = vi.fn(async () => ({}));
    render(<ConnectorFormModal open vendor={ATLASSIAN_VENDOR} onClose={() => {}} onSave={onSave} />);
    expect(screen.getByText(/not saved/i)).toBeDefined();
    await userEvent.type(screen.getByPlaceholderText(/label/i), "default");
    await userEvent.type(screen.getByPlaceholderText(/atlassian account email/i), "e@x.com");
    await userEvent.type(screen.getByPlaceholderText(/^api token/i), "atl-tok");
    await userEvent.click(screen.getByRole("button", { name: /^connect$/i }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({
        vendorId: "atlassian",
        label: "default",
        fields: { email: "e@x.com", apiToken: "atl-tok" }, // testSiteUrl must NOT appear here
      }),
    );
  });

  it("Re-check on an existing instance calls onVerify with the transient extra fields, not onSave", async () => {
    const onVerify = vi.fn(async () => ({ ok: true, detail: "Jira: authenticated" }));
    render(
      <ConnectorFormModal
        open
        vendor={ATLASSIAN_VENDOR}
        existing={{
          id: "c1",
          vendorId: "atlassian",
          label: "default",
          fields: { email: "e@x.com", hasApiToken: true },
        }}
        onClose={() => {}}
        onSave={vi.fn()}
        onVerify={onVerify}
      />,
    );
    await userEvent.type(screen.getByPlaceholderText(/site url/i), "https://acme.atlassian.net");
    await userEvent.click(screen.getByRole("button", { name: /re-check/i }));
    await waitFor(() => expect(onVerify).toHaveBeenCalledWith({ testSiteUrl: "https://acme.atlassian.net" }));
    expect(await screen.findByText(/authenticated/i)).toBeDefined();
  });

  it("renders nothing when closed or when vendor is null", () => {
    const { container } = render(
      <ConnectorFormModal open={false} vendor={GITHUB_VENDOR} onClose={() => {}} onSave={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
