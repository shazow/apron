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

The implementation keeps complete message snapshots and thread metadata in
memory. `message` creates a message when `message_id` is absent and replaces
its entire editable state when the ID is supplied. It assigns `from.user_id`
from the authenticated connection and preserves the original author on edits.
Edits, deletion, and moves require the creating identity. Unknown extension
fields are retained; omitted editable fields are removed on replacement.

`thread` creates metadata with a server-assigned ID and optional title, summary,
and advisory root. Adding messages requires a separate `message` save. Empty
threads retain their metadata; the client decides how to display them. History
can filter by `thread_id`, including transitions that move messages out of the
thread. Unfiltered history contains all room transitions, including threads.
Request IDs deduplicate accepted operations for the connection's anonymous user.

There is no persistent storage, token authentication, upload service, room
management, push registration, or WebAuthn verifier in this example.

Run `go test -race ./...` and `go vet ./...` from this directory to validate it.
