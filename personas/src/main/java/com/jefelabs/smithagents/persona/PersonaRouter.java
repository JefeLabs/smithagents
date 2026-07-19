package com.jefelabs.smithagents.persona;

import org.springframework.stereotype.Component;

/**
 * The {@code _embabel} routing decision: given an inbound Discord message, choose
 * which persona handles it (PRD §3, §6).
 *
 * <p>Operates entirely over the runtime {@link PersonaRegistry} — it never names a
 * persona literally, so adding a persona file under {@code prompts/} is enough to
 * make that persona routable.
 */
@Component
public class PersonaRouter {

    private final PersonaRegistry registry;

    public PersonaRouter(PersonaRegistry registry) {
        this.registry = registry;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // YOUR CONTRIBUTION  (see README → "Your first contribution")
    //
    // Choose a persona from `registry.all()` for the given message. Strategies —
    // pick what fits how your team talks in Discord:
    //
    //   • Explicit @mention  — match message.content() against persona.name()
    //   • Keyword / domain    — match message.content() against persona.keywords()
    //   • LLM classification  — hand `registry.all()` + the message to Embabel
    //
    // Two decisions the code below must make:
    //   1. The cheap default path (favor keyword/mention; escalate to an LLM only
    //      when ambiguous — this runs on EVERY inbound message).
    //   2. No-match behavior (a default owner? ask the human to disambiguate?).
    //
    // Keep it data-driven: never hardcode "Manuel"/"Octavio"/"Aurelio" here.
    // ─────────────────────────────────────────────────────────────────────────
    public Persona route(IncomingMessage message) {
        // TODO(you): implement the routing decision described above (~5-10 lines).
        throw new UnsupportedOperationException(
                "PersonaRouter.route not implemented — see README 'Your first contribution'");
    }
}
