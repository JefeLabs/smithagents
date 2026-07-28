# ChannelAdapter Port + Discord Text Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The broker gains a `ChannelAdapter` port and its first external implementation — a mention-gated Discord text adapter where each agent posts under its own identity — fully working in all-local mode.

**Architecture:** A small `AdapterHub` in the broker sits at two existing seams: `onSpeechText` (every spoken line, already the "free path" for text UIs — main.ts:626) for outbound delivery, and `handleUserText` (main.ts:330) for inbound utterances. Turns serialize in the broker, so a single `origin` field routes replies back to the channel that asked. The Discord adapter is a thin client over an injected `discord.js` surface so tests never touch the network. Spec: `docs/superpowers/specs/2026-07-28-hosted-switchboard-phase1-design.md` §5. This is Plan 1 of 3 (Plan 2: device pairing; Plan 3: `.infra`).

**Recorded deviation from spec §5:** the spec says the existing Tauri text channel is "retrofitted as the first implementation" of the port. This plan deliberately defers that retrofit: the hub coexists with the Tauri channel's existing broadcast path (zero behavior change, zero regression risk), and Discord is the port's first implementation. The retrofit is pure refactor with no user-visible effect and lands when the second external adapter (Slack) forces the cleanup. Approved-by-controller deviation; flag at review if it looks wrong.

**Tech Stack:** TypeScript, node:test via `node --import tsx --test`, discord.js v14 (the one new dependency, broker only).

## Global Constraints

- Broker only — no swarm or control-plane changes in this plan.
- All-local invariant: with no `DISCORD_TOKEN` in env, the broker behaves byte-for-byte as today (adapter never constructed).
- Broker imports use `.ts` specifiers; tests live beside sources as `*.test.ts`.
- Speech lines arrive speaker-prefixed (`Name: text`, sticky-speaker chunks unprefixed) — reuse `resolveSpokenLine`'s semantics, do not re-invent parsing.
- Agent designation: an agent attends a channel iff its `channels` array contains the adapter's channel kind (`"discord"`) — the existing `ComposedAgent.channels` field, honored for the first time. No `channels` field at all = attends everywhere. (`["tauri"]`-only agents therefore stay out of Discord until their file adds `"discord"` — that's the designation working, not a bug.)
- Every rejection/log line is a readable human sentence.
- Tests: `cd broker && node --import tsx --test src/<file>.test.ts`; full `npm test`; `npm run typecheck`.
- Commit after every task, conventional messages, each ending with:
  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

---

### Task 1: The port and the hub

**Files:**
- Create: `broker/src/channels.ts`
- Test: `broker/src/channels.test.ts`

**Interfaces:**
- Consumes: nothing from the broker yet (pure module; speaker resolution is injected).
- Produces (Tasks 2-4 depend on these exact names):

```ts
export interface ChannelSpeechLine { agentId?: string; name?: string; text: string }
export interface ChannelUtterance { text: string; author: string; channelRef: string }
export interface ChannelAdapter {
  /** Stable kind, e.g. "discord" — matched against ComposedAgent.channels. */
  kind: string;
  deliver(line: ChannelSpeechLine, channelRef: string): Promise<void>;
}
export interface HubAgent { id: string; name: string; channels?: string[] }
export class AdapterHub {
  constructor(deps: {
    resolveSpeaker: (text: string) => { speaker?: string; spokenText: string };
    agents: () => HubAgent[];
    submitUserText: (text: string) => void;
  })
  register(adapter: ChannelAdapter): void;
  /** Inbound: a human spoke in an external channel. Sets the turn origin, formats the line, submits it. */
  onUtterance(adapterKind: string, u: ChannelUtterance): void;
  /** Outbound: every spoken line. Delivers to the origin adapter/channel of the current turn only. */
  dispatchSpeech(text: string): void;
  /** Turn lifecycle: cleared when the turn's speech is done. Called by wiring after handleUtterance settles. */
  clearOrigin(): void;
}
```

