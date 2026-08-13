// One-way boot seeding (spec 2026-08-13 queue-sources Part 4): existing
// pipelines become visible source rows + bindings so day-one behavior is
// unchanged. Pure and idempotent — the server loops the writes into
// saveWorkspace/saveBoard and logs each one.

import type { WorkBoard } from "./work-items.js";
import { type ContextSource, isGroupRecord, type Workspace } from "./workspaces.js";

const RELEASES: Omit<ContextSource, "id"> = {
  name: "Repo releases",
  preset: "releases",
  origin: {},
  cadence: "nightly",
  transform: { mode: "analyze" },
  enabled: true,
};

export function seedSourceMigration(
  workspaces: Workspace[],
  boards: WorkBoard[],
): { workspaceWrites: Workspace[]; boardWrites: WorkBoard[] } {
  const workspaceWrites: Workspace[] = [];
  const boardWrites: WorkBoard[] = [];
  for (const ws of workspaces) {
    if (isGroupRecord(ws)) continue;
    let changed = false;
    const sources = [...(ws.sources ?? [])];
    const wsBoards = boards.filter((b) => b.workspaceId === ws.name);

    if (ws.repos.length > 0 && !sources.some((s) => s.id === "releases")) {
      sources.push({ id: "releases", ...RELEASES });
      changed = true;
    }
    for (const board of wsBoards) {
      if (board.jira && !sources.some((s) => s.id === `jira-${board.type}`)) {
        sources.push({
          id: `jira-${board.type}`,
          name: `${board.jira.projectKey} tickets`,
          preset: "jira",
          origin: {
            connectorId: board.jira.connectorId,
            url: board.jira.siteUrl,
            query: board.jira.jql?.trim() || `project = ${board.jira.projectKey} ORDER BY updated DESC`,
          },
          cadence: "nightly",
          transform: { mode: "map" },
          enabled: true,
        });
        changed = true;
      }
    }
    if (changed) workspaceWrites.push({ ...ws, sources });

    for (const board of wsBoards) {
      const want: string[] = [];
      if (ws.repos.length > 0 && (board.type === "reactive" || board.type === "maintenance")) want.push("releases");
      if (board.jira) want.push(`jira-${board.type}`);
      const have = board.queue?.sourceIds ?? [];
      const missing = want.filter((id) => !have.includes(id));
      if (missing.length > 0) {
        board.queue = { sourceIds: [...have, ...missing] };
        boardWrites.push(board);
      }
    }
  }
  return { workspaceWrites, boardWrites };
}
