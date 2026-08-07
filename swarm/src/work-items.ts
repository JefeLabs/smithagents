// Kanban work boards — the user's personal planning store, one JSON file per
// board under .smith/work/. Boards are data (columns included), never code:
// two shipped templates seed them, and every mutation goes through the
// helpers here so routes stay thin and unit tests never boot the server.
// Cards may LINK to a Jira issue or a delegated agent task; neither linkage
// is required, and execution state never moves a card — columns belong to
// the human.
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface WorkColumn {
  id: string;
  name: string;
  /** Jira status to transition a linked card to when it lands here; absent = no push. */
  jiraStatus?: string;
}

export interface WorkCard {
  id: string;
  title: string;
  notes?: string;
  columnId: string;
  /** Position within its column, always renumbered 0..n-1 by the helpers. */
  order: number;
  createdAt: string;
  updatedAt: string;
  jira?: { key: string; url: string; lastPushError?: string };
  delegation?: { agentId: string; taskId: string; state: 'working' | 'completed' | 'failed'; prUrl?: string };
  /** Acceptance-criteria checklist — authored by hand in v1, replaced wholesale on PATCH. Never a column. */
  stories?: Array<{ id: string; text: string; done: boolean; verifiedBy?: string }>;
}

export interface WorkBoard {
  id: string;
  name: string;
  columns: WorkColumn[];
  cards: WorkCard[];
  jira?: { connectorId: string; siteUrl: string; projectKey: string; jql?: string };
}

const BOARD_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const BOARD_TEMPLATES: Record<'personal' | 'capability', WorkColumn[]> = {
  personal: [
    { id: 'backlog', name: 'Backlog' },
    { id: 'ready', name: 'Ready' },
    { id: 'in-progress', name: 'In Progress' },
    { id: 'in-review', name: 'In Review' },
    { id: 'done', name: 'Done' },
  ],
  capability: [
    { id: 'capability', name: 'Capability' },
    { id: 'spec', name: 'Spec' },
    { id: 'implementation-prd', name: 'Implementation PRD' },
    { id: 'user-stories', name: 'User Stories' },
    { id: 'in-progress', name: 'In Progress' },
    { id: 'completed', name: 'Completed' },
  ],
};

export function createBoard(name: string, template: 'personal' | 'capability'): WorkBoard {
  const id = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!BOARD_ID_RE.test(id)) throw new Error(`Board name "${name}" does not reduce to a usable id`);
  return { id, name: name.trim(), columns: BOARD_TEMPLATES[template].map((c) => ({ ...c })), cards: [] };
}

function assertBoard(file: string, v: unknown): WorkBoard {
  const o = v as WorkBoard;
  const ok =
    o && typeof o.id === 'string' && typeof o.name === 'string' &&
    Array.isArray(o.columns) && o.columns.every((c) => typeof c?.id === 'string' && typeof c?.name === 'string') &&
    Array.isArray(o.cards);
  if (!ok) throw new Error(`Invalid work-board file ${file}: requires id, name, columns[], cards[]`);
  return o;
}

export async function loadBoards(dir: string): Promise<{ boards: WorkBoard[]; errors: Array<{ file: string; error: string }> }> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return { boards: [], errors: [] };
  }
  const boards: WorkBoard[] = [];
  const errors: Array<{ file: string; error: string }> = [];
  for (const file of entries.filter((f) => f.endsWith('.json'))) {
    try {
      boards.push(assertBoard(file, JSON.parse(await readFile(join(dir, file), 'utf8'))));
    } catch (err) {
      errors.push({ file, error: String((err as Error).message) });
    }
  }
  return { boards, errors };
}

export async function saveBoard(dir: string, board: WorkBoard): Promise<void> {
  if (!BOARD_ID_RE.test(board.id)) throw new Error(`Invalid board id "${board.id}"`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${board.id}.json`), `${JSON.stringify(board, null, 2)}\n`);
}

export async function deleteBoardFile(dir: string, id: string): Promise<void> {
  if (!BOARD_ID_RE.test(id)) throw new Error(`Invalid board id "${id}"`);
  await rm(join(dir, `${id}.json`));
}

function renumber(board: WorkBoard, columnId: string): void {
  board.cards
    .filter((c) => c.columnId === columnId)
    .sort((a, b) => a.order - b.order)
    .forEach((c, i) => {
      c.order = i;
    });
}

export function addCard(board: WorkBoard, input: { title: string; notes?: string; columnId?: string }): WorkCard {
  const title = input.title?.trim();
  if (!title) throw new Error('Card title is required');
  const columnId = input.columnId ?? board.columns[0]?.id;
  if (!board.columns.some((c) => c.id === columnId)) throw new Error(`Unknown column: ${input.columnId}`);
  const now = new Date().toISOString();
  const card: WorkCard = {
    id: randomUUID(),
    title,
    notes: input.notes?.trim() || undefined,
    columnId,
    order: board.cards.filter((c) => c.columnId === columnId).length,
    createdAt: now,
    updatedAt: now,
  };
  board.cards.push(card);
  return card;
}

export function patchCard(
  board: WorkBoard,
  cardId: string,
  patch: Partial<Pick<WorkCard, 'title' | 'notes' | 'columnId' | 'order' | 'jira' | 'delegation' | 'stories'>>,
): WorkCard {
  const card = board.cards.find((c) => c.id === cardId);
  if (!card) throw new Error(`Unknown card: ${cardId}`);
  if (patch.columnId !== undefined && !board.columns.some((c) => c.id === patch.columnId)) {
    throw new Error(`Unknown column: ${patch.columnId}`);
  }
  const fromColumn = card.columnId;
  if (patch.title !== undefined) card.title = patch.title.trim() || card.title;
  if (patch.notes !== undefined) card.notes = patch.notes.trim() || undefined;
  if (patch.jira !== undefined) card.jira = patch.jira ?? undefined;
  if (patch.delegation !== undefined) card.delegation = patch.delegation ?? undefined;
  if (patch.stories !== undefined) card.stories = patch.stories ?? undefined;
  if (patch.columnId !== undefined || patch.order !== undefined) {
    const toColumn = patch.columnId ?? card.columnId;
    const siblings = board.cards.filter((c) => c.columnId === toColumn && c.id !== card.id).sort((a, b) => a.order - b.order);
    const at = Math.max(0, Math.min(patch.order ?? siblings.length, siblings.length));
    card.columnId = toColumn;
    siblings.splice(at, 0, card);
    siblings.forEach((c, i) => {
      c.order = i;
    });
    if (fromColumn !== toColumn) renumber(board, fromColumn);
  }
  card.updatedAt = new Date().toISOString();
  return card;
}

export function removeCard(board: WorkBoard, cardId: string): void {
  const i = board.cards.findIndex((c) => c.id === cardId);
  if (i < 0) throw new Error(`Unknown card: ${cardId}`);
  const columnId = board.cards[i].columnId;
  board.cards.splice(i, 1);
  renumber(board, columnId);
}
