# This is the Makefile for the KeetaNetwork Pulumi Components project.
# It is used to automate the build, test, and cleanup processes.
#
# It is the place where all automation tasks are defined -- not
# "package.json" (which just holds the references to NodeJS packages
# binaries).
#
# To get a list of targets run "make help".

# The default target -- makes the "dist" directory
all: dist

# This target provides a list of targets.
help:
	@echo "Usage: make [target]"
	@echo ""
	@echo "Targets:"
	@echo "  all              - Builds the project"
	@echo "  dist             - Builds the distribution directory"
	@echo "  do-lint          - Runs eslint on the project source and tests"
	@echo "  typecheck        - Type-checks the source and the tests without emitting"
	@echo "  test             - Runs the unit and integration tests"
	@echo "  test-unit        - Runs the unit tests (no cloud access)"
	@echo "  test-integration - Runs the integration tests (deploys to GCP)"
	@echo "  urn-baseline     - Adds cases to a released version's URN baseline (VERSION=, CASES=)"
	@echo "  cleanup-integration - Destroys this run's and stale integration test stacks"
	@echo "  clean            - Removes build artifacts"
	@echo "  distclean        - Removes all build artifacts and dependencies"
	@echo "  do-npm-pack      - Creates a distributable package for this project"

# This target creates the "node_modules" directory.
node_modules/.done: package.json package-lock.json Makefile
	rm -rf node_modules
	npm clean-install
	@touch node_modules/.done

# Creates the "node_modules" directory -- this target is for
# the directory itself, not its contents so it just
# depends on the contents and updates its timestamp.
node_modules: node_modules/.done
	@touch node_modules

# This target creates the distribution directory.
dist/.done: $(shell find src -type f) node_modules Makefile tsconfig.json package.json
	npm run tsc
	jq '.main = "index.js"' package.json > dist/package.json
	@touch dist/.done

# Creates the distribution directory -- this target is for
# the directory itself, not its contents so it just
# depends on the contents and updates its timestamp.
dist: dist/.done
	@touch dist

# Runs the unit tests: no network, no docker, no GCP.
test-unit: node_modules
	npm run vitest -- run tests/unit

# Runs the integration tests: they deploy real stacks to GCP.
test-integration: node_modules
	npm run vitest -- run tests/integration

# Adds cases to the URN baseline of a released version, e.g.
#   make urn-baseline VERSION=1.0.95 CASES=external-load-balancer
# It must run on a checkout of that release's "src" (for 1.0.95, commit
# f06cb0c) with each new case already appended to
# "tests/unit/harness/tree-cases.ts", because the URNs of a case have to
# come from the released code. It only adds cases and fails on one that is
# already in the file, so a recorded baseline is never rewritten.
urn-baseline: node_modules
	@test -n "$(VERSION)" -a -n "$(CASES)" || { echo "Usage: make urn-baseline VERSION=<release> CASES=<case>[,<case>...]"; exit 1; }
	URN_BASELINE_VERSION="$(VERSION)" URN_BASELINE_CASES="$(CASES)" npm run vitest -- run tests/unit/harness/write-baseline.test.ts

# Destroys the stacks the integration tests leave behind: every stack of
# this GitHub Actions run (GITHUB_RUN_ID), and every test stack untouched
# for longer than the threshold. The examples install "dist", so it is
# built first. Pass CLEANUP_ARGS="--dry-run" to only list the stacks, or
# CLEANUP_ARGS="--max-age-minutes=<n>" to change the threshold.
cleanup-integration: dist
	node tests/helpers/cleanup-integration.ts $(CLEANUP_ARGS)

# This is a synthetic target that runs this test suite.
test: test-unit test-integration

# Type-checks "src" and "tests" together (nothing is emitted)
typecheck: node_modules
	npm run tsc -- --noEmit -p tsconfig.test.json

# Run linting
do-lint: node_modules
	npm run eslint -- -c .eslint.config.mjs src tests

# This is a synthetic target that creates a distributable
# package for this project.
do-npm-pack: dist
	cd dist && npm pack
	mv dist/keetanetwork-pulumi-components-*.tgz .

# Files created during the "build" or "prepare" processes
# are cleaned up by the "clean" target.
#
# These files should also be added to the ".gitignore" file.
clean:
	rm -rf dist
	rm -f .tsbuildinfo
	rm -f keetanetwork-pulumi-components-*.tgz

# Files created during the "install" process are cleaned up
# by the "distclean" target.
#
# These files should also be added to the ".gitignore" file.
distclean: clean
	rm -rf node_modules

.PHONY: all help test test-unit test-integration urn-baseline cleanup-integration typecheck clean distclean do-lint do-npm-pack
