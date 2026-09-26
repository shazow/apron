.PHONY: install dev-web dev-server check test test-go test-wire test-interop test-perf build build-web serve run

# The web client lives in apron-chat/apron-web. The browser tests, dev-web, and
# run use a checkout of it here; replace it with a symlink to use your own.
WEB := .apron-web

$(WEB):
	git clone --depth 1 https://github.com/apron-chat/apron-web.git $@

install: $(WEB)
	npm --prefix $(WEB) ci
	npm --prefix tests/interop ci
	cd servers/go && go mod download

dev-web:
	npm --prefix $(WEB) run dev -- --host 127.0.0.1 --port 5173 --strictPort

dev-server:
	cd servers/go && go run ./cmd/aprond

check:
	cd servers/go && go vet ./...

test: test-go test-wire

test-go:
	cd servers/go && go test -race ./...

# Rendering benchmarks on the production build; fails when a count rises above perf-ceilings.json.
test-perf: build-web
	cd tests/interop && npx playwright test --config=perf.config.ts

test-interop:
	npm --prefix tests/interop test

test-wire:
	npm --prefix tests/interop run test:wire

build-web:
	npm --prefix $(WEB) run build

build: build-web
	cd servers/go && go build -o ../../build/aprond ./cmd/aprond

serve:
	./build/aprond --static-dir $(WEB)/build

run: build
	$(MAKE) serve
