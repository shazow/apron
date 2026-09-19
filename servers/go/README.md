# Go example backend

`cmd/aprond` serves the example Bottomless Chat backend. State is in memory;
restarting the process clears the room log and assigns new anonymous identities.

```sh
go run ./cmd/aprond
```

Defaults:

- HTTP and WebSocket listener: `127.0.0.1:8080`
- WebSocket endpoint: `/ws`
- health endpoint: `/healthz`
- WebSocket origins: `localhost`, `127.0.0.1`, and `::1` during development
- capabilities: `history`, `edit`
- room: `general`

The server accepts `-static-dir <directory>` to serve a built frontend from the
same listener. Use `-origin <pattern,...>` for a deployment-specific origin
allowlist, or `-allow-any-origin` only when the deployment provides its own
cross-site protections. `-addr` changes the listener address.

The implementation keeps raw room transitions and thread metadata in memory,
assigns anonymous identities per connection, and authorizes edits, deletion,
and thread changes by the creating identity. A thread is created by updating an
owned event with a fresh non-empty thread ID; replies must name an existing
thread. Thread names default to that opaque ID, the root is advisory metadata,
and empty threads remain visible for the lifetime of the process. There is no
persistent storage, token authentication, upload service, room management,
push registration, or WebAuthn verifier in this example.

Run `go test -race ./...` and `go vet ./...` from this directory to validate it.
