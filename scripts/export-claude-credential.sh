#!/usr/bin/env bash
# Export the host's Claude subscription into the file format a Linux container
# reads, so docker agents authenticate without an API key or `setup-token`.
#
# WHY THIS WORKS: the credential itself was never platform-specific — only its
# storage is. macOS keeps it in the Keychain (which no container can read);
# Linux keeps it in $HOME/.claude/.credentials.json. The Keychain blob already
# contains a `claudeAiOauth` object in exactly the shape the file wants, so
# copying that one object across is the whole job.
#
# WHAT IS DELIBERATELY LEFT BEHIND: the same blob also holds `mcpOAuth` —
# live Atlassian, Figma, and Stripe access tokens. An agent container has no
# use for them, so only `claudeAiOauth` is written out. Least privilege.
#
# The output directory is bind-mounted read-WRITE as the container's
# ~/.claude (see credentialMount() in swarm/src/runtime.ts): the access token
# expires within hours and the CLI rewrites it in place on refresh, so every
# container shares one self-renewing credential.
#
# FIRST RUN BLOCKS ON A DIALOG. macOS gates Keychain reads per-caller, so the
# first invocation from this script pops "…wants to use your confidential
# information" and waits indefinitely for a click — with no output and no
# timeout, which looks exactly like a hang. Click "Always Allow" once and every
# later run is non-interactive. There is no browser and no OAuth flow here.
set -euo pipefail

DEST_DIR="${SMITH_DOCKER_CLAUDE_DIR:-$HOME/.smith/docker-auth}"
mkdir -p "$DEST_DIR"
chmod 700 "$DEST_DIR"

security find-generic-password -s "Claude Code-credentials" -a "$USER" -w 2>/dev/null | python3 -c "
import json, os, sys, time

raw = sys.stdin.read().strip()
if not raw:
    sys.exit('No Claude credential in the Keychain. Run `claude auth login` on the host first.')

blob = json.loads(raw)
oauth = blob.get('claudeAiOauth')
if not oauth:
    sys.exit('Keychain entry has no claudeAiOauth object — is this a subscription login?')

dest = os.path.join(os.environ['DEST_DIR'], '.credentials.json')
fd = os.open(dest, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, 'w') as f:
    json.dump({'claudeAiOauth': oauth}, f)

dropped = [k for k in blob if k != 'claudeAiOauth']
exp = oauth.get('expiresAt', 0) / 1000
print(f'  wrote {dest} (0600)')
print(f'  subscription: {oauth.get(\"subscriptionType\", \"unknown\")}')
if dropped:
    print(f'  left on host: {\", \".join(dropped)}')
if exp:
    print('  token expires: ' + time.strftime('%Y-%m-%d %H:%M', time.localtime(exp)) +
          f' (refreshes in place; {(exp - time.time()) / 3600:.1f}h)')
"

echo "  docker agents will now authenticate as this subscription"
