# Browser interoperability tests

These tests exercise the SvelteKit client against the Go server through real
Chromium browser contexts. They cover cross-session broadcasts and history
recovery, edit/delete snapshot replay including a deleted-message tombstone,
thread creation and moves, safe rendering of untrusted markup, and phone viewport layout.
The desktop suite also reloads a browser while offline, restores connectivity,
verifies history replay without duplicates, and sends another message.
`reference.spec.ts` covers what the Go reference server adds: uploads hosted
with `og` previews, live streams written over HTTP, `iframe`/`html`/unknown
embeds, avatar uploads and renames shown on earlier messages, leaving and
rejoining rooms and threads through `room_list`, the New divider from read
cursors, and `@user_id` and room mentions. It creates streams and raw embeds
with a small protocol client connected through the Vite proxy, so the URLs the
server mints load same-origin.
The WebAuthn suite uses Chromium's virtual authenticator against the real Go
verifier. It covers passkey registration, login, sign-out, session resumption,
message ownership, and recovery from an invalid signature. These tests use
`localhost` to match the default RP ID; other browser tests use `127.0.0.1`.

Install and run from the repository root:

```sh
cd tests/interop
npm ci
npx playwright install chromium
npm test
```

The config starts both services itself with `reuseExistingServer: false`:

* Go server: `127.0.0.1:8080`, started from `servers/go` with `-addr`
* Vite dev server: `127.0.0.1:5173`, started from `clients/web`

Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` when the browser is supplied by the
environment (for example, the NixOS VM). If it is unset, Playwright uses its
normal Chromium resolution.

The UI contract used by the tests is an accessible textbox named `Message`, a
`Send message` button, and message containers rendered as
`article[data-message-id]`. Mutation controls are named `Edit message`,
`Save changes`, and `Delete message`; the editor textbox is named `Edit
message`. A deleted container remains visible with the exact text `Message
deleted`.

## Shared session fixtures

`npm run test:wire` runs `../fixtures/wire/session` against the actual
TypeScript `ChatClient` using Node.js WebSockets. It requires Node.js 24 and
Go; no browser, Vite process, or example backend is started. The runner builds
`wire-peer.go` using the existing Go module dependencies and starts it on a
random loopback port. HTTP control endpoints deliver fixture frames and capture
client requests; protocol traffic uses a real WebSocket.

The peer is a transport utility, not a protocol implementation or test oracle.
Expected state resides exclusively in JSON fixtures. The runner normalizes
client state and asserts it without querying UI elements or private fields.
Both envelope forms run for every scenario variant. See
[`../fixtures/wire/README.md`](../fixtures/wire/README.md) for the portable format.

## Rendering benchmarks

`perf.spec.ts` times user journeys against the production build, served by the
Go server on `127.0.0.1:8090` (`make test-perf` from the repository root builds
it first). It seeds two rooms of 200 messages and switches between them, then
reports the time to the first painted frame and to the whole room with the CPU
throttled 4x, and Chrome's layout and style counts. The element count is the
same on every run, so `perf-ceilings.json` holds a ceiling for it: the test
fails when a change raises it. When a change lowers it, run with
`PERF_UPDATE=1` to write the new ceiling, and commit it. Set
`PERF_PROFILE=out.cpuprofile` to save a CPU profile of the measured switches.
