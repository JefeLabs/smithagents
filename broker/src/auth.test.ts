import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrokerAuth, AuthError, parseCookies, type WebAuthnAdapter } from './auth.js';

const CRED = { id: 'cred-1', publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ['internal'] };

function fakeWebauthn(): WebAuthnAdapter & { lastChallenge: string } {
  const fake = {
    lastChallenge: 'challenge-1',
    async generateRegistrationOptions({ userName }: { userName: string }) {
      return { challenge: fake.lastChallenge, user: { name: userName } };
    },
    async verifyRegistrationResponse({ response }: { response: unknown }) {
      const ok = (response as { ok?: boolean }).ok !== false;
      return ok ? { verified: true, registrationInfo: { credential: CRED } } : { verified: false };
    },
    async generateAuthenticationOptions() {
      return { challenge: fake.lastChallenge };
    },
    async verifyAuthenticationResponse({ response, credential }: { response: unknown; credential: { counter: number } }) {
      const ok = (response as { ok?: boolean }).ok !== false;
      return ok ? { verified: true, authenticationInfo: { newCounter: credential.counter + 1 } } : { verified: false };
    },
  };
  return fake;
}

async function freshAuth(overrides: Partial<import('./auth.js').BrokerAuthOptions> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'auth-'));
  const file = join(dir, 'auth.json');
  const auth = new BrokerAuth(file, {
    rpId: 'localhost', webOrigin: 'http://localhost:1420', required: true,
    webauthn: fakeWebauthn(), ...overrides,
  });
  await auth.load();
  return { auth, file };
}

test('invite → register → session: full happy path', async () => {
  const { auth } = await freshAuth();
  const { code } = auth.mintInvite();
  const options = await auth.beginRegistration(code, 'edwin');
  assert.equal((options as { user: { name: string } }).user.name, 'edwin');
  const { userId, name, sessionToken } = await auth.finishRegistration(code, { ok: true });
  assert.equal(name, 'edwin');
  const identity = auth.sessionIdentity(sessionToken);
  assert.deepEqual(identity, { kind: 'human', userId, name: 'edwin', role: 'owner' });
});

test('invite codes are single-use and expire', async () => {
  const { auth } = await freshAuth();
  const { code } = auth.mintInvite();
  await auth.beginRegistration(code, 'first');
  await auth.finishRegistration(code, { ok: true });
  await assert.rejects(auth.beginRegistration(code, 'second'), (e: AuthError) => e.code === 'invalid-code');

  const { code: expired } = auth.mintInvite(1_000, 0);
  await assert.rejects(auth.beginRegistration(expired, 'late', 5_000), (e: AuthError) => e.code === 'invalid-code');
});

test('failed attestation never creates a user or consumes a session', async () => {
  const { auth } = await freshAuth();
  const { code } = auth.mintInvite();
  await auth.beginRegistration(code, 'edwin');
  await assert.rejects(auth.finishRegistration(code, { ok: false }), (e: AuthError) => e.code === 'verify-failed');
  assert.equal(auth.listUsers().length, 0);
});

test('login round-trip bumps the credential counter and issues a fresh session', async () => {
  const { auth, file } = await freshAuth();
  const { code } = auth.mintInvite();
  await auth.beginRegistration(code, 'edwin');
  await auth.finishRegistration(code, { ok: true });

  await auth.beginLogin();
  const { sessionToken } = await auth.finishLogin({ ok: true, id: 'cred-1' });
  assert.equal(auth.sessionIdentity(sessionToken)?.kind, 'human');

  const raw = JSON.parse(await readFile(file, 'utf8')) as { users: Array<{ credentials: Array<{ counter: number }> }> };
  assert.equal(raw.users[0]!.credentials[0]!.counter, 1);
});

test('sessions are hashed at rest and survive reload; logout kills them', async () => {
  const { auth, file } = await freshAuth();
  const { code } = auth.mintInvite();
  await auth.beginRegistration(code, 'edwin');
  const { sessionToken } = await auth.finishRegistration(code, { ok: true });

  assert.equal((await readFile(file, 'utf8')).includes(sessionToken), false, 'token never raw on disk');

  const reloaded = new BrokerAuth(file, { rpId: 'localhost', webOrigin: 'http://localhost:1420', required: true, webauthn: fakeWebauthn() });
  await reloaded.load();
  assert.equal(reloaded.sessionIdentity(sessionToken)?.kind, 'human');
  reloaded.logout(sessionToken);
  assert.equal(reloaded.sessionIdentity(sessionToken), null);
});

test('resolveIdentity: cookie session, bearer bridge, query rejected, garbage', async () => {
  const { auth } = await freshAuth({ bridgeToken: 'bridge-secret' });
  const { code } = auth.mintInvite();
  await auth.beginRegistration(code, 'edwin');
  const { sessionToken } = await auth.finishRegistration(code, { ok: true });

  const req = (headers: Record<string, string>, url = '/x') => ({ headers, url } as import('node:http').IncomingMessage);
  assert.equal(auth.resolveIdentity(req({ cookie: `smith_session=${sessionToken}` }))?.kind, 'human');
  assert.deepEqual(auth.resolveIdentity(req({ authorization: 'Bearer bridge-secret' })), { kind: 'bridge' });
  // Tokens in URLs leak into logs — the query path is deliberately dead.
  assert.equal(auth.resolveIdentity(req({}, '/events?token=bridge-secret')), null);
  assert.equal(auth.resolveIdentity(req({ authorization: 'Bearer wrong' })), null);
  assert.equal(auth.resolveIdentity(req({})), null);
});

test('parseCookies handles multiple pairs and absent header', () => {
  assert.deepEqual(parseCookies('a=1; smith_session=tok; b=2').smith_session, 'tok');
  assert.deepEqual(parseCookies(undefined), {});
});