- [ ] **Step 1: Write the failing tests**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdapterHub, type ChannelAdapter, type ChannelSpeechLine } from './channels.ts';

const resolveSpeaker = (text: string) => {
  const m = /^([A-Z][\w-]{1,24}):\s(.*)$/.exec(text);
  return m ? { speaker: m[1], spokenText: m[2]! } : { spokenText: text };
};
const AGENTS = [
  { id: 'ignacio', name: 'Ignacio', channels: ['tauri', 'discord'] },
  { id: 'wilkin', name: 'Wilkin', channels: ['tauri'] },
];
function fakeAdapter(kind: string) {
  const delivered: Array<{ line: ChannelSpeechLine; ref: string }> = [];
  const adapter: ChannelAdapter = { kind, deliver: async (line, ref) => void delivered.push({ line, ref }) };
  return { adapter, delivered };
}

test('utterance from a channel routes that turn\'s speech back to the same channelRef', () => {
  const submitted: string[] = [];
  const { adapter, delivered } = fakeAdapter('discord');
  const hub = new AdapterHub({ resolveSpeaker, agents: () => AGENTS, submitUserText: (t) => submitted.push(t) });
  hub.register(adapter);
  hub.onUtterance('discord', { text: 'que lo que', author: 'Edwin', channelRef: 'chan-1' });
  assert.deepEqual(submitted, ['Edwin (via discord): que lo que']);
  hub.dispatchSpeech('Ignacio: dime a ver');
  assert.deepEqual(delivered, [{ line: { agentId: 'ignacio', name: 'Ignacio', text: 'dime a ver' }, ref: 'chan-1' }]);
});

test('agents not designated for the channel are not delivered', () => {
  const { adapter, delivered } = fakeAdapter('discord');
  const hub = new AdapterHub({ resolveSpeaker, agents: () => AGENTS, submitUserText: () => {} });
  hub.register(adapter);
  hub.onUtterance('discord', { text: 'hi', author: 'Edwin', channelRef: 'chan-1' });
  hub.dispatchSpeech('Wilkin: I should stay silent here'); // channels lacks "discord"
  assert.equal(delivered.length, 0);
});

test('speech with no origin (Tauri/PTT turns) never spills into channels', () => {
  const { adapter, delivered } = fakeAdapter('discord');
  const hub = new AdapterHub({ resolveSpeaker, agents: () => AGENTS, submitUserText: () => {} });
  hub.register(adapter);
  hub.dispatchSpeech('Ignacio: local-only line');
  assert.equal(delivered.length, 0);
});

test('clearOrigin ends the turn; sticky-speaker unprefixed chunks follow the last speaker', () => {
  const { adapter, delivered } = fakeAdapter('discord');
  const hub = new AdapterHub({ resolveSpeaker, agents: () => AGENTS, submitUserText: () => {} });
  hub.register(adapter);
  hub.onUtterance('discord', { text: 'hi', author: 'Edwin', channelRef: 'chan-1' });
  hub.dispatchSpeech('Ignacio: first chunk.');
  hub.dispatchSpeech('second chunk, no prefix.'); // sticky speaker
  assert.equal(delivered.length, 2);
  assert.equal(delivered[1]!.line.agentId, 'ignacio');
  hub.clearOrigin();
  hub.dispatchSpeech('Ignacio: after the turn');
  assert.equal(delivered.length, 2);
});

test('an agent with NO channels field attends everywhere', () => {
  const { adapter, delivered } = fakeAdapter('discord');
  const hub = new AdapterHub({
    resolveSpeaker, agents: () => [{ id: 'nomad', name: 'Nomad' }], submitUserText: () => {},
  });
  hub.register(adapter);
  hub.onUtterance('discord', { text: 'hi', author: 'E', channelRef: 'c' });
  hub.dispatchSpeech('Nomad: present');
  assert.equal(delivered.length, 1);
});
```

- [ ] **Step 2: Run to verify failure** — `node --import tsx --test src/channels.test.ts` — FAIL (module missing).

- [ ] **Step 3: Implement `broker/src/channels.ts`**

```ts
/**
 * ChannelAdapter port — external text/voice surfaces (Discord, Slack, …)
 * plug into the broker here (spec §5). The hub sits at two seams:
 * onSpeechText feeds dispatchSpeech; handleUserText receives onUtterance.
 * Turns serialize in the broker, so one origin field is enough to route a
 * turn's replies back to the channel that asked. Unprefixed speech chunks
 * follow the last speaker (sticky-speaker, same rule the TTS path uses).
 */
