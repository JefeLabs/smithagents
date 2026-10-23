import { execFile } from "node:child_process";
import { access, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { resolveStartPoint } from "./workspace-instances.js";

const exec = promisify(execFile);

/** A disposable `git clone --shared` of the user's repo, made for one docker task. */
export interface TaskClone {
  /** realpath of the user's repo */
  repoPath: string;
  /** the clone directory */
  path: string;
  /** `smith/${taskId}` */
  branch: string;
  /** the commit the branch was cut from */
  baseSha: string;
  /** [0] = the user's objects dir (realpath); then chained alternates exactly as their files name them */
  readOnlyMounts: string[];
}

/** git on the host with hooks and fsmonitor neutralised — a container may have written the config. */
export async function hardenedGit(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await exec("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return stdout.trim();
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? String(err);
    throw new Error(`git ${args.find((a) => !a.startsWith("-"))} failed: ${stderr}`);
  }
}

export function shellQuote(word: string): string {
  return `'${word.replaceAll("'", "'\\''")}'`;
}

/**
 * Strip userinfo from a remote URL before it enters a container-readable config.
 * Fails closed: `undefined` means the clone gets no origin at all.
 */
export function stripUrlCredentials(url: string): string | undefined {
  const sep = url.indexOf("://");
  if (sep === -1) return url;
  const head = url.slice(0, sep + 3);
  const rest = url.slice(sep + 3);
  const slash = rest.indexOf("/");
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  const remainder = slash === -1 ? "" : rest.slice(slash);
  const cleaned = authority.slice(authority.lastIndexOf("@") + 1) + remainder;
  return cleaned.includes("@") ? undefined : head + cleaned;
}

/** A chained alternate becomes a container mount, so it must really be a git object store. */
async function assertObjectStore(entry: string, dir: string, alternatesFile: string): Promise<void> {
  const refuse = (): never => {
    throw new Error(`refusing alternates entry ${entry} in ${alternatesFile}: it is not a git object store`);
  };
  let real: string;
  try {
    real = await realpath(dir);
    if (basename(real) !== "objects" || !(await stat(join(real, "pack"))).isDirectory()) refuse();
  } catch {
    refuse();
  }
}

const MAX_ALTERNATE_DEPTH = 5;

/** The user's objects dir followed by every alternate it chains to, in discovery order. */
export async function objectStoreMounts(repoPath: string): Promise<string[]> {
  const common = await realpath(resolve(repoPath, await hardenedGit(["rev-parse", "--git-common-dir"], repoPath)));
  const found: string[] = [];
  const visit = async (dir: string, depth: number, from?: { entry: string; file: string }): Promise<void> => {
    if (found.includes(dir)) return;
    if (from) await assertObjectStore(from.entry, dir, from.file);
    found.push(dir);
    if (depth >= MAX_ALTERNATE_DEPTH) return;
    const file = join(dir, "info", "alternates");
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const line of text.split("\n")) {
      const l = line.trim();
      if (l === "" || l.startsWith("#")) continue;
      await visit(isAbsolute(l) ? l : resolve(dir, l), depth + 1, { entry: l, file });
    }
  };
  await visit(join(common, "objects"), 0);
  return found;
}

export async function createTaskClone(
  repoPath: string,
  clonePath: string,
  taskId: string,
  base: string,
): Promise<TaskClone> {
  const exists = await access(clonePath).then(
    () => true,
    () => false,
  );
  if (exists) {
    throw new Error(
      `task clone ${clonePath} already exists — a container may have written to it, so it is never reused`,
    );
  }
  const repoReal = await realpath(repoPath);
  const baseSha = await hardenedGit(
    ["rev-parse", "--verify", `${await resolveStartPoint(repoReal, base)}^{commit}`],
    repoReal,
  );
  const readOnlyMounts = await objectStoreMounts(repoReal);
  await mkdir(dirname(clonePath), { recursive: true });
  await hardenedGit(["clone", "--quiet", "--shared", "--no-checkout", repoReal, clonePath], dirname(clonePath));
  // Pin the exact path the container will see; the clone is still trusted here.
  await writeFile(join(clonePath, ".git", "objects", "info", "alternates"), `${readOnlyMounts[0]}\n`);
  const branch = `smith/${taskId}`;
  await hardenedGit(["checkout", "--quiet", "-b", branch, baseSha], clonePath);
  let originUrl: string | null;
  try {
    originUrl = await hardenedGit(["remote", "get-url", "origin"], repoReal);
  } catch {
    originUrl = null;
  }
  const safeUrl = originUrl ? stripUrlCredentials(originUrl) : undefined;
  if (safeUrl) await hardenedGit(["remote", "set-url", "origin", safeUrl], clonePath);
  else await hardenedGit(["remote", "remove", "origin"], clonePath);
  return { repoPath: repoReal, path: clonePath, branch, baseSha, readOnlyMounts };
}

/** The `--upload-pack` command that serves a clone's objects from a throwaway, network-less container. */
export function sandboxedUploadPack(image: string, clone: TaskClone): string {
  const mounts = [clone.path, ...clone.readOnlyMounts].flatMap((p) => ["-v", `${p}:${p}:ro`]);
  return ["docker", "run", "--rm", "-i", "--network", "none", "--entrypoint", "git-upload-pack", ...mounts, image]
    .map(shellQuote)
    .join(" ");
}

/** Fetch the clone's task branch into the user's repo through `uploadPack`; returns the imported tip SHA. */
export async function importTaskBranch(clone: TaskClone, uploadPack: string): Promise<string> {
  await hardenedGit(
    [
      "-c",
      "fetch.fsckObjects=true",
      "-c",
      "transfer.fsckObjects=true",
      "fetch",
      "--quiet",
      "--no-tags",
      "--no-recurse-submodules",
      "--no-write-fetch-head",
      `--upload-pack=${uploadPack}`,
      clone.path,
      `+refs/heads/${clone.branch}:refs/heads/${clone.branch}`,
    ],
    clone.repoPath,
  );
  return hardenedGit(["rev-parse", `refs/heads/${clone.branch}`], clone.repoPath);
}

/** The message for the commit that sweeps an agent's uncommitted leftovers onto the task branch. */
export function autoCommitMessage(agent: string, taskId: string, completed: boolean): string {
  return `${completed ? "task" : "task(incomplete)"}: ${agent} — ${taskId}\n\nAuto-committed by the dispatcher after the agent session exited${completed ? "" : " with a non-zero code"}.`;
}

/** Shell command (run inside the container) that commits leftovers as the agent; a no-op when clean. */
export function finalizeCommand(agent: string, taskId: string, completed: boolean): string {
  return `git add -A && { git diff --cached --quiet || git -c user.name=${shellQuote(`${agent} (smith)`)} -c user.email=crew@smithagents.local commit -q -m ${shellQuote(autoCommitMessage(agent, taskId, completed))}; }`;
}
