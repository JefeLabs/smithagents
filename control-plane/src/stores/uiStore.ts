/**
 * Modal, panel, composer, tuner and grid-tweak UI state — everything that was
 * previously a dozen sibling useStates on the page component. No consumer
 * exists yet; this store is wired up in a later task.
 */
import { create } from "zustand";
import type { AgentSeed } from "../data/agents";
import { GRID_DEFAULTS, type GridParams } from "../hooks/useDotGrid";
import { registerStoreReset } from "./reset";

/** Agent slated for removal; `outcome` stays unset until a preview succeeds. */
export interface RemovalTarget {
  entry: AgentSeed;
  outcome?: "delete" | "archive";
  reasons: string[];
  error?: string;
  busy?: boolean;
}

interface UiState {
  modalOpen: boolean;
  editingId: string | null;
  tunerOpen: boolean;
  gridParams: GridParams;
  sessionsOpen: boolean;
  composer: { locked?: string } | null;
  settingsOpen: boolean;
  workspacesOpen: boolean;
  newWorkspaceOpen: boolean;
  removing: RemovalTarget | null;
  voiceNotice: string | null;
  openAddAgent: () => void;
  openEditAgent: (id: string) => void;
  closeAgentModal: () => void;
  toggleTuner: () => void;
  setGridParam: (key: keyof GridParams, value: number) => void;
  resetGrid: () => void;
  toggleSessions: () => void;
  closeSessions: () => void;
  openComposer: (locked?: string) => void;
  closeComposer: () => void;
  setSettingsOpen: (open: boolean) => void;
  setWorkspacesOpen: (open: boolean) => void;
  setNewWorkspaceOpen: (open: boolean) => void;
  setRemoving: (next: RemovalTarget | null | ((prev: RemovalTarget | null) => RemovalTarget | null)) => void;
  setVoiceNotice: (text: string | null) => void;
}

const initial = {
  modalOpen: false,
  editingId: null,
  tunerOpen: false,
  gridParams: GRID_DEFAULTS,
  sessionsOpen: false,
  composer: null,
  settingsOpen: false,
  workspacesOpen: false,
  newWorkspaceOpen: false,
  removing: null,
  voiceNotice: null,
} satisfies Partial<UiState>;

export const useUiStore = create<UiState>((set) => ({
  ...initial,
  // The + button always creates: it clears editingId even if a previous edit
  // was left open, so the modal never silently reopens on a stale target.
  openAddAgent: () => set({ modalOpen: true, editingId: null }),
  openEditAgent: (id) => set({ modalOpen: true, editingId: id }),
  closeAgentModal: () => set({ modalOpen: false, editingId: null }),
  toggleTuner: () => set((s) => ({ tunerOpen: !s.tunerOpen })),
  setGridParam: (key, value) => set((s) => ({ gridParams: { ...s.gridParams, [key]: value } })),
  resetGrid: () => set({ gridParams: GRID_DEFAULTS }),
  toggleSessions: () => set((s) => ({ sessionsOpen: !s.sessionsOpen })),
  closeSessions: () => set({ sessionsOpen: false }),
  openComposer: (locked) => set({ composer: { locked } }),
  closeComposer: () => set({ composer: null }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setWorkspacesOpen: (workspacesOpen) => set({ workspacesOpen }),
  setNewWorkspaceOpen: (newWorkspaceOpen) => set({ newWorkspaceOpen }),
  setRemoving: (next) => set((s) => ({ removing: typeof next === "function" ? next(s.removing) : next })),
  setVoiceNotice: (voiceNotice) => set({ voiceNotice }),
}));

registerStoreReset(() => useUiStore.setState(initial));