export interface ChannelSpeechLine {
  agentId?: string;
  name?: string;
  text: string;
}

export interface ChannelUtterance {
  text: string;
  author: string;
  channelRef: string;
}

export interface ChannelAdapter {
  /** Stable kind, e.g. "discord" — matched against ComposedAgent.channels. */
  kind: string;
  deliver(line: ChannelSpeechLine, channelRef: string): Promise<void>;
}

export interface HubAgent {
  id: string;
  name: string;
  channels?: string[];
}

interface HubDeps {
  resolveSpeaker: (text: string) => { speaker?: string; spokenText: string };
  agents: () => HubAgent[];
  submitUserText: (text: string) => void;
}

export class AdapterHub {
  private adapters = new Map<string, ChannelAdapter>();
  private origin: { kind: string; channelRef: string } | null = null;
  private lastSpeaker: HubAgent | null = null;

  constructor(private readonly deps: HubDeps) {}

  register(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.kind, adapter);
  }

  onUtterance(adapterKind: string, u: ChannelUtterance): void {
    this.origin = { kind: adapterKind, channelRef: u.channelRef };
    this.lastSpeaker = null;
    this.deps.submitUserText(`${u.author} (via ${adapterKind}): ${u.text}`);
  }

  dispatchSpeech(text: string): void {
    if (!this.origin) return;
    const adapter = this.adapters.get(this.origin.kind);
    if (!adapter) return;
    const { speaker, spokenText } = this.deps.resolveSpeaker(text);
    if (speaker) {
      const q = speaker.toLowerCase();
      this.lastSpeaker =
        this.deps.agents().find((a) => a.id.toLowerCase() === q || a.name.toLowerCase() === q) ?? null;
    }
    const agent = this.lastSpeaker;
    if (!agent) return; // narrator/unknown lines stay out of external channels
    if (agent.channels && !agent.channels.includes(adapter.kind)) return;
    void adapter
      .deliver({ agentId: agent.id, name: agent.name, text: spokenText }, this.origin.channelRef)
      .catch((err) => console.error(`[channels] delivery to ${adapter.kind} failed: ${String(err)}`));
  }

  clearOrigin(): void {
    this.origin = null;
    this.lastSpeaker = null;
  }
}
```

- [ ] **Step 4: Run tests — PASS. `npm run typecheck`.**

- [ ] **Step 5: Commit** — `feat(broker): ChannelAdapter port and turn-routing AdapterHub`

---

### Task 2: Discord adapter

**Files:**
- Create: `broker/src/discord-adapter.ts`
- Test: `broker/src/discord-adapter.test.ts`
- Modify: `broker/package.json` (add `discord.js` `^14`)

**Interfaces:**
- Consumes: `ChannelAdapter`, `ChannelUtterance` from Task 1.
- Produces: `createDiscordAdapter(opts): Promise<{ adapter: ChannelAdapter; stop(): Promise<void> }>` where

```ts
export interface DiscordAdapterOptions {
  token: string;
  /** Channel ids the crew attends. Everything else is ignored. */
  allowlist: string[];
  onUtterance: (u: ChannelUtterance) => void;
  /** Test seam: injected client factory. Defaults to a real discord.js Client. */
  clientFactory?: () => DiscordClientLike;
}
```

`DiscordClientLike` is the minimal surface the adapter uses (login, `on('messageCreate')`, fetch channel, webhook create/fetch, destroy) — defined in `discord-adapter.ts` so tests implement it with plain objects.

- [ ] **Step 1: Install the dependency** — `cd broker && npm install discord.js@^14`. This is the plan's one sanctioned new dependency.

- [ ] **Step 2: Write the failing tests** (fake client, recorded-shape payloads)

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDiscordAdapter, type DiscordClientLike } from './discord-adapter.ts';

const BOT_ID = 'bot-1';
function fakeClient() {
  const handlers = new Map<string, (m: unknown) => void>();
  const sent: Array<{ channelId: string; username: string; content: string }> = [];
  const client: DiscordClientLike = {
    user: { id: BOT_ID },
    login: async () => {},
    destroy: async () => {},
    on: (ev, fn) => void handlers.set(ev, fn),
    webhookFor: async (channelId) => ({
      send: async (p: { username: string; content: string }) => void sent.push({ channelId, ...p }),
    }),
  };
  const message = (over: Record<string, unknown>) => ({
    channelId: 'chan-1',
    content: 'hello crew',
    author: { id: 'human-1', username: 'Edwin', bot: false },
    webhookId: null,
    mentions: { users: new Map(), repliedUser: null, has: (id: string) => id === BOT_ID },
    ...over,
  });
  return { client, handlers, sent, message };
}

test('mention in an allowlisted channel becomes an utterance', async () => {
  const { client, handlers, message } = fakeClient();
  const utterances: unknown[] = [];
  await createDiscordAdapter({
    token: 't', allowlist: ['chan-1'], onUtterance: (u) => utterances.push(u),
    clientFactory: () => client,
  });
  handlers.get('messageCreate')!(message({}));
  assert.deepEqual(utterances, [{ text: 'hello crew', author: 'Edwin', channelRef: 'chan-1' }]);
});

test('non-allowlisted channels, unmentioned messages, bots, and webhooks are ignored', async () => {
  const { client, handlers, message } = fakeClient();
  const utterances: unknown[] = [];
  await createDiscordAdapter({
    token: 't', allowlist: ['chan-1'], onUtterance: (u) => utterances.push(u),
    clientFactory: () => client,
  });
  const h = handlers.get('messageCreate')!;
  h(message({ channelId: 'elsewhere' }));
  h(message({ mentions: { users: new Map(), repliedUser: null, has: () => false } }));
  h(message({ author: { id: 'other-bot', username: 'SomeBot', bot: true } }));
  h(message({ webhookId: 'wh-9' })); // our own agents' posts must never loop back
  assert.equal(utterances.length, 0);
});

test('deliver posts through the channel webhook under the agent name', async () => {
  const { client, sent } = fakeClient();
  const { adapter } = await createDiscordAdapter({
    token: 't', allowlist: ['chan-1'], onUtterance: () => {}, clientFactory: () => client,
  });
  await adapter.deliver({ agentId: 'ignacio', name: 'Ignacio', text: 'dime a ver' }, 'chan-1');
  assert.deepEqual(sent, [{ channelId: 'chan-1', username: 'Ignacio', content: 'dime a ver' }]);
});
```

