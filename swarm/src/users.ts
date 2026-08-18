// Users — the current-operator record credentials live on (design
// §"Settled decisions": config/credential split). One JSON file per user
// under .smith/users/, untracked (holds secrets) unlike agents/workspaces.
import { mkdir, open, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { findVendor } from "./connectors.js";
import { decryptSecret, encryptSecret, isEncrypted, resolveMasterKey } from "./secretbox.js";

export interface ConnectorInstance {
  id: string;
  vendorId: string;
  /** User-chosen: "personal", "acme-corp" — how workspaces reference which one to use. */
  label: string;
  /** Raw values, including secrets — this file is already untracked + 0600. */
  fields: Record<string, string>;
}

export interface VoiceSettings {
  stt?: { instanceId: string };
  tts?: { instanceId: string };
  /** Voice Mode master switch — may only be true while BOTH slots are assigned. */
  enabled?: boolean;
  /** Legacy pre-Voice-Mode field; upgraded to `enabled` on load, never written back. */
  hideInactive?: boolean;
}

export interface User {
  id: string;
  name: string;
  /** Mirrors Workspace's default-invariant pattern; single default user today. */
  default?: boolean;
  connectors?: ConnectorInstance[];
  /** Which connector instance powers each voice capability (spec §2). */
  voice?: VoiceSettings;
  /** Local YYYY-MM-DD of this user's last agenda sweep. Per-user because the sweep is
      per-user — see sweepUserAgenda. */
  agendaSweptDay?: string;
  /** Which CLI engine runs the broker's research turns. Absent = the broker's built-in default. */
  researchEngine?: { cli: string; model?: string };
  /** Which engine backs the conversational brain — the "main brain" role. Absent = SMITH_BRAIN_PROVIDER, then the no-key default. */
  brainEngine?: BrainEngine;
  /**
   * The "quick little things" role — same shape as brainEngine, deliberately,
   * so the wire stays one idea rather than three. Absent = fall back to the
   * main brain.
   */
  quickEngine?: BrainEngine;
  /**
   * The "if something's unavailable" role. Same shape again, with one extra
   * state the other two do not have: an explicit `null` is the ANSWER
   * "nothing — I'll just tell you", not the absence of one. Absent means the
   * question has not been asked yet.
   *
   * The distinction is load-bearing because every save path here merges: a
   * "nothing" recorded as an omitted field would leave whatever engine was
   * chosen before quietly in place. Same class as the voice-flip bug this
   * codebase has already fixed once.
   */
  fallbackEngine?: BrainEngine | null;
  /**
   * How far through the welcome wizard this user got, and which branch they
   * chose. Persisted on the record rather than in browser storage because the
   * spec makes the user record the resume anchor — a fresh browser profile must
   * still resume where the person left off.
   */
  setup?: {
    mode?: "local" | "hosted";
    voice?: boolean;
    /** The user declined to configure a step, as opposed to never reaching it.
        Recorded because a skip on these two steps has no value of its own to
        write — their real state lives in the CLI-tools/API-key registries and
        the engines store — so without a flag, "skipped" and "not yet asked"
        would be indistinguishable.

        Named for the steps as they are now (*Where I think* / *What I think
        with*). The ids they replaced wrote `subscriptionsSkipped` and
        `brainSkipped`; those may still sit on a record written by an older
        build, harmlessly — nothing has ever read either, and `buildUserUpdate`
        merges rather than replaces, so an unknown key is neither validated nor
        dropped. */
    sourcesSkipped?: boolean;
    rolesSkipped?: boolean;
    step?: string;
  };
}

export interface BrainEngine {
  kind: "cli" | "local" | "api";
  /** cli: a CLI id ("claude") · local: a server id ("lmstudio") · api: "anthropic" | "gemini" */
  provider: string;
  model?: string;
  /** local only — where the OpenAI-compatible server listens. */
  baseUrl?: string;
}

/** On-disk shape before migration — legacy files may still have these instead of `connectors`. */
interface LegacyUserFields {
  atlassian?: { email: string; apiToken: string };
  github?: { token: string };
}

/**
 * Lazy migration, no one-time script: a legacy `{atlassian, github}` file is
 * upgraded in memory to `connectors` the moment it's loaded. The file itself
 * is only rewritten in the new shape the next time anything about that user
 * is saved — existing tokens survive untouched, no re-entry required (design
 * §1). An already-migrated user (has `connectors`) is returned as-is, with
 * any stray legacy keys stripped defensively rather than re-merged.
 *
 * Ids are derived deterministically from the user's own id and the vendor
 * (`legacy-<userId>-<vendor>`), not randomUUID(): every swarm route calls
 * loadUsersFromDir fresh per request (no caching), so a random id would mint
 * a NEW id on every single load — a workspace's saved connectorId would
 * never match again after the request that returned it. Determinism keeps
 * loadUsersFromDir a pure function of the file's contents, with no need to
 * write the migrated shape back to disk just to stabilize ids.
 */
function upgradeLegacyConnectors(raw: User & LegacyUserFields): User {
  const { atlassian, github, ...rest } = raw;
  if (rest.connectors) return rest;
  const connectors: ConnectorInstance[] = [];
  if (atlassian) {
    connectors.push({
      id: `legacy-${rest.id}-atlassian`,
      vendorId: "atlassian",
      label: "default",
      fields: { ...atlassian },
    });
  }
  if (github) {
    connectors.push({ id: `legacy-${rest.id}-github`, vendorId: "github", label: "default", fields: { ...github } });
  }
  return connectors.length ? { ...rest, connectors } : rest;
}

/**
 * Pre-Voice-Mode files carry `hideInactive` and no `enabled`. Same lazy-migration
 * contract as upgradeLegacyConnectors: upgraded in memory on every load, written
 * back in the new shape only when the user is next saved. `enabled` derives to
 * true only when both slots were assigned — a working voice setup keeps working,
 * everyone else starts off. A record that already has `enabled` is trusted as-is
 * (an explicit "off" with both slots set must survive reloads).
 */
function upgradeLegacyVoice(user: User): User {
  const voice = user.voice;
  if (!voice) return user;
  const { hideInactive: _legacy, ...rest } = voice;
  if (voice.enabled !== undefined) return { ...user, voice: rest };
  return { ...user, voice: { ...rest, enabled: Boolean(rest.stt && rest.tts) } };
}

function assertUser(file: string, v: unknown): User {
  const o = v as Partial<User> & LegacyUserFields;
  const ok = o && typeof o.id === "string" && typeof o.name === "string";
  if (!ok) {
    throw new Error(`Invalid user file ${file}: requires id and name`);
  }
  return upgradeLegacyVoice(upgradeLegacyConnectors(o as User & LegacyUserFields));
}

/** Which of this instance's field keys are secrets, per the vendor registry. Unknown vendor → none. */
function secretKeysFor(vendorId: string): Set<string> {
  return new Set((findVendor(vendorId)?.fields ?? []).filter((f) => f.secret).map((f) => f.key));
}

function mapSecretFields(user: User, fn: (value: string, isSecret: boolean) => string): User {
  if (!user.connectors) return user;
  return {
    ...user,
    connectors: user.connectors.map((c) => {
      const secrets = secretKeysFor(c.vendorId);
      const fields = Object.fromEntries(Object.entries(c.fields).map(([k, v]) => [k, fn(v, secrets.has(k))]));
      return { ...c, fields };
    }),
  };
}

function encryptUser(user: User, key: Buffer): User {
  // idempotent: an already-encrypted value (incl. a decrypt-failure passthrough) is left alone
  return mapSecretFields(user, (v, isSecret) => (isSecret && v && !isEncrypted(v) ? encryptSecret(v, key) : v));
}

function decryptUser(user: User, key: Buffer): User {
  return mapSecretFields(user, (v, isSecret) => {
    if (!isSecret || !isEncrypted(v)) return v;
    try {
      return decryptSecret(v, key);
    } catch {
      // Wrong/rotated master key: keep the ciphertext as the field value so the
      // connector shows connected-but-failing-verify (spec §3) instead of crashing.
      console.warn(`[users] could not decrypt a secret for connector — re-enter the key in Settings`);
      return v;
    }
  });
}

/** Load every *.json in `dir` as a User. Throws (naming the file) on malformed input. */
export async function loadUsersFromDir(dir: string): Promise<User[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const users: User[] = [];
  const key = await resolveMasterKey();
  for (const file of entries.filter((f) => f.endsWith(".json"))) {
    const raw = await readFile(join(dir, file), "utf8");
    users.push(decryptUser(assertUser(file, JSON.parse(raw)), key));
  }
  return users;
}

/** Write one user to `dir`. Mirror of workspaces.saveWorkspace. Writes credentials with owner-only permissions (0o600). */
export async function saveUser(dir: string, user: User): Promise<void> {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(user.id)) {
    throw new Error(`Invalid user id "${user.id}": use lowercase letters, digits and dashes`);
  }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const filePath = join(dir, `${user.id}.json`);
  const key = await resolveMasterKey();
  const toWrite = encryptUser(user, key);
  const fh = await open(filePath, "w", 0o600);
  try {
    await fh.writeFile(`${JSON.stringify(toWrite, null, 2)}\n`);
  } finally {
    await fh.close();
  }
}

