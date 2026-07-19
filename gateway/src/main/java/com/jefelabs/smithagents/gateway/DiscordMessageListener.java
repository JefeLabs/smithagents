package com.jefelabs.smithagents.gateway;

import com.jefelabs.smithagents.persona.IncomingMessage;
import com.jefelabs.smithagents.persona.Persona;
import com.jefelabs.smithagents.persona.PersonaRegistry;
import com.jefelabs.smithagents.persona.PersonaRouter;
import net.dv8tion.jda.api.events.message.MessageReceivedEvent;
import net.dv8tion.jda.api.events.session.ReadyEvent;
import net.dv8tion.jda.api.hooks.ListenerAdapter;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.util.stream.Collectors;

/**
 * Handles Discord gateway events (PRD §3).
 *
 * <p>Connectivity slice: confirm login on {@code onReady}, post a one-line
 * greeting to a configured channel (a visible outbound send), log inbound
 * messages (proves the {@code MESSAGE_CONTENT} intent), answer {@code !ping},
 * and hand real messages to {@link PersonaRouter} — the one piece still to be
 * implemented — so the pipeline is wired end-to-end.
 */
@Component
public class DiscordMessageListener extends ListenerAdapter {

    private static final Logger log = LoggerFactory.getLogger(DiscordMessageListener.class);

    private final PersonaRouter router;
    private final PersonaRegistry registry;
    private final DiscordProperties props;

    public DiscordMessageListener(PersonaRouter router, PersonaRegistry registry, DiscordProperties props) {
        this.router = router;
        this.registry = registry;
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
        String names = registry.all().stream().map(Persona::name).collect(Collectors.joining(" · "));
        channel.sendMessage("🟢 **smithagents** online — " + registry.all().size()
                        + " agents standing by: " + names)
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
            return;
        }

        try {
            Persona persona = router.route(
                    new IncomingMessage(author, content, event.getChannel().getId()));
            log.info("→ routed to persona: {}", persona.name());
            // TODO(next slice): post the reply AS that persona via a channel webhook.
        } catch (UnsupportedOperationException e) {
            log.debug("Routing not implemented yet (PersonaRouter.route); message not dispatched.");
        }
    }
}
