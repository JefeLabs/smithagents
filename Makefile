# smithagents — developer tasks
#
# `make reset` returns this machine to a genuine first-run state. It is
# deliberately thorough: local state, the at-rest encryption key, leftover task
# branches, abandoned agent tmux sessions, and app settings written into .env.
# Everything is backed up first and the backup is verified before any delete.

SHELL := /bin/bash
.DEFAULT_GOAL := help

STATE_DIRS  := swarm/.smith broker/.smith
MASTER_KEY  := $(HOME)/.smith/master.key
STAMP       := $(shell date +%Y-%m-%d-%H%M%S)
BACKUP_DIR  ?= $(HOME)/smith-reset-backup-$(STAMP)
# App settings the product writes into .env — cleared by a reset. Credentials
# (ANTHROPIC_API_KEY, GEMINI_API_KEY, DEEPGRAM_*, ELEVENLABS_*, LIVEKIT_*) are
# never touched: a first-run user supplies those, a reset does not steal them.
ENV_SETTINGS := SMITH_BRAIN_PROVIDER SMITH_BRAIN_MODEL

.PHONY: help reset reset-restore-voice services-stop agents-stop

help: ## Show available targets
	@grep -hE '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) \
	  | awk -F':.*?## ' '{printf "  \033[1m%-22s\033[0m %s\n", $$1, $$2}'

services-stop: ## Stop the swarm and broker tmux sessions
	@for s in smith-swarm smith-broker; do \
	  if tmux has-session -t $$s 2>/dev/null; then \
	    tmux kill-session -t $$s && echo "  stopped $$s"; \
	  else echo "  $$s not running"; fi; \
	done

agents-stop: ## Kill leftover agent tmux sessions (smith-warm-*, task-*) — never services
	@n=$$(tmux ls 2>/dev/null | grep -cE '^(smith-warm-|task-)' || true); \
	if [ "$$n" = "0" ]; then echo "  no agent sessions"; else \
	  tmux ls 2>/dev/null | grep -E '^(smith-warm-|task-)' | cut -d: -f1 \
	    | while read s; do tmux kill-session -t "$$s" 2>/dev/null || true; done; \
	  echo "  killed $$n agent session(s)"; fi

reset: ## TRUE first-run wipe: state, master key, task branches, agent sessions, app env settings
	@echo "==> True reset. This deletes:"
	@echo "      swarm/.smith and broker/.smith   (agents, workspaces, boards, documents)"
	@echo "      $(MASTER_KEY)"
	@echo "        the at-rest encryption key — any secret still encrypted with it"
	@echo "        becomes unreadable. It regenerates on next use."
	@echo "      smith/* task branches, and abandoned agent tmux sessions"
	@echo "      $(ENV_SETTINGS) from .env  (credentials are NOT touched)"
	@echo "    Verified backup goes to: $(BACKUP_DIR)"
	@read -p "    Type 'reset' to continue: " a; [ "$$a" = "reset" ] || { echo "  aborted"; exit 1; }

	@$(MAKE) --no-print-directory services-stop
	@$(MAKE) --no-print-directory agents-stop
	@sleep 1

	@echo "==> Backing up"
	@mkdir -p "$(BACKUP_DIR)"
	@for d in $(STATE_DIRS); do \
	  if [ -d "$$d" ]; then cp -R "$$d" "$(BACKUP_DIR)/$$(echo $$d | tr '/' '-')" && echo "  $$d"; fi; \
	done
	@if [ -f "$(MASTER_KEY)" ]; then cp "$(MASTER_KEY)" "$(BACKUP_DIR)/master.key" && echo "  $(MASTER_KEY)"; fi
	@if [ -f .env ]; then cp .env "$(BACKUP_DIR)/env.bak" && echo "  .env"; fi

	@echo "==> Verifying the backup before deleting anything"
	@fail=0; \
	for d in $(STATE_DIRS); do \
	  [ -d "$$d" ] || continue; \
	  b="$(BACKUP_DIR)/$$(echo $$d | tr '/' '-')"; \
	  live=$$(find "$$d" -type f | wc -l | tr -d ' '); copy=$$(find "$$b" -type f | wc -l | tr -d ' '); \
	  if [ "$$live" = "$$copy" ]; then echo "  $$d  $$live files  OK"; \
	  else echo "  $$d  live=$$live backup=$$copy  MISMATCH"; fail=1; fi; \
	done; \
	if [ -f "$(MASTER_KEY)" ] && ! cmp -s "$(MASTER_KEY)" "$(BACKUP_DIR)/master.key"; then \
	  echo "  master.key  MISMATCH"; fail=1; fi; \
	if [ "$$fail" = "1" ]; then echo "  refusing to delete — backup is incomplete"; exit 1; fi

	@echo "==> Removing local state"
	@rm -rf $(STATE_DIRS)
	@rm -f "$(MASTER_KEY)"

	@# broker/.smith/identity.json is TRACKED — the "fresh install ships Anderson
	@# only" seed. Driven by git ls-files so new seeds are picked up automatically.
	@echo "==> Restoring tracked seed files"
	@for f in $$(git ls-files $(STATE_DIRS)); do git checkout HEAD -- "$$f" && echo "  $$f"; done

	@echo "==> Removing leftover task branches"
	@n=$$(git branch --list 'smith/*' | wc -l | tr -d ' '); \
	if [ "$$n" = "0" ]; then echo "  none"; else \
	  git branch --list 'smith/*' | tr -d ' ' | xargs -r git branch -D >/dev/null && echo "  deleted $$n branch(es)"; fi

	@echo "==> Pruning stale git worktrees"
	@git worktree prune
	@echo "  worktrees now: $$(git worktree list | wc -l | tr -d ' ')"

	@echo "==> Clearing app settings from .env (credentials untouched)"
	@if [ -f .env ]; then \
	  for k in $(ENV_SETTINGS); do \
	    if grep -q "^$$k=" .env; then \
	      sed -i '' "/^$$k=/d" .env && echo "  removed $$k"; \
	    fi; \
	  done; \
	  sed -i '' -e '/^# Brain provider: gemini keeps Anderson talking/d' \
	            -e '/^# Remove this line (or set to anthropic)/d' .env 2>/dev/null || true; \
	else echo "  no .env"; fi

	@echo
	@echo "True reset complete."
	@echo "  backup   $(BACKUP_DIR)  (includes master.key and env.bak)"
	@echo "  voice    dead until you paste deepgram + elevenlabs into Settings"
	@echo "  browser  clear the 'smith.sound' localStorage key for a spotless first run"
	@echo "  next     start the services, then open the app"

reset-restore-voice: ## Restore only the voice credentials from a backup (BACKUP=path)
	@[ -n "$(BACKUP)" ] || { echo "  usage: make reset-restore-voice BACKUP=<dir>"; exit 1; }
	@[ -d "$(BACKUP)/swarm-.smith/users" ] || { echo "  no users/ in $(BACKUP)"; exit 1; }
	@# Secrets are encrypted with the master key that was live when they were
	@# written, so the key must come back with them or they cannot be decrypted.
	@if [ -f "$(BACKUP)/master.key" ]; then \
	  mkdir -p "$(HOME)/.smith" && cp "$(BACKUP)/master.key" "$(MASTER_KEY)" && chmod 600 "$(MASTER_KEY)"; \
	  echo "  restored master.key (required to decrypt those secrets)"; \
	fi
	@mkdir -p swarm/.smith && cp -R "$(BACKUP)/swarm-.smith/users" swarm/.smith/users
	@echo "  restored swarm/.smith/users — voice keys are back, everything else stays reset"
