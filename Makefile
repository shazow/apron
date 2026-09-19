.PHONY: install dev-web dev-server check test test-web test-go test-interop build serve run

install:
	npm --prefix clients/web ci
	npm --prefix tests/interop ci
	cd servers/go && go mod download

dev-web:
	npm --prefix clients/web run dev -- --host 127.0.0.1 --port 5173 --strictPort

dev-server:
	cd servers/go && go run ./cmd/aprond

check:
	npm --prefix clients/web run check
	cd servers/go && go vet ./...

test: test-web test-go

test-web:
	npm --prefix clients/web test

test-go:
	cd servers/go && go test -race ./...

test-interop:
	npm --prefix tests/interop test

build:
	npm --prefix clients/web run build
	cd servers/go && go build -o ../../build/aprond ./cmd/aprond

serve:
	./build/aprond -static-dir clients/web/build

run: build
	$(MAKE) serve
