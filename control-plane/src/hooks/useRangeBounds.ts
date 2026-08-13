import { useMemo } from "react";
import { effectiveRange, type RangeBounds, resolveDateRange, sprintConfigFor } from "../lib/dateRange";
import { useWorkspaceRecords } from "../queries/http";
import { useGroups, useSession } from "../queries/pushed";
import { useUiStore } from "../stores/uiStore";

/**
 * The context window's concrete WHEN, for any consumer: null = All time. One
 * hook so Boards, the sessions panel and anything later resolve the picked
 * range through the same sprint-config precedence (group lens → active
 * session's workspace). The workspace-records probe stays deferred — it only
 * runs while a sprint range is actually picked (HomePage's held-probe rule).
 */
export function useRangeBounds(): RangeBounds | null {
  const dateRange = useUiStore((s) => s.dateRange);
  const activeLens = useUiStore((s) => s.activeLens);
  const { data: session } = useSession();
  const { data: groups = [] } = useGroups();
  // The default is sprint-when-configured, so the records probe runs whenever
  // sprint is the stored OR defaulted choice (null store = default).
  const { data: workspaceRecords = [] } = useWorkspaceRecords(!dateRange || dateRange.kind === "sprint");
  const lensGroup = activeLens ? groups.find((g) => g.name === activeLens.group) : undefined;
  const workspace = workspaceRecords.find((w) => w.name === session?.workspace);
  const sprint = sprintConfigFor(lensGroup, workspace);
  const bounds = resolveDateRange(effectiveRange(dateRange, sprint), new Date(), sprint);
  // IDENTITY-STABLE across renders: resolveDateRange builds fresh Date objects
  // every call, and a consumer keying an effect on the result would loop on
  // the new reference (MapStage's node builder). The timestamps are the value;
  // memo on them. Windows are day-granular, so they only move at a boundary.
  const key = bounds ? `${bounds.from.getTime()}:${bounds.to.getTime()}` : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` IS `bounds`, flattened to primitives on purpose — listing `bounds` would defeat the memo
  return useMemo(() => bounds, [key]);
}
