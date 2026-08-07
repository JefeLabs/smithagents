// Capability story maps — the authoring layer above the work boards. One
// JSON file per capability under .smith/work/capabilities/. Stories are
// born HERE (never on cards, never in spec docs): a slice exports them to
// a spec skeleton and to linked cards, and toggles flow back through
// applyStoryToggles. Truth has one home; everything else is a view.
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { addCard, createBoard, loadBoards, saveBoard, type WorkBoard, type WorkCard } from './work-items.js';

export interface CapStory {
  id: string;
  stepId: string;
  /** Position within its step's stack. */
  order: number;
  text: string;
  done: boolean;
  /** How it was proven — e.g. 'manual 2026-08-07' or a test file path. */
  verifiedBy?: string;
}

export interface CapActivity {
  id: string;
  name: string;
  order: number;
  steps: Array<{ id: string; name: string; order: number }>;
}

export interface CapSlice {
  id: string;
  name: string;
  order: number;
  /** Disjoint across slices; a story in no slice is backlog. */
  storyIds: string[];
  specPath?: string;
  planPath?: string;
  capCardRef?: { boardId: string; cardId: string };
  deliveryCardRef?: { boardId: string; cardId: string };
}

export interface Capability {
  id: string;
  name: string;
  workspaceId: string;
  activities: CapActivity[];
  stories: CapStory[];
  slices: CapSlice[];
  createdAt: string;
  updatedAt: string;
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function slugify(name: string): string {
  const id = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!ID_RE.test(id)) throw new Error(`Name "${name}" does not reduce to a usable id`);
  return id;
}

export function createCapability(name: string, workspaceId: string): Capability {
  const now = new Date().toISOString();
  return { id: slugify(name), name: name.trim(), workspaceId, activities: [], stories: [], slices: [], createdAt: now, updatedAt: now };
}

function assertCapability(file: string, v: unknown): Capability {
  const o = v as Capability;
  const ok =
    o && typeof o.id === 'string' && typeof o.name === 'string' && typeof o.workspaceId === 'string' &&
    Array.isArray(o.activities) && Array.isArray(o.stories) && Array.isArray(o.slices);
  if (!ok) throw new Error(`Invalid capability file ${file}: requires id, name, workspaceId, activities[], stories[], slices[]`);
  return o;
}

export async function loadCapabilities(dir: string): Promise<{ capabilities: Capability[]; errors: Array<{ file: string; error: string }> }> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return { capabilities: [], errors: [] };
  }
  const capabilities: Capability[] = [];
  const errors: Array<{ file: string; error: string }> = [];
  for (const file of entries.filter((f) => f.endsWith('.json'))) {
    try {
      capabilities.push(assertCapability(file, JSON.parse(await readFile(join(dir, file), 'utf8'))));
    } catch (err) {
      errors.push({ file, error: String((err as Error).message) });
    }
  }
  return { capabilities, errors };
}

