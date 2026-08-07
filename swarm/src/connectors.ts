// swarm/src/connectors.ts
// The vendor registry: one shape drives storage (users.ts), the CRUD+verify
// API (server.ts), and the control-plane's card grid + connect form. Adding
// a vendor later is adding an entry here — not new routes/fields/redaction
// logic (design §"Settled decisions").
import { verifyAtlassian } from './verify-atlassian.js';
import { verifyGithubToken } from './verify-github.js';
import { verifyDatadog } from './verify-datadog.js';
import { verifySnyk } from './verify-snyk.js';
import { verifyElevenlabs } from './verify-elevenlabs.js';
import { verifyDeepgram } from './verify-deepgram.js';

export interface ConnectorFieldDef {
  key: string;
  label: string;
  /** true -> password input; redacted as `has<Key>: boolean` in every API response. */
  secret: boolean;
  type?: 'text' | 'select';
  /** Required when type is 'select'. */
  options?: { value: string; label: string }[];
}

export interface ConnectorVendorDef {
  id: string;
  label: string;
  description: string;
  /** Persisted on the saved ConnectorInstance. */
  fields: ConnectorFieldDef[];
  /**
   * Transient, verify-time-only input — collected on the connect form and on
   * "Re-check", but NEVER written to the saved instance's `fields`. Exists
   * because some vendors (Atlassian) have no way to validate a credential
   * without also knowing something that isn't part of the credential itself
   * (which Jira/Confluence site to test against).
   */
  verifyExtraFields?: ConnectorFieldDef[];
  /** Voice capabilities this vendor's credential can power (spec §1). Absent = not a voice vendor. */
  capabilities?: ('stt' | 'tts')[];
  verify(
    fields: Record<string, string>,
    extra: Record<string, string>,
    fetchImpl?: typeof fetch,
  ): Promise<{ ok: boolean; detail: string }>;
}

const ATLASSIAN: ConnectorVendorDef = {
  id: 'atlassian',
  label: 'Atlassian',
  description: 'Jira issues and Confluence docs — lookup and search from a workspace.',
  fields: [
    { key: 'email', label: 'Atlassian account email', secret: false },
    { key: 'apiToken', label: 'API token', secret: true },
  ],
  // Atlassian API tokens have no site-independent validity check (researched
  // during design — api.atlassian.com/me is OAuth-bearer-only, rejects Basic
  // auth; no fixed global hostname exists the way GitHub's api.github.com
  // does). A site is required to test the credential at all, but the site
  // itself is workspace-owned, not part of this credential — so it's
  // collected here only transiently, for the test call, never saved.
  verifyExtraFields: [
    { key: 'testSiteUrl', label: 'Site URL (used only to test this connection — not saved)', secret: false },
  ],
  verify: (fields, extra, fetchImpl) =>
    verifyAtlassian(extra.testSiteUrl ?? '', fields.email ?? '', fields.apiToken ?? '', undefined, fetchImpl),
};

const GITHUB: ConnectorVendorDef = {
  id: 'github',
  label: 'GitHub',
  description: 'Repo access and pull requests.',
  fields: [{ key: 'token', label: 'Personal access token', secret: true }],
  verify: (fields, _extra, fetchImpl) => verifyGithubToken(fields.token ?? '', fetchImpl),
};

const DATADOG: ConnectorVendorDef = {
  id: 'datadog',
  label: 'Datadog',
  description: 'Monitors, dashboards, and observability data.',
  fields: [
    {
      key: 'site',
      label: 'Site',
      secret: false,
      type: 'select',
      options: [
        { value: 'us1', label: 'US1 (default)' },
        { value: 'us3', label: 'US3' },
        { value: 'us5', label: 'US5' },
        { value: 'eu1', label: 'EU1' },
        { value: 'ap1', label: 'AP1 (Japan)' },
        { value: 'ap2', label: 'AP2 (Australia)' },
        { value: 'uk1', label: 'UK1' },
        { value: 'us1fed', label: 'US1-FED' },
        { value: 'us2fed', label: 'US2-FED' },
      ],
    },
    { key: 'apiKey', label: 'API key', secret: true },
    { key: 'appKey', label: 'Application key', secret: true },
  ],
  verify: (fields, _extra, fetchImpl) =>
    verifyDatadog(fields.site || 'us1', fields.apiKey ?? '', fields.appKey ?? '', fetchImpl),
};

const SNYK: ConnectorVendorDef = {
  id: 'snyk',
  label: 'Snyk',
  description: 'Vulnerability and dependency data.',
  fields: [
    {
      key: 'region',
      label: 'Region',
      secret: false,
      type: 'select',
      options: [
        { value: 'us-01', label: 'US-01 (default)' },
        { value: 'us-02', label: 'US-02' },
        { value: 'eu-01', label: 'EU-01' },
        { value: 'au-01', label: 'AU-01' },
      ],
    },
    { key: 'token', label: 'API token', secret: true },
  ],
  verify: (fields, _extra, fetchImpl) => verifySnyk(fields.region || 'us-01', fields.token ?? '', fetchImpl),
};

const ELEVENLABS: ConnectorVendorDef = {
  id: 'elevenlabs',
  label: 'ElevenLabs',
  description: 'Text-to-speech — the voices agents speak with.',
  fields: [{ key: 'apiKey', label: 'API key', secret: true }],
  capabilities: ['tts'],
  verify: (fields, _extra, fetchImpl) => verifyElevenlabs(fields.apiKey ?? '', fetchImpl),
};

const DEEPGRAM: ConnectorVendorDef = {
  id: 'deepgram',
  label: 'Deepgram',
  description: 'Speech-to-text — how agents hear you.',
  fields: [{ key: 'apiKey', label: 'API key', secret: true }],
  capabilities: ['stt'],
  verify: (fields, _extra, fetchImpl) => verifyDeepgram(fields.apiKey ?? '', fetchImpl),
};

export const VENDORS: ConnectorVendorDef[] = [ATLASSIAN, GITHUB, DATADOG, SNYK, ELEVENLABS, DEEPGRAM];

export function findVendor(id: string): ConnectorVendorDef | undefined {
  return VENDORS.find((v) => v.id === id);
}
