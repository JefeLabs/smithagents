/**
 * A feed URL is attacker-influenced input that the broker fetches on a timer,
 * from inside the trust boundary. Without this guard, adding a "feed" pointing
 * at 169.254.169.254 (cloud metadata), 127.0.0.1:3000 (the swarm), or file://
 * would turn ingest into a confused deputy — classic SSRF.
 *
 * Checked at ADD time and again at FETCH time: a source persisted before this
 * existed, or edited on disk, must not get a free pass.
 */

/** Only these ever reach the network. No file:, no gopher:, no data:. */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/** Hosts that are inside the machine or the private network, and so never a public feed. */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    return true;
  }
  // IPv6 loopback and unique-local / link-local ranges.
  if (host === '::1' || host === '::' || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe80:/.test(host)) return true;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a >= 224) return true; // multicast and reserved
  return false;
}

/** Null when fetchable; otherwise the reason, which the caller shows the human. */
export function urlRejectionReason(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'not a valid URL';
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) return `only http and https feeds are allowed (got ${url.protocol})`;
  if (!url.hostname) return 'not a valid URL';
  if (isPrivateHost(url.hostname)) return `${url.hostname} is a private or loopback address`;
  return null;
}
