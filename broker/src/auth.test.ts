import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { generateAuthenticationOptions } from "@simplewebauthn/server";
import { type AuthError, BrokerAuth, parseCookies, type WebAuthnAdapter } from "./auth.js";

const CRED = { id: "cred-1", publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ["internal"] };

function fakeWebauthn(): WebAuthnAdapter & { lastChallenge: string } {
  const fake = {
    lastChallenge: "challenge-1",
    async generateRegistrationOptions({ userName }: { userName: string }) {
      return { challenge: fake.lastChallenge, user: { name: userName } };
    },
    async verifyRegistrationResponse({ response }: { response: unknown }) {
      const ok = (response as { ok?: boolean }).ok !== false;
      // Like the real library, a bad attestation THROWS.
      if (!ok) throw new Error("Registration verification failed");
      return { verified: true, registrationInfo: { credential: CRED } };
    },
    async generateAuthenticationOptions({ challenge }: { challenge?: Uint8Array }) {
      // The real library returns base64url(challenge) when handed raw bytes.
      if (challenge) fake.lastChallenge = Buffer.from(challenge).toString("base64url");
      return { challenge: fake.lastChallenge };
    },
    async verifyAuthenticationResponse({
      response,
      expectedChallenge,
      credential,
    }: {
      response: unknown;
      expectedChallenge: string | ((c: string) => boolean | Promise<boolean>);
      credential: { counter: number };
    }) {
      // Like the real library: the response carries the challenge it signed, and a
      // mismatch THROWS rather than returning verified:false.
      const signed = (response as { challenge?: string }).challenge ?? fake.lastChallenge;
      const accepted =
        typeof expectedChallenge === "function" ? await expectedChallenge(signed) : expectedChallenge === signed;
      if (!accepted) throw new Error(`Unexpected authentication response challenge "${signed}"`);
      const ok = (response as { ok?: boolean | "throw" }).ok;
      if (ok === "throw") throw new Error('Could not verify signature for "attacker-controlled text"');
      return ok !== false
        ? { verified: true, authenticationInfo: { newCounter: credential.counter + 1 } }
        : { verified: false };
    },
  };
  return fake;
}

async function freshAuth(overrides: Partial<import("./auth.js").BrokerAuthOptions> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "auth-"));
  const file = join(dir, "auth.json");
  const auth = new BrokerAuth(file, {
    rpId: "localhost",
    webOrigin: "http://localhost:1420",
    required: true,
    webauthn: fakeWebauthn(),
    ...overrides,
  });
  await auth.load();
  return { auth, file };
}

test("invite → register → session: full happy path", async () => {
  const { auth } = await freshAuth();
  const { code } = auth.mintInvite();
  const options = await auth.beginRegistration(code, "edwin");
  assert.equal((options as { user: { name: string } }).user.name, "edwin");
  const { userId, name, sessionToken } = await auth.finishRegistration(code, { ok: true });
  assert.equal(name, "edwin");
  const identity = auth.sessionIdentity(sessionToken);
  assert.deepEqual(identity, { kind: "human", userId, name: "edwin", role: "owner" });
});

test("invite codes are single-use and expire", async () => {
  const { auth } = await freshAuth();
  const { code } = auth.mintInvite();
  await auth.beginRegistration(code, "first");
  await auth.finishRegistration(code, { ok: true });
  await assert.rejects(auth.beginRegistration(code, "second"), (e: AuthError) => e.code === "invalid-code");

  const { code: expired } = auth.mintInvite(1_000, 0);
  await assert.rejects(auth.beginRegistration(expired, "late", 5_000), (e: AuthError) => e.code === "invalid-code");
});

test("failed attestation never creates a user or consumes a session", async () => {
  const { auth } = await freshAuth();
  const { code } = auth.mintInvite();
  await auth.beginRegistration(code, "edwin");
  await assert.rejects(auth.finishRegistration(code, { ok: false }), (e: AuthError) => e.code === "verify-failed");
  assert.equal(auth.listUsers().length, 0);
});

