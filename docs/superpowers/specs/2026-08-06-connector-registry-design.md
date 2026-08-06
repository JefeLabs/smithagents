# Connector Registry (Extensible Vendor Connectors) — Design

**Date:** 2026-08-06
**Status:** Approved (Edwin, 2026-08-06)
**Scope:** Replace today's hardcoded Atlassian/GitHub credential fields on `User`
with a generic, extensible connector registry — supporting new vendors
(DataDog, Snyk, and others later) without a schema change per vendor,
multiple named credentials per vendor per user, and a full-screen Settings
surface with a card-based Integrations screen to manage them.

## Goal

Today, `User.atlassian?`/`User.github?` are two hardcoded fields, each with
its own bespoke swarm route, redaction flag, and verify function. Adding a
vendor means repeating that whole pattern from scratch. This spec makes
connector credentials data-driven — one shape (`ConnectorVendorDef` +
`ConnectorInstance`) that any vendor plugs into — migrates Atlassian/GitHub
into it (no special-casing left behind), adds DataDog and Snyk as the first
two "new" vendors under that system, and supports a user holding *multiple*
named credentials per vendor (e.g. a "personal" and an "acme-corp" GitHub
PAT), with workspaces explicitly picking which one they use.

## Settled decisions

- **Generic extensible registry, not a growing hardcoded list.** One
  `ConnectorVendorDef` shape (id, label, field definitions, verify function)
  drives storage, API, and UI for every vendor. Adding a vendor later is a
  registry entry, not new routes/fields/redaction logic each time.
- **Each vendor declares its own fields.** Atlassian needs `email` +
  `apiToken`; GitHub needs `token`; DataDog needs `site` + `apiKey` +
  `appKey`; Snyk needs `region` + `token`. No forced normalization to a
  single "PAT" field — that would drop Atlassian's email pairing and doesn't
  fit multi-key vendors.
- **Every vendor gets a live verify check, including the two new ones.**
  DataDog and Snyk's verify endpoints are researched and specified below
  (§2), not stubbed — this was an explicit call: no vendor ships without a
  working "Test connection."
- **Atlassian and GitHub are fully migrated into the registry — no legacy
  special case left running alongside it.** `verify-atlassian.ts` and
  `verify-github.ts`'s logic becomes those two vendors' `verify` functions;
  `dispatcher.ts`, `materialize()`'s MCP env injection, and every route that
  reads `user.atlassian`/`user.github` today reads through the generic
  `connectors` list instead.
- **A user can hold multiple named credentials per vendor.** Each
  `ConnectorInstance` has a user-chosen `label` ("personal", "acme-corp").
  Workspaces reference a *specific* instance by id, not "the user's
  credential for this vendor" — explicit and unambiguous, since an agent
  acting under the wrong PAT is a real access-control mistake, not just a
  UX inconvenience.
- **Store + verify only for the two new vendors — no new agent tools.**
  DataDog/Snyk connectors are connectable and verifiable in this feature.
  No agent-facing tool consumes them yet (unlike Atlassian/GitHub's
  `lookup_ticket`/`search_docs`/PR creation) — that's separate future work
  once there's a concrete use case for what an agent would do with them.
- **Settings becomes a full-screen surface, replacing today's small
  popover.** Left nav of groups (General, Integrations, Channels, Themes);
  today's destructive reset actions move into General. Modeled on the
  reference screenshots Edwin provided (a grouped-sidebar settings screen;
  a per-vendor integration card with a connect button and status pill; a
  per-vendor "Connect X" form with vendor-specific fields).
- **Workspaces stays where it is.** "Manage workspaces…" remains in the
  Sessions panel footer — explicitly not folded into this Settings redesign,
  to keep this feature scoped to what was asked.

## 1. Data model

**Registry** (`swarm/src/connectors.ts`, new) — a static list of vendor
definitions:

