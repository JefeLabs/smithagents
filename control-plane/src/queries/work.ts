/**
 * Query-key-driven wrappers around `api/work.ts`. Both boards and
 * capabilities are fetched as whole COLLECTIONS — there is no per-item GET on
 * the broker — so `qk.boards` / `qk.capabilities` are the only cache entries
 * these ever touch. `qk.board(id)` / `qk.capability(id)` stay in the key
 * factory unused; a query keyed on either would have nothing to fetch.
 *
 * Every mutation here invalidates the collection on success and lets the
 * failure propagate as a rejected `mutateAsync()` (see api/work.ts's doc
 * comment) — callers catch it themselves rather than reading a mutation
 * `error` field, matching how the original components handled failure inline.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CapabilityT } from "../api/types";
import * as api from "../api/work";
import { qk } from "./keys";

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function useBoards() {
  return useQuery({ queryKey: qk.boards, queryFn: () => api.getBoards() });
}

export function useCapabilities() {
  return useQuery({ queryKey: qk.capabilities, queryFn: () => api.getCapabilities() });
}

// ---------------------------------------------------------------------------
// Board mutations
// ---------------------------------------------------------------------------

export function useCreateBoard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { type: string; workspaceId?: string }) => api.createBoard(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.boards }),
  });
}

export function useCreateCard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ boardId, body }: { boardId: string; body: { title: string } }) => api.addCard(boardId, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.boards }),
  });
}

/**
 * Wraps the single card PATCH. BoardStage owns the optimistic write/rollback
 * around this (it needs the pure `moveCard` domain function and the current
 * cached collection to compute both) — this hook only owns the network call
 * and the post-success invalidate that picks up server-side effects
 * (renumbering, a Jira push's `lastPushError`).
 */
export function useMoveCard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      boardId,
      cardId,
      body,
    }: {
      boardId: string;
      cardId: string;
      body: { columnId?: string; order: number };
    }) => api.patchCard(boardId, cardId, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.boards }),
  });
}

export function useImportJira() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (boardId: string) => api.importJira(boardId),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.boards }),
  });
}

// ---------------------------------------------------------------------------
// Capability mutations
// ---------------------------------------------------------------------------

export function useCreateCapability() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; workspaceId: string }) => api.createCapability(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.capabilities }),
  });
}

export function usePatchCapability() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      body,
    }: {
      id: string;
      body: Partial<Pick<CapabilityT, "name" | "order" | "activities" | "stories" | "slices">>;
    }) => api.patchCapability(id, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.capabilities }),
  });
}

export function useGenerateSpec() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, sliceId }: { id: string; sliceId: string }) => api.generateSpec(id, sliceId),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.capabilities }),
  });
}

export function useSendSlice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, sliceId, target }: { id: string; sliceId: string; target: "capabilities" | "delivery" }) =>
      api.sendSlice(id, sliceId, target),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.capabilities }),
  });
}
