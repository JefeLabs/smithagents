/**
 * Query-key-driven wrappers around every HTTP-backed broker call in
 * `api/broker.ts`. Every query hook is the same three-line shape; every
 * mutation invalidates or overwrites exactly the cache entries its broker
 * response can actually justify — see the section comments below for which
 * of the four mutation shapes a given hook follows.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as api from "../api/broker";
import type {
  ApiKeyListing,
  ChannelsRecord,
  CliToolListing,
  MeRecord,
  VoiceSettingsRecord,
  WorkspaceRecord,
} from "../api/types";
import { qk } from "./keys";

// ---------------------------------------------------------------------------
// Query hooks
// ---------------------------------------------------------------------------

/**
 * `enabled` exists so a caller can defer the request until the UI that needs
 * it is actually on screen — Query then fetches on the false→true flip, which
 * is what a mount-and-refetch-on-open effect used to hand-roll. Defaulting to
 * true keeps every unconditional caller unchanged.
 */
export function useWorkspaceRecords(enabled = true) {
  return useQuery({ queryKey: qk.workspaceRecords, queryFn: () => api.getWorkspaceRecords(), enabled });
}

/**
 * `enabled` exists so `ChannelsGroup` can hold the fetch off until a workspace is actually
 * selected — same reasoning as `useWorkspaceRecords`. Defaulting to true keeps this
 * unaffected for any caller that always has a name in hand.
 */
export function useWorkspaceChannels(name: string, enabled = true) {
  return useQuery({ queryKey: qk.workspaceChannels(name), queryFn: () => api.getWorkspaceChannels(name), enabled });
}

/**
 * `GET /agents` — the one cache entry three consumers share: engine warnings
 * (`queries/health.ts`), surface policy, and the voice capability gate. It
 * replaced three independent fetches of the same URL, so a single invalidation
 * now refreshes all three, and switching which agent a component is looking at
 * re-selects from cache rather than issuing a request that could land stale.
 *
 * Distinct from `useRoster()` (`queries/pushed.ts`) on purpose — see
 * `api.getAgentRecords` for why the roster frame cannot stand in for this.
 */
export function useAgentRecords() {
  return useQuery({ queryKey: qk.agentRecords, queryFn: () => api.getAgentRecords() });
}

export function useConnectorVendors() {
  return useQuery({ queryKey: qk.connectorVendors, queryFn: () => api.getConnectorVendors() });
}

export function useMyConnectors() {
  return useQuery({ queryKey: qk.myConnectors, queryFn: () => api.getMyConnectors() });
}

/** `GET /blueprints` — the composer's document chips. Static per broker run. */
export function useBlueprints() {
  return useQuery({ queryKey: qk.blueprints, queryFn: () => api.getBlueprints(), staleTime: Number.POSITIVE_INFINITY });
}

export function useCliTools() {
  return useQuery({ queryKey: qk.cliTools, queryFn: () => api.getCliTools() });
}

export function useApiKeys() {
  return useQuery({ queryKey: qk.apiKeys, queryFn: () => api.getApiKeys() });
}

export function useContainers() {
  return useQuery({ queryKey: qk.containers, queryFn: () => api.getContainers() });
}

export function useVoiceSettings() {
  return useQuery({ queryKey: qk.voiceSettings, queryFn: () => api.getVoiceSettings() });
}

export function useMe() {
  return useQuery({ queryKey: qk.me, queryFn: () => api.getMe() });
}

/** Same visibility gate as `useWorkspaceRecords` — see the note there. */
export function useExecutionModes(enabled = true) {
  return useQuery({ queryKey: qk.executionModes, queryFn: () => api.getExecutionModes(), enabled });
}

export function useActivity(name: string) {
  return useQuery({ queryKey: qk.activity(name), queryFn: () => api.getActivity(name) });
}

// ---------------------------------------------------------------------------
// List-returning mutations — the broker returns the refreshed list on
// success, so we write it straight into the cache rather than invalidating
// and re-requesting what we just got. An {error} response leaves the cache
// untouched and surfaces via mutation.data.
// ---------------------------------------------------------------------------

export function useSaveApiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, key }: { id: string; key: string }) => api.saveApiKey(id, key),
    onSuccess: (result) => {
      if (Array.isArray(result)) qc.setQueryData<ApiKeyListing[]>(qk.apiKeys, result);
    },
  });
}

