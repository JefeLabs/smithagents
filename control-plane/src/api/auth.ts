/**
 * Passkey auth against the broker's /auth/* surface (Phase 1a). Plain async
 * functions, hook-free, mirroring api/broker.ts. Every call routes through
 * `brokerFetch` (scheme + credentials), branches on `res.ok` (register is 201,
 * logout 204), and runs the WebAuthn ceremony in the browser via
 * @simplewebauthn/browser. getMe deliberately hits fetch directly, bypassing
 * the brokerFetch 401 seam — getMe IS the auth check, so a 401 is a valid
 * "not signed in" answer, not a session-lost event.
 */

import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { brokerFetch, httpUrl } from "./origin";

export type Me = { kind: "human"; userId?: string; name?: string; role?: string; local?: boolean };

export class EnrollError extends Error {
  constructor(public code: "bad-code" | "ceremony-failed") {
    super(code);
  }
}

/** GET /auth/me — the signed-in human, or null on 401. */
export async function getMe(): Promise<Me | null> {
  const res = await fetch(httpUrl("/auth/me"), { credentials: "include" });
  if (!res.ok) return null;
  return (await res.json()) as Me;
}

/** POST /auth/register/options — begins enrollment; 410 means a bad/expired invite. */
export async function beginEnroll(code: string, name: string): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const res = await brokerFetch("/auth/register/options", undefined, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, name }),
  });
  if (res.status === 410) throw new EnrollError("bad-code");
  if (!res.ok) throw new EnrollError("ceremony-failed");
  return (await res.json()) as PublicKeyCredentialCreationOptionsJSON;
}

/** Runs the browser registration ceremony and posts the result — 201 → the new user. */
export async function finishEnroll(
  code: string,
  options: PublicKeyCredentialCreationOptionsJSON,
): Promise<{ userId: string; name: string }> {
  let attestation: unknown;
  try {
    attestation = await startRegistration({ optionsJSON: options });
  } catch {
    throw new EnrollError("ceremony-failed");
  }
  const res = await brokerFetch("/auth/register/verify", undefined, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, response: attestation }),
  });
  if (!res.ok) throw new EnrollError("ceremony-failed");
  return (await res.json()) as { userId: string; name: string };
}

/** Full login: options → browser ceremony → verify. */
export async function login(): Promise<{ userId: string; name: string }> {
  const optRes = await brokerFetch("/auth/login/options", undefined, { method: "POST" });
  if (!optRes.ok) throw new EnrollError("ceremony-failed");
  const options = (await optRes.json()) as PublicKeyCredentialRequestOptionsJSON;
  let assertion: unknown;
  try {
    assertion = await startAuthentication({ optionsJSON: options });
  } catch {
    throw new EnrollError("ceremony-failed");
  }
  const res = await brokerFetch("/auth/login/verify", undefined, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ response: assertion }),
  });
  if (!res.ok) throw new EnrollError("ceremony-failed");
  return (await res.json()) as { userId: string; name: string };
}

/** POST /auth/logout — 204, expires the cookie. */
export async function logout(): Promise<void> {
  await brokerFetch("/auth/logout", undefined, { method: "POST" });
}
