/**
 * Every broker fetch call, lifted out of `useBrokerChat.ts`'s `useCallback`s
 * unchanged — same URL, method, headers, envelope key, and error handling.
 * Plain async functions, no React. This is the file the zod follow-up will
 * later add schemas to, so it must stay hook-free.
 */

import type {
  AgentRecordsResponse,
  ApiKeyListing,
  BlueprintT,
  ChannelsRecord,
  CliToolListing,
  ComposeOp,
  ConnectorInstanceRecord,
  ConnectorVendorMeta,
  DocT,
  ExecutionMode,
  MeRecord,
  VoiceSettingsRecord,
  WorkspaceRecord,
} from "./types";

export const BROKER_BASE = "127.0.0.1:7790";

/** All modes assumed unavailable except the one every machine can always run — the honest fallback when the broker's response is unreadable. */
const DEFAULT_EXECUTION_MODES: Record<ExecutionMode, boolean> = {
  "local-in-process": true,
  "local-docker": false,
  "remote-in-process": false,
  "remote-docker": false,
};

/**
 * POST /sessions — atomic create: the broker validates/acquires the runtime
 * before the session exists, so the caller either gets a live session or a
 * clean rejection.
 */
export async function postSession(
  base: string,
  workspace: string,
  runtime: ExecutionMode,
  prompt: string,
): Promise<{ error?: string; status?: number }> {
  try {
    const res = await fetch(`http://${base}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace, runtime, prompt }),
    });
    if (res.ok) return {};
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return { error: body.error ?? `broker returned ${res.status}`, status: res.status };
  } catch {
    return { error: "broker unreachable" };
  }
}

/** GET /execution-modes — which runtimes this machine can actually run right now, keyed by mode id. */
export async function getExecutionModes(base: string = BROKER_BASE): Promise<Record<ExecutionMode, boolean>> {
  const res = await fetch(`http://${base}/execution-modes`);
  const body = (await res.json()) as { modes?: Record<ExecutionMode, boolean> };
  return body.modes ?? DEFAULT_EXECUTION_MODES;
}

/** POST /utterance — fire-and-forget; the broker echoes accepted utterances back as WS frames, so a failed POST is already communicated by the UI going quiet. */
export async function postUtterance(text: string, base: string = BROKER_BASE): Promise<void> {
  void fetch(`http://${base}/utterance`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  }).catch(() => {
    /* broker down — the disabled composer already communicates this */
  });
}

/** POST /compose — fire-and-forget; roster frames simply won't change if this fails. */
export async function postCompose(op: ComposeOp, base: string = BROKER_BASE): Promise<void> {
  void fetch(`http://${base}/compose`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(op),
  }).catch(() => {
    /* broker down — roster frames simply won't change */
  });
}

/** POST /reset — tears down the requested scope (runtime/conversations/worktrees/agents) and reports what was killed/preserved. */
export async function resetSetup(
  scope: { runtime?: boolean; conversations?: boolean; worktrees?: boolean; agents?: boolean },
  base: string = BROKER_BASE,
): Promise<{ ok?: boolean; error?: string; swarm?: { preserved?: string[]; killed?: Record<string, number> } }> {
  const res = await fetch(`http://${base}/reset`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(scope),
  });
  return (await res.json()) as {
    ok?: boolean;
    error?: string;
    swarm?: { preserved?: string[]; killed?: Record<string, number> };
  };
}

/** GET /activity/:name — whether the named agent is busy, plus its current label/output. */
export async function getActivity(
  name: string,
  base: string = BROKER_BASE,
): Promise<{ busy: boolean; label?: string; output?: string }> {
  const res = await fetch(`http://${base}/activity/${encodeURIComponent(name)}`);
  return (await res.json()) as { busy: boolean; label?: string; output?: string };
}

/**
 * GET /agents — the full stored records, plus the `discord` and `voice`
 * siblings the broker attaches. Not interchangeable with the WS roster frame:
 * that frame is a view model carrying none of `engine`, `channels` or
 * `presence`, which is exactly what every consumer of this endpoint joins on.
 *
 * Only `agents` is defaulted here. `discord` and `voice` stay optional on
 * purpose — absent means "the broker did not say", and each caller has its own
 * rule for that (surfaces default to unconfigured, voice defaults to ENABLED
 * so an unknown never gates the mic).
 */
