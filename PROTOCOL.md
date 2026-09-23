# Apron Chat Protocol

Apron Chat Protocol is designed to be easy to implement in semi-trusted
environments. It runs over a WebSocket, or most other transports. The goal is
an ecosystem of many Apron Chat apps and servers that can speak with each
other: local bridges to other protocols, coding harnesses, internal message
rooms.

The protocol is incremental. The mandatory core (§3) is all a minimal
implementation needs, about a hundred lines. Everything else is an optional
capability: §4 lists them, the appendices specify them.

A first exchange. After the WebSocket opens, the server announces itself,
accepts authentication, and announces visible rooms. The client sends
messages; the server broadcasts them to every client in the room, including
the sender.

```jsonc
// <- server greeting with auth schemes
{"method": "server", "params": {"protocol": 4, "auth": ["guest", "token"]}}

// -> guest auth, requesting a display name
{"method": "auth", "id": "c1", "params": {"scheme": "guest", "name": "Ada"}}

// <- assigned identity
{"id": "c1", "result": {"you": {"user_id": "guest_1234", "name": "Ada"}}}

// <- visible rooms
{"method": "room", "params": {"room_id": "general", "title": "General"}}

// -> post a message
{"method": "message", "id": "c2", "params": {"room_id": "general", "body": {"text": "Hello"}}}

// <- confirmation
{"id": "c2", "result": {"message_id": "1724803200042"}}

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
  log: every change to a room, message, or reaction is a record in it (§2).

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
  `jsonrpc` key in replies. Extension data goes in `ext` (§3.5).
- Servers MAY process requests concurrently and reply in any order. A client
  that needs one request applied before another waits for the first reply.
- Server announcements and broadcasts are notifications.
- Unknown methods: servers reply `error/unsupported` to requests and ignore
  notifications; clients ignore unknown notifications.
- Frame size: implementations SHOULD accept frames up to 256 KiB and MAY
  reject larger requests with `error/too_large`; oversized notifications may
  be dropped. The limit is advisory.
- There is no application-level heartbeat; on WebSocket, liveness uses
  ping/pong.

### 1.1 Envelope and replies

Requests carry a string `id` (§2); frames with a `method` and no `id` are
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
{"method": "activity", "params": {"room_id": "general", "timeout": 8}}
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
  records (§3.4), message snapshots (§3.5), reaction sets (Appendix D).
- Value is the commit time, or the previous `log_id + 1` if the clock has not
  advanced past it.
- Clients MAY use it as a timestamp (this is the only one).
- Positive, below `2^53`, compared numerically. Clients MAY parse as integers.
- Unique within one server only; namespacing across servers is client-defined.
- A room's log is the subsequence of records that touch that room
  (Appendix A).
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
  retained (Appendix A); there is no lookup by `log_id`.
- Suggested convention: holding the record at `prev_log_id`, a client diffs
  the two to see exactly what changed; holding an older one, it knows changes
  were missed; and a message whose `prev_log_id` equals its `message_id` has
  changed once since creation.

**Opaque IDs** — `room_id`, `user_id`, `session_id`, and request `id`.

- Arbitrary strings minted by whichever side creates them; `room_id` and
  `user_id` are server-assigned.
- Request `id`s SHOULD be random, to avoid collisions across devices of the
  same user. They identify operations, not log positions.
- Suggested convention: use a room's creation `log_id` as its `room_id`.
- Suggested convention: keep `room_id`s distinct from `user_id`s, so an `@`
  mention names one or the other (Appendix J.3).
- Field naming for extensions and future methods: Appendix J.

---

## 3. Core

Every server implements this section; a minimal server implements only this
section. Optional features are advertised through capabilities (§4).

### 3.1 `server` frame

Upon accepting a connection, the server MUST immediately send a `server`
frame, unprompted. There is no client hello.

```json
{
  "method": "server", "params": {
    "protocol": 4,
    "name": "impl-name/1.0",
    "caps": ["history", "edit"],
    "auth": ["token"],
    "upload": "https://example/upload"
  }
}
```

- `protocol`: required integer, incremented with each revision of this spec.
  Current value `4`. Implementations make a best effort to interoperate
  across versions; mismatched optional features degrade to their fallbacks
  (§4).
- `name`: optional implementation/version string.
- `caps`: array of capability strings (§4), default `[]`.
- `auth`: required nonempty array of supported authentication schemes (§3.2),
  in server preference order.
- `upload`: optional upload URL; its presence enables uploads (Appendix E).
- `ext`: optional extension metadata (§3.5), such as implementation limits.
- `push`: optional object of supported push kinds; its presence enables push
  (Appendix F).

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
  retired IDs are never reissued (§3.3).
- `token`: bearer string. The reference default.
- `webauthn`: optional passkey scheme (Appendix I).

Except for `webauthn`, servers MAY accept `auth` regardless of `scheme` and
ignore credentials under guest-access policies. Token validation,
identity assignment, and privilege policy are implementation-defined.

`name` is an optional requested display name, valid with any scheme; the
server MAY comply, decline, or alter it, and `you.name` is the answer.
Clients MUST NOT supply `user_id`: identity is server-assigned. `client` is
an optional free-form implementation string for debugging.

Clients MAY pipeline `auth` before `server` arrives. Before successful auth,
other requests get `denied` and other notifications are ignored.

### 3.3 Identity

Identity is server-authoritative: every message carries its author in `from`.
There is no user directory; a user object travels wherever the user appears.

```json
"from": {"user_id": "alice", "name": "Alice"}
```

`user_id` is required and stable. `name` is an optional display string;
absent `name` falls back to `user_id`. `avatar` (Appendix E) and `ext` (§3.5)
are optional. Every identity on the wire (`you`, `from`, `members`, RTC
members) uses this shape, and servers MAY send only `user_id`. Clients keep
the latest user object they receive for each `user_id`, whichever frame
carried it, and render every message with it. Whether history carries a
user's name from posting time or their current one is server policy; the
protocol guarantees neither.

- Suggested convention: servers include `name` in `from`, so clients can
  render messages from users who are no longer members.

A `name` request changes the display name after authentication; the server
MAY comply, decline, or alter it:

```jsonc
// ->
{"method": "name", "id": "c2", "params": {"name": "Alice ⚙"}}
// <-
{"id": "c2", "result": {"you": {"user_id": "alice", "name": "Alice ⚙"}}}
```

After authentication, the server MAY send a `user` notification at any time,
such as after a rename, a profile change, or an authentication change. It
carries exactly one of `you`, sent to the user's own connections, or `new`,
sent to others who share a room with the user. When `user_id` changes, `old`
optionally carries the previous user object:

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
  connection now acts as the new identity: the server re-announces the rooms
  visible to it, removing those no longer visible (§3.4), and clients
  re-derive per-user state such as their own reactions (Appendix D).
- Logged records keep the old `user_id`. Clients MAY treat `old` as a user
  leaving and `new` as a user joining, or MAY alias `old.user_id` to the new
  identity for past and later records.
- Servers SHOULD NOT reissue a retired `user_id` to another user.

Bots and agents are ordinary senders; nothing distinguishes them.

- Suggested convention: `@`-prefixed `user_id`s such as `@server` are system
  identities (Appendix J).

### 3.4 Rooms

A room is a log with a server-chosen `room_id`. Announced rooms are the ones
this connection receives deliveries for. After authentication, servers
SHOULD announce the rooms the user has joined (every visible room, for
servers without membership), and MUST announce a room before delivering
anything in it. Servers MAY announce only recently active threads; the rest
are found with `room_list` (Appendix C). A minimal server may announce just
one room.

```json
{
  "method": "room", "params": {
    "room_id": "general", "log_id": "1724800000000", "title": "General",
    "intro_message": {
      "message_id": "1724800000001", "log_id": "1724800000001", "room_id": "general",
      "from": {"user_id": "alice", "name": "Alice"},
      "body": {"text": "Ops chatter: deploys, alerts, *incidents*.", "format": "markdown"}
    },
    "latest_log_id": "1724803200042", "history_log_id": "1724800000000"
  }
}
```

`server`: assigned by the server, ignored on input. `client`: supplied by the
client, replaced whole by a save. `delivery`: this client's view, not logged.

| field            | set by   | meaning                                                          |
|------------------|----------|------------------------------------------------------------------|
| `room_id`        | server   | required                                                         |
| `log_id`         | server   | position of this room record (§2)                                |
| `prev_log_id`    | server   | optional; this room's previous record (§2)                       |
| `parent_room_id` | client   | optional; fixed at creation; marks a thread (Appendix C)         |
| `title`          | client   | optional plain string; absent falls back to `room_id`            |
| `intro_message`  | client   | optional message object (§3.5): the room's description or summary |
| `ext`            | client   | optional opaque extension data (§3.5)                            |
| `latest_log_id`  | delivery | greatest `log_id` in the room's log                              |
| `history_log_id` | delivery | inclusive lower bound of retrievable history, or `null` if none  |
| `removed`        | delivery | `true` when the room leaves the announced set                    |

A `room` frame is a complete room record (§2); omitted fields are cleared.
Delivery fields describe this client's view and are not logged. A removal
carries only `room_id` and `removed`:

```json
{"method": "room", "params": {"room_id": "general", "removed": true}}
```

`intro_message` is a message like any other. Servers SHOULD embed its
snapshot in announcements so clients can render it without history; editing
it is an ordinary message save (Appendix B). `log_id`, `latest_log_id`, and `history_log_id`
are REQUIRED when cap `history` is advertised and OPTIONAL otherwise;
Appendix A defines their use.

Threads are rooms with a `parent_room_id`. Clients that ignore the field
render them as ordinary rooms; clients that understand it group them under
the parent and MAY collapse or hide them. Servers set `title` on threads so
both render. Creating, listing, joining, and leaving rooms requires cap
`rooms` (Appendix C).

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
| `message_id`  | server | permanent ID (§2)                                     |
| `log_id`      | server | position of this snapshot in the log (§2)             |
| `prev_log_id` | server | optional; this message's previous snapshot (§2)       |
| `from`        | server | author identity (§3.3), preserved across changes      |
| `room_id`     | client | the room the message is in; required on requests      |
| `body`        | client | `text`, `format`, `embeds`                            |
| `reply_to`    | client | optional message object naming the message replied to |
| `deleted`     | client | tombstone marker, default false (Appendix B)          |
| `ext`         | client | optional object of namespaced, opaque extension data  |

**Extensions.** `ext` carries data the spec does not define, keyed by
namespace:

```json
"ext": {"irc": {"network": "libera", "channel": "#ops", "nick": "ada_", "msgid": "a1b2c3"}}
```

Clients need not parse `ext`, and MUST send it back unchanged when saving a
message (Appendix B) or room (Appendix C) unless they mean to change it.
Data that must survive other clients' saves belongs in `ext`, not in unknown
top-level keys. Servers MAY limit `ext` or normalize or reject any field by
local policy.

- `body` is required on creation. `text` defaults to `""`; `format` ∈
  `"plain" | "markdown"`, default `"plain"`; `embeds` defaults to `[]`.
  Both formats are mandatory to render. Markdown is CommonMark with fenced
  code blocks as the baseline rich-content path. Clients MUST disable raw
  HTML in Markdown or sanitize it under the same allowlist as HTML embeds
  (Appendix E). Clients MUST render embeds of unknown `kind` as a labeled
  fallback card (kind name plus `url`, if present).
- Suggested convention: mention users as `@user_id` in `body.text`
  (Appendix J.3).
- **Result:** `{"message_id": "..."}`, the permanent ID. It is the
  confirmation; the broadcast MAY arrive before or after it, and a
  deduplicated retry (§1.2) produces no broadcast.
- **Snapshots replace** under the replay rule (§2), including for messages
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

### 3.6 Core conformance checklist

Every server:

1. Sends a `server` frame on connect (§3.1).
2. Accepts at least one `auth` scheme and replies with `you` (§3.2).
3. Announces at least one `room` (§3.4).
4. Accepts `message` creation: replies with `message_id`, then broadcasts the
   snapshot to the room (§3.5).
5. Replies `error/unsupported` to unknown requests, including `message` with
   a `message_id` when cap `edit` is absent; ignores unknown notifications.
6. Follows §1 for framing and retries and §2 for identifiers.

The opening example is a complete session with a minimal server.

---

## 4. Capabilities

`server.caps` advertises optional requests. Capabilities advertise support,
not authorization; servers still apply local policy per request. Clients
ignore caps they do not recognize. Absence of a cap obligates the client to
the fallback:

| cap         | adds                                                         | fallback                     | spec       |
|-------------|--------------------------------------------------------------|------------------------------|------------|
| `history`   | page and recover a room's log                                | session-only scrollback      | Appendix A |
| `edit`      | `message` saves: edit, move, delete                          | no edit/move/delete UI       | Appendix B |
| `rooms`     | `room` create/update, `room_list`, `room_join`, `room_leave` | fixed room list, no threads  | Appendix C |
| `reactions` | emoji reactions on messages                                  | reaction controls hidden     | Appendix D |
| `activity`  | typing indicators and read markers                           | no typing or read indicators | Appendix D |

Features without a cap: uploads follow `server.upload` (Appendix E); embeds
are body content (Appendix E); push follows `server.push` (Appendix F).

- Suggested convention: third-party extension caps use an `ext:` prefix,
  such as `ext:irc`.

Three frame idioms cover everything logged or announced:

- **Records** (`room`, `message`): complete state at a `log_id` (§2).
- **Per-user state** (`reactions`, `activity`): `from` plus the user's
  complete state for a scope; newest wins per user. `reactions` is logged
  (§2), `activity` is not.
- **Announcements** (`server`, `user`, `rtc`): unlogged, re-sent in full;
  each replaces the last.

---

## Appendix A — `history`

Stateless window query over a room's **log**. `rooms` holds room records
(§3.4), `entries` message snapshots (§3.5), and `reactions` reaction sets
(Appendix D): one log, partitioned by kind.

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
    "first_id": "1724803200042", "last_id": "1724803312011", "more": true,
    "latest_log_id": "1724806800000", "history_log_id": "1724800000000"
  }
}
```

