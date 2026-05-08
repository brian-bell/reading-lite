SHELL := /bin/bash

ENV ?= dev
VARS_FILE := .$(ENV).vars
VALID_ENVS := dev prd

ifneq ($(ENV),$(filter $(ENV),$(VALID_ENVS)))
$(error ENV must be one of: $(VALID_ENVS))
endif

# Mutating scripts are dry-run by default. Use EXECUTE=1 to POST/deploy.
EXECUTE ?= 0
DRY_RUN ?= 0
FORCE ?= 0
INCLUDE_NON_RETRYABLE ?= 0
POLL ?= 0
FAIL_FAST ?= 0
SKIP_BUILD ?= 0

BASE ?=
OUT ?=
READING_ID ?=
FAILED_INPUT ?= .failed-attempts

truthy = $(filter 1 true TRUE yes YES y Y on ON,$(strip $(1)))

EXECUTE_FLAG := $(if $(call truthy,$(EXECUTE)),--execute,)
DRY_RUN_FLAG := $(if $(call truthy,$(DRY_RUN)),--dry-run,)
FORCE_FLAG := $(if $(call truthy,$(FORCE)),--force,)
INCLUDE_NON_RETRYABLE_FLAG := $(if $(call truthy,$(INCLUDE_NON_RETRYABLE)),--include-non-retryable,)
POLL_FLAG := $(if $(call truthy,$(POLL)),--poll,)
FAIL_FAST_FLAG := $(if $(call truthy,$(FAIL_FAST)),--fail-fast,)
SKIP_BUILD_FLAG := $(if $(call truthy,$(SKIP_BUILD)),--skip-build,)
BASE_FLAG := $(if $(strip $(BASE)),--base $(BASE),)
OUT_FLAG := $(if $(strip $(OUT)),--out $(OUT),)
READING_FLAG := $(if $(strip $(READING_ID)),--reading $(READING_ID),)

RUN_WITH_VARS := npx tsx scripts/run-with-vars.ts --vars $(VARS_FILE) --
GATHER_FLAGS := $(BASE_FLAG) $(OUT_FLAG) $(DRY_RUN_FLAG)
REPROCESS_FLAGS := $(EXECUTE_FLAG) $(FORCE_FLAG) $(INCLUDE_NON_RETRYABLE_FLAG) $(POLL_FLAG) $(FAIL_FAST_FLAG) $(BASE_FLAG)
DEPLOY_FLAGS := $(EXECUTE_FLAG)
DEPLOY_WEB_FLAGS := $(EXECUTE_FLAG) $(SKIP_BUILD_FLAG)

.PHONY: help gather-failed retry-failed retry-all-failed deploy-worker deploy-web

help:
	@printf '%s\n' \
		'Usage:' \
		'  make gather-failed [ENV=dev|prd] [BASE=url] [OUT=dir] [DRY_RUN=1]' \
		'  make retry-failed READING_ID=id [ENV=dev|prd] [FAILED_INPUT=dir-or-file] [EXECUTE=1] [FORCE=1] [INCLUDE_NON_RETRYABLE=1] [POLL=1]' \
		'  make retry-all-failed [ENV=dev|prd] [FAILED_INPUT=dir] [EXECUTE=1] [FORCE=1] [INCLUDE_NON_RETRYABLE=1] [POLL=1] [FAIL_FAST=1]' \
		'  make deploy-worker ENV=prd EXECUTE=1' \
		'  make deploy-web ENV=prd EXECUTE=1 [SKIP_BUILD=1]' \
		'' \
		'Defaults:' \
		'  ENV=dev loads .dev.vars; ENV=prd loads .prd.vars.' \
		'  FAILED_INPUT defaults to .failed-attempts (cleared by each gather-failed run).' \
		'  EXECUTE=0 keeps retry/deploy commands in dry-run mode.'

gather-failed:
	@$(RUN_WITH_VARS) npm run gather:failed -- $(GATHER_FLAGS)

retry-failed:
	@test -n "$(READING_ID)" || { echo "READING_ID is required. Example: make retry-failed READING_ID=rd_abc EXECUTE=1" >&2; exit 2; }
	@test -n "$(FAILED_INPUT)" || { echo "FAILED_INPUT is required, or gather failures first with make gather-failed." >&2; exit 2; }
	@$(RUN_WITH_VARS) npm run reprocess:failed -- --input "$(FAILED_INPUT)" $(READING_FLAG) $(REPROCESS_FLAGS)

retry-all-failed:
	@test -n "$(FAILED_INPUT)" || { echo "FAILED_INPUT is required, or gather failures first with make gather-failed." >&2; exit 2; }
	@$(RUN_WITH_VARS) npm run reprocess:failed -- --input "$(FAILED_INPUT)" --all $(REPROCESS_FLAGS)

deploy-worker:
	@if [ -n "$(call truthy,$(EXECUTE))" ] && [ "$(ENV)" != "prd" ]; then \
		echo "Refusing production deploy with ENV=$(ENV). Use ENV=prd EXECUTE=1." >&2; \
		exit 2; \
	fi
	@$(RUN_WITH_VARS) npm run deploy -- $(DEPLOY_FLAGS)

deploy-web:
	@if [ -n "$(call truthy,$(EXECUTE))" ] && [ "$(ENV)" != "prd" ]; then \
		echo "Refusing production deploy with ENV=$(ENV). Use ENV=prd EXECUTE=1." >&2; \
		exit 2; \
	fi
	@$(RUN_WITH_VARS) npm run deploy:web -- $(DEPLOY_WEB_FLAGS)