```ts
export interface ConnectorFieldDef {
  key: string;                    // 'apiToken' | 'email' | 'apiKey' | 'appKey' | 'token' | 'site' | 'region'
  label: string;                  // shown on the connect form
  secret: boolean;                // true -> password input; redacted as hasX boolean in API responses
  type?: 'text' | 'select';       // default 'text'
  options?: { value: string; label: string }[];  // required when type is 'select'
}

export interface ConnectorVendorDef {
  id: string;                     // 'atlassian' | 'github' | 'datadog' | 'snyk'
  label: string;                  // 'Atlassian' | 'GitHub' | 'Datadog' | 'Snyk'
  description: string;            // shown on the integration card, e.g. "Browse, create, and start work from Jira Cloud issues."
  fields: ConnectorFieldDef[];
  verify(fields: Record<string, string>, fetchImpl?: typeof fetch): Promise<{ ok: boolean; detail: string }>;
}

export const VENDORS: ConnectorVendorDef[] = [ATLASSIAN, GITHUB, DATADOG, SNYK];
```

**Per-user storage** (`swarm/src/users.ts`, modified) — replaces today's
`atlassian?`/`github?` fields:

```ts
export interface ConnectorInstance {
  id: string;                     // generated (short id/slug) — stable identity workspaces reference
  vendorId: string;
  label: string;                  // user-chosen: "personal", "acme-corp"
  fields: Record<string, string>; // raw values including secrets — file already untracked + 0600
}

export interface User {
  id: string;
  name: string;
  default?: boolean;
  connectors?: ConnectorInstance[];
}
```

**Migration is lazy, on load, no one-time script.** `loadUsersFromDir`
recognizes the old `{atlassian, github}` shape on read and upgrades it in
memory to one or two `ConnectorInstance` entries (`vendorId: 'atlassian'`
and/or `'github'`, `label: 'default'`, a generated `id`) before returning
the `User`. The file is rewritten in the new shape the next time anything
about that user is saved. Existing saved tokens (including Edwin's own,
already on disk from the earlier connectors feature) survive untouched —
no re-entry required.

## 2. Verification

Atlassian and GitHub keep their existing verify logic (`verify-atlassian.ts`,
`verify-github.ts`), now registered as those two vendors' `verify` functions
in the registry rather than called from bespoke routes.

**DataDog** — fields: `site` (select — US1/US3/US5/EU1/AP1/AP2/UK1/US1-FED/US2-FED,
default US1), `apiKey` (secret), `appKey` (secret).

```
GET https://api.{site-host}/api/v2/validate_keys
Headers: DD-API-KEY: <apiKey>, DD-APPLICATION-KEY: <appKey>
Success (200): {"status": "ok"}
Failure (401/403): {"errors": [...]}
```

This is the only DataDog endpoint that validates both keys together — the
simpler `/api/v1/validate` only checks the API key, and the app key has no
standalone validation endpoint. Site hosts: `api.datadoghq.com` (US1),
`api.us3.datadoghq.com`, `api.us5.datadoghq.com`, `api.datadoghq.eu` (EU1),
`api.ap1.datadoghq.com`, `api.ap2.datadoghq.com`, `api.uk1.datadoghq.com`,
`api.ddog-gov.com`, `api.us2.ddog-gov.com`. A key from one site does not
validate against another site's host — this is why `site` is a required
field, not an assumption.

**Snyk** — fields: `region` (select — US-01/US-02/EU-01/AU-01, default
US-01), `token` (secret).

```
GET https://api.{region-host}/rest/self?version=<today, YYYY-MM-DD>
Headers: Authorization: token <token>
Success (200): {"data": {"type": "user"|"service_account"|"app_instance", "id": "...", "attributes": {...}}}
Failure (401): {"errors": [{"status": "401", "details": "Unauthorized"}]}
```

