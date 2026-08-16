# smith-agent — the image the docker runtime dispatches agents into.
#
# Built FROM the existing smith-agent:latest deliberately: that image already
# carries /entrypoint.sh, whose contract the DockerRuntime depends on (it wraps
# the command in a tmux session named "main", blocks on wait-for, and
# propagates the inner exit code). Rebuilding from scratch would mean
# reproducing that contract exactly; extending keeps it byte-identical.
#
# What the base image lacks: the agent CLIs are placeholder shims that print
# "ERROR: claude CLI is not installed in this image" and exit 1, so every
# docker task failed before the agent ever started.
FROM smith-agent:latest

# The real CLI, replacing the stub at /usr/local/bin/claude.
# The stub must go FIRST: npm refuses to overwrite it and fails the build with
# "EEXIST: file already exists /usr/local/bin/claude".
RUN rm -f /usr/local/bin/claude \
 && npm install -g @anthropic-ai/claude-code \
 && claude --version

# gh is NOT installed on purpose: the container only commits to its task
# branch. Pushing and opening the PR happen on the host, in the dispatcher,
# after the container exits — the agent is deliberately not given push rights.

# Run as a non-root user. The CLI refuses `--dangerously-skip-permissions`
# under root ("cannot be used with root/sudo privileges for security
# reasons") — which the dispatcher always passes — so a root container fails
# every task in under a second, before any auth is even attempted.
#
# uid 501 matches the macOS host user, so files the agent writes into the
# bind-mounted worktree carry the host owner rather than root-owned artefacts
# the host then cannot clean up.
RUN useradd -m -u 501 -s /bin/bash agent 2>/dev/null || true

# The container holds its OWN subscription credential, obtained by logging in
# once from inside a container (`claude auth login`) and persisted in a named
# volume mounted here. On Linux the CLI stores credentials as a FILE under
# $HOME/.claude, unlike macOS where they live in the Keychain — which is what
# makes this possible at all, and why the Keychain itself can never be mounted
# across the boundary.
#
# This directory must exist in the IMAGE, owned by agent, before any volume is
# mounted over it: Docker seeds a fresh named volume from the image's contents
# and ownership at that path. Without this line the volume is created
# root-owned, and uid 501 cannot write its credential — login fails on a
# permission error that looks nothing like an auth problem.
RUN mkdir -p /home/agent/.claude && chown -R agent:agent /home/agent/.claude

USER agent
ENV HOME=/home/agent
