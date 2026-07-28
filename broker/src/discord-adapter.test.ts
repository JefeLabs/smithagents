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