**Membership.** A record belongs to every room its message is in just before
or after it, so a move (Appendix B) appears in both rooms. Room records
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
- Each array is ascending by `log_id`.

**Availability.** Every result includes `latest_log_id` and `history_log_id`
(§3.4), captured consistently with the page. They describe the room, not the
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
set in the slice, under the greatest folded `log_id`. Empty sets are kept so removals replay.
Retained records keep their original `log_id`s and contents and never
incorporate changes after the slice. Compacted and uncompacted pages yield
the same terminal state.

**Replay** follows §2. No earlier state is needed to apply a record, and
order across the arrays is irrelevant.

**Recovery**, per room:

1. When live delivery starts, record `H = latest_log_id` and buffer live
   records above H.
2. Page forward with `before: H`, from `after: C + 1` given a checkpoint C,
   otherwise from the start, until `more: false`.
3. Apply the buffered records. The checkpoint is now H.

If a response's effective lower bound passes the next position you need,
history was discarded: clear the room's state and restart from that bound.
Clients recover each room they display independently; threads are separate
rooms and load when opened.

---

## Appendix B — `edit`

A `message` request carrying an existing `message_id` **saves** that message:
it replaces every client field (§3.5) with the submitted state. Omitted
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
delivered to both rooms (Appendix A), and clients re-home the message rather
than treating it as deleted. If the message has reactions, the server then
logs one reactions record (Appendix D) in the destination carrying every
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
A server MAY rewrite them, and embedded copies of them (§3.5), into
tombstones at their original `log_id`s. This is the only permitted rewrite
of a logged record. Replay reaches the same terminal state either way;
clients holding the old content drop it on the new tombstone.

