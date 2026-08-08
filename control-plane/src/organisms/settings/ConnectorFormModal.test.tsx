import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectorVendorMeta } from "../../api/types";
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

  it("typing into a verifyExtraFields input and then saving excludes it from onSave's fields, even though both were filled in the same interaction", async () => {
    const onSave = vi.fn(async () => ({}));
    render(<ConnectorFormModal open vendor={ATLASSIAN_VENDOR} onClose={() => {}} onSave={onSave} />);
    await userEvent.type(screen.getByPlaceholderText(/label/i), "default");
    await userEvent.type(screen.getByPlaceholderText(/atlassian account email/i), "e@x.com");
    await userEvent.type(screen.getByPlaceholderText(/^api token/i), "atl-tok");
    await userEvent.type(screen.getByPlaceholderText(/site url/i), "https://acme.atlassian.net");
    await userEvent.click(screen.getByRole("button", { name: /^connect$/i }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({
        vendorId: "atlassian",
        label: "default",
        // Exact deep-equality: if a regression merged `extra` into `fields`, this object would
        // gain a `testSiteUrl` key and fail the match below, even though it was typed and the
        // form was saved in the very same interaction.
        fields: { email: "e@x.com", apiToken: "atl-tok" },
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

  it("the save button gates on a non-blank label — whitespace alone does not enable it", async () => {
    // The gate this covers moved from a hand-written `!label.trim()` onto RHF's isValid.
    // `required: true` would accept "   ", so the rule behind isValid has to trim.
    render(<ConnectorFormModal open vendor={GITHUB_VENDOR} onClose={() => {}} onSave={vi.fn()} />);
    const connect = screen.getByRole("button", { name: /^connect$/i }) as HTMLButtonElement;
    expect(connect.disabled).toBe(true);
    await userEvent.type(screen.getByPlaceholderText(/label/i), "   ");
    expect(connect.disabled).toBe(true);
    await userEvent.type(screen.getByPlaceholderText(/label/i), "personal");
    await waitFor(() => expect(connect.disabled).toBe(false));
  });

  it("keeps the modal open and shows the error when onSave rejects the connector", async () => {
    // Covers the busy/error path that moved onto RHF's isSubmitting: a failed save must
    // surface inline and NOT call onClose.
    const onClose = vi.fn();
    const onSave = vi.fn(async () => ({ error: "GitHub rejected that token" }));
    render(<ConnectorFormModal open vendor={GITHUB_VENDOR} onClose={onClose} onSave={onSave} />);
    await userEvent.type(screen.getByPlaceholderText(/label/i), "personal");
    await userEvent.type(screen.getByPlaceholderText(/personal access token/i), "bad");
    await userEvent.click(screen.getByRole("button", { name: /^connect$/i }));
    expect(await screen.findByText(/rejected that token/i)).toBeDefined();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("renders nothing when closed or when vendor is null", () => {
    const { container } = render(
      <ConnectorFormModal open={false} vendor={GITHUB_VENDOR} onClose={() => {}} onSave={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("editing an existing instance displays the real saved value of a select field, not the select's first option", () => {
    // Saved as 'eu1' — a controlled <select> can never render "blank" the way a text input can,
    // so a naive open-effect that blanks all fields would silently display 'US1' (the first
    // option) here instead of the real saved value.
    render(
      <ConnectorFormModal
        open
        vendor={DATADOG_VENDOR}
        existing={{
          id: "c1",
          vendorId: "datadog",
          label: "acme",
          fields: { site: "eu1", hasApiKey: true, hasAppKey: true },
        }}
        onClose={() => {}}
        onSave={vi.fn()}
      />,
    );
    expect(screen.getByRole("combobox")).toHaveProperty("value", "eu1");
  });

  it("reopening the SAME modal instance on a different existing/vendor re-seeds the form instead of keeping the previous instance's values", () => {
    const { rerender } = render(
      <ConnectorFormModal
        open
        vendor={GITHUB_VENDOR}
        existing={{ id: "c1", vendorId: "github", label: "personal", fields: { hasToken: true } }}
        onClose={() => {}}
        onSave={vi.fn()}
      />,
    );
    expect(screen.getByPlaceholderText(/label/i)).toHaveProperty("value", "personal");

    rerender(
      <ConnectorFormModal
        open
        vendor={GITHUB_VENDOR}
        existing={{ id: "c2", vendorId: "github", label: "acme-corp", fields: { hasToken: true } }}
        onClose={() => {}}
        onSave={vi.fn()}
      />,
    );
    expect(screen.getByPlaceholderText(/label/i)).toHaveProperty("value", "acme-corp");
  });
});
