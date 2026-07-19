package com.jefelabs.smithagents.sandbox;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * Chooses a {@link Sandbox.Kind} for an execution mode (PRD §4) — <b>policy, not
 * hardcoding</b>. Defaults: interactive → in-process (fast, trusted), autonomous →
 * docker (isolated, safe). Both overridable via {@code smithagents.sandbox.*-kind}.
 */
@Component
public class SandboxPolicy {

    /** How the work is being driven. */
    public enum ExecutionMode { INTERACTIVE, AUTONOMOUS }

    private final Sandbox.Kind interactiveKind;
    private final Sandbox.Kind autonomousKind;

    public SandboxPolicy(
            @Value("${smithagents.sandbox.interactive-kind:IN_PROCESS}") Sandbox.Kind interactiveKind,
            @Value("${smithagents.sandbox.autonomous-kind:DOCKER}") Sandbox.Kind autonomousKind) {
        this.interactiveKind = interactiveKind;
        this.autonomousKind = autonomousKind;
    }

    public Sandbox.Kind kindFor(ExecutionMode mode) {
        return mode == ExecutionMode.AUTONOMOUS ? autonomousKind : interactiveKind;
    }
}