---

## Appendix C — `rooms`

`room` is bidirectional, like `message`. A client request without `room_id`
creates a room; with `room_id` it replaces the client fields (§3.4) other
than `parent_room_id`, which is fixed at creation; omitted fields are
cleared. Both return
`{"room_id": "..."}` and broadcast the new room record (§3.4).

```jsonc
// -> start a thread on an existing message
{
  "method": "room", "id": "c20", "params": {
    "parent_room_id": "general", "title": "Deploy",
    "intro_message": {"message_id": "1724803200042"}
  }
}
// <-
{"id": "c20", "result": {"room_id": "1724803312001"}}
// <- (broadcast; the server embedded the intro snapshot)
{
  "method": "room", "params": {
    "room_id": "1724803312001", "log_id": "1724803312001",
    "parent_room_id": "general", "title": "Deploy",
    "intro_message": {
      "message_id": "1724803200042", "log_id": "1724803200042", "room_id": "general",
      "from": {...}, "body": {...}
    },
    "latest_log_id": "1724803312001", "history_log_id": "1724803312001"
  }
}
```

- `parent_room_id` MUST name an existing visible room. Nesting depth is
  server policy.
- `intro_message` is a bare reference on input. It MAY live in any room; for
  a thread it is usually the parent-room message that started it. Its text is
  updated by saving that message (Appendix B), not by `room`. A described
  top-level room takes two steps: create it, post the description in it, then
  `room` with `room_id` and `intro_message`.
