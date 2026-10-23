/**
 * Delegation tokens — stateless, HMAC-signed grants that let an agent task
 * create sub-tasks in its own workspace/repo on its own runtime, and nothing
 * else. Format: `sdt1.<base64url(JSON claims)>.<base64url(HMAC-SHA256)>`, the
 * MAC taken over `sdt1.` + payload with a key derived from the admin token.
 */
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import type { RuntimeType, TaskManifest } from "./types.js";

export const DELEGATION_PREFIX = "sdt1.";
export const MAX_DELEGATION_DEPTH = 3;

const RUNTIMES: readonly RuntimeType[] = ["tmux", "docker", "remote", "remote-tmux", "remote-docker"];

export interface DelegationClaims {
  task: string;
  workspace?: string;
  repo?: string;
  branch?: string;
  runtime: RuntimeType;
  depth: number;
}

export function delegationKey(adminToken: string): Buffer {
  return Buffer.from(hkdfSync("sha256", adminToken, "", "smith-delegation-v1", 32));
}

function sign(key: Buffer, payload: string): Buffer {
  return createHmac("sha256", key).update(`${DELEGATION_PREFIX}${payload}`).digest();
}

export function mintDelegationToken(key: Buffer, claims: DelegationClaims): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${DELEGATION_PREFIX}${payload}.${sign(key, payload).toString("base64url")}`;
}

function optionalString(v: unknown): boolean {
  return v === undefined || typeof v === "string";
}

function validClaims(v: unknown): v is DelegationClaims {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.task === "string" &&
    c.task !== "" &&
    typeof c.runtime === "string" &&
    (RUNTIMES as readonly string[]).includes(c.runtime) &&
    typeof c.depth === "number" &&
    Number.isInteger(c.depth) &&
    c.depth >= 0 &&
    optionalString(c.workspace) &&
    optionalString(c.repo) &&
    optionalString(c.branch)
  );
}

export function verifyDelegationToken(key: Buffer | undefined, token: string): DelegationClaims | null {
  try {
    if (!key || typeof token !== "string" || !token.startsWith(DELEGATION_PREFIX)) return null;
    const parts = token.slice(DELEGATION_PREFIX.length).split(".");
    if (parts.length !== 2) return null;
    const [payload, sig] = parts as [string, string];
    const given = Buffer.from(sig, "base64url");
    const expected = sign(key, payload);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return validClaims(claims) ? claims : null;
  } catch {
    return null;
  }
}

export type ScopeResult = { ok: true; body: Partial<TaskManifest> } | { ok: false; error: string };

/**
 * Rewrite a delegated POST /tasks body to the parent's scope. Naming a
 * different workspace/repo/runtime is refused (not silently overridden);
 * location and priority are dropped; only metadata.source survives.
 */
export function scopeDelegatedTask(claims: DelegationClaims, body: Partial<TaskManifest>): ScopeResult {
  if (claims.depth + 1 > MAX_DELEGATION_DEPTH) {
    return { ok: false, error: `delegation depth limit (${MAX_DELEGATION_DEPTH}) reached` };
  }
  const ctx = body.context;
  if (ctx?.workspace !== undefined && ctx.workspace !== claims.workspace) {
    return { ok: false, error: `this task can only delegate within workspace "${claims.workspace ?? "(default)"}"` };
  }
  if (ctx?.repo !== undefined && ctx.repo !== claims.repo) {
    return { ok: false, error: `this task can only delegate within repo "${claims.repo ?? "(default)"}"` };
  }
  if (body.runtime !== undefined && body.runtime !== claims.runtime) {
    return { ok: false, error: `sub-tasks run on this task's runtime (${claims.runtime})` };
  }

  const { location: _location, priority: _priority, metadata, context: _context, ...rest } = body;
  const { repoPath: _repoPath, ...ctxRest } = ctx ?? { files: [], repository: "", branch: "" };
  const source = metadata?.source;
  const branch = ctx?.branch || claims.branch;
  const context: TaskManifest["context"] = {
    ...ctxRest,
    ...(claims.workspace !== undefined ? { workspace: claims.workspace } : {}),
    ...(claims.repo !== undefined ? { repo: claims.repo } : {}),
    branch: branch ?? "",
  };
  return {
    ok: true,
    body: {
      ...rest,
      runtime: claims.runtime,
      context,
      metadata: { source: typeof source === "string" ? source : "delegation" },
    },
  };
}
