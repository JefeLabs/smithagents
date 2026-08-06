/**
 * Pure predicate: is Discord text currently connected for the active workspace?
 * Used in surfaces.presence/info/join to gate Discord availability.
 * Task 10: extracted this check so three call sites in main.ts all read the same
 * source of truth (activeDiscordText), not a stale env var.
 */
export function isDiscordTextActive(discordTextLifecycle: {
  activeDiscordText: unknown;
}): boolean {
  return discordTextLifecycle.activeDiscordText !== null;
}
