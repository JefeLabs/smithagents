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
  /**
   * Handler takes `unknown`, not `DiscordMessageLike`: under strict
   * function types, a handler typed to the narrower shape can never be
   * stored in a plain `Map<string, (m: unknown) => void>` (the test fake's
   * dispatch table), regardless of how this method itself is declared.
   * Implementations narrow the payload to `DiscordMessageLike` themselves.
   */
  on(event: 'messageCreate', handler: (message: unknown) => void): void;
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
  /** Channel ids the crew attends. Everything else is ignored. */
  allowlist: string[];
  onUtterance: (u: ChannelUtterance) => void;
  /** Test seam: injected client factory. Defaults to a real discord.js Client. */
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
    on: (event, handler) => void client.on(event, (m: Message) => handler(m)),
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

  client.on('messageCreate', (raw) => {
    const message = raw as DiscordMessageLike;
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
