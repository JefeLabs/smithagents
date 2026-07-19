package com.jefelabs.smithagents.sandbox;

import java.nio.file.Path;
import java.util.List;

/**
 * A pluggable execution environment for a feature branch (PRD §4).
 *
 * <p>One contract, three backends ({@link Kind}), chosen by {@link SandboxPolicy}
 * rather than hardcoded — the swarm codes against this interface and never cares
 * which isolation tier actually runs the work.
 */
public interface Sandbox {

    /** Isolation tiers, weakest → strongest. */
    enum Kind { IN_PROCESS, WORKTREE, DOCKER }

    /** The outcome of running a command inside a {@link Session}. */
    record ExecResult(int exitCode, String stdout, String stderr) {
        public boolean ok() {
            return exitCode == 0;
        }
    }

    /**
     * A live environment for one branch. {@link #close()} annihilates it — the
     * "destroyed the moment the PR merges" contract from PRD §4.
     */
    interface Session extends AutoCloseable {
        String branch();

        Path workspace();

        ExecResult exec(List<String> command);

        default ExecResult exec(String... command) {
            return exec(List.of(command));
        }

        @Override
        void close();
    }

    Kind kind();

    /** Provision an environment for {@code branch}. */
    Session open(String branch);
}
