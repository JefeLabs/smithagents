/**
 * TextChannel — the broker's text I/O for UIs (Tauri control plane, curl).
 * The textual twin of the mic path: POST /utterance injects a line exactly
 * like the stdin dev channel, and a WebSocket at /events streams the live
 * transcript ({type:'utterance'|'speech', text}) to every connected client.
 * Loopback-only; CORS is wide open because the bind address is the gate.
 */
import { createServer, type Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';

export interface RosterEntry {
  id: string;
  name: string;
  role: string;
  ring?: string;
  status: 'idle' | 'busy' | 'in-meeting' | 'offline';
  taskSummary?: string;
  /** Solo agent or a formed squad (rendered as one circle for the unit). */
  kind: 'agent' | 'squad';
  /** Per-agent Web Speech delivery for UIs that voice the transcript. */
  speech?: { voiceName?: string; lang?: string; pitch?: number; rate?: number };
  /** One-line reason when this agent/squad leader has a hand raised. */
  hand?: string;
  /** True while the live utterance is addressing them ("Hey Manuel"). */
  listening?: boolean;
  /** Squad/group entries: member display names, for the edit-mode expansion. */
  members?: string[];
}

export type ChannelFrame =
  | { type: 'utterance' | 'speech'; text: string }
  | { type: 'roster'; agents: RosterEntry[] }
  /** Hello-frame capabilities: audio=true means the broker streams TTS audio frames. */
  | { type: 'config'; audio: boolean }
  /** One synthesized speech chunk (mp3), base64-encoded for the JSON channel. */
  | { type: 'audio'; speaker?: string; mime: string; dataB64: string }
  /** Active session changed (or hello): full transcript replay + the session list + workspaces. */
  | {
      type: 'session';
      session: { id: string; title: string; workspace: string };
      sessions: Array<{ id: string; title: string; workspace: string; updatedAt: string; active: boolean }>;
      transcript: Array<{ role: 'user' | 'broker'; text: string }>;
      workspaces: string[];
    };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
};

export class TextChannel {
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;

  constructor(
    private readonly onUtterance: (text: string) => void,
    /** Frames sent to each client the moment it connects (e.g. roster snapshot). */
    private readonly helloFrames: () => ChannelFrame[] = () => [],
    /** Roster composition handler (POST /compose). Returns an error string or null. */
    private readonly onCompose: (body: unknown) => string | null = () => 'composition not supported',
    /** Work inspection/control for busy agents and squads. */
    private readonly work?: {
      activity(name: string): Promise<unknown>;
      steer(name: string, message: string): Promise<string | null>;
      cancel(name: string): Promise<string | null>;
    },
    /** Push-to-talk: per-client mic sessions. Binary WS messages are s16le 48kHz mono PCM. */
    private readonly mic?: {
      start(clientId: number): void;
      audio(clientId: number, pcm: Uint8Array): void;
      stop(clientId: number): void;
    },
    /** Session lifecycle (POST /sessions, POST /sessions/:id/activate). Returns an error string or null. */
    private readonly sessions?: {
      create(title?: string, workspace?: string): string | null;
      activate(id: string): string | null;
    },
    /** Full-setup reset (settings). Returns a report of what was destroyed/preserved. */
    private readonly onReset?: (scope: Record<string, unknown>) => Promise<Record<string, unknown>>,
    /** Agent creation: catalog browse, voice audition, and registry writes. */
    private readonly creation?: {
      catalog(): Promise<Record<string, unknown>>;
      generate(body: Record<string, unknown>): Promise<Record<string, unknown>>;
      voices(query: Record<string, string>): Promise<Record<string, unknown>>;
      preview(voiceId: string, text: string): Promise<Buffer>;
      create(body: Record<string, unknown>): Promise<Record<string, unknown>>;
    },
  ) {}

  private clientSeq = 0;

