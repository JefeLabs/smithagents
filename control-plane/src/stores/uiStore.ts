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
  /** Focus view: collapses the artifact shelf and the docked chat (CSS via body[data-focus]). */
  focusMode: boolean;
  toggleFocus: () => void;
  exitFocus: () => void;
  /**
   * Which workspaces Board and Map RENDER. View-only: it never affects dispatch and
   * never changes the active session — work still lands in the active session's
   * workspace regardless of how many are on screen.
   *
   * `"*"` is every workspace. A set is an explicit selection; an EMPTY set means no
   * explicit selection has been made, which is how the consuming stage knows to fall
   * back to the active session's one workspace instead of defaulting to all of them.
   */
  viewedWorkspaces: ReadonlySet<string> | "*";
  setViewedWorkspaces: (next: ReadonlySet<string> | "*") => void;
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
  /** Shows the "no STT configured" notice and self-dismisses it after 6s. */
  showVoiceBlockedNotice: () => void;
}

const VOICE_BLOCKED_NOTICE = "Add a Deepgram key in Settings → Integrations, then select it under Settings → Voice.";
const VOICE_NOTICE_MS = 6000;

// Module-scoped, not a component ref: the notice outlives the stage that
// raised it, so a route unmounting mid-countdown must not cut it short.
let voiceNoticeTimer: ReturnType<typeof setTimeout> | null = null;

function clearVoiceNoticeTimer() {
  if (voiceNoticeTimer) clearTimeout(voiceNoticeTimer);
  voiceNoticeTimer = null;
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
  focusMode: false,
  viewedWorkspaces: new Set<string>(),
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
  toggleFocus: () => set((s) => ({ focusMode: !s.focusMode })),
  exitFocus: () => set({ focusMode: false }),
  toggleSessions: () => set((s) => ({ sessionsOpen: !s.sessionsOpen })),
  closeSessions: () => set({ sessionsOpen: false }),
  openComposer: (locked) => set({ composer: { locked } }),
  closeComposer: () => set({ composer: null }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setWorkspacesOpen: (workspacesOpen) => set({ workspacesOpen }),
  setNewWorkspaceOpen: (newWorkspaceOpen) => set({ newWorkspaceOpen }),
  setRemoving: (next) => set((s) => ({ removing: typeof next === "function" ? next(s.removing) : next })),
  setVoiceNotice: (voiceNotice) => set({ voiceNotice }),
  setViewedWorkspaces: (viewedWorkspaces) => set({ viewedWorkspaces }),
  showVoiceBlockedNotice: () => {
    set({ voiceNotice: VOICE_BLOCKED_NOTICE });
    // Rapid presses restart the window rather than letting an earlier press's
    // timer cut the latest notice short.
    clearVoiceNoticeTimer();
    voiceNoticeTimer = setTimeout(() => {
      voiceNoticeTimer = null;
      useUiStore.setState({ voiceNotice: null });
    }, VOICE_NOTICE_MS);
  },
}));

registerStoreReset(() => {
  // The timer is module-scoped, so a pending dismissal would otherwise fire
  // into the next test and blank a notice it never raised.
  clearVoiceNoticeTimer();
  useUiStore.setState(initial);
});
