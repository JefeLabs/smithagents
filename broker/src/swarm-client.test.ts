import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { SwarmClient, type SwarmEvent, type WsLike } from "./swarm-client.ts";

interface Call {
  url: string;
  init?: RequestInit;
}

function fakeFetch(routes: Record<string, unknown>): { calls: Call[]; fetch: typeof fetch } {
  const calls: Call[] = [];
  const f = (async (url: unknown, init?: unknown) => {
    calls.push({ url: String(url), init: init as RequestInit });
    const path = new URL(String(url)).pathname;
    const body = routes[path];
    if (body === undefined) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return { calls, fetch: f };
}

test("submitTask posts prompt/agent/context and returns taskId", async () => {
  const { calls, fetch } = fakeFetch({
    "/tasks": { taskId: "t-1", agentName: "Manuel", status: "queued", position: 1 },
  });
  const c = new SwarmClient({ baseUrl: "http://127.0.0.1:7777", token: "secret", fetchImpl: fetch });
  const r = await c.submitTask({ prompt: "do it", agent: "claude", repository: "git@x:y.git" });
  assert.equal(r.taskId, "t-1");
  const sent = JSON.parse(String(calls[0]!.init!.body));
  assert.equal(sent.agent, "claude");
  // branch '' -> the server substitutes the workspace repo's default branch
  assert.deepEqual(sent.context, { files: [], repository: "git@x:y.git", branch: "" });
  assert.equal((calls[0]!.init!.headers as Record<string, string>).authorization, "Bearer secret");
});

test("registry unwraps the agents array", async () => {
  const agents = [
    { id: "manuel", name: "Manuel", role: "lead", directives: "d", engine: { cli: "claude", model: "sonnet" } },
  ];
  const { fetch } = fakeFetch({ "/agents/registry": { agents } });
  const c = new SwarmClient({ baseUrl: "http://x", fetchImpl: fetch });
  assert.deepEqual(await c.registry(), agents);
});

test("getOutput returns output; a failure surfaces swarm's own reason", async () => {
  const { fetch } = fakeFetch({ "/tasks/t-1/output": { taskId: "t-1", output: "pane text" } });
  const c = new SwarmClient({ baseUrl: "http://x", fetchImpl: fetch });
  assert.equal((await c.getOutput("t-1")).output, "pane text");
  // The reason is what a human reads in the UI ("Invalid model id: …"), so it
  // must reach the caller rather than being flattened to a status code.
  await assert.rejects(() => c.getOutput("nope"), /not found/);
});

test("a failure with no reason in the body still reports the status", async () => {
  const f = (async () => new Response("<html>gateway blew up</html>", { status: 502 })) as typeof fetch;
  const c = new SwarmClient({ baseUrl: "http://x", fetchImpl: f });
  await assert.rejects(() => c.getOutput("t-1"), /502/);
});

test("subscribe parses events and reconnects; unsubscribe stops it", async () => {
  const sockets: Array<EventEmitter & { close(): void; closed: boolean }> = [];
  const wsFactory = (url: string): WsLike => {
    assert.match(url, /\/ws\?token=tok$/);
    const s = Object.assign(new EventEmitter(), {
      closed: false,
      close() {
        (this as { closed: boolean }).closed = true;
      },
    });
    sockets.push(s as never);
    return s as unknown as WsLike;
  };
  const events: SwarmEvent[] = [];
  const c = new SwarmClient({ baseUrl: "http://h:7777", token: "tok", wsFactory });
  const stop = c.subscribe((e) => events.push(e));
  sockets[0]!.emit("message", JSON.stringify({ type: "task:dispatched", taskId: "t-9", sessionName: "s" }));
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, "task:dispatched");
  stop();
  assert.equal(sockets[0]!.closed, true);
});

test("lifecycle methods hit the right swarm routes", async () => {
  const calls: string[] = [];
  const client = new SwarmClient({
    baseUrl: "http://s",
    fetchImpl: (async (url: unknown, init?: RequestInit) => {
      calls.push(`${init?.method} ${String(url).replace("http://s", "")}`);
      return new Response(JSON.stringify({ ok: true, warmSessions: 0, activeTasks: 0, workspaces: [] }));
    }) as typeof fetch,
  });
  await client.agentUsage("wilkin");
  await client.archiveAgent("wilkin");
  await client.deleteAgent("wilkin");
  await client.createWorkspace({ name: "w", repos: [] });
  await client.updateWorkspace("w", { description: "d" });
  await client.archiveWorkspace("w");
  await client.deleteWorkspace("w");
  await client.workspaceUsage("w");
  await client.listGroups();
  await client.createGroup({ name: "g", workspaces: [], groups: [] });
  await client.updateGroup("g", { workspaces: ["w"] });
  await client.deleteGroup("g");
  assert.deepEqual(calls, [
    "GET /agents/wilkin/usage",
    "POST /agents/wilkin/archive",
    "DELETE /agents/wilkin",
    "POST /workspaces",
    "PUT /workspaces/w",
    "POST /workspaces/w/archive",
    "DELETE /workspaces/w",
    "GET /workspaces/w/usage",
    "GET /groups",
    "POST /groups",
    "PUT /groups/g",
    "DELETE /groups/g",
  ]);
});

test("submitTask with runtime sends it in the body", async () => {
  const { calls, fetch } = fakeFetch({
    "/tasks": { taskId: "t-1", agentName: "Manuel", status: "queued", position: 1 },
  });
  const c = new SwarmClient({ baseUrl: "http://127.0.0.1:7777", fetchImpl: fetch });
  await c.submitTask({ prompt: "do it", agent: "claude", repository: "git@x:y.git", runtime: "remote-docker" });
  const sent = JSON.parse(String(calls[0]!.init!.body));
  assert.equal(sent.runtime, "remote-docker");
});

test("executionModes unwraps modes from response", async () => {
  const { fetch } = fakeFetch({ "/execution-modes": { modes: { "local-in-process": true, "local-docker": false } } });
  const c = new SwarmClient({ baseUrl: "http://x", fetchImpl: fetch });
  const modes = await c.executionModes();
  assert.deepEqual(modes, { "local-in-process": true, "local-docker": false });
});

test("setContainers PUTs the docker config", async () => {
  const { calls, fetch } = fakeFetch({ "/containers": { version: 1, docker: { enabled: true } } });
  const c = new SwarmClient({ baseUrl: "http://x", fetchImpl: fetch });
  await c.setContainers(true);
  const sent = JSON.parse(String(calls[0]!.init!.body));
  assert.deepEqual(sent, { docker: { enabled: true } });
  assert.equal(calls[0]!.init!.method, "PUT");
});

test("deleteAgent/deleteWorkspace send no body and no content-type header", async () => {
  // A bodiless DELETE with Content-Type: application/json 400s against a real
  // fastify server (FST_ERR_CTP_EMPTY_JSON_BODY) — this was live-broken end
  // to end (verified against swarm) until http() stopped setting the header
  // when there is nothing to send.
  const { calls, fetch } = fakeFetch({
    "/agents/wilkin": { ok: true, deleted: "wilkin" },
    "/workspaces/w": { ok: true, deleted: "w" },
  });
  const client = new SwarmClient({ baseUrl: "http://s", fetchImpl: fetch });
  await client.deleteAgent("wilkin");
  await client.deleteWorkspace("w");
  for (const call of calls) {
    assert.equal(call.init?.body, undefined);
    assert.equal((call.init?.headers as Record<string, string> | undefined)?.["content-type"], undefined);
  }
});

test("me/verify methods hit the right swarm routes", async () => {
  const calls: string[] = [];
  const client = new SwarmClient({
    baseUrl: "http://s",
    fetchImpl: (async (url: unknown, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${String(url).replace("http://s", "")}`);
      return new Response(JSON.stringify({ ok: true, id: "me", name: "You", connectors: [], detail: "x" }));
    }) as typeof fetch,
  });
  await client.getMe();
  await client.updateMe({ name: "Edwin" });
  await client.verifyWorkspaceAtlassian("acme");
  await client.verifyRepoGithub("acme", "web");
  assert.deepEqual(calls, [
    "GET /me",
    "PUT /me",
    "POST /workspaces/acme/verify-atlassian",
    "POST /workspaces/acme/repos/web/verify-github",
  ]);
});

test("lookupTicket and search-docs routes", async () => {
  const calls: string[] = [];
  const client = new SwarmClient({
    baseUrl: "http://s",
    fetchImpl: (async (url: unknown, init?: RequestInit) => {
      calls.push(`${init?.method} ${String(url).replace("http://s", "")}`);
      return new Response(
        JSON.stringify({ ok: true, ticket: { key: "P-1", summary: "s", status: "Open", url: "https://x" }, docs: [] }),
      );
    }) as typeof fetch,
  });
  await client.lookupTicket("acme", "P-1");
  await client.searchDocs("acme", "onboarding");
  assert.deepEqual(calls, [
    "POST /workspaces/acme/atlassian/lookup-ticket",
    "POST /workspaces/acme/atlassian/search-docs",
  ]);
});

test("channels methods hit the right swarm routes", async () => {
  const calls: string[] = [];
  const client = new SwarmClient({
    baseUrl: "http://s",
    fetchImpl: (async (url: unknown, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${String(url).replace("http://s", "")}`);
      return new Response(
        JSON.stringify({ hasDiscordToken: false, textChannels: [], voiceChannels: [], ok: true, detail: "x" }),
      );
    }) as typeof fetch,
  });
  await client.getWorkspaceChannels("acme");
  await client.saveWorkspaceChannels("acme", { discord: { botToken: "tok", textChannels: [], voiceChannels: [] } });
  await client.verifyWorkspaceDiscord("acme");
  await client.getWorkspaceDiscordConfig("acme");
  assert.deepEqual(calls, [
    "GET /workspaces/acme/channels",
    "PUT /workspaces/acme/channels",
    "POST /workspaces/acme/channels/verify-discord",
    "GET /workspaces/acme/channels/discord-token",
  ]);
});

