/**
 * Where the broker lives and how to reach it — the ONE place scheme, host, and
 * credentials are decided. Locally the broker is on the page's own hostname at
 * port 7790 (same-site, so the SameSite=Lax session cookie is stored and sent);
 * tauri uses the loopback; in cloud the SPA and broker share the page's own
 * host (ALB path-split). Every broker
 * request goes through `brokerFetch`, so credentials and the 401 seam are
 * uniform across all ~75 call sites rather than repeated at each.
 */
import { useAuthStore } from "../stores/authStore";

export const LOCAL_PORT = 7790;
export const LOCAL_BASE = `127.0.0.1:${LOCAL_PORT}`;

type Loc = { hostname: string; host: string; protocol: string };

function currentLoc(): Loc {
  if (typeof globalThis !== "undefined" && globalThis.location) {
    const { hostname, host, protocol } = globalThis.location;
    return { hostname, host, protocol };
  }
  // node/SSR: behave as dev loopback
  return { hostname: "localhost", host: "localhost", protocol: "http:" };
}

/** False for a dev/tauri origin; true when served from a real host. */
export function isCloud(loc: Pick<Loc, "hostname" | "protocol"> = currentLoc()): boolean {
  if (loc.protocol === "tauri:") return false;
  return loc.hostname !== "localhost" && loc.hostname !== "127.0.0.1";
}

/**
 * host:port the broker answers on: the page's own host in cloud, the loopback
 * under tauri, otherwise the page's own hostname on the broker port.
 */
export function brokerBase(loc: Loc = currentLoc()): string {
  if (isCloud(loc)) return loc.host;
  if (loc.protocol === "tauri:") return LOCAL_BASE;
  return `${loc.hostname}:${LOCAL_PORT}`;
}

function httpScheme(loc: Pick<Loc, "protocol"> = currentLoc()): string {
  return loc.protocol === "https:" ? "https:" : "http:";
}
function wsScheme(loc: Pick<Loc, "protocol"> = currentLoc()): string {
  return loc.protocol === "https:" ? "wss:" : "ws:";
}

/** Full http(s) URL for a broker path; scheme follows the page. */
export function httpUrl(path: string, base: string = BROKER_BASE, loc: Pick<Loc, "protocol"> = currentLoc()): string {
  return `${httpScheme(loc)}//${base}${path}`;
}

/** Full ws(s) URL for a broker path; scheme follows the page. */
export function wsUrl(path: string, base: string = BROKER_BASE, loc: Pick<Loc, "protocol"> = currentLoc()): string {
  return `${wsScheme(loc)}//${base}${path}`;
}

/** Evaluated once at import — the default base for every `base = BROKER_BASE` param. */
export const BROKER_BASE: string = brokerBase();

/**
 * The one fetch every broker call routes through: applies scheme + credentials,
 * and flips `sessionLost` on a 401 in every mode so a mid-session
 * expiry drops the user to login from one place. `/auth/me` opts out (it IS the
 * check; letting it trip the seam would loop).
 */
export async function brokerFetch(path: string, base: string = BROKER_BASE, init?: RequestInit): Promise<Response> {
  const res = await fetch(httpUrl(path, base), { credentials: "include", ...init });
  if (res.status === 401 && path !== "/auth/me") {
    useAuthStore.getState().markSessionLost();
  }
  return res;
}
