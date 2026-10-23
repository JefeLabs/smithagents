import { randomBytes, randomUUID } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** `<home>/.smith` — where the swarm keeps its generated secrets. */
export function smithSecretsDir(home: string = homedir()): string {
  return join(home, ".smith");
}

export function apiTokenPath(home: string = homedir()): string {
  return join(smithSecretsDir(home), "api-token");
}

export function bridgeTokenPath(home: string = homedir()): string {
  return join(smithSecretsDir(home), "broker-bridge-token");
}

/** Every secret file the swarm owns; a docker mount must never expose one. */
export function secretPaths(home: string = homedir()): string[] {
  return [apiTokenPath(home), bridgeTokenPath(home), join(smithSecretsDir(home), "master.key")];
}

/**
 * Read the secret at `path`, creating it (32 random bytes, base64url, 0600, in a 0700 dir) if absent.
 * Race-safe: the token is written to a private temp file and hard-linked into place, so concurrent
 * first callers all end up reading the single winner's token, and a reader never sees a partial file.
 */
export async function ensureSecretFile(path: string): Promise<string> {
  try {
    const existing = (await readFile(path, "utf8")).trim();
    if (existing) return existing;
    throw new Error(`${path} is empty — delete it to regenerate`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${randomBytes(32).toString("base64url")}\n`, { mode: 0o600, flag: "wx" });
  try {
    await link(tmp, path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  } finally {
    await unlink(tmp);
  }
  return (await readFile(path, "utf8")).trim();
}

/** A non-blank SMITH_API_TOKEN wins; otherwise the generated `~/.smith/api-token`. */
export async function resolveApiToken(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): Promise<string> {
  const fromEnv = env.SMITH_API_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  return ensureSecretFile(apiTokenPath(home));
}

export async function adminAuthHeader(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): Promise<{ authorization: string }> {
  return { authorization: `Bearer ${await resolveApiToken(env, home)}` };
}