test("getWorkspaceDiscordConfig returns null when the workspace has no Discord config (404), instead of throwing", async () => {
  const client = new SwarmClient({
    baseUrl: "http://s",
    fetchImpl: (async () =>
      new Response(JSON.stringify({ error: "no Discord config" }), { status: 404 })) as typeof fetch,
  });
  assert.equal(await client.getWorkspaceDiscordConfig("acme"), null);
});

test("connector methods hit the right swarm routes", async () => {
  const calls: string[] = [];
  const client = new SwarmClient({
    baseUrl: "http://s",
    fetchImpl: (async (url: unknown, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${String(url).replace("http://s", "")}`);
      return new Response(
        JSON.stringify({ id: "c1", vendorId: "github", label: "personal", fields: {}, ok: true, detail: "x" }),
      );
    }) as typeof fetch,
  });
  await client.getConnectorVendors();
  await client.getMyConnectors();
  await client.addConnector({ vendorId: "github", label: "personal", fields: { token: "tok" } });
  await client.updateConnector("c1", { label: "renamed" });
  await client.deleteConnector("c1");
  await client.verifyConnector("c1", { testSiteUrl: "https://x.atlassian.net" });
  assert.deepEqual(calls, [
    "GET /connectors/vendors",
    "GET /me/connectors",
    "POST /me/connectors",
    "PUT /me/connectors/c1",
    "DELETE /me/connectors/c1",
    "POST /me/connectors/c1/verify",
  ]);
});

test("getMe/updateMe still hit /me — updateMe body is name-only now", async () => {
  const calls: Array<{ path: string; body?: unknown }> = [];
  const client = new SwarmClient({
    baseUrl: "http://s",
    fetchImpl: (async (url: unknown, init?: RequestInit) => {
      calls.push({
        path: String(url).replace("http://s", ""),
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });
      return new Response(JSON.stringify({ id: "me", name: "Edwin", connectors: [] }));
    }) as typeof fetch,
  });
  await client.getMe();
  await client.updateMe({ name: "Edwin" });
  assert.deepEqual(calls, [
    { path: "/me", body: undefined },
    { path: "/me", body: { name: "Edwin" } },
  ]);
});

test("getTask hits GET /tasks/:taskId and returns the parsed record", async () => {
  const calls: string[] = [];
  const client = new SwarmClient({
    baseUrl: "http://s",
    fetchImpl: (async (url: unknown, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${String(url).replace("http://s", "")}`);
      return new Response(
        JSON.stringify({
          taskId: "t-1",
          status: "completed",
          result: { pullRequestUrl: "https://github.com/x/y/pull/1" },
        }),
      );
    }) as typeof fetch,
  });
  const task = await client.getTask("t-1");
  assert.deepEqual(calls, ["GET /tasks/t-1"]);
  assert.deepEqual(task, {
    taskId: "t-1",
    status: "completed",
    result: { pullRequestUrl: "https://github.com/x/y/pull/1" },
  });
});

