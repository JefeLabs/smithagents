// Users — the current-operator record credentials live on (design
// §"Settled decisions": config/credential split). One JSON file per user
// under .smith/users/, untracked (holds secrets) unlike agents/workspaces.
import { readdir, readFile, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';

export interface User {
  id: string;
  name: string;
  /** Mirrors Workspace's default-invariant pattern; single default user today. */
  default?: boolean;
  atlassian?: { email: string; apiToken: string };
  github?: { token: string };
}

function assertUser(file: string, v: unknown): User {
  const o = v as Partial<User>;
  const ok = o && typeof o.id === 'string' && typeof o.name === 'string';
  if (!ok) {
    throw new Error(`Invalid user file ${file}: requires id and name`);
  }
  return o as User;
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
  for (const file of entries.filter((f) => f.endsWith('.json'))) {
    const raw = await readFile(join(dir, file), 'utf8');
    users.push(assertUser(file, JSON.parse(raw)));
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
  const fh = await open(filePath, 'w', 0o600);
  try {
    await fh.writeFile(`${JSON.stringify(user, null, 2)}\n`);
  } finally {
    await fh.close();
  }
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
