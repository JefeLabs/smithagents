package com.jefelabs.smithagents.sandbox;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.nio.file.Path;
import java.util.List;

/**
 * A {@code git worktree} per branch (PRD §4): filesystem-isolated parallel branches
 * that share the host toolchain — the lightweight "multiplex" with no containers.
 * {@code close()} removes the worktree.
 */
@Component
public class WorktreeSandbox implements Sandbox {

    private static final Logger log = LoggerFactory.getLogger(WorktreeSandbox.class);

    private final Path repoRoot;
    private final Path baseDir;

    public WorktreeSandbox(
            @Value("${smithagents.sandbox.repo-root:.}") String repoRoot,
            @Value("${smithagents.sandbox.worktrees-dir:.sandboxes}") String worktreesDir) {
        this.repoRoot = Path.of(repoRoot).toAbsolutePath().normalize();
        this.baseDir = this.repoRoot.resolve(worktreesDir);
    }

    @Override
    public Kind kind() {
        return Kind.WORKTREE;
    }

    @Override
    public Session open(String branch) {
        Path dir = baseDir.resolve(safe(branch));
        log.info("Opening WORKTREE sandbox for '{}' at {}.", branch, dir);
        ProcessRunner.run(repoRoot, List.of("git", "worktree", "add", "--force", dir.toString(), branch));
        return new Session() {
            @Override public String branch() { return branch; }

            @Override public Path workspace() { return dir; }

            @Override public ExecResult exec(List<String> command) {
                return ProcessRunner.run(dir, command);
            }

            @Override public void close() {
                log.info("Annihilating WORKTREE sandbox for '{}'.", branch);
                ProcessRunner.run(repoRoot, List.of("git", "worktree", "remove", "--force", dir.toString()));
            }
        };
    }

    static String safe(String branch) {
        return branch.replaceAll("[^A-Za-z0-9._-]", "-");
    }
}
