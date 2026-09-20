.PHONY: install dev-web dev-server dev-worker check test test-web test-go test-worker test-wire test-interop test-worker-browser build build-web serve run

install:
	npm --prefix clients/web ci
	npm --prefix tests/interop ci
	npm --prefix servers/cloudflare-worker ci
	cd servers/go && go mod download

dev-web:
	npm --prefix clients/web run dev -- --host 127.0.0.1 --port 5173 --strictPort

dev-server:
	cd servers/go && go run ./cmd/aprond

dev-worker: build-web
	cd servers/cloudflare-worker && npx wrangler dev --port 8080

check:
	npm --prefix clients/web run check
	npm --prefix servers/cloudflare-worker run typecheck
	cd servers/go && go vet ./...

test: test-web test-go test-wire test-worker

test-web:
	npm --prefix clients/web test

test-go:
	cd servers/go && go test -race ./...

test-worker: build-web
	npm --prefix servers/cloudflare-worker test

test-worker-browser: build-web
	cd tests/interop && npx playwright test --config=cloudflare.config.ts

test-interop:
	npm --prefix tests/interop test

test-wire:
	npm --prefix tests/interop run test:wire

build-web:
	npm --prefix clients/web run build

build: build-web
	cd servers/go && go build -o ../../build/aprond ./cmd/aprond

serve:
	./build/aprond -static-dir clients/web/build

run: build
	$(MAKE) serve
