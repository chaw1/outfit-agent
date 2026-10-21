.DEFAULT_GOAL := check

NPM ?= npm
UV ?= uv
PLAYWRIGHT_BROWSERS_PATH ?= $(CURDIR)/app/.tools/browsers

.PHONY: check app-check server-check dev deploy e2e app-e2e server-e2e

check: app-check server-check

app-check:
	cd app && EXPO_OFFLINE=1 EXPO_NO_TELEMETRY=1 $(NPM) run verify

server-check:
	cd server && $(UV) run ruff check .
	cd server && REQUIRE_INTEGRATION=1 $(UV) run pytest -q --cov=app --cov-report=term-missing --cov-report=xml:artifacts/coverage.xml

dev:
	cd server && MOCK_PROVIDERS=1 docker compose up --build

deploy:
	cd server && ./deploy/deploy-ecs.sh

e2e: app-e2e server-e2e

app-e2e:
	cd app && EXPO_OFFLINE=1 EXPO_NO_TELEMETRY=1 PLAYWRIGHT_BROWSERS_PATH="$(PLAYWRIGHT_BROWSERS_PATH)" $(NPM) run test:e2e

server-e2e:
	cd server && $(UV) run python scripts/e2e.py --mode mock
