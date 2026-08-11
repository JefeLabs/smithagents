// ---------------------------------------------------------------------------
// auth.ts — broker connection identity: passkey humans, bearer bridges
//
// (Named auth.ts because identity.ts is the broker's host PERSONA module —
// Anderson — an unrelated concept.)
//
// Mirrors swarm's device-registry pattern: sha256-hashed secrets at rest,
// timingSafeEqual compares, one JSON file, injectable clock. Invite codes
// enroll humans (SimpleWebAuthn ceremonies → passkey credentials → hashed
// session tokens in an HttpOnly cookie); the bridge presents a static
// bearer token. In open mode (required: false) nothing is enforced — the
// loopback dev experience is unchanged.
// ---------------------------------------------------------------------------
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { IncomingMessage } from 'node:http';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';

export type Identity =
  | { kind: 'human'; userId: string; name: string; role: 'owner' }
  | { kind: 'bridge' };

export interface WebAuthnAdapter {
  generateRegistrationOptions(input: { rpID: string; rpName: string; userName: string }): Promise<unknown>;
  verifyRegistrationResponse(input: { response: unknown; expectedChallenge: string; expectedOrigin: string; expectedRPID: string }): Promise<{ verified: boolean; registrationInfo?: { credential: { id: string; publicKey: Uint8Array; counter: number; transports?: string[] } } }>;
  generateAuthenticationOptions(input: { rpID: string }): Promise<unknown>;
  verifyAuthenticationResponse(input: { response: unknown; expectedChallenge: string; expectedOrigin: string; expectedRPID: string; credential: { id: string; publicKey: Uint8Array; counter: number } }): Promise<{ verified: boolean; authenticationInfo?: { newCounter: number } }>;
}

export interface BrokerAuthOptions {
  /** Passkey rpID (the tenant domain) — fixed for life at cell creation. */
  rpId: string;
  /** WebAuthn expected origin, e.g. 'http://localhost:1420'. */
  webOrigin: string;
  /** Static bearer for smith-broker-send/check. */
  bridgeToken?: string;
  /** false = open mode (loopback dev), true = gate everything. */
  required: boolean;
  webauthn?: WebAuthnAdapter;
}

export class AuthError extends Error {
  constructor(public code: 'invalid-code' | 'verify-failed' | 'unknown-credential', message?: string) {
    super(message ?? code);
  }
}

interface StoredCredential {
  id: string;
  /** base64 of the COSE public key — not a secret */
  publicKey: string;
  counter: number;
  transports?: string[];
}

interface StoredUser {
  userId: string;
  name: string;
  role: 'owner';
  createdAt: string;
  credentials: StoredCredential[];
}

interface StoredSession {
  /** sha256 hex of the session token */
  tokenHash: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
}

interface PendingInvite {
  codeHash: string;
  expiresAt: number;
  /** WebAuthn challenge parked by beginRegistration */
  challenge?: string;
  name?: string;
}

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const DEFAULT_INVITE_TTL_MS = 10 * 60_000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
const SESSION_PREFIX = 'smith-sess-';

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest();
const normalizeCode = (code: string): string => code.toUpperCase().replace(/[^A-Z0-9]/g, '');

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

const defaultAdapter: WebAuthnAdapter = {
  generateRegistrationOptions: (input) =>
    generateRegistrationOptions({
      rpID: input.rpID,
      rpName: input.rpName,
      userName: input.userName,
      // Passkeys proper: resident key + user verification give the
      // usernameless Face ID login flow.
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    }),
  verifyRegistrationResponse: (input) =>
    verifyRegistrationResponse({
      response: input.response as Parameters<typeof verifyRegistrationResponse>[0]['response'],
      expectedChallenge: input.expectedChallenge,
      expectedOrigin: input.expectedOrigin,
      expectedRPID: input.expectedRPID,
    }) as ReturnType<WebAuthnAdapter['verifyRegistrationResponse']>,
  generateAuthenticationOptions: (input) => generateAuthenticationOptions({ rpID: input.rpID, userVerification: 'required' }),
  verifyAuthenticationResponse: (input) =>
    verifyAuthenticationResponse({
      response: input.response as Parameters<typeof verifyAuthenticationResponse>[0]['response'],
      expectedChallenge: input.expectedChallenge,
      expectedOrigin: input.expectedOrigin,
      expectedRPID: input.expectedRPID,
      credential: {
        id: input.credential.id,
        publicKey: new Uint8Array(input.credential.publicKey),
        counter: input.credential.counter,
      },
    }) as ReturnType<WebAuthnAdapter['verifyAuthenticationResponse']>,
};

export class BrokerAuth {
  readonly required: boolean;
  private readonly webauthn: WebAuthnAdapter;
  private users: StoredUser[] = [];
  private sessions: StoredSession[] = [];
  private readonly invites: PendingInvite[] = [];
  private readonly loginChallenges = new Set<string>();

  constructor(private readonly filePath: string, private readonly opts: BrokerAuthOptions) {
    this.required = opts.required;
    this.webauthn = opts.webauthn ?? defaultAdapter;
  }