- The server MAY adjust or supply metadata by policy. Unknown `room_id`,
  unknown `parent_room_id`, or invalid types are `invalid_params`;
  unauthorized requests are `denied`.

Discovery and membership:

```jsonc
// -> list a room's threads; omit parent_room_id for top-level rooms
{"method": "room_list", "id": "c21", "params": {"parent_room_id": "general"}}
// <-
{
  "id": "c21", "result": {
    "rooms": [
      {
        "room_id": "1724803312001", "log_id": "1724803312001",
        "parent_room_id": "general", "title": "Deploy",
        "intro_message": {...},
        "latest_log_id": "1724803400000",
        "members": [{"user_id": "alice", "name": "Alice", "avatar": "https://..."}]
      }
    ]
  }
}
// ->
{"method": "room_join", "id": "c22", "params": {"room_id": "1724803312001"}}
// ->
{"method": "room_leave", "id": "c23", "params": {"room_id": "1724803312001"}}
```

- `room_list` returns room records (§3.4) for the visible rooms, each with
  `members`, a list of user objects (§3.3). With `parent_room_id` it lists
  that room's threads, including ones never announced. Listing a room does
  not start deliveries. Servers MAY omit or truncate `members` by policy.
- A room is joined when it is in the announced set; listings carry no
  separate flag.
