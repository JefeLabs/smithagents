/**
 * TextChannel — the broker's text I/O for UIs (Tauri control plane, curl).
 * The textual twin of the mic path: POST /utterance injects a line exactly
 * like the stdin dev channel, and a WebSocket at /events streams the live
 * transcript ({type:'utterance'|'speech', text}) to every connected client.
 * Loopback-only; CORS is wide open because the bind address is the gate.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
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
  // PUT and DELETE aren't CORS-safelisted methods — a real browser/webview fetch
  // preflights them first and blocks the actual request if the method isn't listed
  // here. This file has always routed PUT (/me, /workspaces/:name, /agents/:id) and
  // DELETE (/workspaces/:name, /agents/:id) requests, but the preflight response
  // never advertised them, so those calls never reached this server from a real
  // CORS-enforcing client — only from tests, since Node's fetch doesn't enforce
  // preflight. GET is CORS-safelisted for simple requests but listed anyway for any
  // GET that ever adds a custom header (e.g. an Authorization header) later.
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
};

// Routes that touch credential-presence data need a real origin check, unlike the
// rest of this file's intentionally-open CORS (loopback bind is the gate there).
const ALLOWED_ORIGINS = new Set(['http://localhost:1420']); // control-plane's Vite dev origin (see control-plane/vite.config.ts, tauri.conf.json devUrl)
// TODO: the packaged (non-dev) Tauri app's webview origin is NOT verified against a
// real built app in this environment. It's commonly `tauri://localhost` on macOS or
// `http://tauri.localhost` on Windows, but guessing wrong here would silently lock the
// packaged app out of its own account/workspace-verify routes — confirm the actual
// origin against a real packaged build (e.g. log `window.location.origin` from the
// built app, or check Tauri's own docs for the installed tauri.conf.json's config) and
// add it to this set before shipping a packaged build that depends on these routes.

function isAllowedOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser callers (curl, no Origin header) — same trust model as the rest of this file
  return ALLOWED_ORIGINS.has(origin);
}

/** CORS headers for the credential-adjacent routes only: echo the matched origin, never '*'. */
function credentialCors(req: IncomingMessage): Record<string, string> {
  const origin = req.headers.origin;
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

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
      /** Full stored records, so the wizard can pre-fill when editing. */
      records(): Promise<Record<string, unknown>[]>;
      update(id: string, body: Record<string, unknown>): Promise<Record<string, unknown>>;
      catalog(): Promise<Record<string, unknown>>;
      generate(body: Record<string, unknown>): Promise<Record<string, unknown>>;
      voices(query: Record<string, string>): Promise<Record<string, unknown>>;
      preview(voiceId: string, text: string): Promise<Buffer>;
      create(body: Record<string, unknown>): Promise<Record<string, unknown>>;
    },
    /** Remove-agent decision (archive vs delete) and the confirm-sheet preview behind it. */
    private readonly removal?: {
      preview(id: string): Promise<Record<string, unknown>>;
      execute(id: string): Promise<Record<string, unknown>>;
    },
    /** Workspace CRUD for the manager UI: list for the picker, save for create/edit, remove decides archive vs delete; verify checks a saved connection live. */
    private readonly workspaces?: {
      list(): Promise<Record<string, unknown>[]>;
      save(body: Record<string, unknown>, isNew: boolean): Promise<Record<string, unknown>>;
      remove(name: string): Promise<Record<string, unknown>>;
      verifyAtlassian(name: string): Promise<Record<string, unknown>>;
      verifyGithubRepo(name: string, repoName: string): Promise<Record<string, unknown>>;
    },
    /** Surface presence/admission: live per-agent surface state, Discord availability, on-request join. */
    private readonly surfaces?: {
      /** Per-agent live presence, keyed agentId → surface → present. */
      presence(): Record<string, Record<string, boolean>>;
      /** Discord availability for the UI's grayed rows. */
      info(): { configured: boolean; voiceReady: boolean };
      /** On-request admission. Resolves {ok:true} or {error, status}. */
      join(agentId: string, surface: string): Promise<{ ok: true } | { error: string; status: number }>;
    },
    /** The current operator's profile + credentials (account panel). */
    private readonly me?: {
      get(): Promise<Record<string, unknown>>;
      update(body: Record<string, unknown>): Promise<Record<string, unknown>>;
      verifyGithub(): Promise<Record<string, unknown>>;
    },
    /** Per-workspace Discord channel config (channels manager UI). Origin-restricted like /me. */
    private readonly channels?: {
      get(name: string): Promise<Record<string, unknown>>;
      save(name: string, body: Record<string, unknown>): Promise<Record<string, unknown>>;
      verifyDiscord(name: string): Promise<Record<string, unknown>>;
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

        // /me and the verify-* routes return credential-presence data (or, for
        // verify-github, the operator's real GitHub identity) — unlike the rest of
        // this block, their CORS response must name the actual allowed origin (or
        // omit the header) instead of '*', and they refuse to do any work at all
        // for a disallowed Origin.
        const credJson = (status: number, payload: unknown) =>
          res.writeHead(status, { ...credentialCors(req), 'content-type': 'application/json' }).end(JSON.stringify(payload));
        const credFail = (err: unknown) => credJson(500, { error: String((err as Error).message ?? err) });
        const originBlocked = (): boolean => {
          if (isAllowedOrigin(req)) return false;
          credJson(403, { error: 'origin not allowed' });
          return true;
        };

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
        // Full records for the edit wizard — the roster frame is a view model
        // and deliberately carries none of the persona detail. Additive
        // per-agent `presence` and top-level `discord` availability ride along
        // for surface-aware UIs; existing consumers reading `agents` alone
        // (e.g. AddAgentModal) are unaffected.
        if (req.method === 'GET' && url.pathname === '/agents') {
          void this.creation.records().then((agents) => {
            const presence = this.surfaces?.presence() ?? {};
            const withPresence = agents.map((a) => ({
              ...a,
              presence: presence[String((a as { id?: unknown }).id)] ?? {},
            }));
            return json(200, { agents: withPresence, discord: this.surfaces?.info() ?? { configured: false, voiceReady: false } });
          }, fail);
          return;
        }
        const joinMatch = /^\/agents\/([^/]+)\/surfaces\/([^/]+)\/join$/.exec(url.pathname);
        if (req.method === 'POST' && joinMatch && this.surfaces) {
          void this.surfaces.join(decodeURIComponent(joinMatch[1]!), decodeURIComponent(joinMatch[2]!)).then(
            (r) => ('error' in r ? json(r.status, { error: r.error }) : json(200, { ok: true })),
            fail,
          );
          return;
        }
        const removalMatch = /^\/agents\/([^/]+)\/removal$/.exec(url.pathname);
        if (req.method === 'GET' && removalMatch && this.removal) {
          void this.removal.preview(decodeURIComponent(removalMatch[1]!)).then(
            (r) => json('error' in r ? 404 : 200, r),
            fail,
          );
          return;
        }

        const editMatch = /^\/agents\/([^/]+)$/.exec(url.pathname);
        if (req.method === 'DELETE' && editMatch && this.removal) {
          void this.removal.execute(decodeURIComponent(editMatch[1]!)).then(
            (r) => json('error' in r ? 409 : 200, r),
            fail,
          );
          return;
        }
        if (req.method === 'PUT' && editMatch) {
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
            void this.creation!.update(decodeURIComponent(editMatch[1]!), parsed).then(
              (r) => json(r.error ? 400 : 200, r),
              fail,
            );
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

        if (req.method === 'GET' && url.pathname === '/workspaces' && this.workspaces) {
          void this.workspaces.list().then((workspaces) => json(200, { workspaces }), fail);
          return;
        }
        if (req.method === 'POST' && url.pathname === '/workspaces' && this.workspaces) {
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
            void this.workspaces!.save(parsed, true).then((r) => json(r.error ? 400 : 201, r), fail);
          });
          return;
        }
        const workspaceMatch = /^\/workspaces\/([^/]+)$/.exec(url.pathname);
        if (req.method === 'PUT' && workspaceMatch && this.workspaces) {
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
            void this.workspaces!.save({ ...parsed, name: decodeURIComponent(workspaceMatch[1]!) }, false).then(
              (r) => json(r.error ? 400 : 200, r),
              fail,
            );
          });
          return;
        }
        if (req.method === 'DELETE' && workspaceMatch && this.workspaces) {
          void this.workspaces.remove(decodeURIComponent(workspaceMatch[1]!)).then(
            (r) => json('error' in r ? 409 : 200, r),
            fail,
          );
          return;
        }
        if (req.method === 'GET' && url.pathname === '/me' && this.me) {
          if (originBlocked()) return;
          void this.me.get().then((me) => credJson(200, me), credFail);
          return;
        }
        if (req.method === 'PUT' && url.pathname === '/me' && this.me) {
          if (originBlocked()) return;
          let body = '';
          req.on('data', (c) => {
            body += c;
          });
          req.on('end', () => {
            let parsed: Record<string, unknown> = {};
            try {
              parsed = JSON.parse(body || '{}') as Record<string, unknown>;
            } catch {
              return credJson(400, { error: 'body must be JSON' });
            }
            void this.me!.update(parsed).then((r) => credJson((r as { error?: string }).error ? 400 : 200, r), credFail);
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/me/verify-github' && this.me) {
          if (originBlocked()) return;
          void this.me.verifyGithub().then((r) => credJson((r as { error?: string }).error ? 400 : 200, r), credFail);
          return;
        }
        const wsAtlassianMatch = /^\/workspaces\/([^/]+)\/verify-atlassian$/.exec(url.pathname);
        if (req.method === 'POST' && wsAtlassianMatch && this.workspaces) {
          if (originBlocked()) return;
          void this.workspaces
            .verifyAtlassian(decodeURIComponent(wsAtlassianMatch[1]!))
            .then((r) => credJson((r as { error?: string }).error ? 400 : 200, r), credFail);
          return;
        }
        const repoGithubMatch = /^\/workspaces\/([^/]+)\/repos\/([^/]+)\/verify-github$/.exec(url.pathname);
        if (req.method === 'POST' && repoGithubMatch && this.workspaces) {
          if (originBlocked()) return;
          void this.workspaces
            .verifyGithubRepo(decodeURIComponent(repoGithubMatch[1]!), decodeURIComponent(repoGithubMatch[2]!))
            .then((r) => credJson((r as { error?: string }).error ? 400 : 200, r), credFail);
          return;
        }
        const wsChannelsMatch = /^\/workspaces\/([^/]+)\/channels$/.exec(url.pathname);
        if (req.method === 'GET' && wsChannelsMatch && this.channels) {
          if (originBlocked()) return;
          void this.channels.get(decodeURIComponent(wsChannelsMatch[1]!)).then((r) => credJson(200, r), credFail);
          return;
        }
        if (req.method === 'PUT' && wsChannelsMatch && this.channels) {
          if (originBlocked()) return;
          let body = '';
          req.on('data', (c) => {
            body += c;
          });
          req.on('end', () => {
            let parsed: Record<string, unknown> = {};
            try {
              parsed = JSON.parse(body || '{}') as Record<string, unknown>;
            } catch {
              return credJson(400, { error: 'body must be JSON' });
            }
            void this.channels!.save(decodeURIComponent(wsChannelsMatch[1]!), parsed).then(
              (r) => credJson((r as { error?: string }).error ? 400 : 200, r),
              credFail,
            );
          });
          return;
        }
        const verifyDiscordMatch = /^\/workspaces\/([^/]+)\/channels\/verify-discord$/.exec(url.pathname);
        if (req.method === 'POST' && verifyDiscordMatch && this.channels) {
          if (originBlocked()) return;
          void this.channels.verifyDiscord(decodeURIComponent(verifyDiscordMatch[1]!)).then(
            (r) => credJson((r as { error?: string }).error ? 400 : 200, r),
            credFail,
          );
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
