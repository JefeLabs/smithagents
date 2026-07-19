package com.jefelabs.smithagents.persona;

/**
 * A message arriving from Discord, normalized into the shape the routing engine
 * consumes (PRD §3). Lives in the {@code personas} module (not {@code gateway})
 * so {@link PersonaRouter} can depend on it without creating a module cycle.
 */
public record IncomingMessage(String author, String content, String channelId) {
}
