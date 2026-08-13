/**
 * Every work-board/capability fetch call, lifted out of `BoardStage.tsx`,
 * `MapStage.tsx` and `CardSheet.tsx` unchanged — same URL, method, headers,
 * envelope key, and the same conditions the original treated as failure.
 * Plain async functions, no React.
 *
 * One adaptation, applied uniformly: every function that used to return an
 * `{error?}`-shaped value (or check `res.ok`) now THROWS on that same
 * condition instead of returning it. The originals never changed WHAT counts
 * as failure — only relocating the check from an `if` in a component to a
 * `throw` here, so callers can use try/catch (CardSheet) or React Query's
 * mutation error channel (BoardStage/MapStage) instead of a returned flag.
 * `getBoards`/`getCapabilities` already threw in the original — unchanged.
 */

import type { CapabilityT, TerminalEffectT } from "../api/types";
import type { WorkBoardT } from "../organisms/BoardStage";
import { BROKER_BASE } from "./broker";
import { brokerFetch } from "./origin";

export interface BoardsResult {
  boards: WorkBoardT[];
  errors: Array<{ file: string; error: string }>;
}

export interface CapabilitiesResult {
  capabilities: CapabilityT[];
  errors: Array<{ file: string; error: string }>;
}

// ---------------------------------------------------------------------------
// Boards
// ---------------------------------------------------------------------------

/** GET /work/boards — the whole board collection; there is no per-board GET. */
export async function getBoards(base: string = BROKER_BASE): Promise<BoardsResult> {
  const res = (await brokerFetch(`/work/boards`, base).then((r) => r.json())) as {
    boards?: WorkBoardT[];
    errors?: Array<{ file: string; error: string }>;
    error?: string;
  };
  if (res.error) throw new Error(res.error);
  return { boards: res.boards ?? [], errors: res.errors ?? [] };
}

/** POST /work/boards — creates a board of the given type (and workspace, unless personal). */
export async function createBoard(
  body: { type: string; workspaceId?: string },
  base: string = BROKER_BASE,
): Promise<WorkBoardT> {
  const res = (await brokerFetch(`/work/boards`, base, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
    .then((r) => r.json())
    .catch(() => ({ error: "unreachable" }))) as WorkBoardT & { error?: string };
  if (res.error) throw new Error(res.error);
  return res;
}

/**
 * POST /work/boards/:id/cards — the original discarded the response body
 * entirely (no `res.ok` check, no JSON parse), so a server-side rejection
 * (e.g. a 400) was never surfaced here; only a network failure was. Preserved
 * exactly — do not add a status check that wasn't there.
 */
export async function addCard(boardId: string, body: { title: string }, base: string = BROKER_BASE): Promise<void> {
  await brokerFetch(`/work/boards/${encodeURIComponent(boardId)}/cards`, base, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * PATCH /work/boards/:id/cards/:cardId — one endpoint, two original call
 * sites (BoardStage's move, CardSheet's field/story/flag save) that agreed on
 * everything except what to do with the error text on failure. Unified here;
 * BoardStage's own catch ignores the thrown message (it always shows its own
 * fixed "Move failed" text, same as the original), CardSheet's reads it.
 */
export async function patchCard(
  boardId: string,
  cardId: string,
  body: unknown,
  base: string = BROKER_BASE,
): Promise<void> {
  const res = await brokerFetch(
    `/work/boards/${encodeURIComponent(boardId)}/cards/${encodeURIComponent(cardId)}`,
    base,
    { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  ).catch(() => null);
  if (res?.ok) return;
  const payload = (await res?.json().catch(() => null)) as { error?: string } | null;
  throw new Error(payload?.error ?? "Update failed");
}

/** PATCH /work/boards/:id — edge-column config only. First board-patch client:
    name/columns/jira stay unexposed here until a UI needs them. */
export async function patchBoard(
  boardId: string,
  body: { queue?: { sourceIds: string[] }; terminal?: { columnId?: string; effects: TerminalEffectT[] } },
  base: string = BROKER_BASE,
): Promise<void> {
  const res = await brokerFetch(`/work/boards/${encodeURIComponent(boardId)}`, base, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => null);
  if (res?.ok) return;
  const payload = (await res?.json().catch(() => null)) as { error?: string } | null;
  throw new Error(payload?.error ?? "Update failed");
}

/** DELETE /work/boards/:id/cards/:cardId */
export async function deleteCard(boardId: string, cardId: string, base: string = BROKER_BASE): Promise<void> {
  const res = await brokerFetch(
    `/work/boards/${encodeURIComponent(boardId)}/cards/${encodeURIComponent(cardId)}`,
    base,
    { method: "DELETE" },
  ).catch(() => null);
  if (!res?.ok) throw new Error("Delete failed");
}

/** POST /work/boards/:id/cards/:cardId/route — moves a card to another board type. */
export async function routeCard(
  boardId: string,
  cardId: string,
  toType: string,
  base: string = BROKER_BASE,
): Promise<void> {
  const res = await brokerFetch(
    `/work/boards/${encodeURIComponent(boardId)}/cards/${encodeURIComponent(cardId)}/route`,
    base,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ toType }) },
  ).catch(() => null);
  if (res?.ok) return;
  const payload = (await res?.json().catch(() => null)) as { error?: string } | null;
  throw new Error(payload?.error ?? "Could not move the card");
}

