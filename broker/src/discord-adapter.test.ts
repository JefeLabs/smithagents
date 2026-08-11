import assert from "node:assert/strict";
import { test } from "node:test";
import { createDiscordAdapter, type DiscordClientLike } from "./discord-adapter.ts";

const BOT_ID = "bot-1";
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
    channelId: "chan-1",
    content: "hello crew",
    author: { id: "human-1", username: "Edwin", bot: false },
    webhookId: null,
    mentions: { users: new Map(), repliedUser: null, has: (id: string) => id === BOT_ID },
    ...over,
  });
  return { client, handlers, sent, message };
}

test("mention in an allowlisted channel becomes an utterance", async () => {
  const { client, handlers, message } = fakeClient();
  const utterances: unknown[] = [];
  await createDiscordAdapter({
    token: "t",
    allowlist: ["chan-1"],
    onUtterance: (u) => utterances.push(u),
    clientFactory: () => client,
  });
  handlers.get("messageCreate")!(message({}));
  assert.deepEqual(utterances, [{ text: "hello crew", author: "Edwin", channelRef: "chan-1" }]);
});

test("the mention token is stripped from the text, for both <@id> and <@!id> forms", async () => {
  const { client, handlers, message } = fakeClient();
  const utterances: unknown[] = [];
  await createDiscordAdapter({
    token: "t",
    allowlist: ["chan-1"],
    onUtterance: (u) => utterances.push(u),
    clientFactory: () => client,
  });
  const h = handlers.get("messageCreate")!;
  h(message({ content: "<@bot-1> hola crew" }));
  h(message({ content: "<@!bot-1> oye" }));
  assert.deepEqual(utterances, [
    { text: "hola crew", author: "Edwin", channelRef: "chan-1" },
    { text: "oye", author: "Edwin", channelRef: "chan-1" },
  ]);
});

test("a message that is only the mention token, in either form, produces no utterance", async () => {
  const { client, handlers, message } = fakeClient();
  const utterances: unknown[] = [];
  await createDiscordAdapter({
    token: "t",
    allowlist: ["chan-1"],
    onUtterance: (u) => utterances.push(u),
    clientFactory: () => client,
  });
  const h = handlers.get("messageCreate")!;
  h(message({ content: "<@bot-1>" }));
  h(message({ content: "<@!bot-1> " }));
  assert.equal(utterances.length, 0);
});

test("non-allowlisted channels, unmentioned messages, bots, and webhooks are ignored", async () => {
  const { client, handlers, message } = fakeClient();
  const utterances: unknown[] = [];
  await createDiscordAdapter({
    token: "t",
    allowlist: ["chan-1"],
    onUtterance: (u) => utterances.push(u),
    clientFactory: () => client,
  });
  const h = handlers.get("messageCreate")!;
  h(message({ channelId: "elsewhere" }));
  h(message({ mentions: { users: new Map(), repliedUser: null, has: () => false } }));
  h(message({ author: { id: "other-bot", username: "SomeBot", bot: true } }));
  h(message({ webhookId: "wh-9" })); // our own agents' posts must never loop back
  assert.equal(utterances.length, 0);
});

test("an @everyone/@here ping (or a role the bot holds) does not wake the crew", async () => {
  const { client, handlers, message } = fakeClient();
  const utterances: unknown[] = [];
  await createDiscordAdapter({
    token: "t",
    allowlist: ["chan-1"],
    onUtterance: (u) => utterances.push(u),
    clientFactory: () => client,
  });
  const h = handlers.get("messageCreate")!;
  // Models discord.js's own has(): true for a bare @everyone/@here/role ping
  // when the caller doesn't ask it to be ignored, false once it is —
  // i.e. exactly what a broadcast ping (not a real mention) looks like.
  h(
    message({
      content: "@everyone heads up",
      mentions: {
        users: new Map(),
        repliedUser: null,
        has: (_id: string, opts?: { ignoreEveryone?: boolean }) => !opts?.ignoreEveryone,
      },
    }),
  );
  assert.equal(utterances.length, 0);
});

test("deliver posts through the channel webhook under the agent name", async () => {
  const { client, sent } = fakeClient();
  const { adapter } = await createDiscordAdapter({
    token: "t",
    allowlist: ["chan-1"],
    onUtterance: () => {},
    clientFactory: () => client,
  });
  await adapter.deliver({ agentId: "ignacio", name: "Ignacio", text: "dime a ver" }, "chan-1");
  assert.deepEqual(sent, [{ channelId: "chan-1", username: "Ignacio", content: "dime a ver" }]);
});
