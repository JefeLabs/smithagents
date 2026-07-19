package com.jefelabs.smithagents.persona;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.Resource;
import org.springframework.core.io.support.PathMatchingResourcePatternResolver;
import org.springframework.stereotype.Component;
import org.yaml.snakeyaml.Yaml;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Collection;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;

/**
 * Loads the persona roster from classpath resources (default
 * {@code classpath*:prompts/*.md}) so the swarm is data-driven and this module is
 * self-contained: drop a Markdown file under {@code src/main/resources/prompts/}
 * and it becomes a persona — no code change (PRD §6).
 *
 * <p>Each file may carry optional YAML front-matter
 * ({@code name} / {@code role} / {@code keywords}) delimited by {@code ---},
 * followed by the Markdown directives body (the persona's behavioral contract).
 */
@Component
public class PersonaRegistry {

    private static final Logger log = LoggerFactory.getLogger(PersonaRegistry.class);

    private final Map<String, Persona> personas = new LinkedHashMap<>();
    private final String locationPattern;
    private final PathMatchingResourcePatternResolver resolver =
            new PathMatchingResourcePatternResolver();

    public PersonaRegistry(
            @Value("${smithagents.personas.location:classpath*:prompts/*.md}") String locationPattern) {
        this.locationPattern = locationPattern;
        reload();
    }

    /** (Re)load every persona resource except {@code README.md}. */
    public synchronized void reload() {
        personas.clear();
        Resource[] resources;
        try {
            resources = resolver.getResources(locationPattern);
        } catch (IOException e) {
            throw new UncheckedIOException("Failed to resolve personas at " + locationPattern, e);
        }
        Arrays.stream(resources)
              .filter(r -> {
                  String fn = r.getFilename();
                  return fn != null && !fn.equalsIgnoreCase("README.md");
              })
              .sorted(Comparator.comparing(r -> Objects.toString(r.getFilename(), "")))
              .forEach(this::load);

        if (personas.isEmpty()) {
            log.warn("No personas found at {} — roster is empty.", locationPattern);
        } else {
            log.info("Loaded {} personas from {}: {}", personas.size(), locationPattern, personas.keySet());
        }
    }

    private void load(Resource resource) {
        String filename = Objects.requireNonNull(resource.getFilename());
        String id = stripExtension(filename);
        String content;
        try (InputStream in = resource.getInputStream()) {
            content = new String(in.readAllBytes(), StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new UncheckedIOException("Failed to read persona " + filename, e);
        }

        Map<String, Object> meta = Map.of();
        String directives = content.trim();

        // Optional YAML front-matter: a leading `---` ... `---` block.
        if (content.startsWith("---")) {
            int end = content.indexOf("\n---", 3);
            if (end > 0) {
                String frontMatter = content.substring(3, end).trim();
                directives = content.substring(end + 4).trim();
                if (new Yaml().load(frontMatter) instanceof Map<?, ?> map) {
                    @SuppressWarnings("unchecked")
                    Map<String, Object> cast = (Map<String, Object>) map;
                    meta = cast;
                }
            }
        }

        personas.put(id, new Persona(
                id,
                str(meta.getOrDefault("name", id)),
                str(meta.getOrDefault("role", "")),
                keywords(meta.get("keywords")),
                directives));
    }

    /** All personas, in file-name order. */
    public Collection<Persona> all() {
        return Collections.unmodifiableCollection(personas.values());
    }

    public Optional<Persona> byId(String id) {
        return Optional.ofNullable(personas.get(id));
    }

    private static String stripExtension(String name) {
        int dot = name.lastIndexOf('.');
        return dot < 0 ? name : name.substring(0, dot);
    }

    private static String str(Object value) {
        return value == null ? "" : value.toString();
    }

    private static List<String> keywords(Object raw) {
        return raw instanceof List<?> list
                ? list.stream().map(Object::toString).toList()
                : List.of();
    }
}
