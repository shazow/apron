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

The Go server and the web client check out this repository as a submodule to
run the fixtures; after a protocol or fixture change, update the submodule
there.

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
