PYTHON=python3
PIP=pip3
NPM=npm

PIPFLAGS=$$([ -z "$$VIRTUAL_ENV" ] && echo --user) -U

.PHONY: test
test:
	$(PYTHON) -m unittest

.PHONY: test-ext
test-ext:
	$(PYTHON) -m unittest discover -p "ext_test*.py"

.PHONY: test-ui
test-ui:
	$(NPM) -C hello run test-ui

.PHONY: watch-test
watch-test:
	trap "exit 0" INT; $(PYTHON) -m tornado.autoreload -m unittest

.PHONY: lint
lint:
	pylint -j 0 micro hello/hello.py
	$(NPM) -C client run lint
	$(NPM) -C hello run lint

.PHONY: check
check: test test-ext test-ui lint

.PHONY: deps
deps:
	$(PIP) install $(PIPFLAGS) -r requirements.txt
	@# NOTE: Work around npm update behaving weird if there are no production dependencies (see
	@# https://github.com/npm/npm/issues/16901 )
	$(NPM) -C client update --only=prod --no-optional --no-save
	$(NPM) -C hello update --only=prod --no-optional --no-save
	$(NPM) -C hello run link-micro

.PHONY: deps-dev
deps-dev:
	$(PIP) install $(PIPFLAGS) -r requirements-dev.txt
	$(NPM) -C client update --only=dev --no-optional --no-save
	$(NPM) -C hello update --only=dev --no-optional --no-save

.PHONY: show-deprecated
show-deprecated:
	git grep -in -C1 deprecate $$(git describe --tags $$(git rev-list -1 --first-parent \
	                                                     --until="6 months ago" master))

.PHONY: release
release:
	scripts/release.sh
	cd client && npm publish

.PHONY: clean
clean:
	$(NPM) -C client run clean
	$(NPM) -C hello run clean

.PHONY: help
help:
	@echo "test:            Run all unit tests"
	@echo "test-ext:        Run all extended/integration tests"
	@echo "test-ui:         Run all UI tests"
	@echo "                 BROWSER:       Browser to run the tests with. Defaults to"
	@echo '                                "firefox".'
	@echo "                 WEBDRIVER_URL: URL of the WebDriver server to use. If not set"
	@echo "                                (default), tests are run locally."
	@echo "                 TUNNEL_ID:     ID of the tunnel to use for remote tests"
	@echo "                 PLATFORM:      OS to run the remote tests on"
	@echo "                 SUBJECT:       Text included in subject of remote tests"
	@echo "watch-test:      Watch source files and run all unit tests on change"
	@echo "lint:            Lint and check the style of the code"
	@echo "check:           Run all code quality checks (test and lint)"
	@echo "deps:            Update the dependencies"
	@echo "deps-dev:        Update the development dependencies"
	@echo "show-deprecated: Show deprecated code ready for removal (deprecated for at"
	@echo "                 least six months)"
	@echo "release:         Make a new release"
	@echo "                 FEATURE: Corresponding feature branch"
	@echo "                 VERSION: Version number"
	@echo "clean:           Remove temporary files"
