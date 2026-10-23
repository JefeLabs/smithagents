// TWIN of swarm/src/secret-file.ts (`ensureSecretFile`): there is no shared package, so the
// algorithm is copied. Keep the two in lockstep — same contract, same file format.
import { randomBytes, randomUUID } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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

/**
 * The broker's two secrets. A non-blank env var wins; otherwise the file under `<home>/.smith`
 * (generated on first use). `api-token` is the swarm's admin token — the swarm creates it too,
 * and ensureSecretFile makes whichever process starts first the winner.
 */
export async function resolveBrokerSecrets(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): Promise<{ swarmToken: string; bridgeToken: string }> {
  const dir = join(home, ".smith");
  const swarmToken = env.SMITH_API_TOKEN?.trim() || (await ensureSecretFile(join(dir, "api-token")));
  const bridgeToken = env.SMITH_BROKER_TOKEN?.trim() || (await ensureSecretFile(join(dir, "broker-bridge-token")));
  return { swarmToken, bridgeToken };
}
