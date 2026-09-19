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

The implementation keeps raw room transitions in memory, assigns anonymous
identities per connection, and authorizes edits and deletion by the creating
identity. There is no persistent storage, token authentication, upload service,
thread or room management, push registration, or WebAuthn verifier in this example.

Run `go test -race ./...` and `go vet ./...` from this directory to validate it.