- [ ] **Step 3: Run — FAIL.** `node --import tsx --test src/discord-adapter.test.ts`

- [ ] **Step 4: Implement `broker/src/discord-adapter.ts`**

```ts
/**
 * Discord text channel adapter (spec §5). Mention-gated: the crew replies
 * when the bot is @mentioned or replied to, in allowlisted channels only.
 * Outbound identity: one managed webhook per channel; each agent posts
 * under its own username. Webhook posts carry webhookId — filtering them
 * on inbound is what prevents the crew from answering itself.
 */
import { Client, GatewayIntentBits, type Message, type TextChannel } from 'discord.js';
import type { ChannelAdapter, ChannelSpeechLine, ChannelUtterance } from './channels.ts';

export interface DiscordWebhookLike {
  send(payload: { username: string; content: string }): Promise<unknown>;
}

export interface DiscordClientLike {
  user: { id: string } | null;
  login(token: string): Promise<unknown>;
  destroy(): Promise<unknown>;
  on(event: 'messageCreate', handler: (message: DiscordMessageLike) => void): void;
  webhookFor(channelId: string): Promise<DiscordWebhookLike>;
}

export interface DiscordMessageLike {
  channelId: string;
  content: string;
  author: { id: string; username: string; bot: boolean };
  webhookId: string | null;
  mentions: { has(id: string): boolean };
}

export interface DiscordAdapterOptions {
  token: string;
  allowlist: string[];
  onUtterance: (u: ChannelUtterance) => void;
  clientFactory?: () => DiscordClientLike;
}

const WEBHOOK_NAME = 'smithagents crew';

function realClient(): DiscordClientLike {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });
  const webhooks = new Map<string, DiscordWebhookLike>();
  return {
    get user() {
      return client.user;
    },
    login: (token) => client.login(token),
    destroy: () => client.destroy(),
    on: (event, handler) => void client.on(event, (m) => handler(m as unknown as DiscordMessageLike & Message)),
    webhookFor: async (channelId) => {
      const cached = webhooks.get(channelId);
      if (cached) return cached;
      const channel = (await client.channels.fetch(channelId)) as TextChannel;
      const existing = (await channel.fetchWebhooks()).find((w) => w.name === WEBHOOK_NAME);
      const hook = existing ?? (await channel.createWebhook({ name: WEBHOOK_NAME }));
      webhooks.set(channelId, hook);
      return hook;
    },
  };
}

export async function createDiscordAdapter(
  opts: DiscordAdapterOptions,
): Promise<{ adapter: ChannelAdapter; stop(): Promise<void> }> {
  const client = (opts.clientFactory ?? realClient)();
  const allowed = new Set(opts.allowlist);

  client.on('messageCreate', (message) => {
    if (!allowed.has(message.channelId)) return;
    if (message.author.bot || message.webhookId) return;
    const botId = client.user?.id;
    if (!botId || !message.mentions.has(botId)) return;
    const text = message.content.replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim();
    if (!text) return;
    opts.onUtterance({ text, author: message.author.username, channelRef: message.channelId });
  });

  await client.login(opts.token);

  const adapter: ChannelAdapter = {
    kind: 'discord',
    deliver: async (line: ChannelSpeechLine, channelRef: string) => {
      const hook = await client.webhookFor(channelRef);
      await hook.send({ username: line.name ?? 'crew', content: line.text });
    },
  };
  return { adapter, stop: () => client.destroy().then(() => undefined) };
}
```