test("getTask returns null on 404 (unknown task) instead of throwing", async () => {
  const client = new SwarmClient({
    baseUrl: "http://s",
    fetchImpl: (async () =>
      new Response(JSON.stringify({ error: "Task t-9 not found" }), { status: 404 })) as typeof fetch,
  });
  assert.equal(await client.getTask("t-9"), null);
});

test("getTask throws on a genuine 500, unlike the 404 case", async () => {
  const client = new SwarmClient({
    baseUrl: "http://s",
    fetchImpl: (async () => new Response(JSON.stringify({ error: "swarm on fire" }), { status: 500 })) as typeof fetch,
  });
  await assert.rejects(client.getTask("t-1"), /swarm on fire/);
});

test("avatarFile hits GET /avatars/:file with the same auth header as http(), and returns raw bytes", async () => {
  const calls: Array<{ method: string; url: string; headers: Record<string, string> }> = [];
  const client = new SwarmClient({
    baseUrl: "http://s",
    token: "secret",
    fetchImpl: (async (url: unknown, init?: RequestInit) => {
      calls.push({
        method: init?.method ?? "GET",
        url: String(url),
        headers: (init?.headers as Record<string, string>) ?? {},
      });
      return new Response(Buffer.from("PNGBYTES"), { status: 200 });
    }) as typeof fetch,
  });
  const buf = await client.avatarFile("minerva.png");
  assert.deepEqual(calls, [
    { method: "GET", url: "http://s/avatars/minerva.png", headers: { authorization: "Bearer secret" } },
  ]);
  assert.equal(buf?.toString(), "PNGBYTES");
});

