.PHONY: install dev-web dev-server deploy-web check test test-web test-go test-wire test-interop test-perf build build-web serve run

install:
	npm --prefix clients/web ci
	npm --prefix tests/interop ci
	cd servers/go && go mod download

dev-web:
	npm --prefix clients/web run dev -- --host 127.0.0.1 --port 5173 --strictPort

dev-server:
	cd servers/go && go run ./cmd/aprond

deploy-web:
	VITE_DEFAULT_SERVER_URL=wss://server.apron.chat/ npm --prefix clients/web run build
	cd clients/web && wrangler deploy

check:
	npm --prefix clients/web run check
	cd servers/go && go vet ./...

test: test-web test-go test-wire

test-web:
	npm --prefix clients/web test

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
	npm --prefix clients/web run build

build: build-web
	cd servers/go && go build -o ../../build/aprond ./cmd/aprond

serve:
	./build/aprond --static-dir clients/web/build

run: build
	$(MAKE) serve
