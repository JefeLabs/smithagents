package com.jefelabs.smithagents.gateway;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * The Spring Boot entry point and "central nervous system" of the swarm (PRD §3).
 *
 * <p>Responsibilities this app grows into (each a later slice):
 * <ul>
 *   <li><b>Discord (JDA):</b> stream raw PCM audio + route transcriptions.</li>
 *   <li><b>WebSocket server:</b> synchronize the Tauri thin clients (desktop + iOS).</li>
 *   <li><b>_embabel routing engine:</b> {@code PersonaRouter} (in the {@code personas}
 *       module) chooses a persona per message, iterating a data-driven
 *       {@code PersonaRegistry} — never a hardcoded roster.</li>
 *   <li><b>mTLS validation:</b> reject clients lacking a valid device certificate.</li>
 * </ul>
 *
 * <p>{@code scanBasePackages} spans the whole {@code com.jefelabs.smithagents}
 * tree so the gateway discovers the persona beans that live in the sibling
 * {@code personas} module.
 */
@SpringBootApplication(scanBasePackages = "com.jefelabs.smithagents")
public class GatewayApplication {

    public static void main(String[] args) {
        SpringApplication.run(GatewayApplication.class, args);
    }
}
