package com.jefelabs.smithagents.gateway;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Discord bot configuration (PRD §3). Bound from {@code smithagents.discord.*}.
 *
 * <p>The token is a secret: it is supplied at runtime (env var {@code DISCORD_TOKEN}
 * via {@code application.yml}) and never committed.
 *
 * @param token the Discord bot token; blank/absent disables the connection
 */
@ConfigurationProperties(prefix = "smithagents.discord")
public record DiscordProperties(String token) {

    public boolean hasToken() {
        return token != null && !token.isBlank();
    }
}
