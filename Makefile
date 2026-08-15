# smithagents — developer tasks
#
# `make reset` returns this checkout to a genuine first-run state: no user, no
# agents, no workspaces, no boards, no documents. Everything is backed up first
# and the backup is verified before anything is deleted.

SHELL := /bin/bash
.DEFAULT_GOAL := help

STATE_DIRS := swarm/.smith broker/.smith
STAMP      := $(shell date +%Y-%m-%d-%H%M%S)
BACKUP_DIR ?= $(HOME)/smith-reset-backup-$(STAMP)

.PHONY: help reset reset-restore-voice services-stop

help: ## Show available targets
	@grep -hE '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) \
	  | awk -F':.*?## ' '{printf "  \033[1m%-22s\033[0m %s\n", $$1, $$2}'

services-stop: ## Stop the swarm and broker tmux sessions if they are running
	@for s in smith-swarm smith-broker; do \
	  if tmux has-session -t $$s 2>/dev/null; then \
	    tmux kill-session -t $$s && echo "  stopped $$s"; \
	  else echo "  $$s not running"; fi; \
	done

reset: ## Wipe local state to a first-run install (backs up first, verified)
	@echo "==> This deletes ALL local state: agents, workspaces, boards,"
	@echo "    documents, and your voice credentials (deepgram + elevenlabs)."
	@echo "    A verified backup is written to:"
	@echo "      $(BACKUP_DIR)"
	@read -p "    Type 'reset' to continue: " a; [ "$$a" = "reset" ] || { echo "  aborted"; exit 1; }
	@$(MAKE) --no-print-directory services-stop
	@sleep 1

	@echo "==> Backing up"
	@mkdir -p "$(BACKUP_DIR)"
	@for d in $(STATE_DIRS); do \
	  if [ -d "$$d" ]; then \
	    cp -R "$$d" "$(BACKUP_DIR)/$$(echo $$d | tr '/' '-')" && echo "  $$d"; \
	  fi; \
	done

	@echo "==> Verifying the backup before deleting anything"
	@fail=0; \
	for d in $(STATE_DIRS); do \
	  [ -d "$$d" ] || continue; \
	  b="$(BACKUP_DIR)/$$(echo $$d | tr '/' '-')"; \
	  live=$$(find "$$d" -type f | wc -l | tr -d ' '); \
	  copy=$$(find "$$b" -type f | wc -l | tr -d ' '); \
	  if [ "$$live" = "$$copy" ]; then echo "  $$d  $$live files  OK"; \
	  else echo "  $$d  live=$$live backup=$$copy  MISMATCH"; fail=1; fi; \
	done; \
	if [ "$$fail" = "1" ]; then echo "  refusing to delete — backup is incomplete"; exit 1; fi

	@echo "==> Removing local state"
	@rm -rf $(STATE_DIRS)

	@# broker/.smith/identity.json is TRACKED — it is the "fresh install ships
	@# Anderson only" seed. Deleting it is a working-tree deletion, not state.
	@echo "==> Restoring tracked seed files"
	@for f in $$(git ls-files $(STATE_DIRS)); do \
	  git checkout HEAD -- "$$f" && echo "  $$f"; \
	done

	@echo "==> Pruning stale git worktrees"
	@git worktree prune
	@echo "  worktrees now: $$(git worktree list | wc -l | tr -d ' ')"

	@echo
	@echo "Reset complete. This checkout is now a first-run install."
	@echo "  backup       $(BACKUP_DIR)"
	@echo "  voice        DEAD until you re-paste deepgram + elevenlabs keys,"
	@echo "               or run: make reset-restore-voice BACKUP=$(BACKUP_DIR)"
	@echo "  next         start the services, then open the app"

reset-restore-voice: ## Restore only the voice credentials from a backup (BACKUP=path)
	@[ -n "$(BACKUP)" ] || { echo "  usage: make reset-restore-voice BACKUP=<dir>"; exit 1; }
	@[ -d "$(BACKUP)/swarm-.smith/users" ] || { echo "  no users/ in $(BACKUP)"; exit 1; }
	@mkdir -p swarm/.smith
	@cp -R "$(BACKUP)/swarm-.smith/users" swarm/.smith/users
	@echo "  restored swarm/.smith/users — voice keys are back, everything else stays reset"
