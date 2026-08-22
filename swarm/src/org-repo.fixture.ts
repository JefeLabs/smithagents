// Test-only fixtures for the org config repo layout (spec 2026-08-22 §1.1).
// Not a test file: the suite's glob is `src/*.test.ts`.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function gitCommitAll(cwd: string, msg: string): void {
  execFileSync("git", ["add", "-A"], { cwd });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", msg], {
    cwd,
  });
}

/** An org config repo at `<root>/config` with one committed `workspaces/<slug>/settings.json` per slug. */
export function makeOrgRepo(root: string, slugs: string[]): string {
  const repo = join(root, "config");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  writeFileSync(join(repo, "settings.json"), '{"name":"test-org"}\n');
  for (const slug of slugs) {
    mkdirSync(join(repo, "workspaces", slug), { recursive: true });
    writeFileSync(join(repo, "workspaces", slug, "settings.json"), `${JSON.stringify({ name: slug, repos: [] })}\n`);
  }
  gitCommitAll(repo, "org");
  return repo;
}

/** A project repo with one committed README. */
export function makeGitRepo(path: string): string {
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: path });
  writeFileSync(join(path, "README.md"), `${path}\n`);
  gitCommitAll(path, "init");
  return path;
}