test("login round-trip bumps the credential counter and issues a fresh session", async () => {
  const { auth, file } = await freshAuth();
  const { code } = auth.mintInvite();
  await auth.beginRegistration(code, "edwin");
  await auth.finishRegistration(code, { ok: true });

  await auth.beginLogin();
  const { sessionToken } = await auth.finishLogin({ ok: true, id: "cred-1" });
  assert.equal(auth.sessionIdentity(sessionToken)?.kind, "human");

  const raw = JSON.parse(await readFile(file, "utf8")) as { users: Array<{ credentials: Array<{ counter: number }> }> };
  assert.equal(raw.users[0]!.credentials[0]!.counter, 1);
});

test("sessions are hashed at rest and survive reload; logout kills them", async () => {
  const { auth, file } = await freshAuth();
  const { code } = auth.mintInvite();
  await auth.beginRegistration(code, "edwin");
  const { sessionToken } = await auth.finishRegistration(code, { ok: true });

  assert.equal((await readFile(file, "utf8")).includes(sessionToken), false, "token never raw on disk");

  const reloaded = new BrokerAuth(file, {
    rpId: "localhost",
    webOrigin: "http://localhost:1420",
    required: true,
    webauthn: fakeWebauthn(),
  });
  await reloaded.load();
  assert.equal(reloaded.sessionIdentity(sessionToken)?.kind, "human");
  reloaded.logout(sessionToken);
  assert.equal(reloaded.sessionIdentity(sessionToken), null);
});

test("resolveIdentity: cookie session, bearer bridge, query rejected, garbage", async () => {
  const { auth } = await freshAuth({ bridgeToken: "bridge-secret" });
  const { code } = auth.mintInvite();
  await auth.beginRegistration(code, "edwin");
  const { sessionToken } = await auth.finishRegistration(code, { ok: true });

  const req = (headers: Record<string, string>, url = "/x") =>
    ({ headers, url }) as import("node:http").IncomingMessage;
  assert.equal(auth.resolveIdentity(req({ cookie: `smith_session=${sessionToken}` }))?.kind, "human");
  assert.deepEqual(auth.resolveIdentity(req({ authorization: "Bearer bridge-secret" })), { kind: "bridge" });
  // Tokens in URLs leak into logs — the query path is deliberately dead.
  assert.equal(auth.resolveIdentity(req({}, "/events?token=bridge-secret")), null);
  assert.equal(auth.resolveIdentity(req({ authorization: "Bearer wrong" })), null);
  assert.equal(auth.resolveIdentity(req({})), null);
});

test("parseCookies handles multiple pairs and absent header", () => {
  assert.deepEqual(parseCookies("a=1; smith_session=tok; b=2").smith_session, "tok");
  assert.deepEqual(parseCookies(undefined), {});
});

