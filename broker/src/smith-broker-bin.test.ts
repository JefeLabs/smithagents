import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BrokerAuth } from "./auth.ts";
import { TextChannel } from "./text-channel.ts";

const execFileAsync = promisify(execFile);
const BIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "bin");

/** promisify(execFile) rejects with this shape; typed once so the strict-mode
 * `assert.rejects` validators below can read code/stderr without casts inline. */
type ExecFailure = { code?: number; stdout?: string; stderr?: string };

const tempHomes: string[] = [];
after(async () => {
  await Promise.all(tempHomes.map((d) => rm(d, { recursive: true, force: true })));
});

/** Env for a spawned bridge bin: a throwaway HOME (the bins read ~/.smith/broker-bridge-token at load,
 * and no test may touch the real one) and no inherited SMITH_BROKER_TOKEN. `extra` wins. */
async function binEnv(extra: Record<string, string> = {}): Promise<NodeJS.ProcessEnv> {
  const home = await mkdtemp(join(tmpdir(), "binhome-"));
  tempHomes.push(home);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.SMITH_BROKER_TOKEN;
  Object.assign(env, extra);
  assert.notEqual(env.HOME, homedir(), "spawned bins must not see the real home");
  return env;
}

test("smith-broker-send posts the tagged utterance and prints the task-dispatched handle", async () => {
  const channel = new TextChannel((text) => {
    // Stand in for the brain: any utterance immediately "dispatches" a task.
    channel.broadcast({ type: "task-dispatched", taskId: "t-1", agent: "Manuel", task: text });
  });
  const port = await channel.start(0);
  try {
    const { stdout } = await execFileAsync("node", [join(BIN_DIR, "smith-broker-send.mjs"), "docs/prd.md", "ship it"], {
      env: await binEnv({ SMITH_BROKER_URL: `http://127.0.0.1:${port}`, SMITH_BRIDGE_SOURCE: "claude-code" }),
    });
    const handle = JSON.parse(stdout);
    assert.equal(handle.taskId, "t-1");
    assert.equal(handle.agent, "Manuel");
    assert.match(handle.task, /docs\/prd\.md/);
    assert.match(handle.task, /ship it/);
    assert.match(handle.task, /via claude-code/);
  } finally {
    await channel.stop();
  }
});

test("smith-broker-send times out with the brain's reply and exits non-zero when nothing was dispatched", async () => {
  const channel = new TextChannel(() => {
    channel.broadcast({ type: "utterance", text: "Manuel: which repo is this for?" });
  });
  const port = await channel.start(0);
  try {
    await assert.rejects(
      execFileAsync("node", [join(BIN_DIR, "smith-broker-send.mjs"), "docs/prd.md"], {
        env: await binEnv({ SMITH_BROKER_URL: `http://127.0.0.1:${port}`, SMITH_BROKER_SEND_TIMEOUT_MS: "300" }),
      }),
      (err: unknown) => {
        const e = err as ExecFailure;
        assert.equal(e.code, 1);
        assert.match(e.stderr ?? "", /which repo is this for/);
        return true;
      },
    );
  } finally {
    await channel.stop();
  }
});

