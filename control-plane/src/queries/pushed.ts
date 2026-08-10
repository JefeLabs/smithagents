import { skipToken, useQuery } from "@tanstack/react-query";
import type { BrokerIdentityInfo, ChatMessage, DocT, ExecutionMode, RosterAgent, SessionSummary } from "../api/types";
import { qk } from "./keys";

type ActiveSession = {
  id: string;
  title: string;
  workspace: string;
  runtime: ExecutionMode;
  artifacts: string[];
} | null;

/**
 * The broker exposes no GET for session state — it exists only as a WS frame.
 * skipToken means this query never fetches; the socket store fills it with
 * setQueryData. Until then it stays `pending`, which is exactly the
 * "haven't heard from the broker yet" state the old `sessionKnown` flag
 * hand-rolled.
 */
export function useSession() {
  return useQuery<ActiveSession>({ queryKey: qk.session, queryFn: skipToken, staleTime: Infinity });
}

/** True once the first session frame has been processed — replaces `sessionKnown`. */
export function useSessionKnown(): boolean {
  return useSession().status === "success";
}

export function useSessions() {
  return useQuery<SessionSummary[]>({ queryKey: qk.sessions, queryFn: skipToken, staleTime: Infinity });
}

export function useTranscript() {
  return useQuery<ChatMessage[]>({ queryKey: qk.transcript, queryFn: skipToken, staleTime: Infinity });
}

/**
 * Roster and workspaces are ALSO skipToken, despite `GET /agents` and
 * `GET /workspaces` existing — neither endpoint returns the shape this cache
 * holds. `GET /agents` (broker/src/text-channel.ts:452) returns
 * {agents, discord, voice} with NO `identity` field; the host identity rides
 * the WS roster frame only. `GET /workspaces` (text-channel.ts:528) returns
 * full WorkspaceRecord objects, not the bare name list this key stores.
 *
 * Rather than transform-and-merge two responses to approximate what one frame
 * already delivers correctly, all five pushed keys are socket-fed. The socket
 * connects at app boot, so the "first paint before the frame lands" window a
 * fallback would cover is a single render.
 */
export function useWorkspaces() {
  return useQuery<string[]>({ queryKey: qk.workspaces, queryFn: skipToken, staleTime: Infinity });
}

export function useRoster() {
  return useQuery<{ agents: RosterAgent[]; identity: BrokerIdentityInfo | null }>({
    queryKey: qk.roster,
    queryFn: skipToken,
    staleTime: Infinity,
  });
}

/** Documents frame is pushed just like sessions/roster: skipToken, filled by the socket store. */
export function useDocuments() {
  return useQuery<DocT[]>({ queryKey: qk.documents, queryFn: skipToken, staleTime: Infinity });
}
