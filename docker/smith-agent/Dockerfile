# smith-agent — the image the docker runtime dispatches agents into
# (DockerRuntime in swarm/src/runtime.ts; default image smith-agent:latest).
#
# Build it with `make agent-image`: that builds a candidate, runs the contract
# tests in swarm/src/runtime.docker.test.ts against it, and only then tags it
# smith-agent:latest.
#
# Everything starts from a pinned public image, so a Docker cleanup can never
# strand the recipe — `docker image prune` costs a rebuild, nothing more.
#
#   base  — the runtime contract: Node, tmux, git, and /entrypoint.sh
#   agent — the agent CLI, and the non-root user it must run as

# ── base ─────────────────────────────────────────────────────────────────────
FROM node:24.22.1-trixie-slim AS base

# tmux  — /entrypoint.sh runs every command in tmux session "main"
# git   — agents commit on their task branch inside the container
# tini  — PID 1: forwards `docker stop` signals and reaps the tmux server
# curl, jq, procps — everyday tools agents reach for
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git jq procps tini tmux \
 && rm -rf /var/lib/apt/lists/*

# Agents commit as the crew identity the dispatcher's own auto-commit uses.
# With no identity at all, `git commit` fails "Please tell me who you are", and
# an agent's natural fix — `git config user.email …` — writes into the parent
# .git/config, which is the HOST repo's config, mounted read-write.
RUN git config --system user.name "smith agent" \
 && git config --system user.email crew@smithagents.local

# The dispatcher copies smith-delegate into <worktree>/bin and prepends that
# directory's HOST path to PATH — which does not exist in here. The worktree is
# always mounted at /workspace.
ENV PATH="/workspace/bin:${PATH}"

COPY --chmod=0755 entrypoint.sh /entrypoint.sh
WORKDIR /workspace
ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]

# ── agent ────────────────────────────────────────────────────────────────────
FROM base AS agent

# Pinned so a rebuild is reproducible; bump it like any other dependency.
ARG CLAUDE_CODE_VERSION=2.1.309
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && npm cache clean --force \
 && claude --version

# The CLI cannot update itself in here (its install is root-owned and the agent
# is not root), and a pinned image should not drift at runtime anyway.
ENV DISABLE_AUTOUPDATER=1

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
RUN useradd -m -u 501 -s /bin/bash agent

# The agent's subscription credential is mounted here: exported from the host
# Keychain by scripts/export-claude-credential.sh and bind-mounted read-write by
# credentialMount() in swarm/src/runtime.ts. On Linux the CLI stores
# credentials as a FILE under $HOME/.claude, unlike macOS where they live in the
# Keychain — which is what makes this possible at all, and why the Keychain
# itself can never be mounted across the boundary.
#
# This directory must exist in the IMAGE, owned by agent, for the other route —
# a named volume logged in once from inside a container (`claude auth login`):
# Docker seeds a fresh named volume from the image's contents
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
