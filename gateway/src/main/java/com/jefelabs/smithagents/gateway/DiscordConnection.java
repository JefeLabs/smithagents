package com.jefelabs.smithagents.gateway;

import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import net.dv8tion.jda.api.JDA;
import net.dv8tion.jda.api.JDABuilder;
import net.dv8tion.jda.api.entities.Activity;
import net.dv8tion.jda.api.requests.GatewayIntent;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * Owns the JDA connection to Discord (PRD §3) — embedded in the gateway process
 * by design (see README: "Discord lives inside gateway").
 *
 * <p>The connection is outbound: JDA dials Discord's gateway, so no inbound ports
 * or ngrok are involved here (ngrok/mTLS is only for the Tauri control plane).
 *
 * <p>A blank token disables the connection with a warning rather than failing
 * startup, so the gateway still boots for non-Discord work.
 */
@Component
public class DiscordConnection {

    private static final Logger log = LoggerFactory.getLogger(DiscordConnection.class);

    private final DiscordProperties properties;
    private final DiscordMessageListener listener;
    private JDA jda;

    public DiscordConnection(DiscordProperties properties, DiscordMessageListener listener) {
        this.properties = properties;
        this.listener = listener;
    }

    @PostConstruct
    void connect() {
        if (!properties.hasToken()) {
            log.warn("No Discord token configured — set DISCORD_TOKEN (or smithagents.discord.token). "
                    + "Discord connection DISABLED; the gateway will run without it.");
            return;
        }
        try {
            // MESSAGE_CONTENT is privileged: it must ALSO be enabled for the bot in
            // the Discord Developer Portal, or message bodies arrive empty.
            this.jda = JDABuilder.createDefault(properties.token())
                    .enableIntents(GatewayIntent.MESSAGE_CONTENT)
                    .addEventListeners(listener)
                    .setActivity(Activity.listening("the swarm"))
                    .build();
            log.info("Discord connection initializing… (awaiting READY)");
        } catch (Exception e) {
            log.error("Failed to start Discord connection: {}", e.getMessage(), e);
        }
    }

    @PreDestroy
    void disconnect() {
        if (jda != null) {
            log.info("Shutting down Discord connection…");
            jda.shutdown();
        }
    }

    /** The live JDA instance, or {@code null} when Discord is disabled. */
    public JDA jda() {
        return jda;
    }
}