Region hosts: `api.snyk.io` (US-01, default), `api.us.snyk.io` (US-02),
`api.eu.snyk.io` (EU-01), `api.au.snyk.io` (AU-01). The `version` query
param is mandatory syntactically for a real call, but auth is checked
before version parsing — a validity check (401 vs. 2xx) works even if the
version string is stale, so this is computed as "today's date" at call time
rather than a hardcoded constant. Covers personal access tokens and service
account tokens identically (the response's `data.type` distinguishes them).

## 3. Workspace-side resolution (multi-credential)

`Workspace.atlassian` (`swarm/src/workspaces.ts`) gains a required
`connectorId: string` once at least one Atlassian connector instance exists
for the current user. Each entry in `WorkspaceRepo.github[]` gains its own
`connectorId: string` — repos can belong to different orgs needing
different PATs, so the connector choice is per-repo, not per-workspace.

`WorkspaceManagerModal`'s Atlassian fieldset and per-repo GitHub rows
replace their inline email/token inputs with a dropdown listing the current
user's connector instances for that vendor, by label.

`dispatcher.ts`'s `resolveConnections()` and `drivers/claude.ts`'s
`materialize()` (MCP env var injection) resolve through `workspace.atlassian
.connectorId` / `repo.github.connectorId` — look up that id among the
current user's `connectors` filtered to the matching `vendorId`, and use its
`fields` — instead of reading `user.atlassian`/`user.github` directly.

## 4. API (swarm + broker proxy)

**Swarm:**
- `GET /connectors/vendors` — registry metadata only (id, label, description,
  field definitions *without* values) — safe, non-secret, drives the
  Integrations card grid and each vendor's connect-form fields.
- `GET /me/connectors` — the current user's instances, redacted (secret
  fields become `has<Field>: boolean`; non-secret fields like `site`/`region`
  pass through as-is).
- `POST /me/connectors` — add an instance: `{vendorId, label, fields}` ->
  redacted instance.
- `PUT /me/connectors/:id` — update label and/or fields. Same
  partial-update-preserves-existing-secret convention already established
  for `PUT /me` and `PUT /workspaces/:name/channels`: a blank secret field
  in the submission falls back to the existing stored value, never wipes it.
- `DELETE /me/connectors/:id` — remove an instance.
- `POST /me/connectors/:id/verify` — runs that instance's vendor `verify`
  function against its stored fields.

**Broker proxy:** thin passthrough methods on `SwarmClient`, local routes on
`text-channel.ts`, with the same origin-allowlist CORS treatment already
applied to every other credential-adjacent route in that file.

## 5. UI — full-screen Settings

Replaces today's small anchored popover (`SettingsPanel`, ~340px, absolute-
positioned near the rail) entirely with a full-screen surface, opened the
same way (Settings button in `ToolRail`) but rendered as its own page-level
view with a "back to app" exit.

**Left nav — four groups:**
- **General** — today's destructive reset actions (kill running instances,
  clear conversations, prune worktrees, remove agents), moved here from the
  old popover.
- **Integrations** — a card grid, one card per `ConnectorVendorDef` (icon,
  label, description, connect button). Since a vendor can hold multiple
  named instances, a card with existing connections lists them (label +
  status pill + re-check + remove), with an "+ add another" action opening
  the connect-form modal. A vendor with zero connections shows a single
  "Connect {vendor}" button, matching the reference Jira card.
- **Channels** — today's `ChannelsManagerModal` content, inline as a group
  instead of a separate modal (workspace picker + Discord bot token/channel
  form).
- **Themes** — today's theme picker, moved from the old popover into its
  own group.

**Connect-form modal** (opens from a card's "Connect"/"+ add another"):
vendor name, a `label` input (how this instance is named), then one input
per the vendor's `ConnectorFieldDef[]` (text or select, secret fields as
password inputs), Cancel/Connect actions — matching the reference "Connect
Jira site" mockup's shape, generalized to whatever fields the selected
vendor declares instead of Jira-specific ones.

"Manage workspaces…" is unaffected — stays in the Sessions panel footer.

## Out of scope

- New agent-facing tools that consume DataDog or Snyk credentials (e.g. a
  monitor-status check, a vulnerability list) — this feature only makes
  those credentials connectable and verifiable.
- Auto-matching a workspace/repo to a connector by heuristic (e.g. token
  scope vs. repo owner) — explicitly rejected in favor of an explicit
  per-workspace/per-repo `connectorId` pick.
- Folding "manage workspaces…" into the new Settings surface.
- Any vendor beyond Atlassian, GitHub, DataDog, and Snyk for this pass —
  the registry is built to make adding one later cheap, but no additional
  vendor definitions ship in this feature.
- OAuth-based connection flows — every vendor here authenticates via a
  pasted token/key pair, matching today's Atlassian/GitHub pattern.
