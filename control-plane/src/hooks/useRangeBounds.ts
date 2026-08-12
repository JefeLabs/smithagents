import { type RangeBounds, resolveDateRange, sprintConfigFor } from "../lib/dateRange";
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
  const { data: workspaceRecords = [] } = useWorkspaceRecords(dateRange?.kind === "sprint");
  if (!dateRange) return null;
  const lensGroup = activeLens ? groups.find((g) => g.name === activeLens.group) : undefined;
  const workspace = workspaceRecords.find((w) => w.name === session?.workspace);
  return resolveDateRange(dateRange, new Date(), sprintConfigFor(lensGroup, workspace));
}