- `room_join` and `room_leave` return `{}`. A join announces the room; a
  leave, or losing visibility, sends `removed: true`. A room left but still
  visible stays in `room_list`.
- Members of a room receive announcements of its new threads. Joining an
  unannounced thread announces it.
- Visibility and membership are server policy.

---

## Appendix D — Per-user state: `activity`, `reactions`

### D.1 `activity`

Cap `activity`. A client reports its activity in one room, as a
notification: whether it is typing, and how far it has read. Servers MAY
drop it.

```jsonc
// -> typing, having read up to a point
{"method": "activity", "params": {"room_id": "general", "read_log_id": "1724803200042", "timeout": 8}}
// -> not typing; moves the read marker only
{"method": "activity", "params": {"room_id": "general", "read_log_id": "1724803312050"}}
// <- (broadcast)
{
  "method": "activity", "params": {
    "room_id": "general", "from": {"user_id": "alice"},
    "read_log_id": "1724803312050"
  }
}
```

- `timeout` (optional, seconds) means the user is typing, for that long
  without refresh. Without it, the user's typing indicator ends.
- `read_log_id` (optional) is the greatest `log_id` in the room the user has
  read; omitted, the marker is unchanged. Clients only advance it, and
  servers MAY ignore a value below the one they hold.
- Activity is not logged. Delivery is server policy: to the room, which
  shows read receipts, or only to the user's own connections, which syncs
  read markers across devices.