export function useVerifyApiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.verifyApiKey(id),
    onSuccess: (result) => {
      if (Array.isArray(result)) qc.setQueryData<ApiKeyListing[]>(qk.apiKeys, result);
    },
  });
}

export function useDeleteApiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteApiKey(id),
    onSuccess: (result) => {
      if (Array.isArray(result)) qc.setQueryData<ApiKeyListing[]>(qk.apiKeys, result);
    },
  });
}

export function useSetCliToolEnabled() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.setCliToolEnabled(id, enabled),
    onSuccess: (result) => {
      if (Array.isArray(result)) qc.setQueryData<CliToolListing[]>(qk.cliTools, result);
    },
  });
}

export function useRefreshCliTools() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (tool?: string) => api.refreshCliTools(tool),
    onSuccess: (result) => {
      if (Array.isArray(result)) qc.setQueryData<CliToolListing[]>(qk.cliTools, result);
    },
  });
}

// ---------------------------------------------------------------------------
// Record-returning mutations — write the result straight into the cache
// when it carries no {error}, same reasoning as the list-returning group.
// ---------------------------------------------------------------------------

export function useSaveVoiceSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { stt: { instanceId: string } | null; tts: { instanceId: string } | null; enabled: boolean }) =>
      api.saveVoiceSettings(body),
    onSuccess: (result) => {
      if (!result.error) qc.setQueryData<VoiceSettingsRecord>(qk.voiceSettings, result);
    },
  });
}

export function useUpdateMe() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name?: string }) => api.updateMe(body),
    onSuccess: (result) => {
      if (!result.error) qc.setQueryData<MeRecord>(qk.me, result);
    },
  });
}

export function useSetDockerEnabled() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) => api.setDockerEnabled(enabled),
    onSuccess: (result) => {
      qc.setQueryData(qk.containers, result);
    },
  });
}

export function useSaveWorkspaceChannels() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      name,
      body,
    }: {
      name: string;
      body: { discord?: { botToken: string; textChannels: string[]; voiceChannels: string[] } };
    }) => api.saveWorkspaceChannels(name, body),
    onSuccess: (result, { name }) => {
      if (!result.error) qc.setQueryData<ChannelsRecord>(qk.workspaceChannels(name), result);
    },
  });
}

// ---------------------------------------------------------------------------
// Invalidating mutations — the broker returns no list for these, so we
// invalidate the caches the change could plausibly affect instead of trying
// to reconstruct them from a partial response.
// ---------------------------------------------------------------------------

export function useSaveWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ body, isNew }: { body: WorkspaceRecord; isNew: boolean }) => api.saveWorkspace(body, isNew),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.workspaceRecords });
      qc.invalidateQueries({ queryKey: qk.workspaces });
    },
  });
}

export function useRemoveWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.removeWorkspace(name),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.workspaceRecords });
      qc.invalidateQueries({ queryKey: qk.workspaces });
    },
  });
}

export function useAddConnector() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { vendorId: string; label: string; fields: Record<string, string> }) => api.addConnector(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.myConnectors });
      qc.invalidateQueries({ queryKey: qk.me });
    },
  });
}

export function useUpdateConnector() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: { label?: string; fields?: Record<string, string> } }) =>
      api.updateConnector(id, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.myConnectors });
      qc.invalidateQueries({ queryKey: qk.me });
    },
  });
}

export function useDeleteConnector() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteConnector(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.myConnectors });
      qc.invalidateQueries({ queryKey: qk.me });
    },
  });
}

// ---------------------------------------------------------------------------
// Verify mutations — fire-and-report. They return {ok, detail} and mutate
// no cache; the component reads mutation.data directly.
// ---------------------------------------------------------------------------

export function useVerifyConnector() {
  return useMutation({
    mutationFn: ({ id, extra }: { id: string; extra?: Record<string, string> }) => api.verifyConnector(id, extra),
  });
}

export function useVerifyContainers() {
  return useMutation({
    mutationFn: () => api.verifyContainers(),
  });
}

export function useVerifyWorkspaceDiscord() {
  return useMutation({
    mutationFn: (name: string) => api.verifyWorkspaceDiscord(name),
  });
}

export function useVerifyWorkspaceAtlassian() {
  return useMutation({
    mutationFn: (name: string) => api.verifyWorkspaceAtlassian(name),
  });
}

export function useVerifyRepoGithub() {
  return useMutation({
    mutationFn: ({ name, repoName }: { name: string; repoName: string }) => api.verifyRepoGithub(name, repoName),
  });
}
