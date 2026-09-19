# Example implementations

The SvelteKit client and Go server implement the protocol independently. The
server keeps rooms and history in memory; restarting it clears messages.

## Layout

- `clients/web`: SvelteKit and TypeScript client; connection and replay logic
  lives separately from UI components under `src/lib/protocol`.
- `servers/go`: Go module; `cmd/aprond` is the executable and `internal`
  contains implementation packages.
- `tests/interop`: Playwright tests against real clients and the Go server.

Each implementation owns its manifest, lockfile, and unit tests. Add other
clients or servers as sibling directories. Extract shared libraries only when
there is another consumer.

## Run locally

Use Node.js 24 LTS, npm, Go 1.26+, and Make. From the repository root:

```sh
make install
```

Run these in separate terminals:

```sh
make dev-server
```

```sh
make dev-web
```

Open `http://127.0.0.1:5173`. The development server proxies `/ws` to
`127.0.0.1:8080`. Open another browser tab to chat with a second client.

The example uses anonymous identities. Reconnecting assigns a new identity;
history is replayed from the current server, and messages belonging to the
previous identity remain readable. Edit and delete permissions belong to the
identity that created the message.

## Build and serve

```sh
make run
```

Open `http://127.0.0.1:8080`. The Go process serves the static SvelteKit build
and WebSocket endpoint from the same origin; no Node.js process is needed.
`make run` builds the frontend, builds the Go executable, then starts it.
Use `make serve` to run the existing build. Re-run `make run` after source changes;
use the two development processes above for frontend hot reload.
See `servers/go/README.md` for server flags and origin configuration.

## Validate

```sh
make check
make test
```

Install Chromium once for browser tests:

```sh
cd tests/interop
npx playwright install chromium
```

Then, from the repository root:

```sh
make test-interop
```

The browser tests start their own server and frontend. Stop existing processes
on ports 8080 and 5173 before running them. On Linux, Playwright may also need
system libraries (`npx playwright install --with-deps chromium` on supported
distributions). On NixOS, use a Nix-provided Chromium executable:

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chromium make test-interop
```

No root JavaScript workspace or Go workspace is needed for this initial pair.