export async function getAgentRecords(base: string = BROKER_BASE): Promise<AgentRecordsResponse> {
  const res = await fetch(`http://${base}/agents`);
  const body = (await res.json()) as Partial<AgentRecordsResponse>;
  return { ...body, agents: body.agents ?? [] };
}

// 404/500 resolve with { error } and no outcome — the broker never fails to return JSON, so
// callers only need to guard the network layer, not the parse.
/** GET /agents/:id/removal — previews whether removing an agent would delete or archive it. */
export async function getRemovalPreview(
  id: string,
  base: string = BROKER_BASE,
): Promise<{ outcome?: "delete" | "archive"; reasons?: string[]; error?: string }> {
  const res = await fetch(`http://${base}/agents/${encodeURIComponent(id)}/removal`);
  return (await res.json()) as { outcome?: "delete" | "archive"; reasons?: string[]; error?: string };
}

/** DELETE /agents/:id — removes (or archives) an agent. */
export async function deleteAgent(
  id: string,
  base: string = BROKER_BASE,
): Promise<{ outcome?: string; error?: string }> {
  const res = await fetch(`http://${base}/agents/${encodeURIComponent(id)}`, { method: "DELETE" });
  return (await res.json()) as { outcome?: string; error?: string };
}

/** GET /workspaces — full workspace records, as the manager UI reads and writes them. */
export async function getWorkspaceRecords(base: string = BROKER_BASE): Promise<WorkspaceRecord[]> {
  const res = await fetch(`http://${base}/workspaces`);
  const body = (await res.json()) as { workspaces?: WorkspaceRecord[] };
  return body.workspaces ?? [];
}

