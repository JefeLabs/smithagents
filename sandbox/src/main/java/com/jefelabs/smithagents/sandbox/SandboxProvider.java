package com.jefelabs.smithagents.sandbox;

import org.springframework.stereotype.Component;

import java.util.EnumMap;
import java.util.List;
import java.util.Map;

/**
 * Resolves the right {@link Sandbox} backend by {@link Sandbox.Kind}, or by
 * {@link SandboxPolicy.ExecutionMode} via {@link SandboxPolicy} (PRD §4). Callers
 * ask for a sandbox by intent; this hands back the configured backend.
 */
@Component
public class SandboxProvider {

    private final Map<Sandbox.Kind, Sandbox> byKind = new EnumMap<>(Sandbox.Kind.class);
    private final SandboxPolicy policy;

    public SandboxProvider(List<Sandbox> backends, SandboxPolicy policy) {
        backends.forEach(backend -> byKind.put(backend.kind(), backend));
        this.policy = policy;
    }

    public Sandbox forKind(Sandbox.Kind kind) {
        Sandbox sandbox = byKind.get(kind);
        if (sandbox == null) {
            throw new IllegalStateException("No sandbox backend registered for kind " + kind);
        }
        return sandbox;
    }

    public Sandbox forMode(SandboxPolicy.ExecutionMode mode) {
        return forKind(policy.kindFor(mode));
    }
}
