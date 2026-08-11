/**
 * Cheap check, expensive detail (spec §5). Comparing versions is a small JSON
 * read per dependency per hour; release NOTES are fetched only once a version
 * has already crossed the bar, or to test a patch for a security mention.
 */

export type Ecosystem = 'npm' | 'maven' | 'cargo';

/** Leading v, prerelease and build metadata all stripped before comparison. */
function parts(version: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function classifyBump(from: string, to: string): 'major' | 'minor' | 'patch' | null {
  const a = parts(from);
  const b = parts(to);
  if (!a || !b) return null;
  if (b[0] !== a[0]) return b[0] > a[0] ? 'major' : null;
  if (b[1] !== a[1]) return b[1] > a[1] ? 'minor' : null;
  if (b[2] !== a[2]) return b[2] > a[2] ? 'patch' : null;
  return null; // identical — nothing happened
}

/**
 * `secure by default` must NOT match: the word alone is marketing. A CVE id or
 * an explicit "security <noun>" is the bar.
 */
export function mentionsSecurity(notes: string): boolean {
  return /\bCVE-\d{4}-\d{4,}\b/i.test(notes) || /security\s+(fix|release|advisory|update|patch)/i.test(notes);
}

export function qualifies(bump: 'major' | 'minor' | 'patch', security: boolean): boolean {
  return bump !== 'patch' || security;
}

/** One small JSON read. Any failure is null — a dead registry must not stop ingest. */
export async function latestVersion(
  fetchJson: (url: string) => Promise<unknown>,
  eco: Ecosystem,
  name: string,
): Promise<string | null> {
  try {
    if (eco === 'npm') {
      const body = (await fetchJson(`https://registry.npmjs.org/${name}/latest`)) as { version?: string };
      return body.version ?? null;
    }
    if (eco === 'cargo') {
      const body = (await fetchJson(`https://crates.io/api/v1/crates/${name}`)) as {
        crate?: { max_stable_version?: string };
      };
      return body.crate?.max_stable_version ?? null;
    }
    const [group, artifact] = name.split(':');
    const url = `https://search.maven.org/solrsearch/select?q=g:"${group}"+AND+a:"${artifact}"&rows=1&wt=json`;
    const body = (await fetchJson(url)) as { response?: { docs?: Array<{ latestVersion?: string }> } };
    return body.response?.docs?.[0]?.latestVersion ?? null;
  } catch {
    return null;
  }
}