  async load(now = Date.now()): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.filePath, 'utf8')) as { users?: StoredUser[]; sessions?: StoredSession[] };
      this.users = Array.isArray(raw.users) ? raw.users : [];
      this.sessions = (Array.isArray(raw.sessions) ? raw.sessions : []).filter((s) => Date.parse(s.expiresAt) > now);
    } catch {
      this.users = [];
      this.sessions = [];
    }
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify({ users: this.users, sessions: this.sessions }, null, 2));
  }

  mintInvite(ttlMs = DEFAULT_INVITE_TTL_MS, now = Date.now()): { code: string; expiresAt: number } {
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    const expiresAt = now + ttlMs;
    this.invites.push({ codeHash: sha256(code).toString('hex'), expiresAt });
    return { code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt };
  }

  private findInvite(code: string, now: number): PendingInvite {
    const presented = sha256(normalizeCode(code));
    const invite = this.invites.find((i) => timingSafeEqual(presented, Buffer.from(i.codeHash, 'hex')));
    if (!invite || now > invite.expiresAt) throw new AuthError('invalid-code');
    return invite;
  }

  async beginRegistration(code: string, name: string, now = Date.now()): Promise<unknown> {
    const invite = this.findInvite(code, now);
    const options = await this.webauthn.generateRegistrationOptions({ rpID: this.opts.rpId, rpName: 'smithagents', userName: name });
    invite.challenge = (options as { challenge: string }).challenge;
    invite.name = name;
    return options;
  }

  async finishRegistration(code: string, response: unknown, now = Date.now()): Promise<{ userId: string; name: string; sessionToken: string }> {
    const invite = this.findInvite(code, now);
    if (!invite.challenge || !invite.name) throw new AuthError('invalid-code', 'registration not begun');
    const result = await this.webauthn.verifyRegistrationResponse({
      response,
      expectedChallenge: invite.challenge,
      expectedOrigin: this.opts.webOrigin,
      expectedRPID: this.opts.rpId,
    });
    if (!result.verified || !result.registrationInfo) throw new AuthError('verify-failed');

    // Consume the invite only on success — a failed ceremony can retry.
    this.invites.splice(this.invites.indexOf(invite), 1);
    const cred = result.registrationInfo.credential;
    const user: StoredUser = {
      userId: `user-${randomUUID().slice(0, 8)}`,
      name: invite.name,
      role: 'owner',
      createdAt: new Date(now).toISOString(),
      credentials: [{ id: cred.id, publicKey: Buffer.from(cred.publicKey).toString('base64'), counter: cred.counter, transports: cred.transports }],
    };
    this.users.push(user);
    const sessionToken = await this.createSession(user.userId, now);
    return { userId: user.userId, name: user.name, sessionToken };
  }

  async beginLogin(): Promise<unknown> {
    const options = await this.webauthn.generateAuthenticationOptions({ rpID: this.opts.rpId });
    this.loginChallenges.add((options as { challenge: string }).challenge);
    return options;
  }

  async finishLogin(response: unknown, now = Date.now()): Promise<{ userId: string; name: string; sessionToken: string }> {
    const credentialId = (response as { id?: string }).id;
    const user = this.users.find((u) => u.credentials.some((c) => c.id === credentialId));
    const cred = user?.credentials.find((c) => c.id === credentialId);
    if (!user || !cred) throw new AuthError('unknown-credential');

    // Usernameless flow: any in-flight challenge may match; try each.
    let verified: { verified: boolean; authenticationInfo?: { newCounter: number } } = { verified: false };
    for (const challenge of this.loginChallenges) {
      verified = await this.webauthn.verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: this.opts.webOrigin,
        expectedRPID: this.opts.rpId,
        credential: { id: cred.id, publicKey: new Uint8Array(Buffer.from(cred.publicKey, 'base64')), counter: cred.counter },
      });
      if (verified.verified) { this.loginChallenges.delete(challenge); break; }
    }
    if (!verified.verified) throw new AuthError('verify-failed');
    cred.counter = verified.authenticationInfo?.newCounter ?? cred.counter;
    const sessionToken = await this.createSession(user.userId, now);
    return { userId: user.userId, name: user.name, sessionToken };
  }

  private async createSession(userId: string, now: number): Promise<string> {
    const token = SESSION_PREFIX + randomBytes(32).toString('hex');
    this.sessions.push({
      tokenHash: sha256(token).toString('hex'),
      userId,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
    });
    await this.persist();
    return token;
  }

  sessionIdentity(token: string, now = Date.now()): Identity | null {
    const presented = sha256(token);
    const session = this.sessions.find((s) => timingSafeEqual(presented, Buffer.from(s.tokenHash, 'hex')));
    if (!session || Date.parse(session.expiresAt) <= now) return null;
    const user = this.users.find((u) => u.userId === session.userId);
    if (!user) return null;
    return { kind: 'human', userId: user.userId, name: user.name, role: user.role };
  }

  logout(token: string): void {
    const presented = sha256(token);
    const idx = this.sessions.findIndex((s) => timingSafeEqual(presented, Buffer.from(s.tokenHash, 'hex')));
    if (idx !== -1) {
      this.sessions.splice(idx, 1);
      void this.persist();
    }
  }

  private bridgeIdentity(token: string | undefined): Identity | null {
    if (!token || !this.opts.bridgeToken) return null;
    if (!timingSafeEqual(sha256(token), sha256(this.opts.bridgeToken))) return null;
    return { kind: 'bridge' };
  }

  /** Cookie session first, then bearer/query bridge token. */
  resolveIdentity(req: IncomingMessage): Identity | null {
    const cookies = parseCookies(req.headers.cookie);
    if (cookies.smith_session) {
      const identity = this.sessionIdentity(cookies.smith_session);
      if (identity) return identity;
    }
    const header = req.headers.authorization;
    const bearer = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
    if (bearer) return this.bridgeIdentity(bearer);
    const query = new URL(req.url ?? '/', 'http://localhost').searchParams.get('token') ?? undefined;
    return this.bridgeIdentity(query);
  }

  listUsers(): Array<{ userId: string; name: string; createdAt: string; credentials: number }> {
    return this.users.map((u) => ({ userId: u.userId, name: u.name, createdAt: u.createdAt, credentials: u.credentials.length }));
  }
}
