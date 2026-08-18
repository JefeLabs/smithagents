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
  BrainEngineRecord,
  ChannelsRecord,
  CliToolListing,
  EnginesRecord,
  EnginesUpdate,
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

/**
 * `GET /local-models` — which model servers are running on this machine RIGHT
 * NOW. Deliberately left at the default `staleTime: 0` (no
 * `Number.POSITIVE_INFINITY` like `useBlueprints`): the answer changes the
 * moment someone starts or stops LM Studio, and a cached "nothing is running"
 * is the exact stale lie the wizard's local section must not tell.
 *
 * Callers must distinguish `data: []` (looked, found nothing) from
 * `data: undefined` (still looking, or the look failed) — `data ?? []`
 * collapses the two and reports an absence the probe never established.
 */
export function useLocalModels() {
  return useQuery({ queryKey: qk.localModels, queryFn: () => api.getLocalModels() });
}

export function useContainers() {
  return useQuery({ queryKey: qk.containers, queryFn: () => api.getContainers() });
}

export function useVoiceSettings() {
  return useQuery({ queryKey: qk.voiceSettings, queryFn: () => api.getVoiceSettings() });
}

/**
 * `GET /voice/options` — the wizard's "How should I sound?" cast.
 *
 * `staleTime: Infinity`, like `useBlueprints`: the broker derives this list
 * from a constant stand-in cast at module scope, so it cannot change within a
 * broker run and a refetch on every mount would only re-ask a settled
 * question.
 */
export function useVoiceOptions() {
  return useQuery({
    queryKey: qk.voiceOptions,
    queryFn: () => api.getVoiceOptions(),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useResearchEngine() {
  return useQuery({ queryKey: qk.researchEngine, queryFn: () => api.getResearchEngine() });
}

export function useBrainEngine() {
  return useQuery({ queryKey: qk.brainEngine, queryFn: () => api.getBrainEngine() });
}

/**
 * `GET /me/engines` — the three roles the wizard's *What I think with* step
 * assigns. Separate from `useBrainEngine` (which Settings still uses for the
 * main brain alone) because this asks the whole question in one read, and the
 * step shows all three answers at once.
 */
export function useEngines() {
  return useQuery({ queryKey: qk.engines, queryFn: () => api.getEngines() });
}

/**
 * `GET /machine` — this host's memory, for the wizard's local-model advice.
 * A machine's RAM does not change while the wizard is open, so unlike
 * `useLocalModels` above there is nothing here that goes stale mid-step; it is
 * left at the default anyway rather than pinned, since one extra request on a
 * step that already makes three is not worth a second caching rule to reason
 * about.
 */
export function useMachineFacts() {
  return useQuery({ queryKey: qk.machine, queryFn: () => api.getMachineFacts() });
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

export function useSaveResearchEngine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { cli: string; model?: string } | null) => api.saveResearchEngine(body),
    // A successful CLEAR resolves to a literal `null` body (see api.getResearchEngine's return
    // type) — `result` is only ever a genuine `{error}` object on rejection, never `null`.
    onSuccess: (result) => {
      if (result?.error) return;
      const value: { cli: string; model?: string } | null = result?.cli
        ? { cli: result.cli, model: result.model }
        : null;
      qc.setQueryData(qk.researchEngine, value);
    },
  });
}

export function useSaveBrainEngine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (
      body: { kind: BrainEngineRecord["kind"]; provider: string; model?: string; baseUrl?: string } | null,
    ) => api.saveBrainEngine(body),
    // Same "commit only when the response carries no `error`" contract as useSaveResearchEngine.
    onSuccess: (result) => {
      if (result?.error) return;
      const value: BrainEngineRecord | null = result?.kind
        ? { kind: result.kind, provider: result.provider ?? "", model: result.model }
        : null;
      qc.setQueryData(qk.brainEngine, value);
    },
  });
}

/**
 * `PUT /me/engines`. Commits to the cache only when the response carries no
 * `error`, the same contract as `useSaveBrainEngine` above — a refused save
 * must never leave the picker showing a choice the server rejected.
 *
 * The response is the redacted record of all three roles, so it is written
 * straight in rather than invalidated: what came back IS what a refetch would
 * fetch. `brainEngine`'s own key is invalidated alongside it, because the main
 * role and that key are the same stored field seen two ways, and Settings must
 * not keep showing the brain the wizard just replaced.
 */
export function useSaveEngines() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: EnginesUpdate) => api.saveEngines(body),
    onSuccess: (result) => {
      if (result?.error) return;
      qc.setQueryData<EnginesRecord>(qk.engines, {
        main: result?.main ?? null,
        quick: result?.quick ?? null,
        fallback: result?.fallback ?? null,
      });
      void qc.invalidateQueries({ queryKey: qk.brainEngine });
    },
  });
}

export function useUpdateMe() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name?: string; setup?: MeRecord["setup"] }) => api.updateMe(body),
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

/**
 * `POST /voice/preview` — say one line out loud. Same fire-and-report shape as
 * the verifies above and, like them, it touches no cache: a preview is a sound
 * that plays once and is gone, never state to hold.
 *
 * The caller must read the RESULT, not just the promise: "I have no
 * text-to-speech key" resolves as `{error}` with a sentence for a human, so a
 * bare `await` that ignores the value would report a silent refusal as a
 * success. See `VoicePreviewResult`.
 */
export function usePreviewVoice() {
  return useMutation({
    mutationFn: (body: { voiceId: string; text?: string }) => api.previewVoice(body),
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
