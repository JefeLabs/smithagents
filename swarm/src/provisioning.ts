// Provisioning policy — what a fresh instance needs before an agent can work.
//
// A new instance is a clean checkout, so everything gitignored is missing:
// node_modules, caches, local config. The agent cannot build until they exist.
//
// Deliberately pure: no fs, no child_process. The caller supplies the facts
// (which files exist, whether a path is tracked) so every branch is testable
// without a real checkout — the same discipline session-reconcile.ts keeps, and
// for the same reason: policy that can only be exercised against a live repo
// stops being exercised.

export interface ProvisionPlan {
  /** Gitignored paths to copy from the source checkout. */
  copy: string[];
  /** Commands run in the new member after copying. */
  setup: string[];
  /** Why this plan exists — a lockfile name, "no lockfile", or "config override". */
  detectedBy: string;
}

/**
 * Ordered because a repo can carry several lockfiles; the first match wins and
 * names itself in `detectedBy`, so a surprising plan is traceable to one file
 * without reading this table.
 *
 * INVARIANT: every `copy` entry must be reproducible by that row's own `setup`.
 * Copy is an optimization — a failed one costs a cold build — while setup is the
 * correctness path. A copy nothing can rebuild turns a recoverable slow path
 * into a broken instance.
 */
const SIGNALS: Array<{ file: string; copy: string[]; setup: string[] }> = [
  { file: "pnpm-lock.yaml", copy: ["node_modules"], setup: ["pnpm install --frozen-lockfile"] },
  { file: "package-lock.json", copy: ["node_modules"], setup: ["npm ci"] },
  { file: "yarn.lock", copy: ["node_modules"], setup: ["yarn install --immutable"] },
];

/** `files` is a flat list of entry names at the member root. */
export function detectPlan(files: string[]): ProvisionPlan {
  const present = new Set(files);
  for (const signal of SIGNALS) {
    if (present.has(signal.file)) {
      return { copy: [...signal.copy], setup: [...signal.setup], detectedBy: signal.file };
    }
  }
  // A repo with no dependencies is correctly provisioned by doing nothing. This
  // is a plan, not a failure — and it still names why, so an empty result is
  // never mistaken for a detector that did not run.
  return { copy: [], setup: [], detectedBy: "no lockfile" };
}

export type GuardVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Secrets are NEVER provisioned.
 *
 * §7 of the workspace-instances design decided that credentials are retrieved on
 * demand and never held by the instance, and its strongest argument is that an
 * agent told to "stage and commit ALL your changes" cannot commit a secret that
 * was never on disk. Overrides are user-authored, so someone will eventually
 * list `.env` — which is why that decision is enforced here rather than
 * documented and hoped for.
 */
const SECRET_PATTERNS: RegExp[] = [/(^|\/)\.env($|\.)/i, /\.pem$/i, /(^|\/)id_rsa/i, /(^|\/)master\.key$/i];

export function checkCopyPath(path: string, facts: { tracked: boolean; existsInSource: boolean }): GuardVerdict {
  if (SECRET_PATTERNS.some((re) => re.test(path))) {
    return { ok: false, reason: `"${path}" looks like a secret; secrets are never copied into an instance` };
  }
  if (path.startsWith("/")) {
    return { ok: false, reason: `"${path}" is absolute; only member-relative paths are copied` };
  }
  if (path.split("/").includes("..")) {
    return { ok: false, reason: `"${path}" escapes the member root` };
  }
  // A tracked path is already in the worktree; copying over it would shadow the
  // checkout with a stale copy from the source.
  if (facts.tracked) {
    return { ok: false, reason: `"${path}" is tracked by git and is already in the worktree` };
  }
  if (!facts.existsInSource) {
    return { ok: false, reason: `"${path}" is not present in the source checkout` };
  }
  return { ok: true };
}

export interface ProvisionOverride {
  copy: string[];
  setup: string[];
}

/**
 * An override REPLACES the detected plan; it does not merge with it.
 *
 * Merging produces a union nobody wrote in full, and the first surprising copy
 * sends someone reading detector source to work out where a path came from.
 * Replacement means the answer to "why is this being copied" is always one
 * file.
 */
export function resolvePlan(detected: ProvisionPlan, override: ProvisionOverride | undefined): ProvisionPlan {
  if (!override) return detected;
  return { copy: [...override.copy], setup: [...override.setup], detectedBy: "config override" };
}

/**
 * Apply the guards, with a deliberate asymmetry: an override THROWS, a detected
 * plan warns and drops.
 *
 * A user who wrote a path meant it, and silently ignoring it would leave them
 * believing something is being provisioned that is not. A detector that guessed
 * wrong must not fail the instance over its own guess.
 */
export function applyGuards(
  plan: ProvisionPlan,
  isOverride: boolean,
  factsFor: (path: string) => { tracked: boolean; existsInSource: boolean },
): { plan: ProvisionPlan; warnings: string[] } {
  const copy: string[] = [];
  const warnings: string[] = [];
  for (const path of plan.copy) {
    const verdict = checkCopyPath(path, factsFor(path));
    if (verdict.ok) {
      copy.push(path);
      continue;
    }
    if (isOverride) throw new Error(`provision override: ${verdict.reason}`);
    warnings.push(verdict.reason);
  }
  return { plan: { ...plan, copy }, warnings };
}