test("required mode: send bin authenticates with SMITH_BROKER_TOKEN or ~/.smith/broker-bridge-token; with neither the gate refuses", async () => {
  const dir = await mkdtemp(join(tmpdir(), "binauth-"));
  const auth = new BrokerAuth(join(dir, "auth.json"), {
    rpId: "localhost",
    webOrigin: "http://localhost:1420",
    required: true,
    bridgeToken: "bridge-secret",
  });
  await auth.load();
  // onUtterance at index 0 stands in for the brain; auth at index 24. All
  // middle slots default to undefined.
  const channel = new TextChannel(
    (text) => channel.broadcast({ type: "task-dispatched", taskId: "t-9", agent: "Manuel", task: text }),
    () => [],
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    auth,
  );
  const port = await channel.start(0);
  const emptyHome = await mkdtemp(join(tmpdir(), "binhome-empty-"));
  const fileHome = await mkdtemp(join(tmpdir(), "binhome-file-"));
  await mkdir(join(fileHome, ".smith"), { recursive: true });
  await writeFile(join(fileHome, ".smith", "broker-bridge-token"), "bridge-secret\n");
  const run = async (home: string, token?: string) => {
    const env = await binEnv({
      HOME: home,
      SMITH_BROKER_URL: `http://127.0.0.1:${port}`,
      SMITH_BROKER_SEND_TIMEOUT_MS: "2500",
      ...(token ? { SMITH_BROKER_TOKEN: token } : {}),
    });
    return execFileAsync("node", [join(BIN_DIR, "smith-broker-send.mjs"), "docs/prd.md", "ping"], { env });
  };
  try {
    const { stdout } = await run(emptyHome, "bridge-secret");
    assert.equal(JSON.parse(stdout).taskId, "t-9", "token path reaches the brain and dispatches");

    await assert.rejects(run(emptyHome), (err: unknown) => {
      // No token and no file → POST /utterance is 401, nothing dispatches → send exits 1.
      assert.equal((err as ExecFailure).code, 1);
      return true;
    });

    const viaFile = await run(fileHome);
    assert.equal(
      JSON.parse(viaFile.stdout).taskId,
      "t-9",
      "no env token: the send bin reads ~/.smith/broker-bridge-token",
    );
  } finally {
    await channel.stop();
  }
});

test("smith-broker-send exits 2 with no prd-path argument", async () => {
  await assert.rejects(
    execFileAsync("node", [join(BIN_DIR, "smith-broker-send.mjs")], { env: await binEnv() }),
    (err: unknown) => {
      assert.equal((err as ExecFailure).code, 2);
      return true;
    },
  );
});

// Constructs a TextChannel with only the `tasks` handler wired in — mirrors
// text-channel.test.ts's channelWith helper, kept local since this file
// doesn't need any of the other 13 optional constructor slots.
function channelWithTasks(get: (taskId: string) => Promise<Record<string, unknown> | null>) {
  return new TextChannel(
    () => {},
    () => [],
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { get },
  );
}

test("smith-broker-check prints status and prUrl for a completed task, exits 0", async () => {
  const channel = channelWithTasks(async (taskId) =>
    taskId === "t-1"
      ? { taskId: "t-1", status: "completed", result: { pullRequestUrl: "https://github.com/x/y/pull/1" } }
      : null,
  );
  const port = await channel.start(0);
  try {
    const { stdout } = await execFileAsync("node", [join(BIN_DIR, "smith-broker-check.mjs"), "t-1"], {
      env: await binEnv({ SMITH_BROKER_URL: `http://127.0.0.1:${port}` }),
    });
    assert.deepEqual(JSON.parse(stdout), {
      status: "completed",
      prUrl: "https://github.com/x/y/pull/1",
      raw: { taskId: "t-1", status: "completed", result: { pullRequestUrl: "https://github.com/x/y/pull/1" } },
    });
  } finally {
    await channel.stop();
  }
});

test("smith-broker-check exits non-zero on an unknown taskId", async () => {
  const channel = channelWithTasks(async () => null);
  const port = await channel.start(0);
  try {
    await assert.rejects(
      execFileAsync("node", [join(BIN_DIR, "smith-broker-check.mjs"), "nope"], {
        env: await binEnv({ SMITH_BROKER_URL: `http://127.0.0.1:${port}` }),
      }),
      (err: unknown) => {
        assert.equal((err as ExecFailure).code, 1);
        return true;
      },
    );
  } finally {
    await channel.stop();
  }
});

test("smith-broker-check exits 2 with no taskId argument", async () => {
  await assert.rejects(
    execFileAsync("node", [join(BIN_DIR, "smith-broker-check.mjs")], { env: await binEnv() }),
    (err: unknown) => {
      assert.equal((err as ExecFailure).code, 2);
      return true;
    },
  );
});
