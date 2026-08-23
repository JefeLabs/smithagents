// Spec §9.1 says the org config repo is created "with settings.json … and
// blueprints/ from broker/.smith/blueprints/*.json if present". That seeding
// never happened. The only reader of that directory was
// `broker/src/blueprints.ts:118` (`BROKER_BLUEPRINTS_DIR ?? ".smith/blueprints"`),
// and that file is deleted — so a user's custom blueprints stop taking effect
// at the cutover with no message anywhere. Nothing is destroyed: the JSON is
// never read, moved or touched.
//
// A WARNING ONLY, deliberately. The swarm owns the org repo (§3), so real
// seeding needs a swarm-side write route, and that is Plan 3 work — a
// broker-side copy would put the broker back to writing into a repo it does
// not own, which is the exact coupling this plan removed (final-review
// Minor 1).
import { readdir } from "node:fs/promises";

/**
 * One loud, actionable line if legacy blueprint files are sitting unread —
 * naming every file and the exact destination to copy them to. Returns the
 * notes it emitted (empty when there is nothing to say) so the caller can fold
 * them in with the migration's own.
 */
export async function warnLegacyBlueprints(opts: {
  blueprintsDir: string;
  /** Where they belong now: the org config repo's `blueprints/`. */
  destination: string;
  log: (line: string) => void;
}): Promise<string[]> {
  let files: string[];
  try {
    files = (await readdir(opts.blueprintsDir)).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return []; // no such directory — the normal case, and nothing to say about it
  }
  if (files.length === 0) return [];
  const note =
    `[blueprints] ${files.length} legacy blueprint file(s) in ${opts.blueprintsDir}/ are NO LONGER READ: ${files.join(", ")}. ` +
    `Blueprints now live in the org config repo. Copy them to ${opts.destination}/ and restart to make them take effect again; ` +
    `nothing here has been moved, changed or deleted.`;
  opts.log(note);
  return [note];
}
