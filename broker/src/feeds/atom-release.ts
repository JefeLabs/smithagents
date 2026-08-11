/**
 * Version and notes from a GitHub releases Atom feed — the version source for
 * a topic's github candidate, which has no package registry behind it
 * (spec §5).
 *
 * This is also what makes maven SECURITY patches detectable: Maven Central's
 * search API exposes no scm, so the registry path can never see release notes,
 * while GitHub's Atom entries carry them.
 */

/** The numeric core of a release title. Null when the title names no version. */
export function versionFromTitle(title: string): string | null {
  return /(\d+\.\d+\.\d+)/.exec(title)?.[1] ?? null;
}

function tagText(block: string, name: string): string {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block);
  return m ? m[1]!.trim() : '';
}

/** The newest entry that actually names a version. Atom is newest-first. */
export function latestFromAtom(xml: string): { version: string; notes: string; publishedAt?: string } | null {
  for (const m of xml.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi)) {
    const block = m[1]!;
    const version = versionFromTitle(tagText(block, 'title'));
    if (!version) continue; // a nightly or a rename is not a release
    return {
      version,
      notes: tagText(block, 'content') || tagText(block, 'summary'),
      publishedAt: tagText(block, 'updated') || undefined,
    };
  }
  return null;
}
