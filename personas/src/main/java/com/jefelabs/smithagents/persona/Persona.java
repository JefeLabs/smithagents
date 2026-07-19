package com.jefelabs.smithagents.persona;

import java.util.List;

/**
 * A swarm persona (PRD §6), loaded at runtime from the module's classpath
 * ({@code prompts/*.md}) rather than hardcoded. Adding a persona is a config
 * change, not a code change.
 *
 * @param id         stable identifier (the persona file's base name, e.g. "manuel")
 * @param name       display name (front-matter {@code name}, e.g. "Manuel")
 * @param role       one-line role (front-matter {@code role})
 * @param keywords   routing hints consumed by {@link PersonaRouter} (front-matter {@code keywords})
 * @param directives the Markdown body — the persona's behavioral contract / system prompt
 */
public record Persona(
        String id,
        String name,
        String role,
        List<String> keywords,
        String directives) {
}