Note for the implementer: the fake in the tests implements `DiscordClientLike` directly — if TypeScript flags a mismatch between the fake and the interface, fix the interface (it is the contract), never widen the fake with `as`.

- [ ] **Step 5: Run tests — PASS. `npm run typecheck`. Full `npm test`.**

- [ ] **Step 6: Commit** — `feat(broker): mention-gated Discord adapter with per-agent webhook identity`

---

### Task 3: Wire the hub into main.ts

**Files:**
- Modify: `broker/src/main.ts` (three touch points), `broker/src/config.ts` if env parsing lives there (match existing env patterns), `.env.example`

**Interfaces:**
- Consumes: `AdapterHub` (Task 1), `createDiscordAdapter` (Task 2), existing `resolveSpokenLine` (main.ts:244), `handleUserText` (main.ts:330), `onSpeechText` sink (main.ts:626), the registry the directory is seeded from.
- Produces: env contract `DISCORD_TOKEN` (absent = adapter off) and `DISCORD_CHANNELS` (comma-separated channel ids).

- [ ] **Step 1: Construct the hub** near the other main.ts singletons:

```ts
const adapterHub = new AdapterHub({
  resolveSpeaker: resolveSpokenLine,
  agents: () => directory.list().map((a) => ({ id: a.id, name: a.name, channels: a.channels })),
  submitUserText: handleUserText,
});
```