- Servers MAY keep each user's latest `read_log_id` per room and re-send it
  after announcing the room, as `activity` without `timeout`.
- There is no presence system.

### D.2 `reactions`

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
  after a move (Appendix A).
- The notification's `reactions` array holds one element per user. Live
  broadcasts carry one; compacted history records (Appendix A) MAY carry
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
- Retries follow §1.2. Push wake-ups for reactions are server policy.

---

## Appendix E — Uploads, embeds, and avatars

**Upload.** Media travels over HTTP, not the socket. The client POSTs
`multipart/form-data` to the `upload` URL from the `server` frame, receives
`{"url": "..."}`, and references the URL in an embed. With `token` auth, the
same token is the bearer. With other schemes the server SHOULD re-send the
`server` frame after auth carrying a per-session `upload` URL (§3.1).

**Embeds.** `body.embeds` holds media and rich content in display order;
`kind` selects the renderer. Unknown kinds use the fallback card (§3.5).

```json
{"kind": "image", "url": "...", "mime": "image/png", "w": 800, "h": 600}
{"kind": "file", "url": "...", "name": "report.pdf", "size": 12345}
{"kind": "iframe", "url": "https://backend:8443/term/abc", "h": 300}
{"kind": "html", "html": "<table>…</table>"}
```

- Media kinds: `image`, `video`, `audio`, `file` (with `name`, `size`).
- `iframe`: render with `sandbox="allow-scripts"` and **never**
  `allow-same-origin` alongside it; no top navigation or popups; restrictive
  Permissions-Policy; clamped dimensions (`h` is a suggestion); lazy loading;
  a cap on concurrently live iframes. Intended for backend-served live views
  such as terminals and dashboards.
- `html`: sanitize with an allowlist sanitizer (e.g. DOMPurify) before
  insertion, regardless of source. Servers make no safety promises about
  content flowing through them.
- Future typed embeds (`diff`, `poll`, …) use the fallback rule.

**Avatars.** A user object (§3.3) MAY carry `avatar`, an image shown beside
the user's name.

- Servers send `avatar` in `you`, `user`, and `members`, not in every `from`.
- Servers SHOULD return only `https:` URLs or small
  `data:image/{png,jpeg,gif,webp};base64,` URLs; larger images go through
  upload.
- Clients own their security boundary and choose which sources to load; they
  MAY ignore any avatar. Load values only as images, never as documents, and
  bind or escape them rather than interpolating them into HTML.
- Without a usable avatar, clients draw a placeholder such as initials.

---

## Appendix F — Push

`server.push` (§3.1) maps each supported push kind to its public
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
  prefix (§4).
- `url` is required and identifies the registration. Registering the same
  `url` again replaces it; `push_unregister` removes it. Clients SHOULD
  register on each connection.
- `relay`: the server POSTs the payload as JSON to `url` with `token` as
  bearer. Delivery beyond that POST (APNs/FCM, coalescing) is the relay's
  concern; native apps use a relay run by their vendor. Other kinds define
  their own delivery outside this spec.
