#!/usr/bin/env bash
# /entrypoint.sh — the contract DockerRuntime (swarm/src/runtime.ts) relies on.
#
#   1. The command runs in a tmux session named "main", so sendText/sendKeys can
#      type into it with `docker exec <container> tmux …` — the path every warm
#      (interactive) session uses.
#   2. Everything the session prints is mirrored to the container's stdout, so
#      `docker logs` (captureOutput) is the session's output, not an empty log.
#   3. The container exits with the command's exit code (`docker wait` →
#      waitFor). If session "main" is killed instead, the container stops with 1.
#
# The command arrives as argv and is handed on as argv — nothing re-parses it
# through a shell — so DockerRuntime passes `/bin/bash -c <command>`. A single
# pre-joined argument would be run as a literal filename (exit 127).
set -uo pipefail

readonly exit_file=/tmp/smith-main.exit
readonly mirror=/tmp/smith-main.out

# Inside the pane: wait until the mirror is attached so no early output is lost,
# run the command, record its exit code, and wake the entrypoint.
if [[ ${SMITH_MAIN_PANE-} == 1 ]]; then
  unset SMITH_MAIN_PANE
  tmux wait-for main-ready
  "$@"
  echo "$?" >"$exit_file"
  tmux wait-for -S main-done
  exit 0
fi

# `docker run -it smith-agent:latest` with no command: a shell for poking around.
if [[ $# -eq 0 ]]; then
  exec bash
fi

rm -f "$exit_file" "$mirror"
mkfifo "$mirror"

# The mirror's reader inherits the container's stdout. It blocks until pipe-pane
# opens the FIFO and ends at EOF, when the pane closes.
cat "$mirror" &
reader=$!

if ! tmux new-session -d -s main -e SMITH_MAIN_PANE=1 -- /entrypoint.sh "$@"; then
  echo "[smith-agent] tmux could not start session main" >&2
  kill "$reader" 2>/dev/null
  exit 1
fi

if ! tmux pipe-pane -t main -o "cat > $mirror"; then
  echo "[smith-agent] session output will not reach docker logs" >&2
  kill "$reader" 2>/dev/null
fi
tmux wait-for -S main-ready

# Returns when the command finishes. If session main is killed, the tmux server
# exits with it and this returns at once — with no exit file written.
tmux wait-for main-done

# The pane closes right after main-done; let the mirror drain to EOF so the
# command's last lines reach docker logs before the container stops.
for _ in {1..50}; do
  kill -0 "$reader" 2>/dev/null || break
  sleep 0.1
done

code=1
if [[ -s $exit_file ]]; then
  code=$(<"$exit_file")
else
  echo "[smith-agent] session main ended without reporting an exit code" >&2
fi
[[ $code =~ ^[0-9]+$ ]] || code=1
exit "$code"
