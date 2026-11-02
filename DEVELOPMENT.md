# Development

This repository holds the protocol ([PROTOCOL.md](PROTOCOL.md)), its
[history](HISTORY.md), the shared wire fixtures in
[`tests/fixtures/wire`](tests/fixtures/wire/README.md), a JSON Schema of the
frames in [`schema`](schema/apron.schema.json), and minimal example servers in
[`servers`](servers). The main implementations live in their own
repositories, each with its own development guide, tests, and CI:

- [apron-chat/apron-server-go](https://github.com/apron-chat/apron-server-go):
  the Go reference server, implementing every capability in PROTOCOL.md, and
  the browser interoperability tests against the web client.
- [apron-chat/apron-web](https://github.com/apron-chat/apron-web): the
  SvelteKit and TypeScript web client, deployed at `https://web.apron.chat`.
- [apron-chat/apron-server-cloudflare](https://github.com/apron-chat/apron-server-cloudflare):
  the public demo backend at `wss://server.apron.chat/`, a TypeScript Worker
  and SQLite Durable Object.

The Go server, the web client and terminal.apron.chat check out this
repository as a submodule to run the fixtures; after a protocol or fixture
change, update the submodule there:

- The session fixtures (`tests/fixtures/wire/session`) run in the Go server's
  `make test-wire`, through `tests/interop/wire.spec.ts`. Each fixture plays
  the server, and the web client is under test.
- The replay fixtures (`tests/fixtures/wire/replay`) run in the web client's
  `npm test`, through `src/lib/protocol/wire-replay.test.ts`, and
  `tests/fixtures/history.json` and `tests/fixtures/webauthn.json` through
  `src/lib/protocol/protocol-fixtures.test.ts`.
- `tests/fixtures/push.json` holds push payloads and registrations that only
  `tests/schema/validate.py` checks.
- `tests/fixtures/terminal.json` holds terminal embed outputs and the screens
  that clients show for them ([PROTOCOL.md §4.8.6](PROTOCOL.md#486-embedterminal)).
  They run in
  [apron-chat/terminal.apron.chat](https://github.com/apron-chat/terminal.apron.chat)'s
  `npm test`, through `test/fixtures.test.mjs`, in a headless xterm.js. Each
  case has a `level`, so a client with a smaller renderer can run only the
  `MUST` and `SHOULD` cases.

## Conformance

`tests/conformance/conform.py` checks a running server against PROTOCOL.md:
the core checklist (§3.6), each capability that the server advertises, and the
schema for every frame it sends. It prints one line per check, and fails on a
broken rule but only warns on a SHOULD. CI runs it against the minimal servers:

```sh
uv run servers/python-minimal/apron_server.py &
uv run tests/conformance/conform.py ws://127.0.0.1:8765
```

It signs in as a guest, or with `--token`, and posts messages, so point it at
a test server.

## Schema

`schema/apron.schema.json` describes every frame in PROTOCOL.md. A protocol
change updates it in the same pull request. `tests/schema/validate.py` checks
the fixtures and the examples in PROTOCOL.md against it, and CI runs it:

```sh
uv run tests/schema/validate.py
```

Results carry no `method`, so the schema defines them as `<Method>Result`
(such as `HistoryResult`), for tools that know which request was sent. Frames
the fixtures send on purpose to test rejection are listed in the validator.
