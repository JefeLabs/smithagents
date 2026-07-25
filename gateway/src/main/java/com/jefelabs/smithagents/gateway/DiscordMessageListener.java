package com.jefelabs.smithagents.gateway;

import net.dv8tion.jda.api.events.message.MessageReceivedEvent;
import net.dv8tion.jda.api.events.session.ReadyEvent;
import net.dv8tion.jda.api.hooks.ListenerAdapter;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * Handles Discord gateway events (PRD §3).
 *
 * <p>Connectivity slice: confirm login on {@code onReady}, post a one-line
 * greeting to a configured channel (a visible outbound send), log inbound
 * messages (proves the {@code MESSAGE_CONTENT} intent), and answer {@code !ping}.
 *
 * <p>Message routing to an agent is intentionally absent here: agent identity
 * and dispatch now live in the swarm orchestrator (the {@code swarm/} module).
 * This listener will be rebuilt to route inbound messages against the swarm's
 * agent registry once that path exists.
 */
@Component
public class DiscordMessageListener extends ListenerAdapter {

    private static final Logger log = LoggerFactory.getLogger(DiscordMessageListener.class);

    private final DiscordProperties props;

    public DiscordMessageListener(DiscordProperties props) {
        this.props = props;
    }

    @Override
    public void onReady(ReadyEvent event) {
        var jda = event.getJDA();
        log.info("✅ Connected to Discord as {} — watching {} guild(s).",
                jda.getSelfUser().getName(), jda.getGuilds().size());
        announce(event);
    }

    /** Posts a greeting on connect so an outbound send is visible in the channel. */
    private void announce(ReadyEvent event) {
        if (!props.hasAnnounceChannel()) {
            return;
        }
        var channel = event.getJDA().getTextChannelById(props.announceChannelId());
        if (channel == null) {
            log.warn("Announce channel {} not found or not visible to the bot — skipping greeting.",
                    props.announceChannelId());
            return;
        }
        channel.sendMessage("🟢 **smithagents** gateway online.")
                .queue(m -> log.info("Announcement posted to #{}", channel.getName()),
                        err -> log.warn("Announcement failed: {}", err.getMessage()));
    }

    @Override
    public void onMessageReceived(MessageReceivedEvent event) {
        if (event.getAuthor().isBot()) {
            return; // ignore bots, including ourselves — avoids feedback loops
        }

        String author = event.getAuthor().getName();
        String content = event.getMessage().getContentDisplay();
        log.info("#{} <{}> {}", event.getChannel().getName(), author, content);

        if (content.equalsIgnoreCase("!ping")) {
            event.getChannel().sendMessage("pong 🏓").queue();
        }
        // Routing an inbound message to an agent will be rebuilt against the
        // swarm orchestrator's agent registry (was: personas PersonaRouter).
    }
}
