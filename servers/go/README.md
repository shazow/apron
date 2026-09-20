# Go example backend

`cmd/aprond` serves the example Bottomless Chat backend. State is in memory;
restarting the process clears messages, identities, passkeys, and sessions.

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
- authentication: WebAuthn passkeys and anonymous guests
- passkey RP ID: `localhost`; frontend origins: `http://localhost:5173` and
  `http://localhost:8080`

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
Request IDs deduplicate accepted chat operations for the connection's current
user. Switching identities clears that cache.

## Passkeys

Open the frontend at **http://localhost:5173** during development, or
**http://localhost:8080** when serving a static build. Use the profile panel's
**Add passkey** button to attach a discoverable, user-verified credential to your
current identity, retaining ownership of messages you already sent. **Sign in
with passkey** restores the identity selected in your browser's passkey picker.
You can add up to ten credentials to an identity. Guest chat remains available.

Use explicit settings for an HTTPS deployment (origins refer to the page running
the frontend, which may differ from the WebSocket server):

```sh
go run ./cmd/aprond -static-dir ../../clients/web/build \
  -origin https://chat.example.com \
  -webauthn-rp-id chat.example.com \
  -webauthn-origin https://chat.example.com
```

`-webauthn-rp-id ''` disables passkeys. `-webauthn-origin` accepts a comma-separated
list of exact origins, including ports. The RP ID must be a domain valid for the
frontend origin. Changing the RP ID creates a different credential scope.
`-allow-any-origin` does not relax WebAuthn origin validation. The default
`127.0.0.1` chat URL still supports anonymous chat; use `localhost` for passkeys.

The implementation uses [go-webauthn](https://github.com/go-webauthn/webauthn)
for registration and signature verification. Challenges are random, expire after
two minutes, and belong to one connection and origin. Each finish attempt
consumes its challenge, including failed attempts. New begin requests replace
the outstanding challenge. Authentication requests are not cached for replay.
User presence and verification are required; login updates the credential's
signature counter and flags and rejects a clone warning.

Successful registration or login returns an opaque bearer token for automatic
transport reconnection. Tokens last twelve hours, are stored hashed on the server,
and are bound to the frontend origin. The example client keeps its token only in
memory; a page reload requires signing in again. Sign-out revokes the current
token and disconnects that client. Already authenticated connections are not
revoked globally. An expired token requires another passkey login.

**This is an in-memory example:** restarting the backend invalidates all stored
credentials, including passkeys still present in your authenticator. Add a new
passkey after restarting, and remove obsolete entries using your device's
passkey manager. Durable credential storage, credential removal/account recovery,
and deployment rate limits are future work. There is no upload service, room
management, or push registration.

### Example WebAuthn exchange

These examples define the implementation-specific exchange for the protocol's
`webauthn` scheme. All steps use `auth` requests with fresh IDs over the same
WebSocket; no HTTP authentication endpoints are needed.

| `params.action` | Other parameters | Result |
| --- | --- | --- |
| `register_begin` | None; current connection must be authenticated | `{publicKey: ...}` creation options |
| `register_finish` | `credential`: browser credential JSON | `{you, token}` followed by room/thread announcements |
| `login_begin` | None | `{publicKey: ...}` discoverable request options |
| `login_finish` | `credential`: browser credential JSON | `{you, token}` followed by room/thread announcements |
| `resume` | `token`: previously issued token | `{you, token}` followed by room/thread announcements |
| `logout` | None | `{}`; connection becomes unauthenticated |

Every request includes `params.scheme: "webauthn"`. Binary values in options and
credentials use unpadded base64url, matching the browser's
`PublicKeyCredential.parseCreationOptionsFromJSON`,
`parseRequestOptionsFromJSON`, and `toJSON` APIs. Begin responses do not
authenticate the connection. Failed verification returns `denied` and preserves
the current identity. A client should pause chat operations while switching
identities and must start a new ceremony after a disconnect.

Embedding applications opt in through `Config.WebAuthn`, using a validated
`webauthn.WebAuthn` instance. A nil value leaves anonymous authentication enabled.

Run `go test -race ./...` and `go vet ./...` from this directory to validate it.
