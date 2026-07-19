package com.jefelabs.smithagents.sandbox;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/**
 * A container from the golden image ({@code infra/sandbox.Dockerfile}) with the
 * branch's worktree bind-mounted at {@code /workspace} (PRD §4). Full isolation,
 * reproducible, disposable — the safe default when agents run unattended. Requires
 * Docker running and the golden image built.
 *
 * <p>Composes {@link WorktreeSandbox}: the branch is checked out as a worktree on
 * the host (isolated code), then mounted into the container (isolated toolchain).
 */
@Component
public class DockerSandbox implements Sandbox {

    private static final Logger log = LoggerFactory.getLogger(DockerSandbox.class);

    private final WorktreeSandbox worktrees;
    private final String image;
    private final Path repoRoot;

    public DockerSandbox(
            WorktreeSandbox worktrees,
            @Value("${smithagents.sandbox.image:smithagents/sandbox:latest}") String image,
            @Value("${smithagents.sandbox.repo-root:.}") String repoRoot) {
        this.worktrees = worktrees;
        this.image = image;
        this.repoRoot = Path.of(repoRoot).toAbsolutePath().normalize();
    }

    @Override
    public Kind kind() {
        return Kind.DOCKER;
    }

    @Override
    public Session open(String branch) {
        Session worktree = worktrees.open(branch);
        String container = "sandbox-" + WorktreeSandbox.safe(branch);
        log.info("Opening DOCKER sandbox '{}' from {} (mount {}).", container, image, worktree.workspace());
        ProcessRunner.run(repoRoot, List.of(
                "docker", "run", "-d", "--rm",
                "--name", container,
                "-v", worktree.workspace() + ":/workspace",
                "-w", "/workspace",
                image, "sleep", "infinity"));
        return new Session() {
            @Override public String branch() { return branch; }

            @Override public Path workspace() { return worktree.workspace(); }

            @Override public ExecResult exec(List<String> command) {
                List<String> full = new ArrayList<>(List.of("docker", "exec", container));
                full.addAll(command);
                return ProcessRunner.run(repoRoot, full);
            }

            @Override public void close() {
                log.info("Annihilating DOCKER sandbox '{}'.", container);
                ProcessRunner.run(repoRoot, List.of("docker", "rm", "-f", container));
                worktree.close();
            }
        };
    }
}