test("avatarFile returns null on 404 (no such avatar) instead of throwing", async () => {
  const client = new SwarmClient({
    baseUrl: "http://s",
    fetchImpl: (async () => new Response("not found", { status: 404 })) as typeof fetch,
  });
  assert.equal(await client.avatarFile("ghost.png"), null);
});

test("avatarFile throws on a genuine 500, unlike the 404 case", async () => {
  const client = new SwarmClient({
    baseUrl: "http://s",
    fetchImpl: (async () => new Response("boom", { status: 500 })) as typeof fetch,
  });
  await assert.rejects(client.avatarFile("minerva.png"), /swarm GET \/avatars\/minerva.png -> 500/);
});

test("getVoiceKeys: returns the resolved slots from /me/voice/keys", async () => {
  const client = new SwarmClient({
    baseUrl: "http://s",
    fetchImpl: fakeFetch({ "/me/voice/keys": { stt: { vendorId: "deepgram", apiKey: "dg" }, tts: null } }).fetch,
  });
  assert.deepEqual(await client.getVoiceKeys(), { stt: { vendorId: "deepgram", apiKey: "dg" }, tts: null });
});

test("getVoiceKeys: unreachable swarm → null (distinct from {stt:null,tts:null})", async () => {
  const client = new SwarmClient({
    baseUrl: "http://s",
    fetchImpl: (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch,
  });
  assert.equal(await client.getVoiceKeys(), null);
});

test("getMyVoice/saveMyVoice: GET and PUT /me/voice pass through", async () => {
  const client = new SwarmClient({
    baseUrl: "http://s",
    fetchImpl: fakeFetch({ "/me/voice": { stt: null, tts: null, hideInactive: false } }).fetch,
  });
  assert.deepEqual(await client.getMyVoice(), { stt: null, tts: null, hideInactive: false });
  assert.deepEqual(await client.saveMyVoice({ stt: null, tts: null }), { stt: null, tts: null, hideInactive: false });
});

test("apiAgentOneShot: reply on 200, notApiAgent on 404, typed throw otherwise", async () => {
  const { calls, fetch } = fakeFetch({ "/api-agents/sage/turn": { reply: "I should lead." } });
  const c = new SwarmClient({ baseUrl: "http://x", token: "tok", fetchImpl: fetch });
  const ok = await c.apiAgentOneShot("sage", "lead?");
  assert.deepEqual(ok, { reply: "I should lead." });
  const sent = JSON.parse(String(calls[0]!.init!.body));
  assert.deepEqual(sent, { message: "lead?", oneshot: true });
  assert.equal((calls[0]!.init!.headers as Record<string, string>).authorization, "Bearer tok");

  // fakeFetch 404s unknown paths — the clean fall-back signal, never a throw.
  assert.deepEqual(await c.apiAgentOneShot("ghost", "lead?"), { notApiAgent: true });

  // A 502 with the swarm's typed message throws it verbatim.
  const failing = (async () =>
    new Response(JSON.stringify({ error: "top up the account, then retry", kind: "billing" }), {
      status: 502,
    })) as unknown as typeof fetch;
  const c2 = new SwarmClient({ baseUrl: "http://x", fetchImpl: failing });
  await assert.rejects(() => c2.apiAgentOneShot("sage", "lead?"), /top up the account/);
});
