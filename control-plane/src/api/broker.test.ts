import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getAgentRecords,
  getApiKeys,
  getExecutionModes,
  getWorkspaceRecords,
  pingBrain,
  postSession,
  postUtterance,
  saveApiKey,
  setCliToolEnabled,
} from "./broker";
import type { ExecutionMode, SessionFrame } from "./types";

afterEach(() => vi.unstubAllGlobals());

function stubJson(body: unknown, ok = true, status = 200) {
  const fetchMock = vi.fn(
    async (_url: string, _init?: RequestInit) => ({ ok, status, json: async () => body }) as unknown as Response,
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("broker api", () => {
  it("unwraps the envelope key for list endpoints", async () => {
    // The broker's real envelope key is "providers" (swarm/src/server.ts:1777), not "keys".
    stubJson({ providers: [{ id: "google", label: "Google" }] });
    const keys = await getApiKeys();
    expect(keys).toHaveLength(1);
    expect(keys[0]?.id).toBe("google");
  });

  it("returns [] when an envelope key is absent rather than throwing", async () => {
    stubJson({});
    expect(await getWorkspaceRecords()).toEqual([]);
  });

  it("posts the typed key to the right url", async () => {
    const fetchMock = stubJson({ providers: [] });
    await saveApiKey("google", "sk-live-123");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api-keys/google");
    expect(JSON.parse(String(init.body))).toEqual({ key: "sk-live-123" });
  });

  it("surfaces a broker error body instead of the parsed list", async () => {
    stubJson({ error: "unknown tool" }, false, 400);
    expect(await setCliToolEnabled("nope", true)).toEqual({ error: "unknown tool" });
  });

  it("trusts the parsed body over res.ok — a non-2xx with no {error} still returns the list", async () => {
    // Pins the branch on `body.error`, not `!res.ok || body.error`: a 400 that
    // parses to {tools: []} with no error field must still resolve to [],
    // not get reinterpreted as a rejection just because res.ok is false.
    stubJson({ tools: [] }, false, 400);
    expect(await setCliToolEnabled("nope", true)).toEqual([]);
  });
});

describe("getAgentRecords", () => {
  it("returns the records with the discord and voice siblings intact", async () => {
    // The three consumers of this endpoint each read a different part of the
    // envelope; dropping to `agents` alone would leave two of them blind.
    stubJson({
      agents: [{ id: "wilkin", engine: { cli: "codex" }, channels: { discord: "on-request" }, presence: {} }],
      discord: { configured: true, voiceReady: false },
      voice: { stt: true, tts: false },
    });
    const res = await getAgentRecords();
    expect(res.agents[0]).toMatchObject({ id: "wilkin", engine: { cli: "codex" } });
    expect(res.discord).toEqual({ configured: true, voiceReady: false });
    expect(res.voice).toEqual({ stt: true, tts: false });
  });

  it("defaults agents to [] but leaves discord and voice ABSENT rather than inventing them", async () => {
    // Absent is not the same as a confirmed negative here: `useVoiceStatus`
    // reads undefined as "unknown -> enabled". Defaulting voice to
    // {stt:false,tts:false} in this layer would silently gate the mic.
    stubJson({});
    const res = await getAgentRecords();
    expect(res.agents).toEqual([]);
    expect(res.discord).toBeUndefined();
    expect(res.voice).toBeUndefined();
  });
});

describe("postSession", () => {
  it("POSTs {workspace, runtime, prompt} and resolves {} on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await postSession("127.0.0.1:7790", "acme", "local-in-process" as ExecutionMode, "fix the build");
    expect(fetchMock.mock.calls[0][0]).toContain("/sessions");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      workspace: "acme",
      runtime: "local-in-process",
      prompt: "fix the build",
    });
    expect(r).toEqual({});
  });

  it("surfaces {error, status} on 409", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: 'execution mode "remote-docker" is not available' }), { status: 409 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const r = await postSession("127.0.0.1:7790", "acme", "remote-docker" as ExecutionMode, "fix the build");
    expect(fetchMock.mock.calls[0][0]).toContain("/sessions");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      workspace: "acme",
      runtime: "remote-docker",
      prompt: "fix the build",
    });
    expect(r).toEqual({ error: 'execution mode "remote-docker" is not available', status: 409 });
  });

  it("surfaces a fallback error when the broker is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const r = await postSession("127.0.0.1:7790", "acme", "local-in-process" as ExecutionMode, "fix the build");
    expect(r).toEqual({ error: "broker unreachable" });
  });
});

