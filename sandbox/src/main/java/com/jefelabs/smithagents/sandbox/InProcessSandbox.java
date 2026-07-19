package com.jefelabs.smithagents.sandbox;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.nio.file.Path;
import java.util.List;

/**
 * Runs tasks directly on the host (PRD §4). Fastest, zero overhead, <b>no
 * isolation</b> — assumes a trusted operator whose working tree is already on the
 * target branch. {@code close()} is a no-op: there is nothing to annihilate.
 */
@Component
public class InProcessSandbox implements Sandbox {

    private static final Logger log = LoggerFactory.getLogger(InProcessSandbox.class);

    private final Path repoRoot;

    public InProcessSandbox(@Value("${smithagents.sandbox.repo-root:.}") String repoRoot) {
        this.repoRoot = Path.of(repoRoot).toAbsolutePath().normalize();
    }

    @Override
    public Kind kind() {
        return Kind.IN_PROCESS;
    }

    @Override
    public Session open(String branch) {
        log.info("Opening IN_PROCESS sandbox for '{}' at {} (no isolation).", branch, repoRoot);
        return new Session() {
            @Override public String branch() { return branch; }

            @Override public Path workspace() { return repoRoot; }

            @Override public ExecResult exec(List<String> command) {
                return ProcessRunner.run(repoRoot, command);
            }

            @Override public void close() {
                log.info("Closing IN_PROCESS sandbox for '{}' (no-op).", branch);
            }
        };
    }
}
