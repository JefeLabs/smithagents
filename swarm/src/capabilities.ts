// Capability story maps — the authoring layer above the work boards. One
// JSON file per capability under .smith/work/capabilities/. Stories are
// born HERE (never on cards, never in spec docs): a slice exports them to
// a spec skeleton and to linked cards, and toggles flow back through
// applyStoryToggles. Truth has one home; everything else is a view.
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  addCard,
  type BoardType,
  createBoard,
  findCardByRef,
  loadBoards,
  saveBoard,
  type WorkBoard,
  type WorkCard,
} from "./work-items.js";

export interface CapStory {
  id: string;
  stepId: string;
  /** Position within its step's stack. */
  order: number;
  text: string;
  done: boolean;
  /** How it was proven — e.g. 'manual 2026-08-07' or a test file path. */
  verifiedBy?: string;
  /**
   * Point estimate (real-dashboards spec 2026-08-13): whole number ≥ 0,
   * map-authored — linked cards mirror it read-only. Absent = unestimated;
   * dashboards render "—" and sum it as 0.
   */
  points?: number;
  /**
   * When the story was last TOUCHED — created, re-worded, moved to another
   * step, re-estimated, or toggled (date-range spec 2026-08-12: the map
   * windows stories on this). Optional: stories from before dating carry
   * none and the control plane must always show them.
   */
  updatedAt?: string;
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
  /** May overlap other slices, but each slice must own at least one story no other slice has. A story in no slice is backlog. */
  storyIds: string[];
  specPath?: string;
  planPath?: string;
  capCardRef?: { boardId: string; cardId: string };
  deliveryCardRef?: { boardId: string; cardId: string };
  /**
   * When the slice was last TOUCHED — created, renamed, re-membered, linked,
   * or had a story toggled (date-range spec 2026-08-12: the map's slice
   * listing windows on this). Optional: slices from before dating carry none
   * and the control plane must always show them.
   */
  updatedAt?: string;
}

export interface Capability {
  id: string;
  name: string;
  workspaceId: string;
  /**
   * Where this capability sits in the row, and OPTIONAL on purpose: every capability
   * file written before this existed has no `order`, and rejecting those would empty
   * the map rather than migrate it. `loadCapabilities` gives them a deterministic place
   * instead, and the value is written the first time something reorders them.
   *
   * Unlike activities, steps and stories — which are dense 0..n inside ONE document —
   * a capability is its own file, so renumbering the set is a write per capability.
   * The client still keeps them dense; it just costs more than the others do.
   */
  order?: number;
  activities: CapActivity[];
  stories: CapStory[];
  slices: CapSlice[];
  createdAt: string;
  updatedAt: string;
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function slugify(name: string): string {
  const id = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (!ID_RE.test(id)) throw new Error(`Name "${name}" does not reduce to a usable id`);
  return id;
}

export function createCapability(name: string, workspaceId: string, order = 0): Capability {
  const now = new Date().toISOString();
  // Namespaced like boardIdFor: the id is the on-disk filename, and two
  // workspaces must be able to each have their own "Onboarding".
  const id = `${slugify(workspaceId)}-${slugify(name)}`;
  return {
    id,
    name: name.trim(),
    workspaceId,
    order,
    activities: [],
    stories: [],
    slices: [],
    createdAt: now,
    updatedAt: now,
  };
}

function assertCapability(file: string, v: unknown): Capability {
  const o = v as Capability;
  const ok =
    o &&
    typeof o.id === "string" &&
    typeof o.name === "string" &&
    typeof o.workspaceId === "string" &&
    Array.isArray(o.activities) &&
    Array.isArray(o.stories) &&
    Array.isArray(o.slices);
  if (!ok)
    throw new Error(
      `Invalid capability file ${file}: requires id, name, workspaceId, activities[], stories[], slices[]`,
    );
  return o;
}

export async function loadCapabilities(
  dir: string,
): Promise<{ capabilities: Capability[]; errors: Array<{ file: string; error: string }> }> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return { capabilities: [], errors: [] };
  }
  const capabilities: Capability[] = [];
  const errors: Array<{ file: string; error: string }> = [];
  for (const file of entries.filter((f) => f.endsWith(".json"))) {
    try {
      capabilities.push(assertCapability(file, JSON.parse(await readFile(join(dir, file), "utf8"))));
    } catch (err) {
      errors.push({ file, error: String((err as Error).message) });
    }
  }
  // SORTED, and by (order, id) rather than by order alone. A file written before
  // `order` existed has none, and it has to land somewhere stable: `id` is the
  // filename, so unordered capabilities keep a fixed alphabetical sequence after the
  // ordered ones instead of moving whenever the directory is read in a different
  // sequence. Nothing is renumbered here — load does not write, and a value invented
  // on read would look persisted without being.
  capabilities.sort(
    (a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id),
  );
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

