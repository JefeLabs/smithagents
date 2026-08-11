/**
 * Wires session/workspace activation to the Discord text and voice
 * lifecycles (discord-text-lifecycle.ts / discord-voice-lifecycle.ts, Tasks
 * 7-8): tears down whatever's currently connected on both surfaces — never
 * more than one live connection per surface, regardless of what the new
 * workspace has — then boots whatever the new workspace's own Discord config
 * specifies, if anything. Extracted into its own factory module for the same
 * reason those two were: main.ts's composition-root shape (real SDK clients,
 * `loadBrokerConfig()` throwing on missing env vars, top-level `await
 * broker.start()`, a real HTTP server) resists importing/testing directly, so
 * this holds just the switch-on-activation logic, constructor-injected with
 * the two lifecycle objects and the swarm slice it reads from.
 *
 * main.ts wires the result's `switchDiscordForWorkspace` into three call
 * sites: boot-time initialization and both branches (`create`/`activate`) of
 * the session-activation wrapper — replacing the two temporary env-based
 * bridge blocks Tasks 7-8 left in place.
 *
 * `switchDiscordForWorkspace` is serialized (see `switchChain` below): every
 * call site invokes it fire-and-forget, so without serialization two
 * overlapping switches could interleave — switch(B)'s teardown running while
 * switch(A) is still parked inside its own boot's Gateway login, seeing
 * nothing active yet and no-op'ing, leaving A's client orphaned with no
 * reference held anywhere once B's later boot wins the tracked reference.
 * Chaining every call through one serial promise makes B wait for A's full
 * switch (teardown AND boot) to settle first, so the invariant this module's
 * doc comment states below — never more than one live Discord client at a
 * time — actually holds across overlapping callers, not just within one call.
 */

/** The narrow slice of SwarmClient this switcher needs. Deliberately not
 * SwarmClientLike (broker.ts) — getWorkspaceDiscordConfig returns a raw bot
 * token and is intentionally excluded from that shared interface (Task 4) —
 * so this is its own minimal structural type instead. */
export interface DiscordWorkspaceSource {
  getWorkspaceDiscordConfig(
    name: string,
  ): Promise<{ botToken: string; textChannels: string[]; voiceChannels: string[] } | null>;
}

/** The narrow slices of each lifecycle this switcher drives — not the full
 * DiscordTextLifecycle/DiscordVoiceLifecycle interfaces (their `active*`
 * getters aren't needed here), so a test can hand in a minimal fake. */
export interface DiscordWorkspaceSwitcherDeps {
  swarm: DiscordWorkspaceSource;
  discordTextLifecycle: {
    bootDiscordText(token: string, textChannels: string[]): Promise<unknown>;
    teardownDiscordText(): Promise<void>;
  };
  discordVoiceLifecycle: {
    bootDiscordVoice(token: string, allowlist: string[]): Promise<unknown>;
    teardownDiscordVoice(): Promise<void>;
  };
}

export interface DiscordWorkspaceSwitcher {
  switchDiscordForWorkspace(workspaceName: string): Promise<void>;
}

export function createDiscordWorkspaceSwitcher(deps: DiscordWorkspaceSwitcherDeps): DiscordWorkspaceSwitcher {
  async function doSwitch(workspaceName: string): Promise<void> {
    // Both teardowns are idempotent (see discord-text-lifecycle.ts's and
    // discord-voice-lifecycle.ts's own doc comments) — safe to call
    // unconditionally, whether or not anything is currently connected, e.g.
    // at boot or when switching into a workspace with no Discord config.
    await deps.discordTextLifecycle.teardownDiscordText();
    await deps.discordVoiceLifecycle.teardownDiscordVoice();

    const config = await deps.swarm.getWorkspaceDiscordConfig(workspaceName);
    if (!config) return; // no bot configured for this workspace — Discord simply isn't reachable this session

    // Independent catches: a text-boot failure must not block attempting the
    // voice boot, and vice versa.
    await deps.discordTextLifecycle
      .bootDiscordText(config.botToken, config.textChannels)
      .catch((err: unknown) =>
        console.error(`[discord] failed to start for workspace "${workspaceName}": ${String(err)}`),
      );

    // bootDiscordVoice, unlike bootDiscordText, has no internal empty-allowlist
    // guard — guarded here explicitly, mirroring the boot-time bridge code
    // this replaces (main.ts's old `if (voiceChannelAllowlist.length > 0)`).
    if (config.voiceChannels.length > 0) {
      await deps.discordVoiceLifecycle
        .bootDiscordVoice(config.botToken, config.voiceChannels)
        .catch((err: unknown) =>
          console.error(`[discord-voice] failed to start for workspace "${workspaceName}": ${String(err)}`),
        );
    }
  }

  // Serializing wrapper — see this module's header comment for why. Mirrors
  // broker.ts's `speaking` chain / discord-voice-lifecycle.ts's own
  // `presenceChain` / main.ts's `synthChain`: every call is chained onto the
  // tail of the previous one, so a switch that arrives while an earlier one
  // is still in flight (teardown OR boot) waits for it to fully settle
  // before its own teardown ever runs. The `.catch` here (rather than inside
  // doSwitch) exists purely to keep the chain itself always resolving — a
  // rejection from a call site that awaits/`.then()`s its own promise (e.g.
  // getWorkspaceDiscordConfig throwing) must never poison every switch queued
  // behind it.
  let switchChain: Promise<void> = Promise.resolve();
  function switchDiscordForWorkspace(workspaceName: string): Promise<void> {
    switchChain = switchChain
      .then(() => doSwitch(workspaceName))
      .catch((err: unknown) => {
        console.error(`[discord] workspace switch failed for "${workspaceName}": ${String(err)}`);
      });
    return switchChain;
  }

  return { switchDiscordForWorkspace };
}
