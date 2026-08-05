// Workspace channels — Discord bot token + channel lists, per workspace.
// One JSON file per workspace under .smith/channels/, untracked (holds the
// bot token) — same invariant as users.ts, applied to a different owner:
// Workspace records are git-tracked and can never hold a live secret, so
// this lives in its own untracked companion file, keyed by the same
// workspace name (design §"Settled decisions").
import { readdir, readFile, mkdir, open, rm } from 'node:fs/promises';
import { join } from 'node:path';

export interface WorkspaceChannels {
  discord?: {
    botToken: string;              // secret
    textChannels: string[];        // Discord channel IDs
    voiceChannels: string[];       // Discord channel IDs
  };
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** One workspace's channel config, or null if it has none configured yet. */
export async function loadChannelsFor(dir: string, workspaceName: string): Promise<WorkspaceChannels | null> {
  try {
    const raw = await readFile(join(dir, `${workspaceName}.json`), 'utf8');
    return JSON.parse(raw) as WorkspaceChannels;
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return null;
    throw err;
  }
}

/** Write one workspace's channel config to `dir`. Mirror of users.saveUser — owner-only permissions (0o600). */
export async function saveChannels(dir: string, workspaceName: string, channels: WorkspaceChannels): Promise<void> {
  if (!SLUG.test(workspaceName)) {
    throw new Error(`Invalid workspace name "${workspaceName}": use lowercase letters, digits and dashes`);
  }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const filePath = join(dir, `${workspaceName}.json`);
  const fh = await open(filePath, 'w', 0o600);
  try {
    await fh.writeFile(`${JSON.stringify(channels, null, 2)}\n`);
  } finally {
    await fh.close();
  }
}

/** Remove a workspace's channel config file, if any. No-op if it never existed. */
export async function removeChannelsFor(dir: string, workspaceName: string): Promise<void> {
  await rm(join(dir, `${workspaceName}.json`), { force: true });
}
