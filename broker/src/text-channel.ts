/**
 * TextChannel — the broker's text I/O for UIs (Tauri control plane, curl).
 * The textual twin of the mic path: POST /utterance injects a line exactly
 * like the stdin dev channel, and a WebSocket at /events streams the live
 * transcript ({type:'utterance'|'speech', text}) to every connected client.
 * Loopback-only; CORS is wide open because the bind address is the gate.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { Blueprint } from './blueprints.ts';
import type { Doc } from './documents.ts';

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
  /** Portrait filename; the UI fetches bytes from GET /avatars/<file>. */
  avatar?: string;
}

export type ChannelFrame =
  | { type: 'utterance' | 'speech'; text: string }
  | {
      type: 'roster';
      agents: RosterEntry[];
      /** The broker's own identity (host tile) — never an entry in `agents`. */
      identity?: { name: string; role: string; ring?: string; listening?: boolean };
    }
  /** Hello-frame capabilities: audio=true means the broker streams TTS audio frames. */
  | { type: 'config'; audio: boolean }
  /** One synthesized speech chunk (mp3), base64-encoded for the JSON channel. */
  | { type: 'audio'; speaker?: string; mime: string; dataB64: string }
  /**
   * Active session changed (or hello): full transcript replay + the session list +
   * workspaces. `session: null` is a valid, deliberate state — zero sessions exist yet
   * (fresh install, or every session was removed) — distinct from "hello frame not sent
   * yet"; UIs render an empty/creation state rather than treating it as still-loading.
   */
  | {
      type: 'session';
      session: { id: string; title: string; workspace: string; runtime: string } | null;
      sessions: Array<{ id: string; title: string; workspace: string; updatedAt: string; active: boolean; runtime: string }>;
      transcript: Array<{ role: 'user' | 'broker'; text: string }>;
      workspaces: string[];
    }
  /** A delegated task was just bound to an agent — the deterministic handle an external bridge (broker/bin) correlates against, since the brain's own spoken confirmation is free-form prose. */
  | { type: 'task-dispatched'; taskId: string; agent: string; task: string }
  /** A muted system line (e.g. "no STT key configured") — distinct from an agent's own `speech`, so UIs can render it de-emphasized instead of attributing it to a speaker. */
  | { type: 'notice'; text: string }
  /** A work-board card changed (moved, delegated, or a delegated task completed/failed) — the board stage refetches. */
  | { type: 'board-updated'; boardId: string }
  /** A capability (or one of its slices, or a card linked to it) changed — the story map stage refetches. */
  | { type: 'capability-updated'; capabilityId: string }
  /**
   * All documents, full-frame-on-change — the roster idiom, not a diff. Also
   * delivered to every fresh WS client the moment it connects, same as
   * `session` (see the hello-frame closure in main.ts).
   */
  | { type: 'documents'; documents: Doc[] };

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
  // PATCH is required: the control plane patches capabilities and reorders story cards
  // with it (control-plane/src/api/work.ts:90 and :184). Omitting it here blocks every
  // browser write at preflight while `curl -X PATCH` succeeds, because curl sends no
  // preflight — so the route looks healthy from the terminal and is dead in the app.
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
};

// Routes that touch credential-presence data need a real origin check, unlike the
// rest of this file's intentionally-open CORS (loopback bind is the gate there).
// Both spellings of the SAME dev server. Vite serves 1420 on the loopback interface and the
// browser sends whichever host the user typed, so `http://127.0.0.1:1420` and
// `http://localhost:1420` are one origin in intent and two strings here. Listing only one
// meant the stage worked at localhost and 403'd at 127.0.0.1 — the write failed as "Update
// failed" with a CORS console error, and which of the two you happened to type decided
// whether the app worked. This is not a widening of trust: an attacker cannot originate
// from a loopback dev-server origin in the victim's browser without already controlling it.
const ALLOWED_ORIGINS = new Set(['http://localhost:1420', 'http://127.0.0.1:1420']); // control-plane's Vite dev origin (see control-plane/vite.config.ts, tauri.conf.json devUrl)
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
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