/** POST /work/boards/:id/jira/import */
export async function importJira(boardId: string, base: string = BROKER_BASE): Promise<void> {
  const res = (await brokerFetch(`/work/boards/${encodeURIComponent(boardId)}/jira/import`, base, { method: "POST" })
    .then((r) => r.json())
    .catch(() => ({ error: "Broker unreachable" }))) as { error?: string };
  if (res.error) throw new Error(res.error);
}

/** POST /work/delegate — hands a card to an agent. */
export async function delegateCard(
  body: { boardId: string; cardId: string; agentId: string; workspace?: string; prompt: string },
  base: string = BROKER_BASE,
): Promise<{ taskId?: string }> {
  const res = (await brokerFetch(`/work/delegate`, base, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
    .then((r) => r.json())
    .catch(() => ({ error: "Broker unreachable" }))) as { taskId?: string; error?: string };
  if (res.error) throw new Error(res.error);
  return res;
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/** GET /work/capabilities — all capabilities; there is no per-capability GET, and no client-side workspace filter — MapStage filters the collection itself. */
export async function getCapabilities(base: string = BROKER_BASE): Promise<CapabilitiesResult> {
  const res = (await brokerFetch(`/work/capabilities`, base).then((r) => r.json())) as {
    capabilities?: CapabilityT[];
    errors?: Array<{ file: string; error: string }>;
    error?: string;
  };
  if (res.error) throw new Error(res.error);
  return { capabilities: res.capabilities ?? [], errors: res.errors ?? [] };
}

/** POST /work/capabilities */
export async function createCapability(
  body: { name: string; workspaceId: string },
  base: string = BROKER_BASE,
): Promise<CapabilityT> {
  const res = (await brokerFetch(`/work/capabilities`, base, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
    .then((r) => r.json())
    .catch(() => ({ error: "unreachable" }))) as CapabilityT & { error?: string };
  if (res.error) throw new Error(res.error);
  return res;
}

/** PATCH /work/capabilities/:id — every capability edit (activities/steps/stories/slices) rides this one wholesale PATCH. */
export async function patchCapability(
  id: string,
  body: Partial<Pick<CapabilityT, "name" | "activities" | "stories" | "slices">>,
  base: string = BROKER_BASE,
): Promise<void> {
  const res = await brokerFetch(`/work/capabilities/${encodeURIComponent(id)}`, base, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => null);
  if (res?.ok) return;
  const payload = (await res?.json().catch(() => null)) as { error?: string } | null;
  throw new Error(payload?.error ?? "Update failed");
}