describe("getExecutionModes", () => {
  it("GETs /execution-modes and returns the modes map", async () => {
    const modes: Record<ExecutionMode, boolean> = {
      "local-in-process": true,
      "local-docker": false,
      "remote-in-process": false,
      "remote-docker": false,
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ modes }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await getExecutionModes("127.0.0.1:7790");
    expect(fetchMock.mock.calls[0][0]).toContain("/execution-modes");
    expect(r).toEqual(modes);
  });

  it("falls back to local-in-process-only when the broker omits modes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await getExecutionModes("127.0.0.1:7790");
    expect(r).toEqual({
      "local-in-process": true,
      "local-docker": false,
      "remote-in-process": false,
      "remote-docker": false,
    });
  });
});

describe("SessionFrame (lockstep pin)", () => {
  it("session frame type accepts null", () => {
    // Compile-time: this literal must satisfy the exported SessionFrame type.
    const frame: SessionFrame = { type: "session", session: null, sessions: [], transcript: [], workspaces: [] };
    expect(frame.session).toBeNull();
  });

  it("session frame type accepts a populated session with runtime", () => {
    const frame: SessionFrame = {
      type: "session",
      session: { id: "s1", title: "Fix the build", workspace: "acme", runtime: "local-docker", artifacts: [] },
      sessions: [
        {
          id: "s1",
          title: "Fix the build",
          workspace: "acme",
          updatedAt: "2026-08-07T00:00:00.000Z",
          active: true,
          runtime: "local-docker",
          artifacts: [],
        },
      ],
      transcript: [{ role: "user", text: "hi" }],
      workspaces: ["acme"],
    };
    expect(frame.session?.runtime).toBe("local-docker");
  });
});

describe("postUtterance with a target", () => {
  it("sends the target as an object and resolves null on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
    const error = await postUtterance("look at the auth bug", { kind: "agent", id: "osvaldo" });
    expect(error).toBeNull();
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({ text: "look at the auth bug", target: { kind: "agent", id: "osvaldo" } });
  });

  it("returns the broker's refusal text so the composer can show it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: async () => ({ error: "Osvaldo is busy with: refactor auth." }),
      }),
    );
    expect(await postUtterance("hi", { kind: "agent", id: "osvaldo" })).toBe("Osvaldo is busy with: refactor auth.");
  });

  it("reports an unreachable broker rather than throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    expect(await postUtterance("hi", { kind: "agent", id: "osvaldo" })).toBe("broker unreachable");
  });

  it("omits `target` entirely when none is given, preserving the untargeted wire shape", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
    await postUtterance("plain old utterance");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ text: "plain old utterance" });
  });
});

describe("pingBrain", () => {
  it("returns the measured result the broker reported", async () => {
    stubJson({ ok: true, reply: "hi", latencyMs: 812 });
    expect(await pingBrain()).toEqual({ ok: true, reply: "hi", latencyMs: 812 });
  });

  it("reports a non-2xx as a failure — brokerFetch resolves rather than throwing", async () => {
    // An unchecked response here would tick a receipt nothing earned.
    stubJson({ error: "nope" }, false, 500);
    const result = await pingBrain();
    expect(result.ok).toBe(false);
  });

  it("reports a thrown fetch as a failure rather than propagating", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("broker unreachable");
      }),
    );
    const result = await pingBrain();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/unreachable/);
  });
});