/** Frames the channel owes its clients after a successful mutating /work call. */
export function workUpdateFrames(
  method: string,
  pathname: string,
  payload: unknown,
): Array<{ type: 'capability-updated'; capabilityId: string }> {
  if (method === 'GET') return [];
  const capMatch = pathname.match(/^\/work\/capabilities(?:\/([^/]+))?/);
  if (capMatch) {
    const capabilityId = capMatch[1] ?? (payload as { id?: string })?.id;
    return capabilityId ? [{ type: 'capability-updated', capabilityId }] : [];
  }
  const ref = (payload as { capabilityRef?: { capabilityId?: string } })?.capabilityRef;
  if (/^\/work\/boards\/[^/]+\/cards\/[^/]+$/.test(pathname) && ref?.capabilityId) {
    return [{ type: 'capability-updated', capabilityId: ref.capabilityId }];
  }
  return [];
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
    /**
     * Session lifecycle (POST /sessions, POST /sessions/:id/activate). `create` is async
     * and atomic — the runtime the caller asked for is validated/acquired before the
     * session exists, so a rejected create (e.g. an unavailable execution mode) never
     * leaves a half-created session behind; the handler decides the status code (e.g.
     * 409 for "mode not available") via the optional `status` field. `activate` is
     * unchanged: an error string or null, always mapped to 400/200.
     */
    private readonly sessions?: {
      create(body: { workspace?: string; runtime?: string; prompt?: string }): Promise<{ error: string; status?: number } | null>;
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
      /** Gemini portrait for the wizard preview; {error} when no key or refusal. */
      generateAvatar(body: Record<string, unknown>): Promise<Record<string, unknown>>;
      /** Portrait bytes proxied from the swarm; null = 404. */
      avatarFile(file: string): Promise<Buffer | null>;
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
    },
    /** Per-workspace Discord channel config (channels manager UI). Origin-restricted like /me. */
    private readonly channels?: {
      get(name: string): Promise<Record<string, unknown>>;
      save(name: string, body: Record<string, unknown>): Promise<Record<string, unknown>>;
      verifyDiscord(name: string): Promise<Record<string, unknown>>;
    },
    /** Connector registry (Integrations settings group): vendor metadata, CRUD, and verify. Origin-restricted like /me and channels. */
    private readonly connectors?: {
      vendors(): Promise<Record<string, unknown>[]>;
      list(): Promise<Record<string, unknown>[]>;
      add(body: Record<string, unknown>): Promise<Record<string, unknown>>;
      update(id: string, body: Record<string, unknown>): Promise<Record<string, unknown>>;
      remove(id: string): Promise<Record<string, unknown>>;
      verify(id: string, extra?: Record<string, string>): Promise<Record<string, unknown>>;
    },
    /** Task status passthrough for the external bridge (Copilot/Claude, see broker/bin). Read-only, loopback-trusted like the rest of this file. */
    private readonly tasks?: {
      get(taskId: string): Promise<Record<string, unknown> | null>;
    },
    /** CLI tool registry (CLI Tools settings group + rail badge): machine-level tool statuses, re-probe, enable toggle. Origin-restricted like connectors. */
    private readonly cliTools?: {
      list(): Promise<Record<string, unknown>>;
      refresh(tool?: string): Promise<Record<string, unknown>>;
      setEnabled(id: string, enabled: boolean): Promise<Record<string, unknown>>;
    },
    /** Work boards: verbatim proxy to the swarm + the one dispatch route. Named distinctly from `work` above (busy-agent activity/steer/cancel) — same domain word, different concern. */
    private readonly workBoards?: {
      proxy(method: string, path: string, body?: unknown): Promise<{ status: number; payload: unknown }>;
      delegate(body: Record<string, unknown>): Promise<{ taskId: string } | { error: string }>;
    },
    /** API key registry (Settings → API Keys): provider list, save/verify/remove. Origin-restricted like connectors. No credential route — raw keys never transit 7790. */
    private readonly apiKeys?: {
      list(): Promise<unknown>;
      save(id: string, key: string): Promise<unknown>;
      verify(id: string): Promise<unknown>;
      remove(id: string): Promise<unknown>;
    },
    /** Voice status + settings passthrough (Settings → Voice group). Origin-restricted like connectors. No credential route here either — raw provider keys live behind swarm's /me/voice/keys, never proxied on 7790. */
    private readonly voice?: {
      /** Cached resolver snapshot for the /agents payload. */
      status(): { stt: boolean; tts: boolean };
      /** Voice settings passthrough (Settings → Voice group). Origin-restricted like connectors. */
      get(): Promise<Record<string, unknown>>;
      save(body: unknown): Promise<Record<string, unknown>>;
    },
    /** Execution-mode availability probe (new-session runtime picker): which runtimes this machine can actually run right now, keyed by mode id. Origin-restricted like cliTools. */
    private readonly execModes?: {
      list(): Promise<Record<string, boolean>>;
    },
    /** Local-docker container runtime settings + live daemon verify (Settings → advanced). Origin-restricted like cliTools. */
    private readonly containers?: {
      get(): Promise<unknown>;
      set(enabled: boolean): Promise<unknown>;
      verify(): Promise<unknown>;
    },
    /** Polish-my-input (POST /polish): one standalone rewrite call before dispatch. Null = the model call failed; the caller keeps the draft. */
    private readonly polish?: (text: string) => Promise<string | null>,
    /** Blueprint catalog for GET /blueprints (the document-creation picker). */
    private readonly blueprints?: () => Blueprint[],
    /**
     * Document lifecycle (POST /documents, PATCH /documents/:id/sections/:id).
     * `create` mirrors `sessions.create`'s async/error-with-status shape;
     * `patchSection` is synchronous like `sessions.activate` — an error
     * string or null, mapped to 404/200.
     */
    private readonly documents?: {
      create(body: { blueprintId?: string; workType?: string; title?: string }): Promise<{ doc?: Doc; error?: string; status?: number }>;
      patchSection(docId: string, sectionId: string, body: string): string | null;
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
      if (req.method === 'GET' && this.tasks) {
        const m = /^\/tasks\/([^/]+)$/.exec(new URL(req.url ?? '/', 'http://localhost').pathname);
        if (m) {
          const taskId = decodeURIComponent(m[1]!);
          void this.tasks.get(taskId).then(
            (t) =>
              t
                ? res.writeHead(200, { ...CORS, 'content-type': 'application/json' }).end(JSON.stringify(t))
                : res.writeHead(404, { ...CORS, 'content-type': 'application/json' }).end(JSON.stringify({ error: `task ${taskId} not found` })),
            (err: unknown) =>
              res.writeHead(500, { ...CORS, 'content-type': 'application/json' }).end(JSON.stringify({ error: String((err as Error).message ?? err) })),
          );
          return;
        }
      }
      if (this.creation) {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const json = (status: number, payload: unknown) =>
          res.writeHead(status, { ...CORS, 'content-type': 'application/json' }).end(JSON.stringify(payload));
        const fail = (err: unknown) => json(500, { error: String((err as Error).message ?? err) });

        // /me, workspace channels, and the connector registry (vendors list, CRUD,
        // verify) all return credential-presence data — GET/PUT /me, GET/PUT
        // /workspaces/:name/channels, /workspaces/:name/verify-atlassian,
        // /workspaces/:name/repos/:repo/verify-github, and every /me/connectors*
        // route — unlike the rest of this block, their CORS response must name the
        // actual allowed origin (or omit the header) instead of '*', and they
        // refuse to do any work at all for a disallowed Origin.
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
        // Portraits: one URL shape for roster avatars, chooser cards, and
        // edit-mode previews. `no-cache` because a reroll or preset join can
        // replace bytes behind an unchanged filename.
        const avatarFileMatch = /^\/avatars\/([a-z0-9][a-z0-9-]{0,63}\.png)$/.exec(url.pathname);
        if (req.method === 'GET' && avatarFileMatch) {
          void this.creation.avatarFile(avatarFileMatch[1]!).then(
            (buf) =>
              buf
                ? res.writeHead(200, { ...CORS, 'content-type': 'image/png', 'cache-control': 'no-cache' }).end(buf)
                : json(404, { error: 'avatar not found' }),
            fail,
          );
          return;
        }
        if (req.method === 'POST' && url.pathname === '/avatars/generate') {
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
            void this.creation!.generateAvatar(parsed).then(
              (r) => json((r as { error?: string }).error ? 400 : 200, r),
              fail,
            );
          });
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
            return json(200, {
              agents: withPresence,
              discord: this.surfaces?.info() ?? { configured: false, voiceReady: false },
              voice: this.voice?.status() ?? { stt: false, tts: false },
            });
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
        if (req.method === 'GET' && url.pathname === '/me/voice' && this.voice) {
          if (originBlocked()) return;
          void this.voice.get().then((v) => credJson(200, v), credFail);
          return;
        }
        if (req.method === 'PUT' && url.pathname === '/me/voice' && this.voice) {
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
            void this.voice!.save(parsed).then((r) => credJson((r as { error?: string }).error ? 400 : 200, r), credFail);
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/connectors/vendors' && this.connectors) {
          if (originBlocked()) return;
          void this.connectors.vendors().then((r) => credJson(200, r), credFail);
          return;
        }
        if (req.method === 'GET' && url.pathname === '/me/connectors' && this.connectors) {
          if (originBlocked()) return;
          void this.connectors.list().then((r) => credJson(200, r), credFail);
          return;
        }
        if (req.method === 'POST' && url.pathname === '/me/connectors' && this.connectors) {
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
            void this.connectors!.add(parsed).then((r) => credJson((r as { error?: string }).error ? 400 : 201, r), credFail);
          });
          return;
        }
        const connectorIdMatch = /^\/me\/connectors\/([^/]+)$/.exec(url.pathname);
        if (req.method === 'PUT' && connectorIdMatch && this.connectors) {
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
            void this.connectors!
              .update(decodeURIComponent(connectorIdMatch[1]!), parsed)
              .then((r) => credJson((r as { error?: string }).error ? 400 : 200, r), credFail);
          });
          return;
        }
        if (req.method === 'DELETE' && connectorIdMatch && this.connectors) {
          if (originBlocked()) return;
          void this.connectors
            .remove(decodeURIComponent(connectorIdMatch[1]!))
            .then((r) => credJson((r as { error?: string }).error ? 400 : 200, r), credFail);
          return;
        }
        const connectorVerifyMatch = /^\/me\/connectors\/([^/]+)\/verify$/.exec(url.pathname);
        if (req.method === 'POST' && connectorVerifyMatch && this.connectors) {
          if (originBlocked()) return;
          let body = '';
          req.on('data', (c) => {
            body += c;
          });
          req.on('end', () => {
            let parsed: { extra?: Record<string, string> } = {};
            try {
              parsed = body ? (JSON.parse(body) as { extra?: Record<string, string> }) : {};
            } catch {
              return credJson(400, { error: 'body must be JSON' });
            }
            void this.connectors!
              .verify(decodeURIComponent(connectorVerifyMatch[1]!), parsed.extra)
              .then((r) => credJson((r as { error?: string }).error ? 400 : 200, r), credFail);
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/cli-tools' && this.cliTools) {
          if (originBlocked()) return;
          void this.cliTools.list().then((r) => credJson(200, r), credFail);
          return;
        }
        if (req.method === 'POST' && url.pathname === '/cli-tools/refresh' && this.cliTools) {
          if (originBlocked()) return;
          void this.cliTools
            .refresh(url.searchParams.get('tool') ?? undefined)
            .then((r) => credJson(200, r), credFail);
          return;
        }
        const cliToolMatch = /^\/cli-tools\/([^/]+)$/.exec(url.pathname);
        if (req.method === 'PUT' && cliToolMatch && this.cliTools) {
          if (originBlocked()) return;
          let body = '';
          req.on('data', (c) => {
            body += c;
          });
          req.on('end', () => {
            let parsed: { enabled?: unknown } = {};
            try {
              parsed = JSON.parse(body || '{}') as { enabled?: unknown };
            } catch {
              return credJson(400, { error: 'body must be JSON' });
            }
            if (typeof parsed.enabled !== 'boolean') return credJson(400, { error: 'body must be { enabled: boolean }' });
            void this.cliTools!
              .setEnabled(decodeURIComponent(cliToolMatch[1]!), parsed.enabled)
              .then((r) => credJson((r as { error?: string }).error ? 400 : 200, r), credFail);
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/execution-modes' && this.execModes) {
          if (originBlocked()) return;
          void this.execModes.list().then((modes) => credJson(200, { modes }), credFail);
          return;
        }
        if (req.method === 'GET' && url.pathname === '/containers' && this.containers) {
          if (originBlocked()) return;
          void this.containers.get().then((r) => credJson(200, r), credFail);
          return;
        }
        if (req.method === 'PUT' && url.pathname === '/containers' && this.containers) {
          if (originBlocked()) return;
          let body = '';
          req.on('data', (c) => {
            body += c;
          });
          req.on('end', () => {
            let parsed: { docker?: { enabled?: unknown } } = {};
            try {
              parsed = JSON.parse(body || '{}') as { docker?: { enabled?: unknown } };
            } catch {
              return credJson(400, { error: 'body must be JSON' });
            }
            if (typeof parsed.docker?.enabled !== 'boolean') return credJson(400, { error: 'body must be { docker: { enabled: boolean } }' });
            void this.containers!.set(parsed.docker.enabled).then((r) => credJson(200, r), credFail);
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/containers/verify' && this.containers) {
          if (originBlocked()) return;
          void this.containers.verify().then((r) => credJson(200, r), credFail);
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api-keys' && this.apiKeys) {
          if (originBlocked()) return;
          void this.apiKeys.list().then((r) => credJson(200, r), credFail);
          return;
        }
        const apiKeyVerifyMatch = /^\/api-keys\/([^/]+)\/verify$/.exec(url.pathname);
        if (req.method === 'POST' && apiKeyVerifyMatch && this.apiKeys) {
          if (originBlocked()) return;
          void this.apiKeys
            .verify(decodeURIComponent(apiKeyVerifyMatch[1]!))
            .then((r) => credJson((r as { error?: string }).error ? 400 : 200, r), credFail);
          return;
        }
        const apiKeyMatch = /^\/api-keys\/([^/]+)$/.exec(url.pathname);
        if (req.method === 'PUT' && apiKeyMatch && this.apiKeys) {
          if (originBlocked()) return;
          let body = '';
          req.on('data', (c) => {
            body += c;
          });
          req.on('end', () => {
            let parsed: { key?: string } = {};
            try {
              parsed = JSON.parse(body || '{}') as { key?: string };
            } catch {
              return credJson(400, { error: 'body must be JSON' });
            }
            void this.apiKeys!
              .save(decodeURIComponent(apiKeyMatch[1]!), parsed.key ?? '')
              .then((r) => credJson((r as { error?: string }).error ? 400 : 200, r), credFail);
          });
          return;
        }
        if (req.method === 'DELETE' && apiKeyMatch && this.apiKeys) {
          if (originBlocked()) return;
          void this.apiKeys
            .remove(decodeURIComponent(apiKeyMatch[1]!))
            .then((r) => credJson((r as { error?: string }).error ? 400 : 200, r), credFail);
          return;
        }
        // NOTE: /api-keys/:id/credential is deliberately absent — raw keys never
        // transit 7790 (spec invariant). The verify-match must run BEFORE the bare
        // /api-keys/:id match so PUT/DELETE never swallow /verify; keep this order.
      }
      const sessionMatch = /^\/sessions(?:\/([^/]+)\/activate)?$/.exec(req.url ?? '');
      if (req.method === 'POST' && sessionMatch && this.sessions) {
        // Creating/activating a session is a mutation — same origin guard as /work/delegate
        // and the credential-adjacent routes above. An absent Origin header still passes
        // (the smith-broker-send CLI bridge and same-process callers send no Origin); only a
        // present-and-disallowed origin is refused.
        const originBlocked = (): boolean => {
          if (isAllowedOrigin(req)) return false;
          res.writeHead(403, { ...credentialCors(req), 'content-type': 'application/json' }).end(JSON.stringify({ error: 'origin not allowed' }));
          return true;
        };
        if (originBlocked()) return;
        let body = '';
        req.on('data', (c) => {
          body += c;
        });
        req.on('end', () => {
          let parsed: { workspace?: unknown; runtime?: unknown; prompt?: unknown } = {};
          try {
            parsed = JSON.parse(body || '{}') as typeof parsed;
          } catch {
            /* empty body is fine */
          }
          if (sessionMatch[1]) {
            const error = this.sessions!.activate(decodeURIComponent(sessionMatch[1]));
            res
              .writeHead(error ? 400 : 200, { ...CORS, 'content-type': 'application/json' })
              .end(JSON.stringify(error ? { error } : { ok: true }));
            return;
          }
          // Atomic create: the runtime is validated/acquired before the session exists,
          // so the caller either gets a live session or a clean rejection — never a
          // half-created one. The handler decides the status (e.g. 409 for an
          // unavailable execution mode) via the optional `status` field.
          void this.sessions!.create({
            workspace: typeof parsed.workspace === 'string' ? parsed.workspace : undefined,
            runtime: typeof parsed.runtime === 'string' ? parsed.runtime : undefined,
            prompt: typeof parsed.prompt === 'string' ? parsed.prompt : undefined,
          }).then(
            (r) => {
              res
                .writeHead(r ? (r.status ?? 400) : 200, { ...CORS, 'content-type': 'application/json' })
                .end(JSON.stringify(r ? { error: r.error } : { ok: true }));
            },
            (err: unknown) =>
              res.writeHead(500, { ...CORS, 'content-type': 'application/json' }).end(JSON.stringify({ error: String((err as Error).message ?? err) })),
          );
        });
        return;
      }
      {
        // Blueprints/documents: GET /blueprints is read-only (no guard); the
        // two mutating routes use the same originBlocked() guard POST
        // /sessions uses above — an absent Origin passes, a present-and-
        // disallowed one 403s.
        const url = new URL(req.url ?? '/', 'http://localhost');
        const json = (status: number, payload: unknown) =>
          res.writeHead(status, { ...CORS, 'content-type': 'application/json' }).end(JSON.stringify(payload));
        const originBlocked = (): boolean => {
          if (isAllowedOrigin(req)) return false;
          res.writeHead(403, { ...credentialCors(req), 'content-type': 'application/json' }).end(JSON.stringify({ error: 'origin not allowed' }));
          return true;
        };

        if (req.method === 'GET' && url.pathname === '/blueprints' && this.blueprints) {
          json(200, { blueprints: this.blueprints() });
          return;
        }

        if (req.method === 'POST' && url.pathname === '/documents' && this.documents) {
          if (originBlocked()) return;
          let body = '';
          req.on('data', (c) => {
            body += c;
          });
          req.on('end', () => {
            let parsed: { blueprintId?: unknown; workType?: unknown; title?: unknown } = {};
            try {
              parsed = JSON.parse(body || '{}') as typeof parsed;
            } catch {
              /* empty body handled by the closure's validation */
            }
            void this.documents!.create({
              blueprintId: typeof parsed.blueprintId === 'string' ? parsed.blueprintId : undefined,
              workType: typeof parsed.workType === 'string' ? parsed.workType : undefined,
              title: typeof parsed.title === 'string' ? parsed.title : undefined,
            }).then(
              (r) => (r.doc ? json(200, { doc: r.doc }) : json(r.status ?? 400, { error: r.error ?? 'invalid request' })),
              (err: unknown) => json(500, { error: String((err as Error).message ?? err) }),
            );
          });
          return;
        }

        const docSectionMatch = /^\/documents\/([^/]+)\/sections\/([^/]+)$/.exec(url.pathname);
        if (req.method === 'PATCH' && docSectionMatch && this.documents) {
          if (originBlocked()) return;
          let body = '';
          req.on('data', (c) => {
            body += c;
          });
          req.on('end', () => {
            let text = '';
            try {
              text = String((JSON.parse(body || '{}') as { body?: unknown }).body ?? '');
            } catch {
              /* empty = clear the section, which is legal */
            }
            const error = this.documents!.patchSection(
              decodeURIComponent(docSectionMatch[1]!),
              decodeURIComponent(docSectionMatch[2]!),
              text,
            );
            json(error ? 404 : 200, error ? { error } : { ok: true });
          });
          return;
        }
      }
      if (req.method === 'POST' && req.url === '/polish' && this.polish) {
        const json = (status: number, payload: unknown) =>
          res.writeHead(status, { ...CORS, 'content-type': 'application/json' }).end(JSON.stringify(payload));
        let body = '';
        req.on('data', (c) => {
          body += c;
        });
        req.on('end', () => {
          let text = '';
          try {
            text = String((JSON.parse(body || '{}') as { text?: unknown }).text ?? '');
          } catch {
            /* falls through to the empty-text 400 */
          }
          if (!text.trim()) {
            json(400, { error: 'text is required' });
            return;
          }
          void this.polish!(text).then(
            (polished) => (polished ? json(200, { text: polished }) : json(502, { error: 'polish unavailable' })),
            () => json(502, { error: 'polish unavailable' }),
          );
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
      if (this.workBoards) {
        const url2 = new URL(req.url ?? '/', 'http://localhost');
        if (req.method === 'POST' && url2.pathname === '/work/delegate') {
          // Dispatch binds a task to an agent — same origin guard as /me and /me/connectors;
          // the generic /work/* proxy below stays on the open CORS policy.
          const originBlocked = (): boolean => {
            if (isAllowedOrigin(req)) return false;
            res.writeHead(403, { ...credentialCors(req), 'content-type': 'application/json' }).end(JSON.stringify({ error: 'origin not allowed' }));
            return true;
          };
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
              return res.writeHead(400, { ...CORS, 'content-type': 'application/json' }).end(JSON.stringify({ error: 'body must be JSON' }));
            }
            void this.workBoards!.delegate(parsed).then(
              (r) => res.writeHead('error' in r ? 409 : 200, { ...CORS, 'content-type': 'application/json' }).end(JSON.stringify(r)),
              (err: unknown) => res.writeHead(500, { ...CORS, 'content-type': 'application/json' }).end(JSON.stringify({ error: String((err as Error).message ?? err) })),
            );
          });
          return;
        }
        if (url2.pathname.startsWith('/work/')) {
          // Reads stay on the open CORS policy (boards are not credential data), but a
          // mutation is a mutation: with 'Access-Control-Allow-Origin: *' any page the
          // operator visits could POST/PATCH/DELETE cards here and the write would land
          // even though the attacker can't read the reply. Same guard as /work/delegate.
          const safeMethod = req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS';
          if (!safeMethod && !isAllowedOrigin(req)) {
            res
              .writeHead(403, { ...credentialCors(req), 'content-type': 'application/json' })
              .end(JSON.stringify({ error: 'origin not allowed' }));
            return;
          }
          let body = '';
          req.on('data', (c) => {
            body += c;
          });
          req.on('end', () => {
            let parsed: unknown;
            if (body) {
              try {
                parsed = JSON.parse(body);
              } catch {
                return res.writeHead(400, { ...CORS, 'content-type': 'application/json' }).end(JSON.stringify({ error: 'body must be JSON' }));
              }
            }
            void this.workBoards!.proxy(req.method ?? 'GET', url2.pathname, parsed).then(
              (r) => {
                res.writeHead(r.status, { ...CORS, 'content-type': 'application/json' }).end(JSON.stringify(r.payload));
                if (r.status < 400) {
                  for (const frame of workUpdateFrames(req.method ?? 'GET', url2.pathname, r.payload)) this.broadcast(frame);
                }
              },
              (err: unknown) => res.writeHead(500, { ...CORS, 'content-type': 'application/json' }).end(JSON.stringify({ error: String((err as Error).message ?? err) })),
            );
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
