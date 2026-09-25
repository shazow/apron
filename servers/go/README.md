# Go reference backend

`cmd/aprond` serves the reference Apron backend: it implements every
capability of protocol v4 except multiplexing
([Appendix B.2](../../PROTOCOL.md#b2-multiplexing-envelope))
and WebRTC
([Appendix B.1](../../PROTOCOL.md#b1-webrtc-signaling-for-audio-video-and-peer-to-peer-connections)).
`PROTOCOL.md` now describes v5, which it does not implement yet. State is in memory; restarting the process clears
messages, identities, uploads, passkeys, and sessions.

```sh
go run ./cmd/aprond
```

Defaults:

- HTTP and WebSocket listener: `127.0.0.1:8080`
- WebSocket endpoint: `/ws`; health endpoint: `/healthz`
- embed endpoints: `/write/<token>`, `/files/<embed_id>/<secret>`,
  `/streams/<embed_id>/<secret>`
- WebSocket origins: `localhost`, `127.0.0.1`, and `::1` during development
- capabilities: `history`, `edit`, `rooms`, `reactions`, `activity`,
  `embed:upload`, `embed:stream`; push kind `relay` (`server.push`)
- `server.ext["apron-go"]`: frame, history, upload, avatar, and stream limits
- seeded room: `general` (title `General`)
- authentication: WebAuthn passkeys, bearer-token resume, and `guest`; guest
  user IDs are `guest_<n>` from a server-wide counter and honor an optional
  requested `name`
- passkey RP ID: `localhost`; frontend origins: `http://localhost:5173` and
  `http://localhost:8080`

Flags:

- `-static-dir <directory>` serves a built frontend from the same listener.
- `-origin <pattern,...>` sets a deployment-specific origin allowlist;
  `-allow-any-origin` only when the deployment has its own cross-site
  protections. `-addr` changes the listener address.
- `-public-url https://chat.example` sets the base of write, file, and stream
  URLs. Without it they use the host each WebSocket request arrived on, which
  suits local development but lets a client choose the host in URLs others
  see; set it in any deployment.
- `-max-connections <n>` refuses connections beyond `n` with an error without
  `id` (`retry_after`), then closes them.
- `-messages-per-minute <n>` limits each user's new messages; the excess gets
  `retry_after` with `data.retry_after` in seconds.
- `-disable-push` removes push; `-allow-insecure-push` accepts `http` and
  internal push endpoints (development only).
- `-debug-addr 127.0.0.1:6060` serves `net/http/pprof` and `expvar` under
  `/debug/` on a separate listener; keep it off public interfaces.
  [`cmd/apron-hammer`](cmd/apron-hammer/README.md) load-tests the server and
  reads it to report heap and goroutines.

## Log and history

Every change is a record in one append-only log with a single server-wide
`log_id` sequence (commit time in milliseconds, or the previous ID + 1) shared
by room records, message snapshots, and reaction sets across all rooms. A
message's `message_id` is its creation `log_id`, and a room created by a client
uses its creation `log_id` as its `room_id`. Every record after the first for
its key carries `prev_log_id`: an edit names the previous snapshot, a room
update the previous room record, and a reaction change that user's previous
set (a move's re-logged reactions record, holding several users' sets, has
none). Nothing is compacted or discarded, so each room's `history_log_id` is
the `log_id` of its creation record and `latest_log_id` is the newest record in
that room's log.

`history` returns a window of one room's log partitioned into `rooms`,
`entries`, and `reactions` (always present, possibly empty). `limit` (default
100, clamped to 1000) counts records of every kind, and `first_id`/`last_id`
span all of them. Every room is visible, so any user may page any room's
history, joined or not.

## Identity and profiles

`me` updates the caller's profile: a given `name` is trimmed and capped at 64
characters, `""` removes it; `avatar` must be an `https:` URL or a
`data:image/{png,jpeg,gif,webp};base64,` URL of at most 64 KiB (`""` removes
it); `ext` replaces the profile extension object (`{}` removes it). Profiles
(`you`, `user`, `members`) carry `avatar` and `ext`; `from` in records carries
only `user_id` and `name` at posting time.

A profile change sends `user` with `you` to the user's other connections and
with `new` to everyone who shares a room with them. When a sign-in replaces a
guest identity on a connection, the guest is retired: the connection's
announced rooms switch to the signed-in user's, and those who shared a room
with the guest receive `user` with `new` and `old`. Guests are also retired
when their last connection closes; their user IDs are never reissued, while
passkey users keep their profile, rooms, and push registrations across
connections.

## Rooms, threads, and membership

A thread is a room with `parent_room_id`. `room` without `room_id` creates a
room (optional `parent_room_id`, `title`, `intro_message`, `ext`); with
`room_id` it replaces every client field except `parent_room_id`, which is
fixed at creation. Omitted fields are cleared. Both return `{"room_id": ...}`.
Any authenticated user may create top-level rooms or threads (nested threads
are allowed) and update any room. A thread saved without a title is titled
from the first line of its intro message, or `Thread`. `intro_message` is
stored as a reference and announced with the referenced message's snapshot
embedded.

Every room is visible to every user; the rooms a user has joined are the ones
announced to their connections, and records are delivered only to members:

- A new user joins every room. Everyone joins a new top-level room, and the
  members of a room join its new threads (as does the creator).
- `room_join` joins a room and its threads and announces them; on a room
  already joined it re-announces it to the calling connection. `room_leave`
  leaves a room and its threads, sending `removed: true` for each.
- Posting in a room not joined joins it first: the room is announced, then
  the message is delivered.
- `room_list` returns the top-level rooms, or with `parent_room_id` that
  room's threads, as room records with delivery fields and `members` (at most
  100 profiles), whether joined or not.

Rooms are announced in creation order, so parents precede their threads.

## Messages

Message notifications and history entries are flat snapshots:
`{message_id, log_id, prev_log_id?, room_id, from, body?, reply_to?, deleted?, ext?}`.
`message` creates a message when `message_id` is absent and, when it is
present, replaces every client field (`room_id`, `body`, `reply_to`, `deleted`,
`ext`) with the submitted state. `from` is assigned from the authenticated
connection and preserved across edits; server fields in requests are ignored,
and unknown top-level keys are dropped (extension data belongs in `ext`, which
is passed through unchanged). Edits, deletion, and moves require the creating
identity. A missing `body.format` means `plain`.

Deletion is a save with `deleted: true` and yields a tombstone without `body`.
The server then redacts the message: its earlier snapshots, and copies of them
embedded as `intro_message` in logged room records, become tombstones at their
original `log_id`s, and the content of its hosted embeds is deleted.

`reply_to` is a bare `{"message_id": ...}` reference on input and in
snapshots. It may name a message in any room, including a tombstone, but not
the message itself.

A save with a different `room_id` moves the message. The destination must
exist. The move snapshot is logged in and delivered to both rooms, so it
appears in both rooms' history; earlier snapshots stay in the source room. If
the message has reactions, a `reactions` record carrying every non-empty set
is then logged in the destination room.

## Embeds, uploads, and streams

Every embed gets a server-assigned `embed_id` (`embed_<n>`). A save keeps an
embed by sending it back with its `embed_id`; its `kind` and the fields the
server owns (an upload's `url` and `og`, a stream's `url` or `text`) are
restored from the server's records, while other fields come from the save.
An embed sent without `embed_id` is new, one left out is removed and its
hosted content deleted, and an unknown `embed_id` is `invalid_params`. `og`
sent by clients is dropped: the server describes only media it hosts.

New `upload` and `stream` embeds get a one-time write URL, listed in the
`message` result as `embeds: [{embed_id, kind, write_url}]`. The sender PUTs
or POSTs the content there. A write URL expires after five minutes unused,
and a write that never starts or fails is finished by publishing the message
without the embed.

- **Uploads** (at most 32 MiB). While pending the embed has no `url`. When
  the write finishes the server publishes a snapshot with `url` set to the
  hosted file and, for images and playable media, `og`: `image` (PNG, JPEG,
  and GIF with `width` and `height`; the sender's `og.image.alt` is kept),
  `video`, or `audio`, plus `title`. Files are served sandboxed
  (`Content-Security-Policy: sandbox`, `nosniff`); only images, media, and
  plain text are shown inline, and HTML, XML, and script types are never
  served as such.
- **Streams**: the broadcast embed carries a live `url`. Readers `GET` it for
  the kept text followed by more as it arrives; a reader that falls behind the
  kept window continues from it. The server keeps the trailing 64 KiB. The
  stream ends when the write body ends, after one hour, or at 16 MiB (the
  writer gets `413`); the server then publishes the kept text as `text` in
  place of `url`, and both URLs stop working. Saving the message without the
  embed ends the stream (the writer gets `410`).
- **Avatars** ([PROTOCOL.md §4.6.6](../../PROTOCOL.md#466-avatars)): a message to room `@avatar` with one `upload`
  embed returns a write URL and is neither delivered nor logged. A PNG, JPEG,
  GIF, or WebP of at most 2 MiB becomes the sender's `avatar`, followed by a
  `user` notification; replacing or removing the avatar deletes the upload.

## Reactions

`reactions` sets the caller's complete emoji set on a message and returns `{}`;
the logged record is delivered as
`{log_id, prev_log_id?, message_id, room_id, reactions: [{from, emojis}]}`,
with `room_id` the message's current room. Duplicate emoji collapse, `[]`
clears, and a request that leaves the set unchanged logs nothing. Unknown
messages, non-string or empty entries, entries over 64 bytes, and more than 20
distinct emoji per user are `invalid_params`.

## Activity

`activity` relays `typing` (seconds; `0` stops) and `read_message_id` to the
room's members. A read cursor must name an existing message and only moves
forward; the server keeps each user's latest cursor per room and re-sends the
room's cursors after announcing it. A frame that changes nothing relays
nothing.

## Push

`server.push` offers the `relay` kind. `push_register` takes
`{kind: "relay", url, token?}`; `url` must be `https` (unless
`-allow-insecure-push`) and identifies the registration, so registering it
again replaces it; a user may hold ten. `push_unregister` removes the caller's
registration for a `url`. Registrations belong to the user, so they matter for
passkey users; a guest's end with the guest.

A new message wakes users who have no open connection when it mentions them
(`@user_id`, [PROTOCOL.md Appendix A.3](../../PROTOCOL.md#a3-mention-text), outside Markdown code) or replies to one of their
messages: the server POSTs the push payload (the message without `log_id`,
`format`, or `embeds`, text truncated to 1,000 characters) to each of their
endpoints with `token` as bearer. Deliveries run in the background, refuse to
connect to loopback, private, and link-local addresses, and a relay answering
`404` or `410` loses its registration.

## Requests and errors

Request IDs deduplicate per user, across all of that user's connections: a
retry returns the original result without re-executing or rebroadcasting, a
concurrent duplicate waits for the original, and reuse with a different
method or params is `invalid_params`. The latest 1,024 IDs per user are kept;
failed requests are not cached. Unknown requests return `unsupported`.

Errors not tied to a request omit `id`. On shutdown every connection
receives `retry_after` (`data.retry_after: 5`) before it closes; over
`-max-connections` a new connection receives the `server` frame and then
`retry_after` (`data.retry_after: 30`).

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
passkey manager. Durable credential storage and credential removal/account
recovery are future work.

### Example WebAuthn exchange

These examples define the Go server's bearer-token policy alongside the canonical
protocol exchange ([PROTOCOL.md §4.9](../../PROTOCOL.md#49-webauthn-authentication)). All steps use `auth` requests with fresh IDs
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
