# Apron Chat Protocol

Apron Chat Protocol is designed to be easy to implement in semi-trusted
environments. It runs over a WebSocket, or most other transports. The goal is
an ecosystem of many Apron Chat apps and servers that can speak with each
other: local bridges to other protocols, coding harnesses, internal message
rooms.

The protocol is incremental. The mandatory core ([§3](#3-core)) is all a minimal
implementation needs, about a hundred lines. Everything else is an optional
capability: [§4](#4-capabilities) lists and specifies them.

Contents:

- [1. Transport & framing](#1-transport--framing)
  - [1.1 Envelope and replies](#11-envelope-and-replies)
  - [1.2 Retries and deduplication](#12-retries-and-deduplication)
- [2. Identifiers](#2-identifiers)
- [3. Core](#3-core)
  - [3.1 `server` frame](#31-server-frame)
  - [3.2 Authentication](#32-authentication)
  - [3.3 Identity](#33-identity)
  - [3.4 Rooms](#34-rooms)
  - [3.5 Messages](#35-messages)
  - [3.6 Core conformance checklist](#36-core-conformance-checklist)
- [4. Capabilities](#4-capabilities)
  - [4.1 `history`](#41-history)
  - [4.2 `edit`](#42-edit)
  - [4.3 `rooms`](#43-rooms)
    - [4.3.1 Listing](#431-listing)
    - [4.3.2 Membership](#432-membership)
    - [4.3.3 Updates](#433-updates)
    - [4.3.4 Creating and editing](#434-creating-and-editing)
    - [4.3.5 Posting](#435-posting)
  - [4.4 `activity`](#44-activity)
  - [4.5 `reactions`](#45-reactions)
  - [4.6 Embeds and avatars](#46-embeds-and-avatars)
    - [4.6.1 OpenGraph metadata (`og`)](#461-opengraph-metadata-og)
    - [4.6.2 Embed identity](#462-embed-identity)
    - [4.6.3 Writes](#463-writes)
    - [4.6.4 `embed:upload`](#464-embedupload)
    - [4.6.5 `embed:stream`](#465-embedstream)
    - [4.6.6 Avatars](#466-avatars)
  - [4.7 Push](#47-push)
  - [4.8 `command`](#48-command)
  - [4.9 WebAuthn authentication](#49-webauthn-authentication)
- [Appendix A — Conventions (informative)](#appendix-a--conventions-informative)
  - [A.1 System identities and scoped notices](#a1-system-identities-and-scoped-notices)
  - [A.2 Field naming](#a2-field-naming)
  - [A.3 Mention text](#a3-mention-text)
- [Appendix B — Multiplexing envelope (informative)](#appendix-b--multiplexing-envelope-informative)
- [Appendix C — Under consideration](#appendix-c--under-consideration)
  - [C.1 WebRTC: signaling for audio, video, and peer-to-peer connections](#c1-webrtc-signaling-for-audio-video-and-peer-to-peer-connections)

A first exchange. After the WebSocket opens, the server announces itself and
accepts authentication, and the client lists the rooms it has joined. The
client sends messages; the server broadcasts them to every client in the
room, including the sender.

```jsonc
// <- server greeting with capabilities and auth schemes
{"method": "server", "params": {"protocol": 5, "caps": ["rooms"], "auth": ["guest", "token"]}}

// -> guest auth, requesting a display name
{"method": "auth", "id": "c1", "params": {"scheme": "guest", "name": "Ada"}}

// <- assigned identity
{"id": "c1", "result": {"you": {"user_id": "guest_1234", "name": "Ada"}}}

// -> joined rooms
{"method": "room_list", "id": "c2", "params": {"only_joined": true}}

// <- one room
{"id": "c2", "result": {"joined": [{"room_id": "general", "title": "General"}]}}

// -> post a message
{"method": "message", "id": "c3", "params": {"room_id": "general", "body": {"text": "Hello"}}}

// <- confirmation
{"id": "c3", "result": {"message_id": "1724803200042"}}

// <- broadcast to everyone in the room
{
  "method": "message", "params": {
    "message_id": "1724803200042", "log_id": "1724803200042", "room_id": "general",
    "from": {"user_id": "guest_1234", "name": "Ada"},
    "body": {"text": "Hello"}
  }
}
```

- Client request `id` corresponds to server reply `id`.
- `message_id` is a stable message identifier for its lifetime.
- `log_id` identifies one change. The protocol is built around an append-only
  log: every change to a room, message, or reaction is a record in it ([§2](#2-identifiers)).

---

## 1. Transport & framing

- WebSocket is the reference transport; others work if they deliver whole
  frames.
- A **frame** is one JSON object: one WebSocket text message, or one line on
  a byte-stream transport such as TCP or stdio (newline-delimited JSON).
- Frames look like [JSON-RPC 2.0](https://www.jsonrpc.org/specification)
  requests, responses, and notifications (`method`, `params`, `id`, `result`,
  `error`), minus the `"jsonrpc": "2.0"` key.
- Unknown keys MUST be ignored and MAY be dropped, so a JSON-RPC 2.0 client
  can talk to an Apron server unchanged, but it should not expect the
  `jsonrpc` key in replies. Extension data goes in `ext` ([§3.5](#35-messages)).
- Servers MAY process requests concurrently and reply in any order. A client
  that needs one request applied before another waits for the first reply.
- Server announcements and broadcasts are notifications.
- Unknown methods: servers reply `error/unsupported` to requests and ignore
  notifications; clients ignore unknown notifications.
- Frame size: implementations SHOULD accept frames up to 256 KiB and MAY
  reject larger requests with `error/too_large`; oversized notifications may
  be dropped. The limit is advisory.
- Liveness: a server MAY advertise `ping` ([§3.1](#31-server-frame)). Clients that support it
  then send exactly `{"method":"ping"}` at that interval, fixed bytes so
  servers can answer without parsing, and the server answers
  `{"method":"pong"}`, before authentication too. A server MAY close a
  connection that pinged and then stopped.

### 1.1 Envelope and replies

Requests carry a string `id` ([§2](#2-identifiers)); frames with a `method` and no `id` are
notifications.

```jsonc
// ->
{
  "method": "message", "id": "c42", "params": {
    "room_id": "general",
    "body": {"text": "hello", "format": "plain"}
  }
}
// <-
{"id": "c42", "result": {"message_id": "1724803200042"}}
```

A notification omits `id` and receives no reply:

```json
{"method": "activity", "params": {"room_id": "general", "typing": 8}}
```

Success returns a `result` object (`{}` if empty). Errors contain integer
`code`, string `message`, and optional `data`:

```json
{"id": "c42", "error": {"code": -32601, "message": "Unsupported method"}}
{"id": "c43", "error": {"code": -32002, "message": "Too Many Requests", "data": {"retry_after": 30}}}
```

`error/<name>` denotes the following numeric codes:

| code   | name              | meaning                                                |
|--------|-------------------|--------------------------------------------------------|
| -32700 | `parse_error`     | invalid JSON                                           |
| -32600 | `invalid_request` | invalid envelope                                       |
| -32601 | `unsupported`     | method/capability not implemented                      |
| -32602 | `invalid_params`  | invalid method parameters                              |
| -32603 | `internal_error`  | internal server error                                  |
| -32001 | `denied`          | authentication/authorization failure                   |
| -32002 | `retry_after`     | rate limited; `data.retry_after` is a delay in seconds |
| -32003 | `too_large`       | message too large                                      |

Clients distinguish errors by `code` alone. `message` is free text for
people: servers SHOULD make it specific enough to show as is, such as
"Session expired; sign in again" rather than "Denied".

Other application errors MAY use non-reserved JSON-RPC codes. Valid
notifications never receive error replies.

An error not tied to a request omits `id`: parse errors, invalid envelopes
whose `id` cannot be determined, and errors about the connection as a whole.
The server MAY close the connection after sending one:

```json
{"error": {"code": -32002, "message": "Server at capacity", "data": {"retry_after": 30}}}
```

Clients act on the code: after `retry_after`, wait before reconnecting;
after `denied`, do not reconnect automatically until the user acts.

### 1.2 Retries and deduplication

Retries SHOULD preserve `id`, `method`, and `params` across reconnects. New
operations, including changed parameters, MUST use a new `id`. Deduplication
ignores object key order.

Servers SHOULD deduplicate by `(user_id, id)`, using the authenticated `user_id`:

- return the original result for a duplicate, without re-executing or
  rebroadcasting;
- reject reuse with a different method or params as `invalid_params`;
- coalesce concurrent duplicates.

Retention across reconnects and restarts is implementation-defined.
Request `id`s sent before authentication are connection-scoped;
authentication MUST execute on each connection.

---

## 2. Identifiers

All IDs are strings.

**`log_id`** — position of one change in the server's append-only log.

- Decimal string of Unix epoch milliseconds, e.g. `"1724803200042"`.
- One strictly increasing sequence per server, covering every record: room
  records ([§3.4](#34-rooms)), message snapshots ([§3.5](#35-messages)), reaction sets ([§4.5](#45-reactions)).
- Value is the commit time, or the previous `log_id + 1` if the clock has not
  advanced past it.
- Clients MAY use it as a timestamp (this is the only one).
- Positive, below `2^53`, compared numerically. Clients MAY parse as integers.
- Unique within one server only; namespacing across servers is client-defined.
- A room's log is the subsequence of records that touch that room
  ([§4.1](#41-history)).
- Reference generator: `str(max(unix_epoch_ms(), last_id + 1))`.

**`message_id`** — permanent identity of a message.

- Equal to the `log_id` of its creation; never changes.
- Unique across rooms, so it is a complete reference on its own.
- `log_id == message_id` marks the creation; later changes have greater
  `log_id`s.

**Records and replay.** Every record is the complete state for its key at its
`log_id`:

| record           | key                     |
|------------------|-------------------------|
| room record      | `room_id`               |
| message snapshot | `message_id`            |
| reaction set     | `(message_id, user_id)` |

- Clients keep the record with the greatest `log_id` per key, regardless of
  source (live, history, embedded) or arrival order.
- `log_id` and other server fields are ignored on input.
- A record MAY carry `prev_log_id`, the `log_id` of the previous record for
  the same key. It links changes backward even when that record is no longer
  retained ([§4.1](#41-history)); there is no lookup by `log_id`.
- Suggested convention: if a client already has the record that
  `prev_log_id` names, it can diff the two to see exactly what changed. If
  its copy is older than that, it missed at least one change in between. A
  message whose `prev_log_id` equals its `message_id` has changed exactly
  once since it was created.

**Opaque IDs** — `room_id`, `user_id`, `embed_id`, `session_id`, and request
`id`.

- Arbitrary strings minted by whichever side creates them; `room_id` and
  `user_id` are server-assigned.
- Request `id`s SHOULD be random, to avoid collisions across devices of the
  same user. They identify operations, not log positions.
- Suggested convention: use a room's creation `log_id` as its `room_id`.
- Suggested convention: keep `room_id`s distinct from `user_id`s, so
  `@mentions` are unambiguous ([Appendix A.3](#a3-mention-text)).

---

## 3. Core

Every server implements this section; a minimal server implements only this
section. Optional features are advertised through capabilities ([§4](#4-capabilities)).

### 3.1 `server` frame

Upon accepting a connection, the server MUST immediately send a `server`
frame, unprompted. There is no client hello.

```json
{
  "method": "server", "params": {
    "protocol": 5,
    "name": "impl-name/1.0",
    "caps": ["history", "edit"],
    "auth": ["token"]
  }
}
```

- `protocol`: required integer, incremented with each revision of this spec.
  Current value `5`. Implementations make a best effort to interoperate
  across versions; mismatched optional features degrade to their fallbacks
  ([§4](#4-capabilities)).
- `name`: optional implementation/version string.
- `caps`: array of capability strings ([§4](#4-capabilities)), default `[]`.
- `auth`: required nonempty array of supported authentication schemes ([§3.2](#32-authentication)),
  in server preference order.
- `ext`: optional extension metadata ([§3.5](#35-messages)), such as implementation limits.
- `push`: optional object of supported push kinds; its presence enables push
  ([§4.7](#47-push)).
- `ping`: optional positive integer, the seconds between client pings ([§1](#1-transport--framing)).

The server MAY send a new `server` frame at any time; each **fully replaces**
the previous. Clients re-evaluate feature UI but MUST NOT un-render existing
content.

### 3.2 Authentication

```jsonc
// ->
{
  "method": "auth", "id": "c1", "params": {
    "scheme": "token",
    "token": "...",
    "name": "Alice",
    "client": "bottomless-web/0.3"
  }
}
// <-
{"id": "c1", "result": {"you": {"user_id": "alice", "name": "Alice"}}}
```

`params.scheme` selects the scheme:

- `guest`: no credentials; the server assigns identity. Suggested
  convention: `guest_` plus a global counter, such as `guest_1234`, so
  retired IDs are never reissued ([§3.3](#33-identity)).
- `token`: bearer string. The reference default.
- `webauthn`: optional passkey scheme ([§4.9](#49-webauthn-authentication)).

Except for `webauthn`, servers MAY accept `auth` regardless of `scheme` and
ignore credentials under guest-access policies. Token validation,
identity assignment, and privilege policy are implementation-defined.

`name` and `user_id` are optional requests, valid with any scheme; `you`
is what the server assigned. Servers SHOULD NOT give out a previously used
`user_id` without authenticating its owner. `client` is an optional
free-form implementation string for debugging.

Clients MAY pipeline `auth` before `server` arrives. Before successful auth,
other requests get `denied` and other notifications are ignored.

### 3.3 Identity

Identity is server-authoritative: every message carries its author in `from`.

```json
"from": {"user_id": "alice", "name": "Alice"}
```

`user_id` is required and stable. `name` is an optional display string; absent
`name` falls back to `user_id`. `avatar` ([§4.6.6](#466-avatars)) and `ext` ([§3.5](#35-messages)) are
optional. Every identity on the wire (`you`, `new`, `old`, `from`, `members`,
`users`, RTC members) uses this shape, and servers MAY send only `user_id`.
Clients keep one user object per `user_id` and merge into it every one they
receive, whichever frame carried it: a present field replaces the kept value,
an empty value (`""`, `{}`) removes it, and a missing field leaves it
unchanged, so an object with only `user_id` changes nothing. Clients render
every message with the kept object.

Clients SHOULD show a user as `Name (@user_id)` where space allows, and
MUST when another user in the same room shares the name, so no one can pass
as someone else.

Servers SHOULD include `name` in `from`, so clients can render any message
without looking its author up.

A result MAY carry `users`, complete user objects, each user once, for the
identities elsewhere in it, such as a history page's authors. Clients merge
them like any other user object, after the rest of the result, so `users`
wins over an older `from` in the same result. Clients that ignore them lose
only what `from` leaves out, such as avatars. A `from` in history may carry
the name from posting time; servers that send those SHOULD send the users'
current objects in `users`.

A `me` request updates the user's own profile after authentication, by the
same rule: fields given replace their current values, fields omitted stay
unchanged, and an empty value removes the field. `name`, `avatar`, and
`ext` are settable; the server MAY comply, decline, or alter any of them.
Servers announce a removed field as its empty value:

```jsonc
// -> rename and remove the avatar; ext is untouched
{"method": "me", "id": "c2", "params": {"name": "Alice ⚙", "avatar": ""}}
// <-
{"id": "c2", "result": {"you": {"user_id": "alice", "name": "Alice ⚙", "avatar": ""}}}
```

After authentication, the server MAY send a `user` notification at any time,
such as after a rename, a profile change, or an authentication change. It
carries `you`, sent to the user's own connections, or `new` and `old`, sent
to others who share a room with the user. `new` alone is the user's current
object, `old` alone says the user no longer shares any room with the
recipient, and both together say `user_id` changed. With `room_id`, they
announce joins and leaves ([§4.3.2](#432-membership)):

```jsonc
// <- to the user's own connections
{"method": "user", "params": {"you": {"user_id": "guest_1234", "name": "Ada L"}}}
// <- to others who share a room with the user
{"method": "user", "params": {"new": {"user_id": "guest_1234", "name": "Ada L"}}}
// <- user_id change
{
  "method": "user", "params": {
    "new": {"user_id": "ada", "name": "Ada"},
    "old": {"user_id": "guest_1234", "name": "Ada L"}
  }
}
```

- `you` replaces the connection's identity. If its `user_id` changes, the
  connection now acts as the new identity: it receives deliveries for the
  new identity's rooms ([§3.4](#34-rooms)), and clients re-derive per-user state such as
  their room list ([§4.3.1](#431-listing)) and their own reactions ([§4.5](#45-reactions)).
- After a `user_id` change, logged records keep the old `user_id`; clients
  MAY alias it to the new identity.
- Servers SHOULD NOT reissue a retired `user_id` to another user.

Bots and agents are ordinary senders. Servers MAY mark kinds of users by
convention in `user_id`, `name`, or `ext`, such as the `@` prefix for system
identities ([Appendix A.1](#a1-system-identities-and-scoped-notices)).

### 3.4 Rooms

A room is a log with a server-chosen `room_id`. Every message names its room
([§3.5](#35-messages)). A server without cap `rooms` MAY have a single room: clients learn
its `room_id` from the messages in it, and title any room they know nothing
more about by its `room_id`. Listing, joining, creating, and threads are cap
`rooms` ([§4.3](#43-rooms)).

A connection receives deliveries for the rooms its user has joined: every
room, on servers without membership. Posting does not require joining
([§3.5](#35-messages)).

A **room record** describes one room, as `room_list` and `room_update`
carry it ([§4.3](#43-rooms)):

```json
{
  "room_id": "general", "log_id": "1724800000000", "title": "General",
  "intro_message": {
    "message_id": "1724800000001", "log_id": "1724800000001", "room_id": "general",
    "from": {"user_id": "alice", "name": "Alice"},
    "body": {"text": "Ops chatter: deploys, alerts, *incidents*.", "format": "markdown"}
  },
  "latest_log_id": "1724803200042", "history_log_id": "1724800000000"
}
```

`server`: assigned by the server, ignored on input. `client`: supplied by the
client, replaced whole by a save. `delivery`: this client's view, not logged.

| field                     | set by   | meaning                                                                           |
|---------------------------|----------|-----------------------------------------------------------------------------------|
| `room_id`                 | server   | required                                                                          |
| `log_id`                  | server   | position of this room record ([§2](#2-identifiers))                               |
| `prev_log_id`             | server   | optional; this room's previous record ([§2](#2-identifiers))                      |
| `parent_room_id`          | client   | optional; fixed at creation; marks a thread ([§4.3.4](#434-creating-and-editing)) |
| `title`                   | client   | optional plain string; absent falls back to `room_id`                             |
| `intro_message`           | client   | optional message object ([§3.5](#35-messages)): the room's description or summary |
| `ext`                     | client   | optional opaque extension data ([§3.5](#35-messages))                             |
| `latest_log_id`           | delivery | greatest `log_id` in the room's log                                               |
| `history_log_id`          | delivery | inclusive lower bound of retrievable history, or `null` if none                   |
| `member_count`, `members` | delivery | optional, in `room_list` only ([§4.3.1](#431-listing))                            |

A room record is complete ([§2](#2-identifiers)); omitted fields are cleared, except
`member_count` and `members`.

`intro_message` is a message like any other. Servers SHOULD embed its
snapshot in room records so clients can render it without history; editing
it is an ordinary message save ([§4.2](#42-edit)). `log_id`, `latest_log_id`, and
`history_log_id` are REQUIRED when cap `history` is advertised and OPTIONAL
otherwise; [§4.1](#41-history) defines their use.

Threads are rooms with a `parent_room_id`. Clients that ignore the field
render them as ordinary rooms; clients that understand it group them under
the parent and MAY collapse or hide them. Servers set `title` on threads so
both render.

### 3.5 Messages

A message is one object, at different completeness depending on direction.
A client sends the fields it controls; the server broadcasts the complete
object as an authoritative **snapshot** at one log position.

```jsonc
// ->
{
  "method": "message", "id": "c3", "params": {
    "room_id": "general",
    "body": {"text": "hello *world*", "format": "markdown"}
  }
}
// <-
{"id": "c3", "result": {"message_id": "1724803200042"}}
// <- broadcast to every client in the room, including the sender
{
  "method": "message", "params": {
    "message_id": "1724803200042", "log_id": "1724803200042", "room_id": "general",
    "from": {"user_id": "alice", "name": "Alice"},
    "body": {"text": "hello *world*", "format": "markdown"}
  }
}
```

| field         | set by | meaning                                               |
|---------------|--------|-------------------------------------------------------|
| `message_id`  | server | permanent ID ([§2](#2-identifiers))                                     |
| `log_id`      | server | position of this snapshot in the log ([§2](#2-identifiers))             |
| `prev_log_id` | server | optional; this message's previous snapshot ([§2](#2-identifiers))       |
| `from`        | server | author identity ([§3.3](#33-identity)), preserved across changes      |
| `room_id`     | client | the room the message is in; omitted, the default room |
| `body`        | client | `text`, `format`, `embeds`, `mentions`                |
| `reply_to`    | client | optional message object naming the message replied to |
| `deleted`     | client | tombstone marker, default false ([§4.2](#42-edit))          |
| `ext`         | client | optional object of namespaced, opaque extension data  |

**Extensions.** `ext` carries data the spec does not define, keyed by
namespace:

```json
"ext": {"irc": {"network": "libera", "channel": "#ops", "nick": "ada_", "msgid": "a1b2c3"}}
```

Clients need not parse `ext`, and MUST send it back unchanged when saving a
message ([§4.2](#42-edit)) or room ([§4.3.4](#434-creating-and-editing)) unless they mean to change it.
Data that must survive other clients' saves belongs in `ext`, not in unknown
top-level keys. Servers MAY limit `ext` or normalize or reject any field by
local policy.

- `body` is required on creation. `text` defaults to `""`; `format` ∈
  `"plain" | "markdown"`, default `"plain"`; `embeds` and `mentions`
  default to `[]`.
  Both formats are mandatory to render. Markdown is CommonMark with fenced
  code blocks as the baseline rich-content path. Clients MUST disable raw
  HTML in Markdown or sanitize it under the same allowlist as HTML embeds
  ([§4.6](#46-embeds-and-avatars)). Clients MUST render embeds of unknown `kind` from `og` if
  present, otherwise as a labeled fallback card (kind name, plus `url` or
  plain `text` if present).
- `mentions` lists the `user_id`s the message mentions; see **Mentions**
  below.
- A request without `room_id` posts to the server's default room, and the
  snapshot names it. Posting does not require joining the room; servers MAY
  deny it by policy (`denied`). An unknown or invisible `room_id` is
  `invalid_params`.
- A new message with no `text` and no `embeds` SHOULD be neither logged nor
  broadcast; its result is then `{}`.
- **Result:** `{"message_id": "..."}`, the permanent ID. It is the
  confirmation; the broadcast, delivered to the room's members, MAY arrive
  before or after it, and a deduplicated retry ([§1.2](#12-retries-and-deduplication)) produces no broadcast.
- **Snapshots replace** under the replay rule ([§2](#2-identifiers)), including for messages
  the client has not loaded. Servers MAY publish a snapshot of any message at
  any time, such as edits, deletions, and moves of older messages. Support is
  mandatory regardless of cap `edit`.
- **References.** `reply_to` and `intro_message` hold a message object: bare
  (`message_id` only) from clients, optionally a full snapshot from servers,
  installed like any other. Embedded snapshots carry a bare `reply_to`.
  Clients render the referring message even when the target is missing or
  deleted.
- `reply_to.message_id` MUST name an existing message other than the message
  itself; it MAY be in another room. Invalid references are `invalid_params`.
- On a live connection, servers deliver each room's snapshots in ascending
  `log_id`, and each snapshot once per connection.
- A `message` notification without `message_id` is a transient notice, such
  as a private system notice ([Appendix A.1](#a1-system-identities-and-scoped-notices)): clients render it but never
  install it as a snapshot.

**Mentions.** A message lists the users it mentions in `body.mentions`, and
usually shows each one in `body.text` as `@` followed by the `user_id`
([Appendix A.3](#a3-mention-text)):

```json
"body": {
  "text": "@guest_1234 can you check `@property` in https://example.com/@bob?",
  "format": "markdown",
  "mentions": ["guest_1234"]
}
```

- `mentions` alone decides who is mentioned: servers ([§4.7](#47-push)) and clients
  treat as mentioned only the users it lists, whatever `text` contains.
  Servers never parse `text` to find mentions.
- An edit ([§4.2](#42-edit)) mentions only the users it adds to `mentions`; users
  already listed are not mentioned again.
- Composers add a user to `mentions` when the user picks them, and insert
  `@user_id` in `text`.
- Mentions that notify a whole room are not defined.

### 3.6 Core conformance checklist

Every server:

1. Sends a `server` frame on connect ([§3.1](#31-server-frame)).
2. Accepts at least one `auth` scheme and replies with `you` ([§3.2](#32-authentication)).
3. Accepts `message` without `room_id` into its default room ([§3.5](#35-messages)).
4. Accepts `message` creation: replies with `message_id` and broadcasts the
   snapshot to the room ([§3.5](#35-messages)).
5. Replies `error/unsupported` to unknown requests, including `message` with
   a `message_id` when cap `edit` is absent; ignores unknown notifications.
6. Follows [§1](#1-transport--framing) for framing and retries and [§2](#2-identifiers) for identifiers.

The opening example is a complete session with a server that has cap
`rooms`. A minimal server skips `room_list`: its client posts without
`room_id` and learns the room from the broadcast.

A minimal client (informative):

1. Authenticates with `auth` once `server` arrives, and posts with `message`
   ([§3.2](#32-authentication), [§3.5](#35-messages)).
2. Groups messages by `room_id`, titling a room by its `room_id` unless it
   knows its record ([§3.4](#34-rooms)).
3. Keeps each message's snapshot with the greatest `log_id`, from any
   source, and renders tombstones ([§2](#2-identifiers), [§3.5](#35-messages)).
4. Merges user objects per `user_id`, and shows `Name (@user_id)` when two
   users in a room share a name ([§3.3](#33-identity)).
5. Renders `plain` and `markdown` text with raw HTML disabled, and a
   fallback card for embed kinds it does not support ([§3.5](#35-messages)).
6. Matches replies by `id`, acts on error codes, and ignores unknown
   notifications and keys ([§1](#1-transport--framing)).

---

## 4. Capabilities

`server.caps` advertises optional requests. Capabilities advertise support,
not authorization; servers still apply local policy per request. Each is
designed to degrade gracefully when missing, with nothing to negotiate:
clients ignore caps they do not recognize, unknown methods get
`unsupported` and unknown keys are ignored ([§1](#1-transport--framing)), and a client whose server
lacks a cap falls back as below:

| cap            | adds                                                         | fallback                     | spec                       |
|----------------|--------------------------------------------------------------|------------------------------|----------------------------|
| `history`      | page and recover a room's log                                | session-only scrollback      | [§4.1](#41-history)        |
| `edit`         | `message` saves: edit, move, delete                          | no edit/move/delete UI       | [§4.2](#42-edit)           |
| `rooms`        | `room_list`, `room_join`, `room_leave`, `room_set`, updates  | one default room, no threads | [§4.3](#43-rooms)          |
| `activity`     | typing, read markers, away, and mute                         | no typing or read indicators | [§4.4](#44-activity)       |
| `reactions`    | emoji reactions on messages                                  | reaction controls hidden     | [§4.5](#45-reactions)      |
| `embed:upload` | `upload` embeds: files the sender writes over HTTP           | no attachments               | [§4.6.4](#464-embedupload) |
| `embed:stream` | live-streamed text in a message                              | post the finished text       | [§4.6.5](#465-embedstream) |
| `command`      | commands from client to server, such as `/kick`              | no commands                  | [§4.8](#48-command)        |

Features without a cap: other embeds are body content ([§4.6](#46-embeds-and-avatars)); push
follows `server.push` ([§4.7](#47-push)), passkeys `server.auth` ([§4.9](#49-webauthn-authentication)), and liveness
`server.ping` ([§1](#1-transport--framing)).

- Suggested convention: third-party extension caps use an `ext:` prefix,
  such as `ext:irc`.

Six frame idioms cover everything logged or announced:

- **Records** (room records, `message`): complete state at a `log_id` ([§2](#2-identifiers)).
- **Per-user state** (`reactions`): `from` plus the user's complete state for
  a scope; newest wins per user. Logged ([§2](#2-identifiers)).
- **Activity** (`activity`): `from` plus changes to the user's transient
  state; present fields update it and absent fields leave it unchanged. Not
  part of the append-only log.
- **Announcements** (`server`, `rtc`): unlogged, re-sent in full; each
  replaces the last.
- **Room updates** (`room_update`): unlogged changes to the user's rooms,
  never a full list ([§4.3.3](#433-updates)).
- **Users** (`user`, and every user object): unlogged; each merges into the
  kept object ([§3.3](#33-identity)).

### 4.1 `history`

Stateless window query over a room's **log**. `rooms` holds room records
([§3.4](#34-rooms)), `entries` message snapshots ([§3.5](#35-messages)), and `reactions` reaction sets
([§4.5](#45-reactions)): one log, partitioned by kind. Without `room_id`, it pages the default
room ([§3.5](#35-messages)).

```jsonc
// ->
{
  "method": "history", "id": "c9", "params": {
    "room_id": "general",
    "after": "1724803200000", "before": "1724806800000", "limit": 200
  }
}
// <-
{
  "id": "c9", "result": {
    "rooms": [],
    "entries": [
      {
        "message_id": "1724803200042", "log_id": "1724803200042", "room_id": "general",
        "from": {...}, "body": {...}
      }
    ],
    "reactions": [
      {
        "log_id": "1724803312011", "message_id": "1724803200042", "room_id": "general",
        "reactions": [{"from": {"user_id": "carol", "name": "Carol"}, "emojis": ["👍"]}]
      }
    ],
    "users": [
      {"user_id": "alice", "name": "Alice", "avatar": "https://..."},
      {"user_id": "carol", "name": "Carol"}
    ],
    "first_id": "1724803200042", "last_id": "1724803312011", "more": true,
    "latest_log_id": "1724806800000", "history_log_id": "1724800000000"
  }
}
```

**Membership.** A record belongs to every room its message is in just before
or after it, so a move ([§4.2](#42-edit)) appears in both rooms. Room records
belong to their own room. Earlier history of a moved message stays in the
source room.

**Bounds and ordering.**

- `after`/`before` are inclusive `log_id` bounds; either MAY be omitted.
- Intersect the bounds with available history, then select a contiguous
  slice of the room's changes of either kind. `limit` is a positive count of
  changes, applied before compaction; servers MAY clamp it and supply a
  default. With `after`, select the oldest matches; otherwise the newest.
- `first_id`/`last_id` are the slice's first and last `log_id`s before
  compaction; return both or neither. `more` indicates further matching
  changes in the selected direction. An empty slice returns `entries: []`
  and `more: false`; `rooms` and `reactions` MAY be omitted when empty.
- Continue forward with `after = last_id + 1`, backward with
  `before = first_id - 1`, computed numerically and encoded as strings.
  Never derive continuation from compacted records.
- `rooms`, `entries`, and `reactions` are each ascending by `log_id`.

**Availability.** Every result includes `latest_log_id` and `history_log_id`
([§3.4](#34-rooms)), captured consistently with the page. They describe the room, not the
page. Retention may advance between requests; inspect each response before
applying it. A resource rejection is an error, not an empty result.

**Retention.** Servers SHOULD compact old history at rest rather than discard
it: keep the latest record per key under compaction's rules below. Compacted
history still counts as available, keeps checkpoints valid, and leaves
`history_log_id` in place. A server that truly discards a prefix advances
`history_log_id`; the effective lower bound is `history_log_id`, or
`latest_log_id + 1` when null, and MUST NOT decrease.

**Compaction (optional).** After selecting the slice, a server MAY keep only
the last room record and each message's last snapshot in the slice, and MAY
fold each message's reaction sets into one record carrying each user's last
set in the slice, under the greatest folded `log_id`. Empty sets are kept so
removals replay. Retained records keep their original `log_id`s and contents
and never incorporate changes after the slice. Compacted and uncompacted pages
yield the same terminal state.

**Replay** follows [§2](#2-identifiers). No earlier state is needed to apply a record, and
order across the arrays is irrelevant. `users` holds current user objects
for the page ([§3.3](#33-identity)) and is merged after the records.

**Recovery**, per room:

1. When live delivery starts, after authentication or on joining, buffer
   live records for the room. Take `H` as its `latest_log_id`, from its room
   record ([§4.3.1](#431-listing)) or a `history` page, and keep the buffered records
   above H.
2. Page forward with `before: H`, from `after: C + 1` given a checkpoint C,
   otherwise from `after: history_log_id`, until `more: false`.
3. Apply the buffered records. The checkpoint is now H.

If a response's effective lower bound passes the next position you need,
history was discarded: clear the room's state and restart from that bound.
Clients recover each room they display independently; threads are separate
rooms and load when opened.

### 4.2 `edit`

A `message` request carrying an existing `message_id` **saves** that message:
it replaces every client field ([§3.5](#35-messages)) with the submitted state. Omitted
fields are removed; objects and arrays are replaced whole; `null` has no
deletion meaning. Clients MUST resubmit every client field they want kept,
including `room_id`, `body`, `reply_to`, and `ext`. The server preserves
`message_id`, `from`, and other server fields. Saves apply in server
order with no merge.

```jsonc
// -> edit
{
  "method": "message", "id": "c12", "params": {
    "message_id": "1724803200042", "room_id": "general",
    "body": {"text": "hello world", "format": "plain"}
  }
}
// <-
{"id": "c12", "result": {"message_id": "1724803200042"}}
// <- snapshot with a new log_id
{
  "method": "message", "params": {
    "message_id": "1724803200042", "log_id": "1724803312007", "room_id": "general",
    "from": {"user_id": "alice", "name": "Alice"},
    "body": {"text": "hello world", "format": "plain"}
  }
}
```

An unknown `message_id` is `invalid_params`; a save never creates a message.
Unauthorized saves are `denied` by server policy. The authoritative snapshot
MAY differ from the submitted state.

**Move.** A save with a different `room_id` moves the message. The
destination MUST exist and be visible to the caller. The snapshot is
delivered to both rooms ([§4.1](#41-history)), and clients re-home the message rather
than treating it as deleted. If the message has reactions, the server then
logs one reactions record ([§4.5](#45-reactions)) in the destination carrying every
non-empty set, so reactions follow the message.

```jsonc
// -> move Bob's reply into thread room 1724803312001
{
  "method": "message", "id": "c15", "params": {
    "message_id": "1724803200043", "room_id": "1724803312001",
    "reply_to": {"message_id": "1724803200042"},
    "body": {"text": "Hello back!"}
  }
}
```

**Delete** is a save with `deleted: true`; `body` is then optional and the
server MUST omit it from the tombstone. `deleted: true` on creation is
`invalid_params`. Other client fields keep replacement semantics.

```jsonc
// ->
{
  "method": "message", "id": "c14", "params": {
    "message_id": "1724803200043", "room_id": "1724803312001", "deleted": true
  }
}
// <-
{
  "method": "message", "params": {
    "message_id": "1724803200043", "log_id": "1724803312050", "room_id": "1724803312001",
    "from": {"user_id": "bob", "name": "Bob"},
    "deleted": true
  }
}
```

Clients render tombstones and hide their reactions.

**Redaction.** Earlier snapshots of a deleted message still hold its content.
A server MAY rewrite them, and embedded copies of them ([§3.5](#35-messages)), into
tombstones at their original `log_id`s. This is the only permitted rewrite
of a logged record. Replay reaches the same terminal state either way;
clients holding the old content drop it on the new tombstone.

### 4.3 `rooms`

Cap `rooms` adds rooms to find, join, and create, and threads. Five methods
share the `room_` prefix: `room_list`, `room_join`, `room_leave`, and
`room_set` are requests; `room_update` is a notification. Visibility and
membership are server policy.

#### 4.3.1 Listing

`room_list` answers with the rooms matching its filters, as
room records ([§3.4](#34-rooms)) in two arrays: `joined`, rooms the user has joined, and
`rooms`, visible rooms the user has not joined. Listing never joins.

```jsonc
// -> my rooms, threads included
{"method": "room_list", "id": "c20", "params": {"only_joined": true}}
// <-
{
  "id": "c20", "result": {
    "joined": [
      {
        "room_id": "general", "log_id": "1724800000000", "title": "General",
        "latest_log_id": "1724803500000", "history_log_id": "1724800000000",
        "member_count": 12
      },
      {
        "room_id": "1724803312001", "log_id": "1724803312001",
        "parent_room_id": "general", "title": "Deploy", "intro_message": {...},
        "latest_log_id": "1724803400000", "history_log_id": "1724803312001",
        "member_count": 2,
        "members": [{"user_id": "alice"}, {"user_id": "bob"}]
      }
    ],
    "users": [
      {"user_id": "alice", "name": "Alice", "avatar": "https://..."},
      {"user_id": "bob", "name": "Bob"}
    ]
  }
}
// -> reconnecting: only my rooms with activity since a position
{"method": "room_list", "id": "c21", "params": {"only_joined": true, "latest_log_id": "1724803450000"}}
// -> general's threads I have not joined
{"method": "room_list", "id": "c22", "params": {"parent_room_id": "general", "not_joined": true}}
// -> one room, with its members
{"method": "room_list", "id": "c23", "params": {"room_id": "1724803312001"}}
```

Every filter is optional:

- `only_joined` and `not_joined` let the server leave out `rooms` or
  `joined`, respectively.
- `parent_room_id` lists only that room's threads. Without it, `joined`
  holds joined rooms at every depth, threads included, and `rooms` only
  top-level rooms.
- `room_id` lists only that visible room, such as for its members. It
  overrides `parent_room_id`; an unknown or invisible `room_id` is
  `invalid_params`. Servers SHOULD accept it.
- `latest_log_id` lists only rooms whose `latest_log_id` is greater. A room
  joined or left since then may be missing from such a result; a client
  that needs its full membership lists with `only_joined` alone.

A result lists rooms matching its filters, most recently active first.
`joined` lists every match and is never truncated; servers MAY list only
the most recently active of `rooms`, and a room left out is still visible
and can be joined.

Each room carries `member_count`, how many users have joined it, and
`members`, user objects ([§3.3](#33-identity)): either complete, or `user_id` only with the
complete objects in the result's `users`. Servers MAY truncate or omit
`members` and MAY omit `member_count`, which stays the total. A client given
no `members` learns a room's members from its history and from joins ([§4.3.2](#432-membership)).

#### 4.3.2 Membership

`room_join` and `room_leave` take only a `room_id` and
return `{}`. Joining subscribes: every connection of the user receives
deliveries for the joined room, and under the suggested wake rule only
joined rooms notify ([§4.7](#47-push)).
An unknown or invisible `room_id` is `invalid_params`; the server MAY deny
either by policy.

The room's other members MAY be told with a `user` notification ([§3.3](#33-identity))
carrying `room_id`: `new` alone announces a join, `old` alone a leave. They
are sent as they happen, never as a member list, and servers MAY skip them,
such as in large rooms; the members a client learns this way are partial.

```jsonc
// ->
{"method": "room_join", "id": "c24", "params": {"room_id": "1724803399000"}}
// ->
{"method": "room_leave", "id": "c25", "params": {"room_id": "1724803312001"}}
// <- to the members of general, when Ada joins it and later leaves
{"method": "user", "params": {"room_id": "general", "new": {"user_id": "ada", "name": "Ada"}}}
{"method": "user", "params": {"room_id": "general", "old": {"user_id": "ada"}}}
```

#### 4.3.3 Updates

`room_update` tells the user's connections what changed, never
the full list:

- `joined`: room records of rooms the user joined, on any connection, by
  creating them, or by the server's doing.
- `left`: `[{room_id}]` of rooms the user is no longer in: left, removed,
  no longer visible, or deleted.
- `updated`: room records that are new or changed while membership is not:
  an edit to a joined room, or a new thread in one.

```jsonc
// <- after the join above
{"method": "room_update", "params": {"joined": [{"room_id": "1724803399000", "parent_room_id": "general", "title": "Incident", ...}]}}
// <- after the leave above
{"method": "room_update", "params": {"left": [{"room_id": "1724803312001"}]}}
// <- a joined room was renamed
{"method": "room_update", "params": {"updated": [{"room_id": "general", "log_id": "1724803600000", "title": "General (ops)", ...}]}}
```

#### 4.3.4 Creating and editing

`room_set` without `room_id` creates a room and
joins the creator; with `room_id` it replaces the client fields ([§3.4](#34-rooms))
other than `parent_room_id`, which is fixed at creation, and omitted fields
are cleared. Both return `{"room_id": "..."}`, and the change arrives as a
`room_update`.

```jsonc
// -> start a thread on an existing message
{
  "method": "room_set", "id": "c26", "params": {
    "parent_room_id": "general", "title": "Deploy",
    "intro_message": {"message_id": "1724803200042"}
  }
}
// <-
{"id": "c26", "result": {"room_id": "1724803312001"}}
// <- to the creator; the server embedded the intro snapshot
{
  "method": "room_update", "params": {
    "joined": [
      {
        "room_id": "1724803312001", "log_id": "1724803312001",
        "parent_room_id": "general", "title": "Deploy",
        "intro_message": {
          "message_id": "1724803200042", "log_id": "1724803200042", "room_id": "general",
          "from": {...}, "body": {...}
        },
        "latest_log_id": "1724803312001", "history_log_id": "1724803312001"
      }
    ]
  }
}
```

- `parent_room_id` MUST name an existing visible room. Nesting depth is
  server policy.
- `intro_message` is a bare reference on input. It MAY live in any room; for
  a thread it is usually the parent-room message that started it. Its text is
  updated by saving that message ([§4.2](#42-edit)), not by `room_set`. A
  described top-level room takes three steps: create it, post the description
  in it, then `room_set` with `room_id` and `intro_message`.
- The server MAY adjust or supply metadata by policy. Unknown `room_id`,
  unknown `parent_room_id`, or invalid types are `invalid_params`;
  unauthorized requests are `denied`.

#### 4.3.5 Posting

Posting in a room does not require joining it ([§3.5](#35-messages)). The server MAY
deny the post, or MAY join the poster. A poster who has not joined does not
receive the broadcast; the result is the confirmation.

### 4.4 `activity`

Cap `activity`. A client reports changes to its activity as a
notification: typing and how far it has read in a room, and optionally
whether anyone is attending the connection and what the user has muted.
Each present field updates that state; absent fields leave it unchanged.
Activity is not part of the append-only log. Servers MAY drop `typing` and
`read_message_id`, but apply the latest `away` and `mute` they support.

```jsonc
// -> start typing
{"method": "activity", "params": {"room_id": "general", "typing": 8}}
// -> stop typing
{"method": "activity", "params": {"room_id": "general", "typing": 0}}
// -> advance the read cursor
{"method": "activity", "params": {"room_id": "general", "read_message_id": "1724803312050"}}
// -> nobody is attending this connection, such as an unfocused tab
{"method": "activity", "params": {"away": true}}
// -> no notifications from general for 8 hours; then none from anywhere
{"method": "activity", "params": {"room_id": "general", "mute": 28800}}
{"method": "activity", "params": {"mute": 3600}}
// <- (broadcast)
{
  "method": "activity", "params": {
    "room_id": "general", "from": {"user_id": "alice"},
    "typing": 8, "read_message_id": "1724803312050"
  }
}
```

- `typing` (seconds): show the user as typing for up to that long, or until
  a new message from them arrives. `0` stops.
- `read_message_id`: the user has read the room up to and including that
  message. Clients only advance it, and servers MAY ignore a cursor that
  moves back.
- Delivery is server policy: to the room, which shows read receipts, or only
  to the user's own connections, which syncs read cursors across devices.
- Servers MAY keep each user's latest `read_message_id` per room and send
  it to the user's connections after they list the room ([§4.3.1](#431-listing)).
- `away` (optional): `true` when nobody is attending this connection, such as
  an unfocused tab, a backgrounded app, or a connection opened to fetch after
  a push. It applies to the sending connection only and ends with `away:
  false`, `typing`, `read_message_id`, or a `message` from that connection, or
  the connection closing; fetching history does not end it. Servers MAY hold
  back unlogged frames, such as typing, from away connections, and use it to
  decide pushes ([§4.7](#47-push)).
- `mute` (optional, seconds): the user wants no notifications from the
  room named by `room_id`, or from every room without one, for that long.
  `0` clears it. Each scope is set and cleared on its own: clearing the
  all-rooms mute leaves a muted room muted. What muting holds back, such as
  whether mentions still notify, is server policy; servers MAY cap the
  duration.
- `away` is never delivered. Servers keep `mute` and send it only to the
  user's own connections, with the seconds remaining, so devices agree.
- There is no presence system.

### 4.5 `reactions`

Cap `reactions`. A client sets its own complete set of emoji on one message;
omitted emoji are removed and `[]` clears. The server logs the change with a
`log_id` and broadcasts it to the message's room. The result is `{}`; the
broadcast carries the state.

```jsonc
// ->
{"method": "reactions", "id": "c17", "params": {"message_id": "1724803200043", "emojis": ["👍"]}}
// <-
{"id": "c17", "result": {}}
// <- (broadcast)
{
  "method": "reactions", "params": {
    "log_id": "1724803312011", "message_id": "1724803200043", "room_id": "1724803312001",
    "reactions": [{"from": {"user_id": "carol", "name": "Carol"}, "emojis": ["👍"]}]
  }
}
```

- The request names only the message. The logged record carries the room the
  message was in at that moment, which may differ from its current room
  after a move ([§4.1](#41-history)).
- The notification's `reactions` array holds one element per user. Live
  broadcasts carry one; compacted history records ([§4.1](#41-history)) MAY carry
  several. Each element replaces that user's set on that message.
- Clients keep state per `(message_id, user_id)` and derive the aggregate:
  counts per emoji, who reacted, and whether `you.user_id` did. They tolerate
  reactions for messages they have not loaded.
- `emojis` entries are strings; duplicates collapse and order is
  insignificant. One emoji sequence per entry is the interoperable baseline.
  Servers MAY normalize, reject other strings, or cap distinct emoji per
  message or per user, all `invalid_params`. An unknown `message_id` is
  `invalid_params`. A request that leaves state unchanged MAY produce no
  change.
- Retries follow [§1.2](#12-retries-and-deduplication). Push wake-ups for reactions are server policy.

### 4.6 Embeds and avatars

`body.embeds` holds rich content in display order; `kind` selects
the renderer. Unknown kinds render from `og`, or else the fallback card
([§3.5](#35-messages)).

```json
{"embed_id": "embed_1240", "kind": "upload", "title": "report.pdf", "url": "https://chat.example/f/Qm7xk2…"}
{"embed_id": "embed_1241", "kind": "iframe", "url": "https://backend:8443/term/abc", "height": 300}
{"embed_id": "embed_1242", "kind": "html", "html": "<table>…</table>"}
```

- `iframe`: render with `sandbox="allow-scripts"` and **never**
  `allow-same-origin` alongside it; no top navigation or popups; restrictive
  Permissions-Policy; clamped dimensions (`height` is a suggestion); lazy
  loading; a cap on concurrently live iframes. Intended for backend-served
  live views such as terminals and dashboards.
- `html`: sanitize with an allowlist sanitizer (e.g. DOMPurify) before
  insertion, regardless of source. Servers make no safety promises about
  content flowing through them.
- `upload` is [§4.6.4](#464-embedupload), and `stream` is [§4.6.5](#465-embedstream).

#### 4.6.1 OpenGraph metadata (`og`)

Any embed MAY carry `og`, an [OpenGraph](https://ogp.me/)
description of its content as JSON: property names without the `og:`
prefix, with structured properties nested (`og:image:width` becomes
`image.width`).

```json
"og": {
  "title": "before.png",
  "image": {"url": "https://chat.example/f/Zr8Tq1…/thumb", "type": "image/webp", "width": 320, "height": 180, "alt": "Dashboard before the fix"}
}
```

- Clients render kinds they support natively and draw the rest from `og`
  ([§3.5](#35-messages)): `title`, `description`, `site_name`, and `image`, `video`, and
  `audio` (each with `url`, `type`, `width`, `height`, `alt`). They ignore
  other properties.
- `og.image` is a preview to show, `og.video` and `og.audio` are what a
  player loads, and the embed's own `url` is where a click goes.
- Servers SHOULD be the source of truth for `og`: they set it in the
  broadcast and MAY keep, replace, or drop one a client sent. They SHOULD
  host or proxy the media it references and set its dimensions. Clients
  SHOULD NOT load `og` media from other origins.

#### 4.6.2 Embed identity

Servers that advertise any `embed:*` cap assign each
embed an opaque `embed_id`; other servers MAY store embeds as given.

- A save keeps an embed by sending it back with its `embed_id`. An embed
  without one is new, an `embed_id` left out removes that embed, and an
  unknown `embed_id` is `invalid_params`.
- The server owns `embed_id`, an upload's `url`, and a stream's `url` and
  `text`. It ignores them on input and restores them on a save from
  its records.
- Content the server hosts for an embed belongs to that message. When the
  embed is removed or the message is deleted or redacted, servers SHOULD
  delete the content.
- Anyone with a URL the server hosts can fetch it, so servers SHOULD make
  these URLs unguessable, such as with a random path segment, not just the
  `embed_id`.
- Suggested convention: `embed_` plus a server-wide counter, such as
  `embed_1234`.

#### 4.6.3 Writes

New `upload` and `stream` embeds take their content over HTTP.
The `message` or `command` ([§4.8](#48-command)) result lists them, in request order:

```jsonc
// -> the sender attaches a file
{
  "method": "message", "id": "c8", "params": {
    "room_id": "general",
    "body": {"text": "Before the fix:", "embeds": [{"kind": "upload", "title": "before.png"}]}
  }
}
// <-
{
  "id": "c8", "result": {
    "message_id": "1724803500000",
    "embeds": [{"embed_id": "embed_1235", "kind": "upload", "write_url": "https://chat.example/w/4c7a…"}]
  }
}
// sender: curl -T before.png https://chat.example/w/4c7a…
// <- the embed as broadcast: pending, then completed in a later snapshot
{"embed_id": "embed_1235", "kind": "upload", "title": "before.png"}
{
  "embed_id": "embed_1235", "kind": "upload", "title": "before.png",
  "url": "https://chat.example/f/Zr8Tq1…",
  "og": {
    "title": "before.png",
    "image": {"url": "https://chat.example/f/Zr8Tq1…/thumb", "type": "image/webp", "width": 320, "height": 180}
  }
}
```

- The sender sends the content as an HTTP request body to `write_url`.
  `write_url` is a credential and expires if unused.
- The server finishes each write exactly once: on success it publishes a
  snapshot with the embed completed; if the write never starts in time or
  fails, it publishes a snapshot without the embed. For a command, the server
  acts on the finished write instead, such as setting an avatar ([§4.6.6](#466-avatars)).

#### 4.6.4 `embed:upload`

Cap `embed:upload`. The sender gives an optional `title`, such
as the file name. While `url` is absent the upload is pending, and clients
show a placeholder. On success the server sets `url` to the file it hosts.

- The server SHOULD add `og` describing the file: `image` for a preview,
  and `video` or `audio` for playable media. It MAY keep what the sender
  gave, such as `og.image.alt`.
- Without `og`, clients show a file card: `title` linking to `url`.

#### 4.6.5 `embed:stream`

Cap `embed:stream`. A message can carry live text that the sender writes over
HTTP while readers watch it grow. Stream embeds follow the embed identity
([§4.6.2](#462-embed-identity)) and write ([§4.6.3](#463-writes)) rules.

```jsonc
// -> the embed in a message request; the result and write follow §4.6.3
{"kind": "stream", "format": "terminal"}
// sender: foo 2>&1 | curl -T - <write_url>
// <- the embed as broadcast: live at its url, then finished with the kept text
{"embed_id": "embed_1234", "kind": "stream", "format": "terminal", "url": "https://chat.example/s/p3Wn9d…"}
{"embed_id": "embed_1234", "kind": "stream", "format": "terminal", "text": "…"}
```

- `format` names how to render the text; default `"plain"`, shown as is with
  line breaks kept. Clients MAY support other formats natively, such as
  `"markdown"` (rendered under [§3.5](#35-messages)'s rules) or `"terminal"`, and render
  unknown formats as plain.
- Write: the sender sends UTF-8 text as a streaming HTTP request body to
  `write_url`. The end of the body ends the stream.
- Read: `GET url` returns the text the server has kept, continues as more
  arrives, and ends when the stream does. A reader that reconnects replaces
  what it has shown with the new response.
- Finish: when the stream ends, the server publishes a snapshot whose embed
  carries the kept text as `text` in place of `url`, and both URLs stop
  working. A sender with cap `edit` MAY save the message without the embed
  first, which ends the stream.
- How much text the server keeps, size and time limits, and the grace period
  after a writer disconnects are server policy. At a limit, the server ends
  the stream and keeps the trailing text.
- `url` is served by the chat server; clients SHOULD NOT connect to stream
  URLs on other origins.

#### 4.6.6 Avatars

A user object ([§3.3](#33-identity)) MAY carry `avatar`, an image shown beside
the user's name.

- Servers send `avatar` in `you`, `user`, `members`, and `users` ([§3.3](#33-identity)),
  not in every `from`.
- Servers SHOULD return only `https:` URLs or small
  `data:image/{png,jpeg,gif,webp};base64,` URLs. A larger image goes through
  an upload (caps `command` and `embed:upload`): a `/avatar` command ([§4.8](#48-command))
  with one `upload` embed asks the server to use that file as the sender's
  avatar. The result carries the write URL, and the server sets `avatar` and
  sends `user` ([§3.3](#33-identity)) when the upload completes.
- Clients own their security boundary and choose which sources to load; they
  MAY ignore any avatar. Load values only as images, never as documents, and
  bind or escape them rather than interpolating them into HTML.
- Without a usable avatar, clients draw a placeholder such as initials.

### 4.7 Push

`server.push` ([§3.1](#31-server-frame)) maps each supported push kind to its public
configuration. Its presence enables `push_register` and `push_unregister`.

```jsonc
// <- in the server frame; the second kind is illustrative
"push": {"relay": {}, "webpush": {"key": "BNcR..."}}
// ->
{
  "method": "push_register", "id": "c30", "params": {
    "kind": "relay", "url": "https://relay.example/p/xyz", "token": "..."
  }
}
// ->
{"method": "push_unregister", "id": "c31", "params": {"url": "https://relay.example/p/xyz"}}
```

- `kind` names a key of `server.push`; the other fields are specific to that
  kind. Unknown kinds are `invalid_params`. Third-party kinds use the `ext:`
  prefix ([§4](#4-capabilities)).
- `url` is required and identifies the registration. Registering the same
  `url` again replaces it; `push_unregister` removes it. Clients SHOULD
  register on each connection.
- `relay`: the server POSTs the payload as JSON to `url` with `token` as
  bearer. Delivery beyond that POST (APNs/FCM, coalescing) is the relay's
  concern; native apps use a relay run by their vendor. Other kinds define
  their own delivery outside this spec.
- Every kind delivers the same payload: a message object ([§3.5](#35-messages)) without
  `log_id`, so clients render it but never install it as a snapshot. `body`
  MAY be truncated or omitted; servers SHOULD omit `format` and `embeds`.
- Wake policy is server-defined.
- Suggested convention: wake a user only for rooms they have joined ([§4.3.2](#432-membership)),
  when every connection of theirs is away or gone ([§4.4](#44-activity)) and neither
  that room nor all rooms are muted for them. Servers MAY wait briefly first
  and skip the push if the user's `read_message_id` has passed the message.

```json
{
  "message_id": "1724803200042", "room_id": "general",
  "from": {"user_id": "alice", "name": "Alice"},
  "body": {"text": "Deploy is done, can someone check the dashboards?"}
}
```

Registered endpoints are client-supplied URLs the server will POST to, an
SSRF vector into the server's network. Servers SHOULD accept only `https`
endpoints resolving to non-internal addresses.

### 4.8 `command`

Cap `command`. A `command` request sends an instruction to the server. It
takes the same params as creating a message ([§3.5](#35-messages)) and differs only in what
happens to it:

- `body.text` is the command line as the user typed it, slash included; the
  server parses it. Clients send composer text that starts with `/` as a
  `command`, and text that starts with `//` as a message starting with `/`.
- A command is never logged, broadcast, or saved, and has no `message_id`.
  `message_id` and `deleted` are `invalid_params`.
- `mentions`, `reply_to`, and `embeds` are arguments. Mentioned users are
  not notified.
- The result is `{}`, or `{"embeds": [...]}` with write URLs for new
  `upload` embeds ([§4.6.3](#463-writes)). A failure is an ordinary error whose
  `message` the client shows.
- The server replies, when it needs to, with system notices ([Appendix A.1](#a1-system-identities-and-scoped-notices)):
  `@private` to the sender, `@room` to the room, `@server` to everyone.
  Effects arrive as the frames they cause, such as `room_update`.
- Retries follow [§1.2](#12-retries-and-deduplication), so a retried command does not run twice.
- Commands are for what a server provides beyond this spec. Which exist,
  their arguments, and who may use them are server policy.
- Servers that support commands SHOULD provide `/help`, replying with a
  `@private` notice that lists the commands available to the sender, with
  their arguments and what they do.
- Clients MAY handle commands that match a request themselves, such as
  `/nick` as `me`, `/topic` as `room_set`, `/join` as `room_join`, `/leave`
  as `room_leave`, and `/mute` as `activity`, and send the rest as
  `command`.

```jsonc
// -> remove a user from the room; mentions name the target
{
  "method": "command", "id": "c30", "params": {
    "room_id": "general",
    "body": {"text": "/kick @guest_1234 spamming", "mentions": ["guest_1234"]}
  }
}
// <-
{"id": "c30", "result": {}}
// <- to the room
{
  "method": "message", "params": {
    "message_id": "1724803900001", "log_id": "1724803900001", "room_id": "general",
    "from": {"user_id": "@room", "name": "General"},
    "body": {"text": "@guest_1234 was removed by @alice: spamming"}
  }
}
// <- to guest_1234's connections
{"method": "room_update", "params": {"left": [{"room_id": "general"}]}}

// -> answer an agent's permission prompt by replying to it
{
  "method": "command", "id": "c31", "params": {
    "room_id": "agent", "reply_to": {"message_id": "1724803900000"},
    "body": {"text": "/approve"}
  }
}
// <- or, from a user without the right
{"id": "c31", "error": {"code": -32001, "message": "Only the session owner can approve"}}

// -> list the available commands
{"method": "command", "id": "c32", "params": {"room_id": "general", "body": {"text": "/help"}}}
// <-
{"id": "c32", "result": {}}
// <- to the sender only
{
  "method": "message", "params": {
    "room_id": "general",
    "from": {"user_id": "@private", "name": "Only you"},
    "body": {
      "text": "- `/kick @user [reason]`: remove someone from this room\n- `/avatar` with an image: set your avatar",
      "format": "markdown"
    }
  }
}

// -> set an avatar from an upload (§4.6.6)
{
  "method": "command", "id": "c33", "params": {
    "body": {"text": "/avatar", "embeds": [{"kind": "upload", "title": "me.png"}]}
  }
}
// <-
{
  "id": "c33", "result": {
    "embeds": [{"embed_id": "embed_1300", "kind": "upload", "write_url": "https://chat.example/w/9c1e…"}]
  }
}
```

### 4.9 WebAuthn authentication

Servers advertising `webauthn` in `server.params.auth` MUST use this
exchange; no separate capability is needed.

Both steps are `auth` requests with string IDs and `scheme: "webauthn"`. Use
`action: "register"` to create a credential or `action: "login"` to sign in,
unchanged between steps. Notifications do not run ceremonies.

| Step     | Additional request fields                      | Successful result                                        |
|----------|------------------------------------------------|----------------------------------------------------------|
| `begin`  | `step: "begin"`                                | `challenge_id` (opaque), `public_key` (WebAuthn options) |
| `finish` | `step: "finish"`, `challenge_id`, `credential` | `you` ([§3.3](#33-identity))                                             |

`public_key` holds creation options for registration or request options for
login, in standard
[WebAuthn JSON](https://www.w3.org/TR/webauthn-3/#sctn-parseCreationOptionsFromJSON)
with binary fields as unpadded base64url. Clients pass them to
`navigator.credentials.create` or `.get` and return the credential in
`finish`. Registration MUST require discoverable credentials; login omits
`allowCredentials` or sends an empty array. Both require user verification.

Challenges MUST be unpredictable, expiring, and bound to the connection,
action, RP ID, allowed origin, and any proposed registration identity. Keep
one pending ceremony per connection: a new begin replaces it, disconnect
invalidates it, and a matching finish consumes it even on failure. Servers
MUST perform
[WebAuthn verification](https://www.w3.org/TR/webauthn-3/#sctn-rp-operations)
before recording credentials or authenticating.

Only a verified finish returns `you`. Begin
or failure does not change existing authentication. Registration
eligibility and reauthentication permission are server policy. Malformed
fields are `invalid_params`; invalid challenges, failed verification, or
policy rejection are `denied`.

**Session resume (optional).** A server that also advertises `token` MAY
include `token` in a verified `finish` result. The client MAY present it on
later connections with `scheme: "token"` to resume the identity without a new
ceremony; the result MAY carry a replacement `token`, superseding the
presented one. Servers MUST bind such tokens to the ceremony's allowed
origin, MUST expire them, and reject unknown, expired, or mismatched tokens
with `denied`. Lifetime, renewal, and revocation are server policy. Clients
that ignore `token` remain conforming.

---

## Appendix A — Conventions (informative)

### A.1 System identities and scoped notices

`user_id`s beginning with `@` are reserved for server-controlled identities,
such as `@sfu` for a media server ([Appendix C.1](#c1-webrtc-signaling-for-audio-video-and-peer-to-peer-connections)). Servers SHOULD NOT assign
them to users. They carry an ordinary `from` and render like any sender, so
clients unaware of the convention still work; clients MAY style them as
system messages.

Three of them tell the receiver who else got the message:

| `from.user_id` | received by                   | logged | for example                                  |
|----------------|-------------------------------|--------|---------------------------------------------|
| `@server`      | every user on the server      | yes    | maintenance notices, announcements           |
| `@room`        | every member of the room      | yes    | joins and leaves, removals, poll results     |
| `@private`     | only this user                | no     | welcomes, command replies, errors, reminders |

- `room_id` is where the message is shown. A notice about no room in
  particular goes in room `@server`, which every user receives without
  joining; clients unaware of it show it as a room of its own. Room IDs
  beginning with `@` are reserved for such server-defined rooms.
- `@private` messages are not logged and carry neither `log_id` nor
  `message_id`. Like push payloads ([§4.7](#47-push)), clients render them but
  never install them as snapshots, and they are not in history. A private
  notice that should last belongs in a room of its own.

```jsonc
// <- to everyone on the server
{
  "method": "message", "params": {
    "message_id": "1724803500001", "log_id": "1724803500001", "room_id": "@server",
    "from": {"user_id": "@server", "name": "Server"},
    "body": {"text": "Maintenance at 17:00 UTC."}
  }
}
// <- to everyone in general
{
  "method": "message", "params": {
    "message_id": "1724803500002", "log_id": "1724803500002", "room_id": "general",
    "from": {"user_id": "@room", "name": "General"},
    "body": {"text": "@guest_1234 joined"}
  }
}
// <- to the new member only, shown in general
{
  "method": "message", "params": {
    "room_id": "general",
    "from": {"user_id": "@private", "name": "Only you"},
    "body": {"text": "Welcome to General! Deploy chatter goes in threads."}
  }
}
```

### A.2 Field naming

Entity ID fields use the `_id` suffix (`user_id`, `room_id`, `message_id`,
`embed_id`, `parent_room_id`, `session_id`). Embedded objects use descriptive
names (`from`, `body`, `reply_to`, `intro_message`). JSON-RPC's envelope `id`
keeps its name. Extensions and future methods should follow the same pattern.

### A.3 Mention text

In `body.text`, a mention ([§3.5](#35-messages)) usually appears as `@` followed by an ID:

- The ID is an optional `@` then a run of `[A-Za-z0-9_.-]`, not preceded by
  a letter or digit, so `foo@bar.com` is not one. Trailing `.` and `-` are
  not part of it. Servers that want users and rooms to be mentionable mint
  IDs from that set, such as `guest_1234`. System identities ([A.1](#a1-system-identities-and-scoped-notices)) take a
  second `@`, as in `@@server`.
- How `text` renders is up to the client. Clients MAY show an `@id` naming
  a known user with the user's latest display name ([§3.3](#33-identity)), such as a chip,
  and one naming a room as a link to the room, wherever their formatting
  allows. When an ID names both a user and a room, clients treat it as a
  user. Unknown IDs render as written.

---

## Appendix B — Multiplexing envelope (informative)

Multiple logical protocol connections can share one physical WebSocket via an
aggregator that proxies backends. This envelope is outside the core protocol.

A mux endpoint wraps every core frame in an envelope with an opaque
connection ID:

```json
{"conn_id": "b1", "frame": {"method": "message", "id": "c3", "params": {"room_id": "general", "body": {}}}}
```

Each `conn_id` carries an independent core session. Frame ordering is
preserved per `conn_id`, not across them. Control uses unwrapped frames:

```jsonc
// ->
{"type": "conn_open", "conn_id": "b1", "url": "wss://backend.example/ws"}
// <-
{"type": "conn_ready", "conn_id": "b1"}
// <-
{"type": "conn_error", "conn_id": "b1", "code": "unreachable", "message": "..."}
// <- or ->
{"type": "conn_close", "conn_id": "b1"}
```

`conn_id` is chosen by the opener, unique per socket. After `conn_ready`, the
backend's `server` frame arrives wrapped, first on that `conn_id`.
`conn_close` from either side ends the logical connection. The aggregator
forwards inner frames unparsed and holds only the `conn_id`↔upstream mapping;
backends remain authoritative, and frames may be encrypted end to end.
Aggregator authentication is deployment-defined.

---

## Appendix C — Under consideration

Designs that are not yet part of the protocol, kept here so implementations
can experiment and converge on them.

### C.1 WebRTC: signaling for audio, video, and peer-to-peer connections

Planned capability `rtc`: the socket carries signaling; media travels out of
band. Future channels (screenshare, documents, file transfer) should reuse
the pattern: a server-announced session with authoritative membership, a join
request returning connection configuration, and an opaque relay frame.

**Sessions** are announcements ([§4](#4-capabilities)):

```jsonc
// <-
{
  "method": "rtc", "params": {
    "room_id": "general", "session_id": "call_7", "kind": "voice",
    "members": [{"user_id": "alice", "name": "Alice"}],
    "active": true
  }
}
```

Re-sent on membership change; `"active": false` ends the session.

**Join / leave.** ICE configuration is vended at join, since TURN credentials
are deployment-specific and short-lived. A client MAY propose a session with
a fresh `session_id`; the server confirms with an `rtc` frame or replies
`denied`.

```jsonc
// ->
{"method": "rtc_join", "id": "c40", "params": {"room_id": "general", "session_id": "call_7"}}
// <-
{
  "id": "c40", "result": {
    "ice": [
      {"urls": "stun:stun.example:3478"},
      {"urls": "turn:turn.example", "username": "u", "credential": "c"}
    ]
  }
}
// ->
{"method": "rtc_leave", "id": "c41", "params": {"session_id": "call_7"}}
```

**Signaling relay.** The server routes `rtc_signal` by the required
`to.user_id` within the session and attaches the sender's `from`. WebRTC
handles loss and renegotiation.

```jsonc
// ->
{
  "method": "rtc_signal", "params": {
    "session_id": "call_7", "to": {"user_id": "bob"},
    "payload": {"sdp_type": "offer", "sdp": "v=0..."}
  }
}
// <-
{
  "method": "rtc_signal", "params": {
    "session_id": "call_7", "from": {"user_id": "alice", "name": "Alice"},
    "payload": {"sdp_type": "offer", "sdp": "v=0..."}
  }
}
```

**Topology.** Mesh is the baseline: peers negotiate pairwise and the server
only relays; clients SHOULD soft-cap participants. A future cap `rtc.sfu`
adds a media server joining as member `@sfu` ([Appendix A.1](#a1-system-identities-and-scoped-notices)), with which
clients negotiate a single PeerConnection.

**Exclusions.** Mute and camera state are derivable from media streams.
Invite/ring/reject state machines are covered by an `rtc` frame plus a push
notification. Recording and transcoding are server-side.