export async function saveCapability(dir: string, cap: Capability): Promise<void> {
  if (!ID_RE.test(cap.id)) throw new Error(`Invalid capability id "${cap.id}"`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${cap.id}.json`), `${JSON.stringify(cap, null, 2)}\n`);
}

export async function deleteCapabilityFile(dir: string, id: string): Promise<void> {
  if (!ID_RE.test(id)) throw new Error(`Invalid capability id "${id}"`);
  await rm(join(dir, `${id}.json`));
}

export function patchCapability(cap: Capability, patch: Partial<Pick<Capability, 'name' | 'activities' | 'stories' | 'slices'>>): Capability {
  const activities = patch.activities ?? cap.activities;
  const stories = patch.stories ?? cap.stories;
  const slices = patch.slices ?? cap.slices;
  const stepIds = new Set(activities.flatMap((a) => a.steps.map((s) => s.id)));
  for (const s of stories) {
    if (!stepIds.has(s.stepId)) throw new Error(`Story "${s.text}" references unknown step ${s.stepId}`);
  }
  const storyIds = new Set(stories.map((s) => s.id));
  const claimed = new Set<string>();
  for (const slice of slices) {
    for (const id of slice.storyIds) {
      if (!storyIds.has(id)) throw new Error(`Slice "${slice.name}" references unknown story ${id}`);
      if (claimed.has(id)) throw new Error(`Story ${id} is in two slices — storyIds must be disjoint`);
      claimed.add(id);
    }
  }
  if (patch.name?.trim()) cap.name = patch.name.trim();
  cap.activities = activities;
  cap.stories = stories;
  cap.slices = slices;
  cap.updatedAt = new Date().toISOString();
  return cap;
}

export function sliceStories(cap: Capability, sliceId: string): CapStory[] {
  const slice = cap.slices.find((s) => s.id === sliceId);
  if (!slice) throw new Error(`Unknown slice: ${sliceId}`);
  return slice.storyIds.map((id) => {
    const story = cap.stories.find((s) => s.id === id);
    if (!story) throw new Error(`Slice references unknown story ${id}`);
    return story;
  });
}

/** Linked-card checklists are toggle-only views: only done/verifiedBy may differ from the capability's stories. */
export function applyStoryToggles(
  cap: Capability,
  sliceId: string,
  incoming: Array<{ id: string; text: string; done: boolean; verifiedBy?: string }>,
): CapStory[] {
  const canonical = sliceStories(cap, sliceId);
  if (incoming.length !== canonical.length) {
    throw new Error(`Story count mismatch (${incoming.length} sent, ${canonical.length} in the slice) — add/remove stories in the map, cards are toggle-only`);
  }
  const seen = new Set<string>();
  for (const sent of incoming) {
    if (seen.has(sent.id)) throw new Error(`Duplicate story id ${sent.id} — toggle-only, each story appears once`);
    seen.add(sent.id);
    const story = canonical.find((s) => s.id === sent.id);
    if (!story) throw new Error(`Unknown or missing story ${sent.id} — cards are toggle-only`);
    if (sent.text !== story.text) throw new Error(`Story ${sent.id} text changed — toggle-only; edit text in the map`);
    story.done = sent.done;
    story.verifiedBy = sent.verifiedBy ?? undefined;
  }
  cap.updatedAt = new Date().toISOString();
  return canonical.map((s) => ({ ...s }));
}

export function renderSpecSkeleton(sliceName: string, stories: CapStory[], dateISO: string): string {
  return [
    `# ${sliceName} — design`,
    '',
    `Date: ${dateISO}`,
    'Status: draft',
    '',
    '## Goal',
    '',
    '## Acceptance criteria',
    '',
    ...stories.map((s) => `- [ ] ${s.text}`),
    '',
  ].join('\n');
}

export function workspaceBoardId(workspaceId: string, target: 'capabilities' | 'delivery'): string {
  return `${slugify(workspaceId)}-${target}`;
}

/** Create the workspace's Capabilities + Delivery pair iff missing. ONLY the pair — maintenance/support are on-demand. */
export async function ensureWorkspaceBoards(workDir: string, workspaceId: string): Promise<void> {
  const { boards } = await loadBoards(workDir);
  const wanted: Array<['capabilities' | 'delivery', string]> = [
    ['capabilities', `${workspaceId} Capabilities`],
    ['delivery', `${workspaceId} Delivery`],
  ];
  for (const [template, name] of wanted) {
    const board = createBoard(name, template, workspaceId);
    board.id = workspaceBoardId(workspaceId, template);
    if (!boards.some((b) => b.id === board.id)) await saveBoard(workDir, board);
  }
}

/** Pure card creation for a slice send: leftmost column, story copies, capabilityRef. Caller saves board + slice ref. */
export function sendSliceToBoard(cap: Capability, slice: CapSlice, board: WorkBoard): WorkCard {
  const card = addCard(board, { title: slice.name });
  card.stories = sliceStories(cap, slice.id).map((s) => ({ id: s.id, text: s.text, done: s.done, verifiedBy: s.verifiedBy }));
  card.capabilityRef = { capabilityId: cap.id, sliceId: slice.id };
  return card;
}
