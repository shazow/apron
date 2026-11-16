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
the core checklist (§3.6), each capability and sign-in scheme that the server
advertises, and the schema for every frame it sends. CI runs it against the
minimal servers:

```sh
uv run servers/python-minimal/apron_server.py &
uv run tests/conformance/conform.py ws://127.0.0.1:8765
```

It prints one line per check, with a stable ID and the section that it checks:
PASS, FAIL on a broken rule, WARN on a SHOULD, SKIP with the reason, or MANUAL
for a rule that only a person can check, such as what a sign-in page shows.
MANUAL items are listed again at the end, and never fail a run. An ID is
`<scheme or area>.<area>.<name>`, where the middle part is the attacker that the
rule guards against (`A1` to `A5`) or a plain area, such as `shape`:
`external.A3.verifier`, `core.shape.server-frame`. `--list` prints every check.
A refusal by the server's policy, such as a guest who may only read, skips the
check with the server's message.

- `--only PATTERN` runs the checks whose IDs match a glob, such as
  `'external.A3.*'`. It repeats.
- `--scheme NAME` runs one sign-in scheme's profile, and the core checks. It
  repeats.
- `--json PATH` writes a report: `{"tool", "version", "target", "started",
  "results": [{"id", "section", "status", "message", "notes"}], "summary"}`,
  with a count for each status in `summary`.
- `--token` signs in with a token instead of as a guest. It posts messages and
  creates users, so point it at a test server.
- `--origin` sets the `Origin` of a WebAuthn ceremony that conform.py runs
  itself, with a software authenticator. It defaults to the server's own origin.

Most sign-in checks need no one to sign in: begins, the sign-in pages' answers
and headers, made-up codes and tokens, and `ext:oauth`'s endpoints. With
`--sign-in`, someone signs in on the server's pages, and conform.py catches each
redirect on a loopback address. It checks the redirect, the code's bindings, the
token, an addition, and a switch to another account. Without `--portal`, a
person signs in in a browser:

```sh
uv run tests/conformance/conform.py wss://chat.example/ws --sign-in
```

### Portals

`--portal COMMAND` signs in with a program instead of a person. conform.py
runs `COMMAND <authorization URL>` once for each sign-in, with these
environment variables:

- `APRON_PORTAL_REDIRECT_URI`: the request's `redirect_uri`. The sign-in ends
  when the browser is sent there.
- `APRON_PORTAL_DECISION`: `allow`, or `decline`.
- `APRON_PORTAL_IDENTITY`: who signs in, such as `default`. The same name is the
  same account. The portal makes a new identity for a name that it has not
  seen, such as a new passkey or another test subject.
- `APRON_PORTAL_STATE`: a directory that lasts for the run, for the portal's
  own state.

The portal prints the URL that the page redirected to as its last line of
output, and exits 0. Otherwise it exits non-zero, with the reason as its last
line on standard error, and the checks that needed the sign-in skip with it.

`tests/conformance/portals/passkey.cjs` drives a page in Chromium with a
virtual passkey authenticator, which keeps each identity's passkeys for the
run. It finds buttons by what their text means, so it works on most passkey
pages, on external pages that sign in with a passkey, and on a test identity
provider's form. It needs Node.js and Playwright with Chromium. Write a portal
of the same shape for another kind of sign-in page.

### In an implementation's CI

Start the server on `localhost` with a fresh store, then run conform.py with
the passkey portal. It exits 1 on a FAIL. For apron-server-go, with this
repository checked out in `apron`:

```sh
go run ./cmd/aprond --addr 127.0.0.1:8080 --store memory --upload.dir "$(mktemp -d)" \
  --webauthn.origin http://localhost:8080 &
uv run apron/tests/conformance/conform.py ws://localhost:8080/ws \
  --portal "node apron/tests/conformance/portals/passkey.cjs" --json conformance.json
```

aprond offers `external` only with an extension that signs users in on a page,
and the external checks skip without one. For apron-server-cloudflare:

```sh
npx wrangler dev --port 8787 --var EXTERNAL_SIGN_IN:true --var PUBLIC_ORIGIN:http://localhost:8787 \
  --var RP_ORIGINS:http://localhost:8787 --var ALLOWED_ORIGINS:http://localhost:8787 &
uv run apron/tests/conformance/conform.py ws://localhost:8787/ \
  --portal "node apron/tests/conformance/portals/passkey.cjs" --json conformance.json
```

### Client driver

`tests/conformance/conform_client.py` checks a client's sign-in. It plays two
Apron servers, on two ports and so two origins, with their sign-in pages, and
an issuer with a token endpoint on a third port. It runs normal and hostile
scenarios, such as a redirect with another `state`, a begin `url` that is
`javascript:`, a passkey ceremony for another RP ID, and an email link that
names the other server. It checks what the client sends, such as whether one
server's token reaches the other. It prints and writes results like conform.py, with
`--only`, `--list`, and `--json`.

An adapter drives the client. It is a program that the client's author
writes: the driver sends it commands as JSON lines on standard input
(`reset`, `connect`, `sign_in`, `open_link`, and `redirect`), and it reports
events on standard output, such as `open_url` when the client wants a
browser. The script's docstring defines the protocol. Without an adapter,
`--interactive` tells a person what to do in the client, and its sign-in page
shows Approve and Decline buttons:

```sh
uv run tests/conformance/conform_client.py --adapter "node my-client/conformance-adapter.js"
uv run tests/conformance/conform_client.py --interactive
```

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
