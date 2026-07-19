# Golden sandbox image (PRD §4) — the pinned toolchain for ephemeral per-branch
# sandboxes. Built ONCE and reused by every DOCKER-tier sandbox: branch code is
# bind-mounted at /workspace, the tools stay baked here. Rebuild on a cadence, not
# per branch.
FROM mcr.microsoft.com/devcontainers/base:ubuntu-24.04

# Docker sets TARGETARCH (arm64 on Apple silicon, amd64 on x86) during buildx.
ARG TARGETARCH
ARG KUBECTL_VERSION=v1.31.0

# --- system tools ---
RUN apt-get update && apt-get install -y --no-install-recommends \
      git tmux jq ca-certificates curl gnupg \
    && rm -rf /var/lib/apt/lists/*

# --- GitHub CLI ---
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=${TARGETARCH} signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# --- Node + JS toolchain (pinned) ---
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g \
      typescript@5.6.0 \
      @biomejs/biome@2.0.0 \
      @anthropic-ai/claude-code
# TODO: pin @anthropic-ai/claude-code to a known-good version.

# --- kubectl (pinned) ---
RUN curl -fsSLO "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl" \
    && install -m 0755 kubectl /usr/local/bin/kubectl \
    && rm kubectl

WORKDIR /workspace
# The gateway keeps the container alive and drives it via `docker exec`.
CMD ["sleep", "infinity"]
