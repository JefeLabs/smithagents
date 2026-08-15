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

# Auth crosses into Linux via a long-lived token (`claude setup-token` on the
# host), passed per-run with `-e CLAUDE_CODE_OAUTH_TOKEN=…` rather than baked
# in. macOS Keychain credentials cannot be mounted into a Linux container,
# which is the whole reason the token path exists.
