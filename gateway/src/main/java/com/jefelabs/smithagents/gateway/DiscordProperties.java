package com.jefelabs.smithagents.gateway;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Discord bot configuration (PRD §3), bound from {@code smithagents.discord.*}.
 * The token is a secret — supplied at runtime via the {@code DISCORD_TOKEN} env
 * var and never committed.
 *
 * @param token             the Discord bot token; blank/absent disables the connection
 * @param announceChannelId optional channel id the bot greets on connect (a visible send)
 */
@ConfigurationProperties(prefix = "smithagents.discord")
public record DiscordProperties(String token, String announceChannelId) {

    public boolean hasToken() {
        return token != null && !token.isBlank();
    }

    public boolean hasAnnounceChannel() {
        return announceChannelId != null && !announceChannelId.isBlank();
    }
}
