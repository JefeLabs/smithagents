/**
 * Discord text adapter boot/teardown, extracted out of main.ts's composition
 * root so it's a callable, testable unit instead of the one-shot
 * boot-at-startup block it used to be. main.ts's top-level script structure
 * (real SDK clients, `loadBrokerConfig()` throwing on missing env vars,
 * top-level `await broker.start()`, a real HTTP server) genuinely resists
 * direct unit testing — importing it runs the whole app. This module holds
 * just the Discord-text-specific lifecycle logic, constructor-injected with
 * the hub it registers/unregisters against (mirrors channels.ts's own
 * HubDeps-style structural injection) and an optional `createDiscordAdapter`
 * test seam (mirrors discord-adapter.ts's own `clientFactory` seam one level
 * up).
 *
 * Task 9 wires this into session-activation lifecycle; today main.ts still
 * boots it once at startup from env vars, same as before this extraction.
 */
import type { ChannelAdapter, ChannelUtterance } from './channels.ts';
import { createDiscordAdapter as realCreateDiscordAdapter } from './discord-adapter.ts';

/** The narrow slice of AdapterHub this lifecycle needs — not the whole class,
 * so a test can hand in a minimal fake instead of constructing a real hub. */
export interface DiscordTextHub {
  register(adapter: ChannelAdapter): void;
  unregister(kind: string): void;
  onUtterance(adapterKind: string, u: ChannelUtterance): void;
}

export interface DiscordTextLifecycleDeps {
  hub: DiscordTextHub;
  /** Test seam: injected adapter factory. Defaults to the real discord-adapter.ts one. */
  createDiscordAdapter?: typeof realCreateDiscordAdapter;
}

export interface DiscordTextLifecycle {
  /** Boots the text adapter for one bot token + channel allowlist, registers
   * it with `hub`, and tracks it as the active connection. Null (nothing
   * started, nothing tracked) when `textChannels` is empty — matches the
   * original inline boot's "allowlist empty -> don't start, log why" guard. */
  bootDiscordText(token: string, textChannels: string[]): Promise<{ stop: () => Promise<void> } | null>;
  /** Stops and unregisters the active connection, if any, and clears it.
   * Safe to call when nothing is active (no-op) or repeatedly (idempotent
   * after the first call clears state). */
  teardownDiscordText(): Promise<void>;
  /** The currently-booted connection, or null if none is active. */
  readonly activeDiscordText: { stop: () => Promise<void> } | null;
}

export function createDiscordTextLifecycle(deps: DiscordTextLifecycleDeps): DiscordTextLifecycle {
  const createAdapter = deps.createDiscordAdapter ?? realCreateDiscordAdapter;
  let activeDiscordText: { stop: () => Promise<void> } | null = null;

  async function bootDiscordText(token: string, textChannels: string[]): Promise<{ stop: () => Promise<void> } | null> {
    if (textChannels.length === 0) {
      console.error('[discord] bot token present but no text channels configured — adapter not started.');
      return null;
    }
    const { adapter, stop } = await createAdapter({
      token,
      allowlist: textChannels,
      onUtterance: (u) => deps.hub.onUtterance('discord', u),
    });
    deps.hub.register(adapter);
    console.log(`[discord] crew attending ${textChannels.length} channel(s)`);
    const active = {
      stop: async () => {
        deps.hub.unregister('discord');
        await stop();
      },
    };
    activeDiscordText = active;
    return active;
  }

  async function teardownDiscordText(): Promise<void> {
    if (!activeDiscordText) return;
    const current = activeDiscordText;
    activeDiscordText = null;
    await current.stop().catch((err) => console.error(`[discord] teardown failed: ${String(err)}`));
  }

  return {
    bootDiscordText,
    teardownDiscordText,
    get activeDiscordText() {
      return activeDiscordText;
    },
  };
}
