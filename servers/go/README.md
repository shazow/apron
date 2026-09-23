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
- protocol: Apron v3 (`PROTOCOL.md` at the repository root)
- capabilities: `history`, `edit`, `rooms`, `reactions`
- seeded room: `general` (title `General`)
- authentication: WebAuthn passkeys, bearer-token resume, and `guest`; guest
  user IDs are `guest_<n>` and honor an optional requested `name`
- passkey RP ID: `localhost`; frontend origins: `http://localhost:5173` and
  `http://localhost:8080`

The server accepts `-static-dir <directory>` to serve a built frontend from the
same listener. Use `-origin <pattern,...>` for a deployment-specific origin
allowlist, or `-allow-any-origin` only when the deployment provides its own
cross-site protections. `-addr` changes the listener address.

## Log and history

Every change is a record in one append-only log with a single server-wide
`log_id` sequence (commit time in milliseconds, or the previous ID + 1) shared
by room records, message snapshots, and reaction sets across all rooms. A
message's `message_id` is its creation `log_id`, and a room created by a client
uses its creation `log_id` as its `room_id`. Nothing is compacted or discarded,
so each room's `history_log_id` is the `log_id` of its creation record
(including the seeded `general` room) and `latest_log_id` is the newest record
in that room's log.

`history` returns a window of one room's log partitioned into `rooms`,
`entries`, and `reactions` (always present, possibly empty). `limit` (default
100, clamped to 1000) counts records of every kind, and `first_id`/`last_id`
span all of them.

## Messages

Message notifications and history entries are flat snapshots:
`{message_id, log_id, room_id, from, body?, reply_to?, deleted?, ext?}`.
`message` creates a message when `message_id` is absent and, when it is
present, replaces every client field (`room_id`, `body`, `reply_to`, `deleted`,
`ext`) with the submitted state. `from` is assigned from the authenticated
connection and preserved across edits; `log_id` and `from` in requests are
ignored, and unknown top-level keys are dropped (extension data belongs in
`ext`, which is passed through unchanged). Edits, deletion, and moves require
the creating identity. `body` is stored as submitted; a missing `body.format`
means `plain`. Deletion is a save with `deleted: true` and yields a tombstone
without `body`.

`reply_to` is a bare `{"message_id": ...}` reference on input and in
snapshots. It may name a message in any room, including a tombstone, but not
the message itself.

A save with a different `room_id` moves the message. The destination must
exist. The move snapshot is logged in and broadcast to both rooms, so it
appears in both rooms' history; earlier snapshots stay in the source room. If
the message has reactions, a `reactions` record carrying every non-empty set
is then logged in the destination room.

## Rooms and threads

A thread is a room with `parent_room_id`. `room` without `room_id` creates a
room (optional `parent_room_id`, `title`, `intro_message`, `ext`); with
`room_id` it replaces every client field except `parent_room_id`, which is
fixed at creation.
Omitted fields are cleared. Both return `{"room_id": ...}` and broadcast the
new room record, which is logged in the room's own log. Any authenticated
user may create top-level rooms or threads (nested threads are allowed) and
update any room. A thread saved without a title is titled from the first line
of its intro message, or `Thread`.

`intro_message` is stored as a reference and announced with the referenced
message's snapshot embedded. After authentication the server announces every
room in creation order, so parents precede their threads. Every room is
visible to every user: `room_join` on a known room returns `{}` and re-sends
its announcement, and `room_leave` is `denied`.

## Reactions

`reactions` sets the caller's complete emoji set on a message and returns `{}`;
the logged record is broadcast as
`{log_id, message_id, room_id, reactions: [{from, emojis}]}`, with `room_id`
the message's current room. Duplicate emoji collapse, `[]` clears, and a
request that leaves the set unchanged logs nothing. Unknown messages, non-string
or empty entries, entries over 64 bytes, and more than 20 distinct emoji per
user are `invalid_params`.

## Requests

Request IDs deduplicate accepted operations for the connection's current user:
a retry returns the original result without re-executing or rebroadcasting,
and reuse with a different method or params is `invalid_params`. Switching
identities clears that cache. `name` renames the current identity. `typing` is
relayed to all clients. Unknown requests return `unsupported`.

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
`127.0.0.1` chat URL still supports guest chat; use `localhost` for passkeys.

The implementation uses [go-webauthn](https://github.com/go-webauthn/webauthn)
for registration and signature verification. Challenges are random, expire after
two minutes, and belong to one connection, action, RP ID, and origin. A finish
for the current challenge consumes it before verification, including failed
attempts; a new begin replaces the outstanding challenge. Authentication
requests are not cached for replay.
User presence and verification are required; login updates the credential's
signature counter and flags and rejects a clone warning.

Successful registration or login returns an opaque bearer token for automatic
transport reconnection. Tokens last twelve hours, are stored hashed on the server,
and are bound to the frontend origin. The example client keeps its token only in
memory; a page reload requires signing in again. Sign-out drops the local token
and reconnects. Already authenticated connections and disconnected clients
retain their server-side token until it expires. An expired token requires
another passkey login.

**This is an in-memory example:** restarting the backend invalidates all stored
credentials, including passkeys still present in your authenticator. Add a new
passkey after restarting, and remove obsolete entries using your device's
passkey manager. Durable credential storage, credential removal/account recovery,
and deployment rate limits are future work. There is no upload service or push
registration.

### Example WebAuthn exchange

These examples define the Go server's bearer-token policy alongside the canonical
protocol exchange (Appendix I). All steps use `auth` requests with fresh IDs
over the same WebSocket; no HTTP authentication endpoints are needed.

| `params.action` and `params.step` | Other parameters | Result |
| --- | --- | --- |
| `action: "register", step: "begin"` | None; current connection must be authenticated | `{challenge_id, public_key}` creation options |
| `action: "register", step: "finish"` | `challenge_id`, `credential`: browser credential JSON | `{you, token}` followed by room announcements |
| `action: "login", step: "begin"` | None | `{challenge_id, public_key}` discoverable request options |
| `action: "login", step: "finish"` | `challenge_id`, `credential`: browser credential JSON | `{you, token}` followed by room announcements |

Bearer resumption uses the separate `token` authentication scheme:
`{"scheme":"token","token":"..."}`. Dropping the token and reconnecting
signs out the current client; tokens remain valid for their configured lifetime
and are not revoked by disconnecting.

Every ceremony request includes `params.scheme: "webauthn"`. Binary values in options and
credentials use unpadded base64url, matching the browser's
`PublicKeyCredential.parseCreationOptionsFromJSON`,
`parseRequestOptionsFromJSON`, and `toJSON` APIs. Begin responses do not
authenticate the connection. Failed verification returns `denied` and preserves
the current identity. Notifications do not start or finish ceremonies. A client
should pause chat operations while switching identities and must start a new
ceremony after a disconnect.

Embedding applications opt in through `Config.WebAuthn`, using a validated
`webauthn.WebAuthn` instance. A nil value leaves only guest authentication enabled.

Run `go test -race ./...` and `go vet ./...` from this directory to validate it.
