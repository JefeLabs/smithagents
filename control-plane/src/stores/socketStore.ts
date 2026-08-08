/**
 * The single owner of the broker WebSocket. Every frame the broker pushes is
 * translated here into a Query cache write (the frame carried the data) or an
 * invalidation (the frame carried only an id), so no component ever holds
 * broker state of its own.
 *
 * Ported from `useBrokerChat.ts`'s effect with the frame semantics unchanged —
 * only the destination moved, from a dozen useStates to the cache.
 */

import type { QueryClient } from "@tanstack/react-query";
import { create } from "zustand";
import { BROKER_BASE } from "../api/broker";
import type {
  AudioFrame,
  BrokerIdentityInfo,
  ChatMessage,
  RosterAgent,
  SessionFrame,
  SessionSummary,
} from "../api/types";
import { qk } from "../queries/keys";
import { registerStoreReset } from "./reset";

const RECONNECT_MS = 2000;

/**
 * Every frame the broker's text channel can broadcast, mirroring
 * `broker/src/text-channel.ts`'s `ChannelFrame` — the second lockstep parser.
 * `task-dispatched` is listed with no case below: it exists for the external
 * bridge (broker/bin) and the UI has always ignored it. Listing it keeps that
 * a decision rather than an oversight.
 */
type BrokerFrame =
  | { type: "utterance" | "speech" | "notice"; text: string }
  | { type: "roster"; agents: RosterAgent[]; identity?: BrokerIdentityInfo }
  | { type: "config"; audio: boolean }
  | ({ type: "audio" } & AudioFrame)
  | { type: "board-updated"; boardId: string }
  | { type: "capability-updated"; capabilityId: string }
  | { type: "task-dispatched"; taskId: string; agent: string; task: string }
  | SessionFrame;

interface SocketState {
  connected: boolean;
  /**
   * From the broker's `config` frame: true when the BROKER is producing audio
   * itself. HomePage passes `!audioMode` as useSpokenReplies' `webSpeechEnabled`,
   * so dropping this would make the browser speak replies aloud on top of the
   * broker's own TTS — double audio, not silence.
   */
  audioMode: boolean;
  connect: (qc: QueryClient, base?: string) => void;
  disconnect: () => void;
  /**
   * Mic frames are the only thing this app sends over the socket. `send` and
   * `compose` are HTTP POSTs (api/broker.ts) — the broker echoes an accepted
   * utterance back as a frame, and that echo is what fills the transcript.
   * Putting either on the socket would drop every message silently.
   */
  micControl: (type: "mic-start" | "mic-stop") => void;
  micAudio: (pcm: ArrayBuffer) => void;
  onAudioFrame: (fn: (frame: AudioFrame) => void) => () => void;
}

// Module-scoped, not store state: these are imperative handles, and putting a
// live socket in reactive state would notify every subscriber on reconnect.
let socket: WebSocket | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
/** True between connect() and disconnect(). Guards re-entry AND arms the reconnect. */
let active = false;
let nextId = 0;
const audioSubs = new Set<(frame: AudioFrame) => void>();

function append(qc: QueryClient, role: ChatMessage["role"], text: string) {
  qc.setQueryData<ChatMessage[]>(qk.transcript, (list = []) => [...list, { id: nextId++, role, text }]);
}

export const useSocketStore = create<SocketState>((set) => ({
  connected: false,
  audioMode: false,

  connect: (qc, base = BROKER_BASE) => {
    // Idempotent on `active`, not on `socket`: StrictMode double-mounts this, and
    // between a drop and its reconnect `socket` is null while a timer is armed —
    // guarding on the handle alone would open a second socket in that window.
    if (active) return;
    active = true;

    const open = () => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(`ws://${base}/events`);
      } catch (err) {
        // `base` is caller-supplied, and a malformed one throws right here. Releasing
        // the guard matters more than the throw does: `active` is module-scoped, so
        // leaving it set would make every later connect() a silent no-op that no
        // remount could heal — the store would be dead for the life of the page.
        active = false;
        throw err;
      }
      socket = ws;
      ws.onopen = () => set({ connected: true });
      ws.onmessage = (e) => {
        // close() only moves a socket to CLOSING; buffered frames can still arrive
        // until the handshake finishes. Without this, a superseded socket would keep
        // writing into the same QueryClient its replacement is writing to.
        if (socket !== ws) return;
        const frame = JSON.parse(String(e.data)) as BrokerFrame;

        switch (frame.type) {
          case "session":
            // A null session is KNOWN zero, not "not heard from yet" — setQueryData
            // with null still flips the query to success, which is what useSessionKnown reads.
            qc.setQueryData<SessionFrame["session"]>(qk.session, frame.session);
            qc.setQueryData<SessionSummary[]>(qk.sessions, frame.sessions);
            qc.setQueryData<string[]>(qk.workspaces, frame.workspaces);
            nextId = 0; // the frame replays the whole transcript, so ids restart with it
            qc.setQueryData<ChatMessage[]>(
              qk.transcript,
              frame.transcript.map((t) => ({ id: nextId++, role: t.role, text: t.text })),
            );
            return;
          case "roster":
            qc.setQueryData<{ agents: RosterAgent[]; identity: BrokerIdentityInfo | null }>(qk.roster, {
              agents: frame.agents,
              identity: frame.identity ?? null,
            });
            return;
          case "config":
            set({ audioMode: frame.audio });
            return;
          case "audio":
            // Audio is a stream, not state — it plays once and is gone.
            for (const fn of audioSubs) fn(frame);
            return;
          case "board-updated":
            // Id-only frames: invalidate, never write. There is no data here to cache.
            qc.invalidateQueries({ queryKey: qk.board(frame.boardId) });
            return;
          case "capability-updated":
            qc.invalidateQueries({ queryKey: qk.capability(frame.capabilityId) });
            return;
          case "notice":
            append(qc, "notice", frame.text);
            return;
          case "utterance":
            append(qc, "user", frame.text);
            return;
          case "speech":
            append(qc, "broker", frame.text);
            return;
          default:
            return; // task-dispatched, and anything a newer broker adds
        }
      };
      ws.onclose = () => {
        // A superseded socket closing late (close() is async) must not clear the
        // handle its replacement owns, nor arm a second reconnect.
        if (socket !== ws) return;
        socket = null;
        set({ connected: false });
        if (active) timer = setTimeout(open, RECONNECT_MS);
      };
      ws.onerror = () => ws.close();
    };
    open();
  },

  disconnect: () => {
    active = false;
    if (timer) clearTimeout(timer);
    timer = null;
    const ws = socket;
    socket = null; // cleared first, so this socket's own onclose is treated as superseded
    ws?.close();
    set({ connected: false });
  },

  micControl: (type) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type }));
  },
  micAudio: (pcm) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(pcm);
  },

  onAudioFrame: (fn) => {
    audioSubs.add(fn);
    return () => {
      audioSubs.delete(fn);
    };
  },
}));

registerStoreReset(() => {
  useSocketStore.getState().disconnect();
  audioSubs.clear();
  nextId = 0;
  useSocketStore.setState({ connected: false, audioMode: false });
});
