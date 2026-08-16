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
#
# Base on the PRISTINE stub image, never on smith-agent:latest. The build's
# output is promoted to :latest, so `FROM smith-agent:latest` makes the second
# build start from the first build's output — which already ends with
# `USER agent`, so `npm install -g` runs unprivileged and the build dies at
# "rm -f /usr/local/bin/claude". Pinning the original base keeps rebuilds
# idempotent instead of working exactly once.
FROM smith-agent:stub-backup

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

# Mark first-run onboarding complete.
#
# This file is NOT in the mounted .claude directory — it sits beside it at
# $HOME/.claude.json, so it is per-container and cannot be persisted by the
# credential mount. Without it an interactive session opens on the theme
# picker, then a "select login method" prompt, and finally an OAuth URL
# waiting for a pasted code — none of which a send-keys driver can answer, and
# all of which are invisible to `--print`, which skips onboarding entirely.
#
# The mounted credential is already valid at that point (the CLI populates
# `oauthAccount` from it); onboarding simply runs ahead of the auth check. So
# the fix is to declare onboarding done, not to log in again.
# `projects./workspace.hasTrustDialogAccepted` clears the second gate: the
# "Is this a project you trust?" prompt, which is keyed by working directory.
# The container's working directory is always /workspace, so the answer is
# known at build time. The third gate — the Bypass Permissions warning, whose
# default option is "No, exit" — needs nothing here: the CLI records
# `skipDangerousModePermissionPrompt` in .claude/settings.json, which IS inside
# the mounted directory and therefore persists across containers on its own.
RUN printf '%s' '{"hasCompletedOnboarding":true,"theme":"dark","projects":{"/workspace":{"hasTrustDialogAccepted":true}}}' > /home/agent/.claude.json \
 && chown agent:agent /home/agent/.claude.json

USER agent
ENV HOME=/home/agent
