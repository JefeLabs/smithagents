package com.jefelabs.smithagents.gateway;

import com.jefelabs.smithagents.persona.IncomingMessage;
import com.jefelabs.smithagents.persona.Persona;
import com.jefelabs.smithagents.persona.PersonaRouter;
import net.dv8tion.jda.api.events.message.MessageReceivedEvent;
import net.dv8tion.jda.api.events.session.ReadyEvent;
import net.dv8tion.jda.api.hooks.ListenerAdapter;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * Handles Discord gateway events (PRD §3).
 *
 * <p>First slice = connectivity smoke test: confirm login on {@code onReady}, log
 * every inbound message (proves the {@code MESSAGE_CONTENT} intent), and answer
 * {@code !ping} with {@code pong} (proves REST send). Real messages are handed to
 * {@link PersonaRouter} — the one piece still unimplemented — so the pipeline is
 * wired end-to-end the moment {@code route()} exists.
 */
@Component
public class DiscordMessageListener extends ListenerAdapter {

    private static final Logger log = LoggerFactory.getLogger(DiscordMessageListener.class);

    private final PersonaRouter router;

    public DiscordMessageListener(PersonaRouter router) {
        this.router = router;
    }

    @Override
    public void onReady(ReadyEvent event) {
        var self = event.getJDA().getSelfUser();
        log.info("✅ Connected to Discord as {} — watching {} guild(s).",
                self.getName(), event.getJDA().getGuilds().size());
    }

    @Override
    public void onMessageReceived(MessageReceivedEvent event) {
        if (event.getAuthor().isBot()) {
            return; // ignore bots, including ourselves — avoids feedback loops
        }

        String author = event.getAuthor().getName();
        String content = event.getMessage().getContentDisplay();
        log.info("#{} <{}> {}", event.getChannel().getName(), author, content);

        // Connectivity check: read (MESSAGE_CONTENT intent) + send round-trip.
        if (content.equalsIgnoreCase("!ping")) {
            event.getChannel().sendMessage("pong 🏓").queue();
            return;
        }

        // Intended pipeline. routeToPersona is the one method still to be written;
        // catch its placeholder exception so connectivity isn't blocked by it.
        try {
            Persona persona = router.route(
                    new IncomingMessage(author, content, event.getChannel().getId()));
            log.info("→ routed to persona: {}", persona.name());
            // TODO(next slice): dispatch to the persona's LLM reply + MLX voice.
        } catch (UnsupportedOperationException e) {
            log.debug("Routing not implemented yet (PersonaRouter.route); message not dispatched.");
        }
    }
}
