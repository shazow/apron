# Example implementations

The SvelteKit client and Go server implement the protocol independently. The
server keeps rooms and history in memory; restarting it clears messages.

## Layout

- `clients/web`: SvelteKit and TypeScript client; connection and replay logic
  lives separately from UI components under `src/lib/protocol`.
- `servers/go`: Go module; `cmd/aprond` is the executable and `internal`
  contains implementation packages.
- `servers/cloudflare-worker`: TypeScript Worker and SQLite Durable Object for
  the bounded public demo; see its [setup and operating guide](servers/cloudflare-worker/README.md).
- `tests/interop`: Playwright tests against real clients and the Go or Workers backend.
- `tests/fixtures/wire`: portable JSON replay and session scenarios with
  expected protocol state; see its README for adapter requirements.

Each implementation owns its manifest, lockfile, and unit tests. Add other
clients or servers as sibling directories. Extract shared libraries only when
there is another consumer.

## Run locally

With Nix and [devenv](https://devenv.sh/getting-started/) 2.3+, from the
repository root:

```sh
devenv shell -- make install
devenv up
```

The locked environment provides Node.js 24, npm, Go 1.26, Make, a C compiler
for Go race tests, and Chromium on Linux. `devenv up` starts the Go backend and
Vite frontend; Ctrl-C stops both. Use `devenv shell` for an interactive shell
with the same tools. Dependency installation is explicit; rerun `make install`
after manifest or lockfile changes.
For background processes, use `devenv up --detach` and stop them with
`devenv down`.

Without Nix, install Node.js 24 LTS, npm, Go 1.26+, Make, and a C compiler.
Run `make install`, then `make dev-server` and `make dev-web` in separate
terminals. All Make commands below work inside `devenv shell` or with those
tools installed directly.

Open `http://localhost:5173`. The development server proxies `/ws` to
`127.0.0.1:8080`. Open another browser tab to chat with a second client.

To use the Cloudflare backend locally, follow its secret setup and run
`make dev-worker` instead of `make dev-server`. `make test-worker` runs its
Workers runtime suite; `make test-worker-browser` tests browser passkeys against
local Wrangler. The public demo has persistent passkeys and rolling history;
its passkey registration creates a new identity instead of upgrading guest
ownership as the Go example does.

The example starts with an anonymous identity. Use **Add passkey** in the profile
editor's Sign-in row to retain that identity and its message ownership, and
**Sign in with passkey** to return to it (or choose Passkey on the connect
screen). Passkey sessions resume after transport disconnects;
page reloads require signing in again. Anonymous reconnects receive a new identity.
Edit and delete permissions belong to the identity that created the message.
Messages and passkey registrations are held in memory and lost on server restart.
Use `localhost` for the default passkey configuration; see
[`servers/go/README.md`](servers/go/README.md#passkeys) for deployment settings.

## Threads

Start a thread from one of your messages, then open it to reply. The room
timeline shows only unthreaded messages; each thread shows its current members
after replaying edits and moves. Open threads through the thread list. Use the
message controls to move your messages to another thread or back to the room.
Drafts are kept separately for each room and thread.

Thread cards in the room feed preview up to three lines of the summary, or the
latest loaded message when no summary is present. Open a thread to read the
full summary pinned under the header. The Edit button in the header opens a
popover for the thread's name and summary. Without a summary, no summary
section is shown. Saving an empty summary removes it and restores the message
preview. Summaries are Markdown, rendered and sanitized like message bodies;
the card previews the source. Any authenticated participant can edit thread
metadata in the example server. A `thread` request with an existing `thread_id`
and `title` and/or `summary` updates only the supplied fields and broadcasts the
complete metadata; the root and messages stay intact. The jump prompt is hidden
when the latest timeline item is already visible.

Use a message's Reply action to reference it in a new message. Reply references
are restricted to the same room but may cross thread boundaries. The
composer keeps the reply target with the destination's draft. A reply shows the
quoted message above its body; clicking the quote opens its destination, scrolls
to the original and highlights it briefly. Edits preserve references; More →
Remove reply removes one. Messages can move between threads while preserving
reply references. Deleted targets display as “Message deleted”; targets outside
loaded history display as “Message unavailable”.

TODO: Add an interface for bulk-moving messages into a thread.

The server stores thread metadata in memory and re-announces it on connection.
Empty threads remain available; deleting or moving their root does not remove
them. Create metadata through `thread`, then use `message` with the returned
`thread_id` to add messages. Messages in a thread use `message.params.thread_id`;
replies to a specific message also set `message.params.reply_message_id`. Edits and
moves submit the complete editable message state with its `message_id`; omitting
`thread_id` returns it to the room. Moves follow the example's author-only edit
policy. Opening a thread also requests its history through a separate
`history` query with `thread_id`.

## Build and serve

```sh
make run
```

Open `http://localhost:8080`. The Go process serves the static SvelteKit build
and WebSocket endpoint from the same origin; no Node.js process is needed.
`make run` builds the frontend, builds the Go executable, then starts it.
Use `make serve` to run the existing build. Re-run `make run` after source changes;
use the two development processes above for frontend hot reload.
See `servers/go/README.md` for server flags and origin configuration.

## Validate

Run the full validation suite, including builds and browser tests:

```sh
devenv test
```

Run individual checks inside `devenv shell`:

```sh
make check
make test
```

`make test` includes shared replay fixtures in the frontend unit suite and
session fixtures over real loopback WebSockets. Run the latter alone with
`make test-wire`; it needs Node.js and Go, but no browser or running dev server.

The devenv environment supplies Chromium on Linux. Outside that environment,
or on macOS, install Chromium once for browser tests:

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
distributions). For a custom browser installation, set:

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chromium make test-interop
```

No root JavaScript workspace or Go workspace is required.

## Environment updates

`devenv.lock` pins Nix inputs. Run `devenv update`, validate with `devenv test`,
and commit the lockfile when updating the toolchain. Keep Node and Go versions
aligned with `.node-version`, `go.mod`, and CI. Machine-specific overrides go
in ignored `devenv.local.nix` or `devenv.local.yaml` files.