  /** Bind 127.0.0.1:port (0 = ephemeral for tests); resolves the actual port. */
  start(port: number): Promise<number> {
    const server = createServer((req, res) => {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS).end();
        return;
      }
      if (req.method === 'POST' && req.url === '/utterance') {
        let body = '';
        req.on('data', (c) => {
          body += c;
        });
        req.on('end', () => {
          let text: unknown;
          try {
            text = (JSON.parse(body) as { text?: unknown }).text;
          } catch {
            text = undefined;
          }
          if (typeof text !== 'string' || !text.trim()) {
            res.writeHead(400, { ...CORS, 'content-type': 'application/json' }).end(JSON.stringify({ error: 'body must be {"text": string}' }));
            return;
          }
          const utterance = text.trim();
          this.broadcast({ type: 'utterance', text: utterance });
          this.onUtterance(utterance);
          res.writeHead(202, { ...CORS, 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }));
        });
        return;
      }
      if (req.method === 'POST' && req.url === '/compose') {
        let body = '';
        req.on('data', (c) => {
          body += c;
        });
        req.on('end', () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(body);
          } catch {
            parsed = null;
          }
          const error = parsed ? this.onCompose(parsed) : 'body must be JSON';
          const status = error ? 400 : 200;
          res.writeHead(status, { ...CORS, 'content-type': 'application/json' }).end(JSON.stringify(error ? { error } : { ok: true }));
        });
        return;
      }
      if (req.method === 'POST' && req.url === '/reset' && this.onReset) {
        let body = '';
        req.on('data', (c) => {
          body += c;
        });
        req.on('end', () => {
          let scope: Record<string, unknown> = {};
          try {
            scope = JSON.parse(body || '{}') as Record<string, unknown>;
          } catch {
            /* empty body = default scope */
          }
          void this.onReset!(scope)
            .then((report) => res.writeHead(200, { ...CORS, 'content-type': 'application/json' }).end(JSON.stringify(report)))
            .catch((err: unknown) =>
              res.writeHead(500, { ...CORS, 'content-type': 'application/json' }).end(JSON.stringify({ error: String(err) })),
            );
        });
        return;
      }
      if (this.creation) {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const json = (status: number, payload: unknown) =>
          res.writeHead(status, { ...CORS, 'content-type': 'application/json' }).end(JSON.stringify(payload));
        const fail = (err: unknown) => json(500, { error: String((err as Error).message ?? err) });

        if (req.method === 'GET' && url.pathname === '/agent-catalog') {
          void this.creation.catalog().then((c) => json(200, c), fail);
          return;
        }
        if (req.method === 'GET' && url.pathname === '/voices') {
          const query = Object.fromEntries(url.searchParams.entries());
          void this.creation.voices(query).then((v) => json(200, v), fail);
          return;
        }
        if (req.method === 'POST' && url.pathname === '/voices/preview') {
          let body = '';
          req.on('data', (c) => {
            body += c;
          });
          req.on('end', () => {
            let parsed: { voiceId?: string; text?: string } = {};
            try {
              parsed = JSON.parse(body || '{}') as typeof parsed;
            } catch {
              /* handled below */
            }
            if (!parsed.voiceId) return json(400, { error: 'body must be {voiceId, text?}' });
            void this.creation!.preview(parsed.voiceId, parsed.text?.trim() || 'Hola, mi gente. This is how I sound.').then(
              (audio) => res.writeHead(200, { ...CORS, 'content-type': 'audio/mpeg' }).end(audio),
              fail,
            );
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/agents/generate') {
          let body = '';
          req.on('data', (c) => {
            body += c;
          });
          req.on('end', () => {
            let parsed: Record<string, unknown> = {};
            try {
              parsed = JSON.parse(body || '{}') as Record<string, unknown>;
            } catch {
              return json(400, { error: 'body must be JSON' });
            }
            void this.creation!.generate(parsed).then((draft) => json(200, draft), fail);
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/agents') {
          let body = '';
          req.on('data', (c) => {
            body += c;
          });
          req.on('end', () => {
            let parsed: Record<string, unknown> = {};
            try {
              parsed = JSON.parse(body || '{}') as Record<string, unknown>;
            } catch {
              return json(400, { error: 'body must be JSON' });
            }
            void this.creation!.create(parsed).then((r) => json(r.error ? 400 : 201, r), fail);
          });
          return;
        }
      }
      const sessionMatch = /^\/sessions(?:\/([^/]+)\/activate)?$/.exec(req.url ?? '');
      if (req.method === 'POST' && sessionMatch && this.sessions) {
        let body = '';
        req.on('data', (c) => {
          body += c;
        });
        req.on('end', () => {
          let parsed: { title?: unknown; workspace?: unknown } = {};
          try {
            parsed = JSON.parse(body || '{}') as typeof parsed;
          } catch {
            /* empty body is fine */
          }
          const error = sessionMatch[1]
            ? this.sessions!.activate(decodeURIComponent(sessionMatch[1]))
            : this.sessions!.create(
                typeof parsed.title === 'string' ? parsed.title : undefined,
                typeof parsed.workspace === 'string' ? parsed.workspace : undefined,
              );
          res
            .writeHead(error ? 400 : 200, { ...CORS, 'content-type': 'application/json' })
            .end(JSON.stringify(error ? { error } : { ok: true }));
        });
        return;
      }
      const workMatch = /^\/activity\/([^/]+)(\/steer|\/cancel)?$/.exec(req.url ?? '');
      if (workMatch && this.work) {
        const name = decodeURIComponent(workMatch[1]!);
        const action = workMatch[2];
        const respond = (status: number, payload: unknown) =>
          res.writeHead(status, { ...CORS, 'content-type': 'application/json' }).end(JSON.stringify(payload));
        if (req.method === 'GET' && !action) {
          this.work
            .activity(name)
            .then((a) => respond(200, a))
            .catch((err) => respond(502, { error: String(err) }));
          return;
        }
        if (req.method === 'POST' && action) {
          let body = '';
          req.on('data', (c) => {
            body += c;
          });
          req.on('end', () => {
            const message = ((): string => {
              try {
                return String((JSON.parse(body) as { message?: unknown }).message ?? '');
              } catch {
                return '';
              }
            })();
            const run = action === '/steer' ? this.work!.steer(name, message) : this.work!.cancel(name);
            run.then((error) => respond(error ? 409 : 200, error ? { error } : { ok: true })).catch((err) => respond(502, { error: String(err) }));
          });
          return;
        }
      }
      res.writeHead(404, CORS).end();
    });

    this.wss = new WebSocketServer({ server, path: '/events' });
    this.wss.on('connection', (client) => {
      const clientId = ++this.clientSeq;
      for (const frame of this.helloFrames()) client.send(JSON.stringify(frame));
      client.on('message', (data, isBinary) => {
        if (!this.mic) return;
        if (isBinary) {
          this.mic.audio(clientId, new Uint8Array(data as Buffer));
          return;
        }
        try {
          const frame = JSON.parse(String(data)) as { type?: string };
          if (frame.type === 'mic-start') this.mic.start(clientId);
          if (frame.type === 'mic-stop') this.mic.stop(clientId);
        } catch {
          // not a control frame — ignore
        }
      });
      client.on('close', () => this.mic?.stop(clientId));
    });
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        const addr = server.address();
        resolve(typeof addr === 'object' && addr ? addr.port : port);
      });
    });
  }

  /** Connected WS clients — lets callers skip work (e.g. TTS spend) when nobody listens. */
  get clientCount(): number {
    return this.wss?.clients.size ?? 0;
  }

  /** Fan a frame out to every open client; dead sockets are skipped. */
  broadcast(frame: ChannelFrame): void {
    if (!this.wss) return;
    const data = JSON.stringify(frame);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(data);
    }
  }

  async stop(): Promise<void> {
    for (const client of this.wss?.clients ?? []) client.terminate();
    await new Promise<void>((resolve) => this.wss?.close(() => resolve()));
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
    this.wss = null;
    this.server = null;
  }
}
