SHELL := /bin/bash

ENV ?= dev
VARS_FILE := .$(ENV).vars
VALID_ENVS := dev prd

ifneq ($(ENV),$(filter $(ENV),$(VALID_ENVS)))
$(error ENV must be one of: $(VALID_ENVS))
endif

# Mutating scripts are dry-run by default. Use EXECUTE=1 to deploy.
EXECUTE ?= 0
SKIP_BUILD ?= 0

truthy = $(filter 1 true TRUE yes YES y Y on ON,$(strip $(1)))

EXECUTE_FLAG := $(if $(call truthy,$(EXECUTE)),--execute,)
SKIP_BUILD_FLAG := $(if $(call truthy,$(SKIP_BUILD)),--skip-build,)

RUN_WITH_VARS := npx tsx scripts/run-with-vars.ts --vars $(VARS_FILE) --
DEPLOY_FLAGS := $(EXECUTE_FLAG)
DEPLOY_WEB_FLAGS := $(EXECUTE_FLAG) $(SKIP_BUILD_FLAG)

.PHONY: help deploy-worker deploy-web

help:
	@printf '%s\n' \
		'Usage:' \
		'  make deploy-worker ENV=prd EXECUTE=1' \
		'  make deploy-web ENV=prd EXECUTE=1 [SKIP_BUILD=1]' \
		'' \
		'Defaults:' \
		'  ENV=dev loads .dev.vars; ENV=prd loads .prd.vars.' \
		'  EXECUTE=0 keeps deploy commands in dry-run mode.'

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
