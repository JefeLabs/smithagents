// Secrets-at-rest for .smith/users/*.json (spec §3): AES-256-GCM via node:crypto
// only — no native deps, identical on macOS/Linux/Windows. Master key resolves
// OS-agnostically: SMITH_MASTER_KEY env (the cloud/headless seam) else
// ~/.smith/master.key, auto-generated 0600. The key lives in the HOME dir,
// outside every repo checkout/worktree, so a copied workspace never carries
// key + ciphertext together.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const ENC_PREFIX = "enc:v1:";

export function isEncrypted(value: string): boolean {
  return value.startsWith(ENC_PREFIX);
}

export function encryptSecret(value: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString("base64")}:${ct.toString("base64")}:${tag.toString("base64")}`;
}

/** Throws on malformed input, wrong key, or a tampered ciphertext — the caller decides the fallback. */
export function decryptSecret(value: string, key: Buffer): string {
  const segs = value.slice(ENC_PREFIX.length).split(":");
  if (!isEncrypted(value) || segs.length !== 3) throw new Error("secretbox: not an enc:v1 value");
  const [iv, ct, tag] = segs.map((s) => Buffer.from(s, "base64"));
  const d = createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}

/** Env wins (64 hex chars); else read-or-create ~/.smith/master.key. */
export async function resolveMasterKey(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): Promise<Buffer> {
  const fromEnv = env.SMITH_MASTER_KEY;
  if (fromEnv !== undefined) {
    if (!/^[0-9a-f]{64}$/i.test(fromEnv)) {
      throw new Error("SMITH_MASTER_KEY must be 64 hex characters (32 bytes)");
    }
    return Buffer.from(fromEnv, "hex");
  }
  const dir = join(home, ".smith");
  const file = join(dir, "master.key");
  try {
    const hex = (await readFile(file, "utf8")).trim();
    if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error(`${file} is corrupt: expected 64 hex characters`);
    return Buffer.from(hex, "hex");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const key = randomBytes(32);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const fh = await open(file, "w", 0o600);
  try {
    await fh.writeFile(`${key.toString("hex")}\n`);
  } finally {
    await fh.close();
  }
  return key;
}