/** POST/PUT /workspaces — creates (isNew) or updates a workspace record. */
export async function saveWorkspace(
  body: WorkspaceRecord,
  isNew: boolean,
  base: string = BROKER_BASE,
): Promise<{ error?: string; name?: string }> {
  const res = await fetch(`http://${base}/workspaces${isNew ? "" : `/${encodeURIComponent(body.name)}`}`, {
    method: isNew ? "POST" : "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as { error?: string; name?: string };
}

/** DELETE /workspaces/:name */
export async function removeWorkspace(
  name: string,
  base: string = BROKER_BASE,
): Promise<{ outcome?: string; error?: string }> {
  const res = await fetch(`http://${base}/workspaces/${encodeURIComponent(name)}`, { method: "DELETE" });
  return (await res.json()) as { outcome?: string; error?: string };
}

/** POST /workspaces/:name/verify-atlassian */
export async function verifyWorkspaceAtlassian(
  name: string,
  base: string = BROKER_BASE,
): Promise<{ ok?: boolean; detail?: string; error?: string }> {
  const res = await fetch(`http://${base}/workspaces/${encodeURIComponent(name)}/verify-atlassian`, {
    method: "POST",
  });
  return (await res.json()) as { ok?: boolean; detail?: string; error?: string };
}

/** POST /workspaces/:name/repos/:repoName/verify-github */
export async function verifyRepoGithub(
  name: string,
  repoName: string,
  base: string = BROKER_BASE,
): Promise<{ ok?: boolean; detail?: string; error?: string }> {
  const res = await fetch(
    `http://${base}/workspaces/${encodeURIComponent(name)}/repos/${encodeURIComponent(repoName)}/verify-github`,
    { method: "POST" },
  );
  return (await res.json()) as { ok?: boolean; detail?: string; error?: string };
}

/** GET /workspaces/:name/channels */
export async function getWorkspaceChannels(name: string, base: string = BROKER_BASE): Promise<ChannelsRecord> {
  const res = await fetch(`http://${base}/workspaces/${encodeURIComponent(name)}/channels`);
  return (await res.json()) as ChannelsRecord;
}

/** PUT /workspaces/:name/channels */
export async function saveWorkspaceChannels(
  name: string,
  body: { discord?: { botToken: string; textChannels: string[]; voiceChannels: string[] } },
  base: string = BROKER_BASE,
): Promise<ChannelsRecord & { error?: string }> {
  const res = await fetch(`http://${base}/workspaces/${encodeURIComponent(name)}/channels`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as ChannelsRecord & { error?: string };
}

/** POST /workspaces/:name/channels/verify-discord */
export async function verifyWorkspaceDiscord(
  name: string,
  base: string = BROKER_BASE,
): Promise<{ ok?: boolean; detail?: string; error?: string }> {
  const res = await fetch(`http://${base}/workspaces/${encodeURIComponent(name)}/channels/verify-discord`, {
    method: "POST",
  });
  return (await res.json()) as { ok?: boolean; detail?: string; error?: string };
}

/** GET /me/voice */
export async function getVoiceSettings(base: string = BROKER_BASE): Promise<VoiceSettingsRecord> {
  const res = await fetch(`http://${base}/me/voice`);
  return (await res.json()) as VoiceSettingsRecord;
}

/** PUT /me/voice */
export async function saveVoiceSettings(
  body: { stt: { instanceId: string } | null; tts: { instanceId: string } | null; hideInactive: boolean },
  base: string = BROKER_BASE,
): Promise<VoiceSettingsRecord & { error?: string }> {
  const res = await fetch(`http://${base}/me/voice`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as VoiceSettingsRecord & { error?: string };
}

/** GET /me — the operator's own profile. */
export async function getMe(base: string = BROKER_BASE): Promise<MeRecord> {
  const res = await fetch(`http://${base}/me`);
  return (await res.json()) as MeRecord;
}

/** PUT /me */
export async function updateMe(
  body: { name?: string },
  base: string = BROKER_BASE,
): Promise<MeRecord & { error?: string }> {
  const res = await fetch(`http://${base}/me`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as MeRecord & { error?: string };
}

/** GET /connectors/vendors — the connector catalog. */
export async function getConnectorVendors(base: string = BROKER_BASE): Promise<ConnectorVendorMeta[]> {
  const res = await fetch(`http://${base}/connectors/vendors`);
  return (await res.json()) as ConnectorVendorMeta[];
}

/** GET /me/connectors — the operator's own connector instances. */
export async function getMyConnectors(base: string = BROKER_BASE): Promise<ConnectorInstanceRecord[]> {
  const res = await fetch(`http://${base}/me/connectors`);
  return (await res.json()) as ConnectorInstanceRecord[];
}

/** POST /me/connectors */
export async function addConnector(
  body: { vendorId: string; label: string; fields: Record<string, string> },
  base: string = BROKER_BASE,
): Promise<ConnectorInstanceRecord & { error?: string }> {
  const res = await fetch(`http://${base}/me/connectors`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as ConnectorInstanceRecord & { error?: string };
}

/** PUT /me/connectors/:id */
export async function updateConnector(
  id: string,
  body: { label?: string; fields?: Record<string, string> },
  base: string = BROKER_BASE,
): Promise<ConnectorInstanceRecord & { error?: string }> {
  const res = await fetch(`http://${base}/me/connectors/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as ConnectorInstanceRecord & { error?: string };
}

/** DELETE /me/connectors/:id */
export async function deleteConnector(
  id: string,
  base: string = BROKER_BASE,
): Promise<{ ok?: boolean; error?: string }> {
  const res = await fetch(`http://${base}/me/connectors/${encodeURIComponent(id)}`, { method: "DELETE" });
  return (await res.json()) as { ok?: boolean; error?: string };
}

/** POST /me/connectors/:id/verify */
export async function verifyConnector(
  id: string,
  extra?: Record<string, string>,
  base: string = BROKER_BASE,
): Promise<{ ok?: boolean; detail?: string; error?: string }> {
  const res = await fetch(`http://${base}/me/connectors/${encodeURIComponent(id)}/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ extra }),
  });
  return (await res.json()) as { ok?: boolean; detail?: string; error?: string };
}

/** GET /cli-tools — catalog engine joined with machine status. */
export async function getCliTools(base: string = BROKER_BASE): Promise<CliToolListing[]> {
  const res = await fetch(`http://${base}/cli-tools`);
  return ((await res.json()) as { tools?: CliToolListing[] }).tools ?? [];
}

/** GET /containers */
export async function getContainers(base: string = BROKER_BASE): Promise<{ docker: { enabled: boolean } }> {
  const res = await fetch(`http://${base}/containers`);
  return (await res.json()) as { docker: { enabled: boolean } };
}

/** PUT /containers */
export async function setDockerEnabled(
  enabled: boolean,
  base: string = BROKER_BASE,
): Promise<{ docker: { enabled: boolean } }> {
  const res = await fetch(`http://${base}/containers`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ docker: { enabled } }),
  });
  return (await res.json()) as { docker: { enabled: boolean } };
}

/** POST /containers/verify */
export async function verifyContainers(base: string = BROKER_BASE): Promise<{ ok: boolean; detail: string }> {
  const res = await fetch(`http://${base}/containers/verify`, { method: "POST" });
  return (await res.json()) as { ok: boolean; detail: string };
}

/** POST /cli-tools/refresh?tool=:tool — re-detects one tool, or every tool when omitted. */
export async function refreshCliTools(tool?: string, base: string = BROKER_BASE): Promise<CliToolListing[]> {
  const res = await fetch(`http://${base}/cli-tools/refresh${tool ? `?tool=${encodeURIComponent(tool)}` : ""}`, {
    method: "POST",
  });
  return ((await res.json()) as { tools?: CliToolListing[] }).tools ?? [];
}

/** PUT /cli-tools/:id */
export async function setCliToolEnabled(
  id: string,
  enabled: boolean,
  base: string = BROKER_BASE,
): Promise<CliToolListing[] | { error: string }> {
  const res = await fetch(`http://${base}/cli-tools/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  const body = (await res.json()) as { tools?: CliToolListing[]; error?: string };
  return body.error ? { error: body.error } : (body.tools ?? []);
}

/** GET /api-keys — provider keys joined with redacted machine state. */
export async function getApiKeys(base: string = BROKER_BASE): Promise<ApiKeyListing[]> {
  const res = await fetch(`http://${base}/api-keys`);
  return ((await res.json()) as { providers?: ApiKeyListing[] }).providers ?? [];
}

/** PUT /api-keys/:id — returns the refreshed listing, or {error} on rejection. */
export async function saveApiKey(
  id: string,
  key: string,
  base: string = BROKER_BASE,
): Promise<ApiKeyListing[] | { error: string }> {
  const res = await fetch(`http://${base}/api-keys/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key }),
  });
  const body = (await res.json()) as { providers?: ApiKeyListing[]; error?: string };
  return body.error ? { error: body.error } : (body.providers ?? []);
}

/** POST /api-keys/:id/verify */
export async function verifyApiKey(
  id: string,
  base: string = BROKER_BASE,
): Promise<ApiKeyListing[] | { error: string }> {
  const res = await fetch(`http://${base}/api-keys/${encodeURIComponent(id)}/verify`, { method: "POST" });
  const body = (await res.json()) as { providers?: ApiKeyListing[]; error?: string };
  return body.error ? { error: body.error } : (body.providers ?? []);
}

/** DELETE /api-keys/:id */
export async function deleteApiKey(
  id: string,
  base: string = BROKER_BASE,
): Promise<ApiKeyListing[] | { error: string }> {
  const res = await fetch(`http://${base}/api-keys/${encodeURIComponent(id)}`, { method: "DELETE" });
  const body = (await res.json()) as { providers?: ApiKeyListing[]; error?: string };
  return body.error ? { error: body.error } : (body.providers ?? []);
}

/** POST /activity/:name/:action — steer or cancel a running agent; returns an error string, or null on success. */
export async function postWorkAction(
  name: string,
  action: "steer" | "cancel",
  message?: string,
  base: string = BROKER_BASE,
): Promise<string | null> {
  const res = await fetch(`http://${base}/activity/${encodeURIComponent(name)}/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(message ? { message } : {}),
  });
  if (res.ok) return null;
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error ?? `HTTP ${res.status}`;
}

/** POST /sessions/:id/activate — fire-and-forget. */
export async function activateSession(id: string, base: string = BROKER_BASE): Promise<void> {
  void fetch(`http://${base}/sessions/${encodeURIComponent(id)}/activate`, { method: "POST" }).catch(() => {});
}

/**
 * DELETE /sessions/:id — permanent, so unlike activate this one is awaited and
 * reports its failure: a delete that silently did nothing would leave the row
 * on screen with no explanation. The refreshed list arrives on the sessions
 * frame, not in this response.
 */
export async function deleteSession(id: string, base: string = BROKER_BASE): Promise<string | null> {
  try {
    const res = await fetch(`http://${base}/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (res.ok) return null;
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return body.error ?? `HTTP ${res.status}`;
  } catch {
    return "broker unreachable";
  }
}

/** GET /blueprints — the creation form's schema list. */
export async function getBlueprints(base: string = BROKER_BASE): Promise<BlueprintT[]> {
  try {
    const res = await fetch(`http://${base}/blueprints`);
    if (!res.ok) return [];
    const body = (await res.json()) as { blueprints?: BlueprintT[] };
    return body.blueprints ?? [];
  } catch {
    return [];
  }
}

/** POST /documents — creates the doc AND its document session; the documents/session frames follow on the socket. */
export async function postDocument(
  blueprintId: string,
  text: string,
  workType?: string,
  base: string = BROKER_BASE,
): Promise<{ doc?: DocT; error?: string }> {
  try {
    const res = await fetch(`http://${base}/documents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ blueprintId, workType, text }),
    });
    const body = (await res.json().catch(() => ({}))) as { doc?: DocT; error?: string };
    if (res.ok && body.doc) return { doc: body.doc };
    return { error: body.error ?? `broker returned ${res.status}` };
  } catch {
    return { error: "broker unreachable" };
  }
}

/** PATCH /documents/:id — re-cast an untouched document under another blueprint. */
export async function patchDocBlueprint(
  docId: string,
  blueprintId: string,
  base: string = BROKER_BASE,
): Promise<{ error?: string }> {
  try {
    const res = await fetch(`http://${base}/documents/${encodeURIComponent(docId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ blueprintId }),
    });
    if (res.ok) return {};
    const parsed = (await res.json().catch(() => ({}))) as { error?: string };
    return { error: parsed.error ?? `broker returned ${res.status}` };
  } catch {
    return { error: "broker unreachable" };
  }
}

/** PATCH /documents/:id — rename the page; the refreshed documents frame follows. */
export async function patchDocTitle(
  docId: string,
  title: string,
  base: string = BROKER_BASE,
): Promise<{ error?: string }> {
  try {
    const res = await fetch(`http://${base}/documents/${encodeURIComponent(docId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    });
    if (res.ok) return {};
    const parsed = (await res.json().catch(() => ({}))) as { error?: string };
    return { error: parsed.error ?? `broker returned ${res.status}` };
  } catch {
    return { error: "broker unreachable" };
  }
}

/** PATCH a section body; the refreshed documents frame follows on the socket. */
export async function patchDocSection(
  docId: string,
  sectionId: string,
  body: string,
  base: string = BROKER_BASE,
): Promise<{ error?: string }> {
  try {
    const res = await fetch(
      `http://${base}/documents/${encodeURIComponent(docId)}/sections/${encodeURIComponent(sectionId)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body }),
      },
    );
    if (res.ok) return {};
    const parsed = (await res.json().catch(() => ({}))) as { error?: string };
    return { error: parsed.error ?? `broker returned ${res.status}` };
  } catch {
    return { error: "broker unreachable" };
  }
}

/** POST /polish — rewrite a draft; null-equivalent failure keeps the caller's draft. */
export async function postPolish(text: string, base: string = BROKER_BASE): Promise<{ text?: string; error?: string }> {
  try {
    const res = await fetch(`http://${base}/polish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const body = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
    if (res.ok && body.text) return { text: body.text };
    return { error: body.error ?? `broker returned ${res.status}` };
  } catch {
    return { error: "broker unreachable" };
  }
}

/** Composer-facing polish adapter: null on any failure so the caller keeps the draft. */
export async function polishDraft(text: string): Promise<string | null> {
  const r = await postPolish(text);
  return r.text ?? null;
}