- Every kind delivers the same payload: a message object (§3.5) without
  `log_id`, so clients render it but never install it as a snapshot. `body`
  MAY be truncated or omitted; servers SHOULD omit `format` and `embeds`.
- Wake policy is server-defined.

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

---

## Appendix G — Multiplexing envelope (informative)

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

## Appendix H — Out-of-band channels: WebRTC (informative)

Planned capability `rtc`: the socket carries signaling; media travels out of
band. Future channels (screenshare, documents, file transfer) should reuse
the pattern: a server-announced session with authoritative membership, a join
request returning connection configuration, and an opaque relay frame.

**Sessions** are announcements (§4):

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
adds a media server joining as member `@sfu` (Appendix J), with which
clients negotiate a single PeerConnection.

**Exclusions.** Mute and camera state are derivable from media streams.
Invite/ring/reject state machines are covered by an `rtc` frame plus a push
notification; when `rtc` lands, push payloads (Appendix F) gain an optional
call hint. Recording and transcoding are server-side.

---

## Appendix I — WebAuthn authentication (optional)

Servers advertising `webauthn` in `server.params.auth` MUST use this
exchange; no separate capability is needed.

Both steps are `auth` requests with string IDs and `scheme: "webauthn"`. Use
`action: "register"` to create a credential or `action: "login"` to sign in,
unchanged between steps. Notifications do not run ceremonies.

| Step     | Additional request fields                  | Successful result                                     |
|----------|--------------------------------------------|-------------------------------------------------------|
| `begin`  | `step: "begin"`                            | `challenge_id` (opaque), `public_key` (WebAuthn options) |
| `finish` | `step: "finish"`, `challenge_id`, `credential` | `you` (§3.3)                                       |

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

Only a verified finish returns `you`, followed by room announcements. Begin
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

## Appendix J — Conventions (informative)

### J.1 System identities

`user_id`s beginning with `@` are reserved for server-controlled identities,
such as `@server` for the server itself or `@sfu` for a media server
(Appendix H). Servers SHOULD NOT assign them to users. They carry an ordinary
`from` and render like any sender, so clients unaware of the convention
still work; clients MAY style them as system messages.

```json
{
  "method": "message", "params": {
    "message_id": "1724803500001", "log_id": "1724803500001", "room_id": "general",
    "from": {"user_id": "@server", "name": "Server"},
    "body": {"text": "Maintenance at 17:00 UTC."}
  }
}
```

### J.2 Field naming

Entity ID fields use the `_id` suffix (`user_id`, `room_id`, `message_id`,
`parent_room_id`, `session_id`). Embedded objects use descriptive names
(`from`, `body`, `reply_to`, `intro_message`). JSON-RPC's envelope `id` keeps
its name. Extensions and future methods should follow the same pattern.

### J.3 Mentions

A mention is `@` followed by a `user_id` or `room_id` in `body.text`:

```json
"body": {"text": "@guest_1234 can you check the deploy?"}
```

- The ID is an optional `@` then a run of `[A-Za-z0-9_.-]`, not
  preceded by a letter or digit, so `foo@bar.com` is not a mention. Trailing
  `.` and `-` are not part of it. In Markdown, code spans and code blocks
  contain no mentions.
- Servers that want users and rooms to be mentionable mint IDs from that
  set, such as `guest_1234`. System identities (J.1) take a second `@`, as in
  `@@server`.
- Clients render a user mention with the user's latest display name (§3.3),
  such as a chip, and MAY highlight mentions of `you`. A room mention links
  to the room. When an ID names both a user and a room, clients treat it as
  a user. Unknown IDs render as written.
- Composers insert `@user_id` when the user picks a person, for example from
  `members` (Appendix C).
- Servers MAY apply the same rule to wake mentioned users (Appendix F).
- Mentions that notify a whole room are not defined.
