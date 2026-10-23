// swarm/bin/smith-delegate, run for real against a stand-in swarm on loopback.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const SCRIPT = fileURLToPath(new URL("../bin/smith-delegate", import.meta.url));

interface Received {
  method?: string;
  url?: string;
  headers: NodeJS.Dict<string | string[]>;
  body: string;
}

/** A stand-in swarm that records each request and answers with `status`/`reply`. */
async function standInSwarm(status: number, reply: object) {
  const received: Received[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      received.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, received, close: () => server.close() };
}

/** Only what the dispatcher would give a session — nothing leaks in from this shell. */
function sessionEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, ...extra };
}

test("smith-delegate: posts the sub-task to SMITH_URL, aimed at the parent's workspace/repo/branch", async () => {
  const swarm = await standInSwarm(200, { taskId: "t-123" });
  try {
    const { stdout } = await execFileP(SCRIPT, ["claude", "fix", `it's the "flaky" test`], {
      env: sessionEnv({ SMITH_URL: swarm.url, SMITH_WORKSPACE: "acme", SMITH_REPO: "web", SMITH_BRANCH: "dev" }),
    });
    assert.equal(swarm.received.length, 1);
    const [request] = swarm.received;
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/tasks");
    assert.deepEqual(JSON.parse(request.body), {
      prompt: `fix it's the "flaky" test`,
      agent: "claude",
      context: { files: [], repository: "", branch: "dev", workspace: "acme", repo: "web" },
      metadata: { source: "smith-delegate" },
    });
    assert.match(stdout, /t-123/);
  } finally {
    swarm.close();
  }
});

test("smith-delegate: with no parent context it names none, leaving the swarm its default", async () => {
  const swarm = await standInSwarm(200, { taskId: "t-1" });
  try {
    await execFileP(SCRIPT, ["codex", "do it"], { env: sessionEnv({ SMITH_URL: swarm.url }) });
    assert.deepEqual(JSON.parse(swarm.received[0].body).context, { files: [], repository: "", branch: "" });
  } finally {
    swarm.close();
  }
});

test("smith-delegate: a refused delegation exits non-zero and shows the swarm's reason", async () => {
  const swarm = await standInSwarm(400, { error: "Unknown workspace/repo: acme/nope" });
  try {
    await assert.rejects(
      execFileP(SCRIPT, ["claude", "do it"], { env: sessionEnv({ SMITH_URL: swarm.url, SMITH_REPO: "nope" }) }),
      (err: { code?: number; stdout?: string; stderr?: string }) => {
        assert.notEqual(err.code, 0);
        assert.match(`${err.stdout}${err.stderr}`, /Unknown workspace\/repo: acme\/nope/);
        return true;
      },
    );
  } finally {
    swarm.close();
  }
});

test("smith-delegate: authenticates with the session's own delegation token", async () => {
  const swarm = await standInSwarm(200, { taskId: "t-1" });
  try {
    await execFileP(SCRIPT, ["claude", "do it"], {
      env: sessionEnv({ SMITH_URL: swarm.url, SMITH_DELEGATE_TOKEN: "sdt1.fake" }),
    });
    assert.equal(swarm.received[0].headers.authorization, "Bearer sdt1.fake");
  } finally {
    swarm.close();
  }
});

test("smith-delegate: never sends SMITH_API_TOKEN, even when the session inherited one", async () => {
  const swarm = await standInSwarm(200, { taskId: "t-1" });
  try {
    await execFileP(SCRIPT, ["claude", "do it"], {
      env: sessionEnv({ SMITH_URL: swarm.url, SMITH_API_TOKEN: "admin-secret" }),
    });
    assert.equal(swarm.received[0].headers.authorization, undefined);
  } finally {
    swarm.close();
  }
});