`AgentDirectory` has no list accessor today — add one (named `list`, since the private map is already named `agents`): `list(): RegistryAgent[] { return [...this.agents.values()]; }` in `directory.ts`. `RegistryAgent` gains `channels?: string[]` in `swarm-client.ts` — the field already rides the registry JSON; the type just never declared it.

- [ ] **Step 2: Outbound seam** — in the existing `onSpeechText` callback (main.ts:626 area), add `adapterHub.dispatchSpeech(text);` alongside the current transcript/frame handling. **Turn end:** in `handleUserText`, after `broker.handleUtterance(text)` settles (the existing `.then(...)`), add `.finally(() => adapterHub.clearOrigin())`.

- [ ] **Step 3: Conditional Discord startup** near the other service boots:

```ts
const discordToken = process.env.DISCORD_TOKEN;
if (discordToken) {
  const allowlist = (process.env.DISCORD_CHANNELS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (allowlist.length === 0) {
    console.error('[discord] DISCORD_TOKEN is set but DISCORD_CHANNELS is empty — the crew would attend nowhere. Adapter not started.');
  } else {
    void createDiscordAdapter({
      token: discordToken,
      allowlist,
      onUtterance: (u) => adapterHub.onUtterance('discord', u),
    }).then(
      ({ adapter }) => {
        adapterHub.register(adapter);
        console.log(`[discord] crew attending ${allowlist.length} channel(s)`);
      },
      (err) => console.error(`[discord] failed to start: ${String(err)}`),
    );
  }
}
```

- [ ] **Step 4: `.env.example`** — add `DISCORD_TOKEN=` and `DISCORD_CHANNELS=` with one-line comments (bot token; comma-separated channel ids the crew attends). Note the PRD called the old `DISCORD_TOKEN` var vestigial — it is now real again, same name.

- [ ] **Step 5: Verify** — `npm run typecheck` + full `npm test` (85+ tests stay green: with no token the adapter never constructs, and the hub without origins is inert — the all-local invariant).

- [ ] **Step 6: Commit** — `feat(broker): wire the adapter hub — Discord attends when a token is present`

---

### Task 4: Docs + designation + live verification

**Files:**
- Modify: `PRD.md` (§2 concepts or §5 shipped + the §6.2 Discord line), `README.md` (env table + a channels line), `swarm/.smith/agents/ignacio.json` + `wilkin.json` (add `"discord"` to `channels`)

- [ ] **Step 1: Agent designation** — add `"discord"` to the `channels` arrays of `ignacio.json` and `wilkin.json` (data change, exactly how the designation is meant to work).

- [ ] **Step 2: PRD** — §6.2's "Discord: deliberately out …" item becomes: shipped as the first ChannelAdapter (mention-gated text, per-agent webhook identity, allowlisted channels; `DISCORD_TOKEN`/`DISCORD_CHANNELS` are live env vars again). Add a §5 dated line (2026-07-28 or the ship date). Note voice channels and Slack remain open items.

- [ ] **Step 3: README** — Configure section gains the two env vars; the architecture bullet list mentions the broker's ChannelAdapter port (Tauri text channel and Discord today; the port is where Slack/voice land later).

- [ ] **Step 4: Live verification (all-local, Edwin's guild)** — with the stack running locally: create a Discord bot, invite it to the guild with Manage Webhooks + Read/Send permissions, set both env vars, restart broker. Then: @mention the bot in an allowlisted channel with a question addressed to Ignacio → Ignacio answers **as Ignacio** (webhook identity) in the channel, the turn also lands in the Tauri transcript, and Wilkin (not yet designated if Step 1 deferred his file) stays silent. A message in a non-allowlisted channel does nothing. Record the checklist results in the task report; if no Discord credentials are available in the execution environment, state that plainly and hand the checklist to Edwin.

- [ ] **Step 5: Full suites** — broker `npm run typecheck && npm test`; nothing else changed (swarm/control-plane untouched — confirm with `git status`).

- [ ] **Step 6: Commit** — `docs: Discord is the first channel adapter — designation, env, PRD`