test("firstRunInviteUrl: with no passkey it returns a link whose code enrolls; once one exists, null", async () => {
  const { auth } = await freshAuth();
  assert.equal(auth.hasUsers(), false);
  const url = auth.firstRunInviteUrl();
  // 16 symbols: the owner invite is a link, so length costs nothing.
  assert.match(url ?? "", /^http:\/\/localhost:1420\/#invite=[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const code = (url ?? "").split("#invite=")[1] as string;
  await auth.beginRegistration(code, "Edwin");
  await auth.finishRegistration(code, { ok: true });
  assert.equal(auth.hasUsers(), true);
  assert.equal(auth.firstRunInviteUrl(), null);
});

test("a human-typed invite stays 8 symbols, and both lengths redeem however they are typed", async () => {
  const { auth } = await freshAuth();
  const long = (auth.firstRunInviteUrl() ?? "").split("#invite=")[1] as string;
  const { code: short } = auth.mintInvite();
  assert.match(short, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  for (const code of [short, long]) {
    const typed = code.toLowerCase().replaceAll("-", "");
    await assert.doesNotReject(auth.beginRegistration(typed, `user-${code.length}`));
  }
});

test("firstRunInviteUrl: an open broker never mints one", async () => {
  const { auth } = await freshAuth({ required: false });
  assert.equal(auth.firstRunInviteUrl(), null);
});

test("firstRunInviteUrl: the invite lasts 24h", async () => {
  const { auth } = await freshAuth();
  const code = (auth.firstRunInviteUrl(0) ?? "").split("#invite=")[1] as string;
  await assert.doesNotReject(auth.beginRegistration(code, "Edwin", 23 * 60 * 60_000));
  const { auth: other } = await freshAuth();
  const late = (other.firstRunInviteUrl(0) ?? "").split("#invite=")[1] as string;
  await assert.rejects(
    other.beginRegistration(late, "Edwin", 25 * 60 * 60_000),
    (e: AuthError) => e.code === "invalid-code",
  );
});

/** Register edwin and return the auth + fake so login tests can drive challenges. */
async function enrolled() {
  const webauthn = fakeWebauthn();
  const { auth } = await freshAuth({ webauthn });
  const { code } = auth.mintInvite();
  await auth.beginRegistration(code, "edwin");
  await auth.finishRegistration(code, { ok: true });
  return { auth, webauthn };
}

const login = (auth: BrokerAuth, challenge: string, now: number) =>
  auth.finishLogin({ ok: true, id: "cred-1", challenge }, now);
const refused = (e: AuthError) => e.code === "verify-failed";

test("a login challenge is accepted once, then refused (replay)", async () => {
  const { auth, webauthn } = await enrolled();
  await auth.beginLogin(0);
  const challenge = webauthn.lastChallenge;
  await assert.doesNotReject(login(auth, challenge, 1_000));
  await assert.rejects(login(auth, challenge, 2_000), refused);
});

test("an expired login challenge is refused", async () => {
  const { auth, webauthn } = await enrolled();
  await auth.beginLogin(0);
  await assert.rejects(login(auth, webauthn.lastChallenge, 5 * 60_000), refused);
  await auth.beginLogin(0);
  await assert.doesNotReject(login(auth, webauthn.lastChallenge, 5 * 60_000 - 1));
});

test("a login challenge with one flipped byte (bad HMAC) is refused", async () => {
  const { auth, webauthn } = await enrolled();
  await auth.beginLogin(0);
  const raw = Buffer.from(webauthn.lastChallenge, "base64url");
  for (const index of [0, 12, raw.length - 1]) {
    const bad = Buffer.from(raw);
    bad[index] = (bad[index] ?? 0) ^ 1;
    await assert.rejects(login(auth, bad.toString("base64url"), 1_000), refused);
  }
  await assert.doesNotReject(login(auth, webauthn.lastChallenge, 1_000)); // the genuine one still works
});

test("1000 beginLogin calls never stop a legitimate pending challenge from succeeding", async () => {
  const { auth, webauthn } = await enrolled();
  await auth.beginLogin(0);
  const legit = webauthn.lastChallenge;
  for (let i = 0; i < 1000; i++) await auth.beginLogin(0);
  await assert.doesNotReject(login(auth, legit, 1_000));
});

test("a cancelled attempt never blocks the retry", async () => {
  const { auth, webauthn } = await enrolled();
  await auth.beginLogin(0); // the cancelled prompt
  await auth.beginLogin(1_000); // the retry
  const { sessionToken } = await login(auth, webauthn.lastChallenge, 2_000);
  assert.equal(auth.sessionIdentity(sessionToken, 2_000)?.kind, "human");
  await assert.rejects(login(auth, "nope", 3_000), refused);
});

test("two concurrent finishLogin calls with the same response yield exactly one session", async () => {
  const { auth, webauthn } = await enrolled();
  await auth.beginLogin(0);
  const results = await Promise.allSettled([
    login(auth, webauthn.lastChallenge, 1_000),
    login(auth, webauthn.lastChallenge, 1_000),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "rejected").length, 1);
});

test("the REAL library hands raw challenge bytes back as the same base64url the server verifies", async () => {
  const bytes = new Uint8Array(randomBytes(56));
  const options = await generateAuthenticationOptions({ rpID: "localhost", challenge: bytes });
  assert.equal(options.challenge, Buffer.from(bytes).toString("base64url"));
  // and through BrokerAuth's default adapter: a 56-byte challenge, 75 base64url chars
  const { auth } = await freshAuth({ webauthn: undefined });
  const real = (await auth.beginLogin(0)) as { challenge: string };
  assert.equal(real.challenge.length, 75);
});

test("a throwing library on sign-in or enrollment is a generic verify-failed", async () => {
  const { auth } = await enrolled();
  await assert.rejects(auth.finishLogin({ ok: true, id: "cred-1", challenge: "x" }, 0), refused);
  const { code } = auth.mintInvite();
  await auth.beginRegistration(code, "again");
  await assert.rejects(auth.finishRegistration(code, { ok: false }), refused);
  await assert.doesNotReject(auth.finishRegistration(code, { ok: true })); // invite not consumed by the failure
});

test("a junk-signature attempt on a minted challenge does not burn it", async () => {
  const { auth, webauthn } = await enrolled();
  await auth.beginLogin(0);
  const challenge = webauthn.lastChallenge;
  await assert.rejects(auth.finishLogin({ ok: false, id: "cred-1", challenge }, 1_000), refused);
  await assert.rejects(auth.finishLogin({ ok: "throw", id: "cred-1", challenge }, 1_000), refused);
  assert.equal(auth.inFlightLoginCount(), 0);
  await assert.doesNotReject(login(auth, challenge, 2_000));
  assert.equal(auth.inFlightLoginCount(), 0);
  await assert.rejects(login(auth, challenge, 3_000), refused); // replay after success
});

test("a full replay guard fails closed and evicts nothing", async () => {
  const { auth, webauthn } = await enrolled();
  await auth.beginLogin(0);
  const first = webauthn.lastChallenge;
  await login(auth, first, 1);
  for (let i = 1; i < 1024; i++) {
    await auth.beginLogin(0);
    await login(auth, webauthn.lastChallenge, 1);
  }
  await auth.beginLogin(0);
  await assert.rejects(login(auth, webauthn.lastChallenge, 2), refused); // guard full -> refused
  await assert.rejects(login(auth, first, 2), refused); // nothing was evicted
  // once entries expire the guard frees up
  await auth.beginLogin(10 * 60_000);
  await assert.doesNotReject(login(auth, webauthn.lastChallenge, 10 * 60_000 + 1));
});

test("a non-string challenge or a non-object response is refused without a throw", async () => {
  const { auth } = await enrolled();
  await assert.rejects(auth.finishLogin(undefined, 0), refused);
  await assert.rejects(auth.finishLogin({ ok: true, id: "cred-1", challenge: 42 }, 0), refused);
});

test("a verified assertion is spent even when saving its session throws: the replay is refused", async () => {
  const webauthn = fakeWebauthn();
  const { auth, file } = await freshAuth({ webauthn });
  const { code } = auth.mintInvite();
  await auth.beginRegistration(code, "edwin");
  await auth.finishRegistration(code, { ok: true });
  await auth.beginLogin(0);
  const challenge = webauthn.lastChallenge;
  // A directory where auth.json lives: persist() throws EISDIR inside createSession.
  await rm(file);
  await mkdir(file);
  await assert.rejects(login(auth, challenge, 1_000));
  await rm(file, { recursive: true });
  assert.equal(auth.inFlightLoginCount(), 0);
  await assert.rejects(login(auth, challenge, 2_000), refused);
});
