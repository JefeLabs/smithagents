/**
 * Navbar alert badge: a derived "what's wrong right now" list, joined from
 * query sources that already exist — the socket's `connected` flag, the
 * boards collection's per-file `errors`, and health's engine-warning join —
 * never fetched itself, the same shape `computeEngineWarnings`
 * (queries/health.ts) already uses. Invalidating any underlying key
 * refreshes the badge with no bespoke refresh path.
 *
 * `voiceNotice` (stores/uiStore.ts) is deliberately excluded: it self-dismisses
 * after 6s and belongs to the moment it fired in, not to a list reviewed later.
 */
import type { WorkBoardT } from "../organisms/BoardStage";
import { useSocketStore } from "../stores/socketStore";
import { useEngineWarnings } from "./health";
import { useBoards } from "./work";

export interface Alert {
  id: string;
  severity: "warn" | "error";
  text: string;
  /** Router path the row navigates to, e.g. "/board" or "/work/<agentId>". Absent when there is nowhere useful to send the click. */
  target?: string;
}

export interface AlertSources {
  connected: boolean;
  engineWarnings: Record<string, string>;
  boards: WorkBoardT[];
  boardErrors: Array<{ file: string; error: string }>;
}

/**
 * Pure join, no hooks, no React import. A disconnected broker takes over the
 * WHOLE result: every downstream source (board errors, engine warnings) is a
 * CONSEQUENCE of the broker being down, not an independent fact, so this
 * returns before even looking at them — one alert, not one per thing that
 * stopped working because the socket did.
 */
export function computeAlerts({ connected, engineWarnings, boards, boardErrors }: AlertSources): Alert[] {
  if (!connected) {
    return [{ id: "broker-disconnected", severity: "error", text: "Broker disconnected" }];
  }

  const alerts: Alert[] = [];

  for (const [agentId, warning] of Object.entries(engineWarnings)) {
    alerts.push({
      id: `engine-${agentId}`,
      severity: "warn",
      text: `${agentId} — ${warning}`,
      target: `/work/${agentId}`,
    });
  }

  for (const { file, error } of boardErrors) {
    alerts.push({ id: `board-error-${file}`, severity: "error", text: error, target: "/board" });
  }

  for (const board of boards) {
    for (const card of board.cards) {
      if (card.jira?.lastPushError) {
        alerts.push({ id: `jira-push-${card.id}`, severity: "error", text: card.jira.lastPushError, target: "/board" });
      }
    }
  }

  return alerts;
}

// Stable empties so a pending boards query does not hand `computeAlerts` a
// fresh array identity every render — same rule queries/health.ts follows.
const NO_BOARDS: WorkBoardT[] = [];
const NO_BOARD_ERRORS: Array<{ file: string; error: string }> = [];

export function useAlerts(): Alert[] {
  const connected = useSocketStore((s) => s.connected);
  const engineWarnings = useEngineWarnings();
  const { data } = useBoards();
  return computeAlerts({
    connected,
    engineWarnings,
    boards: data?.boards ?? NO_BOARDS,
    boardErrors: data?.errors ?? NO_BOARD_ERRORS,
  });
}
