package com.jefelabs.smithagents.gateway;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;

/**
 * The Spring Boot entry point and "central nervous system" of the swarm (PRD §3).
 *
 * <p>Responsibilities this app grows into (each a later slice):
 * <ul>
 *   <li><b>Discord (JDA):</b> stream raw PCM audio + route transcriptions.</li>
 *   <li><b>WebSocket server:</b> synchronize the Tauri thin clients (desktop + iOS).</li>
 *   <li><b>Agent routing:</b> inbound messages route to an agent defined in the
 *       swarm orchestrator's registry (the {@code swarm/} module), which owns
 *       agent identity and dispatch — never a hardcoded roster.</li>
 *   <li><b>mTLS validation:</b> reject clients lacking a valid device certificate.</li>
 * </ul>
 *
 * <p>{@code scanBasePackages} spans the whole {@code com.jefelabs.smithagents}
 * tree so the gateway discovers component beans across sibling modules (e.g.
 * {@code sandbox}).
 */
@SpringBootApplication(scanBasePackages = "com.jefelabs.smithagents")
@ConfigurationPropertiesScan
public class GatewayApplication {

    public static void main(String[] args) {
        SpringApplication.run(GatewayApplication.class, args);
    }
}