/**
 * One-time-per-boot migration pass (spec §3): any user file still holding a
 * plaintext secret is re-saved, which encrypts it. Skips files already fully
 * encrypted so boots don't churn IVs. Returns how many files were rewritten.
 *
 * Runs at server boot (server.ts start(), before app.listen()), so a single
 * corrupt file must never abort the sweep: unlike loadUsersFromDir (called
 * per-request, where a thrown error only 500s that one route), a throw here
 * would stop the orchestrator from listening at all over a voice-adjacent
 * file — every agent, workspace, and task taken down with it. Each file is
 * therefore its own failure domain; a bad one is skipped (with a named
 * warning) and the sweep continues, including past a saveUser failure (e.g.
 * a legacy id that fails saveUser's id-shape check).
 */
export async function sweepEncryptUsers(dir: string): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }
  let rewritten = 0;
  for (const file of entries.filter((f) => f.endsWith(".json"))) {
    try {
      const raw = assertUser(file, JSON.parse(await readFile(join(dir, file), "utf8")));
      const hasPlaintextSecret = (raw.connectors ?? []).some((c) => {
        const secrets = secretKeysFor(c.vendorId);
        return Object.entries(c.fields).some(([k, v]) => secrets.has(k) && v && !isEncrypted(v));
      });
      if (!hasPlaintextSecret) continue;
      await saveUser(dir, raw); // raw is plaintext in memory; saveUser encrypts
      rewritten++;
    } catch (err) {
      console.warn(`[users] skipping ${file} during encrypt sweep: ${(err as Error).message}`);
    }
  }
  return rewritten;
}

/**
 * "Current user" — trivially resolved today (single-operator, no auth in
 * all-local mode). Same fallback shape as Workspace's default resolution:
 * the `default`-flagged user, else the sole file present, else null.
 * This is the one seam a real auth system replaces later.
 */
export function resolveCurrentUser(users: User[]): User | null {
  return users.find((u) => u.default) ?? users[0] ?? null;
}