/**
 * Slices whose every story also appears in another slice. Pure, total, and
 * evaluated over the WHOLE set — a slice is invalidated by what its neighbours
 * contain, so this can never be answered one slice at a time. Empty storyIds
 * owns nothing, so a storyless slice is reported here rather than needing its
 * own check.
 *
 * Counts each story across all slices FIRST, then asks each slice whether it
 * holds one with a count of 1. Marking duplicates while iterating would report
 * only the later of two identical slices, when both are equally unowned.
 *
 * Mirrored in control-plane/src/organisms/map/slices.ts — that copy disables a
 * button, this one decides what persists. Both are tested against the same
 * case table; keep them in step.
 */
export function slicesWithoutExclusiveStory(slices: CapSlice[]): CapSlice[] {
  const uses = new Map<string, number>();
  for (const slice of slices) {
    for (const id of new Set(slice.storyIds)) uses.set(id, (uses.get(id) ?? 0) + 1);
  }
  return slices.filter((slice) => !slice.storyIds.some((id) => uses.get(id) === 1));
}

export function patchCapability(
  cap: Capability,
  patch: Partial<Pick<Capability, "name" | "order" | "activities" | "stories" | "slices">>,
): Capability {
  const activities = patch.activities ?? cap.activities;
  const stories = patch.stories ?? cap.stories;
  const slices = patch.slices ?? cap.slices;
  const stepIds = new Set(activities.flatMap((a) => a.steps.map((s) => s.id)));
  for (const s of stories) {
    if (!stepIds.has(s.stepId)) throw new Error(`Story "${s.text}" references unknown step ${s.stepId}`);
    // Free small integer, enforced here so a bad estimate can never persist —
    // absent is fine (unestimated), fractional or negative is not.
    if (s.points !== undefined && (!Number.isInteger(s.points) || s.points < 0)) {
      throw new Error("Story points must be a whole number ≥ 0");
    }
  }
  const storyIds = new Set(stories.map((s) => s.id));
  for (const slice of slices) {
    for (const id of slice.storyIds) {
      if (!storyIds.has(id)) throw new Error(`Slice "${slice.name}" references unknown story ${id}`);
    }
  }
  // Slices MAY overlap. What they may not do is leave a neighbour owning nothing
  // of its own — and because a slice is invalidated by what its neighbours hold,
  // the comparison is between the whole set before and the whole set after.
  //
  // Keyed by id, never by count: a write that repairs one slice while breaking
  // another leaves the count level and the set changed. Already-invalid slices
  // are grandfathered because two of them are live on the Plan and Deliver
  // boards, and deleting slices with cards would destroy work.
  const invalidBefore = new Set(slicesWithoutExclusiveStory(cap.slices).map((s) => s.id));
  const newlyInvalid = slicesWithoutExclusiveStory(slices).filter((s) => !invalidBefore.has(s.id));
  if (newlyInvalid.length > 0) {
    const names = newlyInvalid.map((s) => `"${s.name}"`).join(", ");
    throw new Error(`${names} would own no story that no other slice has — every slice needs one of its own`);
  }
  if (patch.name?.trim()) cap.name = patch.name.trim();
  // Guarded on `undefined`, not on truthiness: order 0 is the first slot and the most
  // common value a reorder writes, and `if (patch.order)` would silently drop it.
  if (patch.order !== undefined) cap.order = patch.order;
  // Activity stamps (date-range spec 2026-08-12): the map windows stories and
  // slices on WHEN they were last touched. A NEW or content-changed item
  // stamps now; an untouched one carries its old stamp forward — clients send
  // whole arrays without reliably round-tripping updatedAt, so recomputing
  // here is the only way the stamp survives a patch. A pure `order` move is
  // layout, not activity, and does not count as touch.
  const now = new Date().toISOString();
  const prevStories = new Map(cap.stories.map((s) => [s.id, s]));
  for (const s of stories) {
    const old = prevStories.get(s.id);
    const untouched =
      old !== undefined &&
      old.text === s.text &&
      old.done === s.done &&
      old.stepId === s.stepId &&
      (old.points ?? undefined) === (s.points ?? undefined) &&
      (old.verifiedBy ?? undefined) === (s.verifiedBy ?? undefined);
    s.updatedAt = untouched ? old.updatedAt : now;
  }
  const prevSlices = new Map(cap.slices.map((s) => [s.id, s]));
  const refKey = (r?: { boardId: string; cardId: string }) => (r ? `${r.boardId}/${r.cardId}` : "");
  for (const s of slices) {
    const old = prevSlices.get(s.id);
    const untouched =
      old !== undefined &&
      old.name === s.name &&
      old.specPath === s.specPath &&
      old.planPath === s.planPath &&
      old.storyIds.length === s.storyIds.length &&
      old.storyIds.every((id, i) => id === s.storyIds[i]) &&
      refKey(old.capCardRef) === refKey(s.capCardRef) &&
      refKey(old.deliveryCardRef) === refKey(s.deliveryCardRef);
    s.updatedAt = untouched ? old.updatedAt : now;
  }
  cap.activities = activities;
  cap.stories = stories;
  cap.slices = slices;
  cap.updatedAt = now;
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
    throw new Error(
      `Story count mismatch (${incoming.length} sent, ${canonical.length} in the slice) — add/remove stories in the map, cards are toggle-only`,
    );
  }
  const seen = new Set<string>();
  const touched = new Set<string>();
  const now = new Date().toISOString();
  for (const sent of incoming) {
    if (seen.has(sent.id)) throw new Error(`Duplicate story id ${sent.id} — toggle-only, each story appears once`);
    seen.add(sent.id);
    const story = canonical.find((s) => s.id === sent.id);
    if (!story) throw new Error(`Unknown or missing story ${sent.id} — cards are toggle-only`);
    if (sent.text !== story.text) throw new Error(`Story ${sent.id} text changed — toggle-only; edit text in the map`);
    // Activity stamps ride real changes only — a no-op resync must not make
    // every story and slice look freshly touched (date-range spec 2026-08-12).
    if (story.done !== sent.done || (story.verifiedBy ?? undefined) !== (sent.verifiedBy ?? undefined)) {
      story.updatedAt = now;
      touched.add(story.id);
    }
    story.done = sent.done;
    story.verifiedBy = sent.verifiedBy ?? undefined;
  }
  if (touched.size > 0) {
    // Toggling a story is progress ON ITS SLICES — they surface in the map's
    // windowed slice listing the same way the story does on the canvas.
    for (const slice of cap.slices) {
      if (slice.storyIds.some((id) => touched.has(id))) slice.updatedAt = now;
    }
  }
  cap.updatedAt = now;
  return canonical.map((s) => ({ ...s }));
}

