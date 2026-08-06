// Avatar file store — the swarm owns agent portraits as files, the way it
// owns agent identity as JSON. Live agents' art lives in .smith/avatars/
// (reset archives it with the roster); the shipped preset art is committed
// under assets/avatars/. avatarData/avatarPreset are transport-only fields
// on the create/update routes — this module turns them into files and a
// stored filename, and nothing else ever touches the bytes.
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Same stem rule as agent ids (agents.ts) — also the traversal guard. */
export const AVATAR_FILE_RE = /^[a-z0-9][a-z0-9-]{0,63}\.png$/;

const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

/** Decode and validate a base64 avatar payload. Throws a user-facing Error. */
export function decodeAvatarData(avatarData: string): Buffer {
  const buf = Buffer.from(avatarData, 'base64');
  if (buf.length > MAX_AVATAR_BYTES) {
    throw new Error('avatar image must be under 2 MB');
  }
  if (buf.length < PNG_MAGIC.length || !buf.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
    throw new Error('avatar image must be a PNG');
  }
  return buf;
}

/**
 * Persist the avatar a create/update body carried, if any. Custom art
 * arrives as base64 (`avatarData`); a preset join names committed art
 * (`avatarPreset`) which is copied so every live agent's portrait lives in
 * one directory. Returns the filename to store on the agent record.
 */
export async function stageAvatar(opts: {
  agentId: string;
  liveDir: string;
  presetDir: string;
  avatarData?: string;
  avatarPreset?: string;
}): Promise<string | undefined> {
  const { agentId, liveDir, presetDir, avatarData, avatarPreset } = opts;
  if (!avatarData && !avatarPreset) return undefined;
  const file = `${agentId}.png`;
  if (!AVATAR_FILE_RE.test(file)) {
    throw new Error(`invalid agent id for avatar file: "${agentId}"`);
  }
  await mkdir(liveDir, { recursive: true });
  if (avatarData) {
    await writeFile(join(liveDir, file), decodeAvatarData(avatarData));
    return file;
  }
  const presetFile = `${avatarPreset}.png`;
  if (!AVATAR_FILE_RE.test(presetFile)) {
    throw new Error(`invalid avatar preset: "${avatarPreset}"`);
  }
  try {
    await copyFile(join(presetDir, presetFile), join(liveDir, file));
  } catch {
    throw new Error(`no committed art for preset "${avatarPreset}"`);
  }
  return file;
}

/** Serve lookup: live art first, committed preset art as the fallback. */
export async function readAvatar(file: string, liveDir: string, presetDir: string): Promise<Buffer | null> {
  if (!AVATAR_FILE_RE.test(file)) return null;
  for (const dir of [liveDir, presetDir]) {
    try {
      return await readFile(join(dir, file));
    } catch {
      // try the next directory
    }
  }
  return null;
}
