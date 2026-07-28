import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Live transcript + send pipe to the broker's text channel.
 * The transcript is entirely WS-driven: the channel echoes every accepted
 * utterance (ours included) as a frame, so there is no optimistic local
 * append to dedupe. Reconnects on a fixed backoff while the broker is down.
 */
export interface ChatMessage {
  id: number;
  role: "user" | "broker";
  text: string;
}

export interface SpeechProfile {
  voiceName?: string;
  lang?: string;
  pitch?: number;
  rate?: number;
}

export interface AudioFrame {
  speaker?: string;
  mime: string;
  dataB64: string;
}

export interface RosterAgent {
  id: string;
  name: string;
  role: string;
  ring?: string;
  status: "idle" | "busy" | "in-meeting" | "offline";
  taskSummary?: string;
  kind: "agent" | "squad";
  speech?: SpeechProfile;
  hand?: string;
  /** True while the live utterance is addressing them ("Hey Manuel"). */
  listening?: boolean;
  members?: string[];
}

export type ComposeOp = { op: "form"; agents: string[] } | { op: "add" | "remove"; target: string; agent: string };

export interface SessionSummary {
  id: string;
  title: string;
  workspace: string;
  updatedAt: string;
  active: boolean;
}

const DEFAULT_BASE = "127.0.0.1:7790";
const RECONNECT_MS = 2000;

export function useBrokerChat(opts?: { base?: string; onAudio?: (frame: AudioFrame) => void }) {
  const base = opts?.base ?? DEFAULT_BASE;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [roster, setRoster] = useState<RosterAgent[]>([]);
  const [connected, setConnected] = useState(false);
  const [audioMode, setAudioMode] = useState(false);
  const [session, setSession] = useState<{ id: string; title: string; workspace: string } | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [workspaces, setWorkspaces] = useState<string[]>([]);
  const nextId = useRef(0);
  const wsRef = useRef<WebSocket | null>(null);
  const onAudio = useRef(opts?.onAudio);
  onAudio.current = opts?.onAudio;

  useEffect(() => {
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const open = () => {
      ws = new WebSocket(`ws://${base}/events`);
      wsRef.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onmessage = (e) => {
        const frame = JSON.parse(String(e.data)) as
          | { type: "utterance" | "speech"; text: string }
          | { type: "roster"; agents: RosterAgent[] }
          | { type: "config"; audio: boolean }
          | ({ type: "audio" } & AudioFrame)
          | {
              type: "session";
              session: { id: string; title: string; workspace: string };
              sessions: SessionSummary[];
              transcript: Array<{ role: "user" | "broker"; text: string }>;
              workspaces: string[];
            };
        if (frame.type === "session") {
          setSession(frame.session);
          setSessions(frame.sessions);
          setWorkspaces(frame.workspaces);
          nextId.current = 0;
          setMessages(frame.transcript.map((t) => ({ id: nextId.current++, role: t.role, text: t.text })));
          return;
        }
        if (frame.type === "config") {
          setAudioMode(frame.audio);
          return;
        }
        if (frame.type === "audio") {
          onAudio.current?.(frame);
          return;
        }
        if (frame.type === "roster") {
          setRoster(frame.agents);
          return;
        }
        if (frame.type !== "utterance" && frame.type !== "speech") return;
        setMessages((list) => [
          ...list,
          { id: nextId.current++, role: frame.type === "utterance" ? "user" : "broker", text: frame.text },
        ]);
      };
      ws.onclose = () => {
        setConnected(false);
        if (!disposed) timer = setTimeout(open, RECONNECT_MS);
      };
      ws.onerror = () => ws?.close();
    };
    open();

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  }, [base]);

  const send = useCallback(
    (text: string) => {
      void fetch(`http://${base}/utterance`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      }).catch(() => {
        /* broker down — the disabled composer already communicates this */
      });
    },
    [base],
  );

  const compose = useCallback(
    (op: ComposeOp) => {
      void fetch(`http://${base}/compose`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(op),
      }).catch(() => {
        /* broker down — roster frames simply won't change */
      });
    },
    [base],
  );

  const resetSetup = useCallback(
    async (scope: { runtime?: boolean; conversations?: boolean; worktrees?: boolean; agents?: boolean }) => {
      const res = await fetch(`http://${base}/reset`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(scope),
      });
      return (await res.json()) as {
        ok?: boolean;
        error?: string;
        swarm?: { preserved?: string[]; killed?: Record<string, number> };
      };
    },
    [base],
  );

  const activity = useCallback(
    async (name: string): Promise<{ busy: boolean; label?: string; output?: string }> => {
      const res = await fetch(`http://${base}/activity/${encodeURIComponent(name)}`);
      return (await res.json()) as { busy: boolean; label?: string; output?: string };
    },
    [base],
  );

  const removalPreview = useCallback(
    // 404/500 resolve with { error } and no outcome — the broker never fails to return JSON, so
    // callers only need to guard the network layer, not the parse.
    async (id: string): Promise<{ outcome?: "delete" | "archive"; reasons?: string[]; error?: string }> => {
      const res = await fetch(`http://${base}/agents/${encodeURIComponent(id)}/removal`);
      return (await res.json()) as { outcome?: "delete" | "archive"; reasons?: string[]; error?: string };
    },
    [base],
  );

  const removeAgent = useCallback(
    async (id: string): Promise<{ outcome?: string; error?: string }> => {
      const res = await fetch(`http://${base}/agents/${encodeURIComponent(id)}`, { method: "DELETE" });
      return (await res.json()) as { outcome?: string; error?: string };
    },
    [base],
  );

  const workAction = useCallback(
    async (name: string, action: "steer" | "cancel", message?: string): Promise<string | null> => {
      const res = await fetch(`http://${base}/activity/${encodeURIComponent(name)}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(message ? { message } : {}),
      });
      if (res.ok) return null;
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return body.error ?? `HTTP ${res.status}`;
    },
    [base],
  );

  const createSession = useCallback(
    (workspace?: string) => {
      void fetch(`http://${base}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(workspace ? { workspace } : {}),
      }).catch(() => {});
    },
    [base],
  );

  const activateSession = useCallback(
    (id: string) => {
      void fetch(`http://${base}/sessions/${encodeURIComponent(id)}/activate`, { method: "POST" }).catch(() => {});
    },
    [base],
  );

  const micControl = useCallback((type: "mic-start" | "mic-stop") => {
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ type }));
  }, []);

  const micAudio = useCallback((pcm: ArrayBuffer) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(pcm);
  }, []);

  return {
    messages,
    roster,
    connected,
    audioMode,
    session,
    sessions,
    workspaces,
    send,
    compose,
    activity,
    removalPreview,
    removeAgent,
    workAction,
    micControl,
    micAudio,
    createSession,
    activateSession,
    resetSetup,
  };
}