export function renderSpecSkeleton(sliceName: string, stories: CapStory[], dateISO: string): string {
  return [
    `# ${sliceName} — design`,
    "",
    `Date: ${dateISO}`,
    "Status: draft",
    "",
    "## Goal",
    "",
    "## Acceptance criteria",
    "",
    ...stories.map((s) => `- [ ] ${s.text}`),
    "",
  ].join("\n");
}

/** Create the workspace's standing boards iff missing. Ideation + Plan + Deliver; the rest are on-demand. */
export async function ensureWorkspaceBoards(workDir: string, workspaceId: string): Promise<void> {
  const { boards } = await loadBoards(workDir);
  for (const type of ["ideation", "plan", "deliver"] as BoardType[]) {
    const board = createBoard(type, workspaceId);
    if (!boards.some((b) => b.id === board.id)) await saveBoard(workDir, board);
  }
}

/** The single personal board. Workspace-less, so ensureWorkspaceBoards cannot cover it. */
export async function ensurePersonalBoard(workDir: string): Promise<void> {
  const { boards } = await loadBoards(workDir);
  if (boards.some((b) => b.id === "personal")) return;
  await saveBoard(workDir, createBoard("personal"));
}

/** Pure card creation for a slice send: leftmost column, story copies, capabilityRef. Caller saves board + slice ref. */
export function sendSliceToBoard(cap: Capability, slice: CapSlice, board: WorkBoard): WorkCard {
  const card = addCard(board, { title: slice.name });
  card.stories = sliceStories(cap, slice.id).map((s) => ({
    id: s.id,
    text: s.text,
    done: s.done,
    points: s.points,
    verifiedBy: s.verifiedBy,
  }));
  card.capabilityRef = { capabilityId: cap.id, sliceId: slice.id };
  return card;
}

/**
 * After a capability edit, a slice's stories may have moved on from the
 * snapshot a linked card was sent with. Refresh every linked card's story
 * copies from the slice's current stories so the checklist stays a synced
 * view rather than a stale one (a slice whose stories were all unassigned
 * ends up with an empty checklist, not a dead one). Call only after the
 * capability patch that produced `cap` has itself succeeded and persisted —
 * this is a second, best-effort write pass, not part of that validation.
 * Skips only refs whose CARD no longer resolves anywhere: findCardByRef
 * treats ref.boardId as a hint, so a card routed to another board keeps
 * syncing instead of silently freezing into a read-only stale checklist.
 */
export async function resyncLinkedCards(workDir: string, cap: Capability): Promise<void> {
  const { boards } = await loadBoards(workDir);
  const dirty = new Set<WorkBoard>();
  for (const slice of cap.slices) {
    const refs = [slice.capCardRef, slice.deliveryCardRef].filter((r): r is { boardId: string; cardId: string } =>
      Boolean(r),
    );
    if (refs.length === 0) continue;
    let stories: CapStory[];
    try {
      stories = sliceStories(cap, slice.id);
    } catch {
      continue; // patchCapability already enforces this; skip defensively rather than throw mid-resync
    }
    for (const ref of refs) {
      const found = findCardByRef(boards, ref);
      if (found) {
        found.card.stories = stories.map((s) => ({
          id: s.id,
          text: s.text,
          done: s.done,
          points: s.points,
          verifiedBy: s.verifiedBy,
        }));
        dirty.add(found.board);
      }
    }
  }
  for (const board of dirty) await saveBoard(workDir, board);
}

/** Clear a slice's ref to a card that no longer exists (e.g. the card was deleted). Returns whether anything changed. */
export function unlinkSliceCard(cap: Capability, sliceId: string, cardId: string): boolean {
  const slice = cap.slices.find((s) => s.id === sliceId);
  if (!slice) return false;
  let changed = false;
  if (slice.capCardRef?.cardId === cardId) {
    slice.capCardRef = undefined;
    changed = true;
  }
  if (slice.deliveryCardRef?.cardId === cardId) {
    slice.deliveryCardRef = undefined;
    changed = true;
  }
  if (changed) cap.updatedAt = new Date().toISOString();
  return changed;
}

/**
 * Point a slice's ref at the board a card has just been routed to. The refs
 * stay accurate rather than merely recoverable, so nothing has to fall back
 * to the whole-store scan. Matches on cardId across every slice — the caller
 * knows the card, not which slice or which of the two refs holds it. Returns
 * whether anything changed.
 */
export function repointSliceCardRef(cap: Capability, cardId: string, boardId: string): boolean {
  let changed = false;
  for (const slice of cap.slices) {
    for (const key of ["capCardRef", "deliveryCardRef"] as const) {
      const ref = slice[key];
      if (ref?.cardId === cardId && ref.boardId !== boardId) {
        slice[key] = { boardId, cardId };
        changed = true;
      }
    }
  }
  if (changed) cap.updatedAt = new Date().toISOString();
  return changed;
}

/**
 * Unlink, never orphan: every card this capability's slices point at loses
 * its capabilityRef, keeping its story copies as a plain local checklist.
 * Pure over an already-loaded board set; returns the boards the caller must
 * save. A card left `linked` to a deleted capability is toggle-only with no
 * add and no remove and NO UI to clear it, so a ref that fails to resolve
 * here is unrecoverable without hand-editing JSON — hence findCardByRef's
 * cardId-keyed search, which survives the card having been routed.
 */
export function unlinkCapabilityCards(boards: WorkBoard[], cap: Capability): WorkBoard[] {
  const dirty = new Set<WorkBoard>();
  for (const slice of cap.slices) {
    for (const ref of [slice.capCardRef, slice.deliveryCardRef]) {
      if (!ref) continue;
      const found = findCardByRef(boards, ref);
      if (!found) continue;
      found.card.capabilityRef = undefined;
      dirty.add(found.board);
    }
  }
  return [...dirty];
}
