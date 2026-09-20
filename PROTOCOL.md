# Apron Chat Protocol

Apron Chat Protocol is designed to be easy to implement in semi-trusted environments. It can run over a WebSocket, or most other transports. The goal is to foster an ecosystem of many Apron Chat apps and Apron Chat servers who can speak with each other--from things like local chat bridges to other protocols, to coding harnesses, to internal message rooms.

The protocol is designed to be incremental by level, the minimal backend ("Level 0") should be implementable in about a hundred lines.

Let's start with a simple exchange:

After the WebSocket opens, the server announces itself, accepts authentication,
and announces visible rooms. The client can then send messages; the server
broadcasts them to all clients in the room, including the sender.

```jsonc
// <- Server greeting with auth capabilities
{"method": "server", "params": {"protocol": 2, "auth": ["anonymous", "token"]}}
// Client authenticates anonymously, requesting a display name ->
{"method": "auth", "id": "c1", "params": {"scheme": "anonymous", "name": "Ada"}}
// <- Server confirms the identity it assigned
{"id": "c1", "result": {"you": {"user_id": "guest_1", "name": "Ada"}}}
// <- Server shares available rooms
{"method": "room", "params": {"room_id": "general"}}
// Client posts a message ->
{"method": "message", "id": "c2", "params": {"room_id": "general", "body": {"text": "Hello"}}}
// <- Server confirms message ID
{"id": "c2", "result": {"message_id": "1724803200042"}}
// <- Server broadcasts the message to everyone
{"method": "message", "params": {"room_id": "general", "log_id": "1724803200042", "message": {
  "message_id": "1724803200042", "from": {"user_id": "guest_1", "name": "Ada"}, "body": {"text": "Hello"}
}}}
```

Request `id` correlates replies. The server-assigned `message_id` identifies
the message in both the result and the broadcast; `log_id` identifies a change
in the room log.

---

## 1. Transport & framing

- One WebSocket connection. Each WebSocket text message contains exactly one JSON
  object (a **frame**).
- Frames use the [JSON-RPC 2.0](https://www.jsonrpc.org/specification)
  request, response, and notification shapes (`method`, `params`, `id`,
  `result`, `error`) without the `jsonrpc` member.
- Requests MAY be pipelined; the server processes them in order but MAY reply
  out of order. Server announcements and broadcasts are notifications.
- Unknown methods: servers reply `error/unsupported` to requests and ignore
  notifications; clients ignore unknown notifications. Unknown *fields*,
  both envelope members and fields in known methods, MUST be ignored by both
  sides, except message extension fields, which are preserved as described
  in §3.5.
- Frame size: implementations SHOULD accept frames up to 256 KiB and MAY
  reject larger requests with `error/too_large`; oversized notifications may
  be dropped. The limit is advisory.
- Liveness uses WebSocket ping/pong; there is no application-level heartbeat.

### 1.1 Envelope and replies

Request `id`, when present, MUST be a string (§2). Clients SHOULD include `id`
for result correlation or retries, including `auth`, `history`, and mutations.
Broadcast log IDs reside in `params.log_id`.

```jsonc
// ->
{"method": "message", "id": "c42",
   "params": {"room_id": "general", "body": {"text": "hello", "format": "plain"}}}
// <-
{"id": "c42", "result": {"message_id": "1724803200042"}}
```

A notification additionally omits `id`:

```json
{"method": "message", "params": {"room_id": "general", "body": {"text": "hello", "format": "plain"}}}
```

Success returns a `result` object (`{}` if empty). Errors contain integer
`code`, string `message`, and optional `data`:

```json
{"id": "c42", "error": {"code": -32601, "message": "Unsupported method"}}
{"id": "c43", "error": {"code": -32002, "message": "Try later", "data": {"ms": 1000}}}
```

`error/<name>` denotes the following numeric codes:

| code   | name             | meaning                                      |
|--------|------------------|----------------------------------------------|
| -32700 | `parse_error`    | invalid JSON                                 |
| -32600 | `invalid_request` | invalid envelope                            |
| -32601 | `unsupported`    | method/capability not implemented            |
| -32602 | `invalid_params` | invalid method parameters                    |
| -32603 | `internal_error` | internal server error                        |
| -32001 | `denied`         | authentication/authorization failure         |
| -32002 | `retry_after`    | rate limited; `data.ms` is an integer delay   |
| -32003 | `too_large`      | message too large                            |

Other application errors MAY use non-reserved JSON-RPC codes. Parse errors
and invalid envelopes whose request ID cannot be determined use `id: null`,
as in JSON-RPC; this is the sole exception to string IDs. Valid notifications
still receive no error replies.

### 1.2 Retries and recommended deduplication

Retries SHOULD preserve `id`, `method`, and `params` across reconnects. New
operations, including changed parameters, MUST use new IDs. Deduplication
ignores object key order.

Servers SHOULD deduplicate by `(authenticated user_id, request id)`, return
the original result for accepted duplicates without re-execution or rebroadcast, reject
conflicting methods/parameters with `invalid_params`, and coalesce concurrent
duplicates.

Retention and persistence across reconnects/restarts are implementation-defined.
Pre-authentication IDs are connection-scoped; authentication MUST execute on
each connection.

---

## 2. Identifiers (mandatory)

All IDs on the wire are **strings**, except the `null` response ID used for
unidentifiable invalid requests (§1.1).

**Log IDs** (`log_id`) are decimal strings based on Unix epoch
milliseconds — e.g. `"1724803200042"`. Creations and updates MUST share one
strictly increasing sequence per room. Generation is implementation-defined.
Recommended generator: `id = str(max(unix_epoch_ms(), last_id + 1))`.
`"0"` is reserved for the empty-log boundary; entries MUST use positive IDs.

**Message IDs** (`message_id`) are assigned the creation's `log_id` and remain
unchanged throughout the message's lifetime. Every server message snapshot carries its
own outer `log_id`; `message.message_id` identifies the message (§3.5).
`log_id == message_id` denotes creation; later changes have greater log IDs.
JSON-RPC request IDs deduplicate requests (§1.2); log IDs identify transitions
during history and live replay. Clients supply an existing
`message_id` to save a message, but MUST NOT supply `log_id` on a save request.

- Compare numerically. Values are below `2^53`; clients MAY parse them as
  integers.
- Derived timestamps and time-window bounds are approximate. There is no
  separate timestamp field.
- Cross-room ordering is approximate. On a live connection, servers MUST
  deliver a room's `message` notifications in ascending log-ID order.
- Log IDs are unique only within a room on a single server. Log namespacing
  is client-defined.

**Opaque IDs** (rooms, threads, sessions, user IDs, client request `id`s)
are arbitrary strings chosen by whichever side mints them. Servers SHOULD
prefix them by type — e.g. `t_` for threads, `call_` for RTC sessions.
Room and thread IDs are assigned by the server at creation.
Client request `id`s SHOULD be randomly generated to avoid collisions across
devices and connections, including devices authenticated as the same user.
Request IDs identify operations, not positions in the server's room log.

Named entity ID fields use the `_id` suffix, such as `user_id`, `room_id`,
`thread_id`, `root_message_id`, `session_id`, and `conn_id`. Embedded objects
use descriptive field names such as `from` and `body`. JSON-RPC's envelope
`id` keeps its name. Method names, such as `room` and `thread`, identify operations
or announcements rather than ID fields.

---

## 3. Level 0 — mandatory core

A Level 0 server implements this section. Selected optional features are
advertised through capabilities (§4).

### 3.1 `server` frame

Upon accepting a connection, the server MUST immediately send a `server` frame,
unprompted. There is no client hello.

```json
{
  "method": "server",
  "params": {
    "protocol": 2,
    "name": "impl-name/1.0",
    "caps": ["history", "edit", "rooms"],
    "auth": ["token"],
    "upload": "https://example/upload"
  }
}
```

- `protocol`: required integer. Current value `2`.
- `name`: optional implementation/version string.
- `caps`: array of capability strings (§4), default `[]`.
- `auth`: required nonempty array of supported authentication schemes (§3.2),
  in server preference order.
- `upload`: optional upload URL; its presence enables uploads (§6.1).

The server MAY send a new `server` frame at any time; each **fully replaces**
the previous. On receipt, clients re-evaluate feature UI but MUST
NOT retroactively un-render existing content. After replying
`error/unsupported`, servers SHOULD follow with a fresh `server` frame.

### 3.2 Authentication

```jsonc
// ->
{"method": "auth", "id": "c1", "params": {"scheme": "token", "token": "...", "name": "Alice", "client": "bottomless-web/0.3"}}
// <-
{"id": "c1", "result": {"you": {"user_id": "alice", "name": "Alice"}}}
```

`params.scheme` selects the authentication scheme:

- `anonymous` — no credentials; server assigns identity.
- `token` — bearer string. The reference default.
- `webauthn` — suggested optional scheme; exchange details are
  implementation-defined.

Servers MAY accept `auth` regardless of `params.scheme` and ignore credentials.
Credential validation, identity assignment, and privilege policy are
implementation-defined.

`name` is an optional requested display name, valid with any scheme. The
server MAY comply, decline, or alter it, exactly as for the `name` request
(§3.3); `you.name` in the result is the answer. Clients MUST NOT supply
`user_id`: identity is always server-assigned.

`client` is an optional free-form implementation/version string for debugging.
Clients MAY pipeline `auth` before `server` arrives. Before successful auth,
other requests get `denied`; other notifications are ignored.

### 3.3 Identity

Identity is server-authoritative: every message carries its author in `from`.
There is no user directory or profile state.

```json
"from": {"user_id": "alice", "name": "Alice", "avatar": "https://..."}
```

`user_id` is required and stable. `name`/`avatar` are optional advisory strings,
current as of that message; absent `name` falls back to `user_id`. Authentication
results (`you`), typing notifications (`from`), and RTC identities (`members`,
`from`, and `to`) use the same identity shape. A `name` request changes the
display name after authentication; the server MAY comply, decline, or alter it,
and the result carries the resulting identity:

```jsonc
// ->
{"method": "name", "id": "c2", "params": {"name": "Alice ⚙"}}
// <-
{"id": "c2", "result": {"you": {"user_id": "alice", "name": "Alice ⚙"}}}
```

Bots and agents are ordinary senders; nothing distinguishes them at the
protocol level.

### 3.4 Rooms

Rooms have server-chosen string IDs. After authentication, servers MUST announce
all currently visible rooms. Clients rebuild the current metadata view from
these announcements:

```json
{"method": "room", "params": {
  "room_id": "general", "name": "General", "topic": "optional", "latest_id": "1724803200042"
}}
```

Re-sending `room` fully replaces its metadata; omitted optional fields are
cleared. `room_id` is required; `name` and `topic` are optional strings, with
`name` defaulting to `room_id`. Servers MUST emit `removed: true` when a room
leaves the client's visible set, withdrawing the room and its thread metadata.
Only `room_id` and `removed` are required:

```json
{"method": "room", "params": {"room_id": "general", "removed": true}}
```

Omitted `removed` means false. History retention and access after room removal,
including client cache policy, are implementation-defined. Servers MUST
announce a room before delivering entries in it. A Level 0 server announces
one room. Join/leave/create require cap `rooms` (§6.3).

`latest_id` is the maximum committed room log ID, including creations and updates;
`"0"` denotes an empty log. It is REQUIRED on active room announcements when
`history` is supported, OPTIONAL otherwise. For history-enabled rooms, an
announcement establishing live delivery MUST establish `latest_id` at the same
serialization point: transitions through `latest_id` are recoverable via history
(complete or compacted history), and subsequent entries MUST be delivered live in
log order. Re-announcements report the current head but MUST NOT advance
client checkpoints or replace an active recovery bound (§5.1).

### 3.5 Messages

A client `message` request creates a message when `params.message_id` is absent.
With an existing `message_id`, it replaces that message's editable state
(§5.3, cap `edit`). Server `message` notifications carry authoritative snapshots.

Create:

```jsonc
// ->
{
  "method": "message",
  "id": "c3",
  "params": {"room_id": "general", "body": {"text": "hello *world*", "format": "markdown"}}
}
// <-
{"id": "c3", "result": {"message_id": "1724803200042"}}
```

Broadcast (to all clients in the room, including the sender):

```jsonc
// <- (broadcast)
{
  "method": "message",
  "params": {
    "room_id": "general",
    "log_id": "1724803200042",
    "message": {
      "message_id": "1724803200042",
      "from": {"user_id": "alice", "name": "Alice"},
      "body": {"text": "hello *world*", "format": "markdown"}
    }
  }
}
```

Server `message` notifications MUST contain `room_id`, `log_id`, and `message`, the
complete message object as of that log position, including its `message_id`,
`from`, extensions, and any tombstone. The same format covers creations, edits,
deletions, and thread moves. Clients install newer snapshots by `message_id`
and re-render, even when the message has not been loaded (§5.1). Support is
mandatory regardless of cap `edit`; servers MAY publish changes to any message,
including ones predating the connection.

- A client `message` requires string `room_id` and object `body`, except when
  replacing an existing message with a tombstone (§5.3). Body fields are optional:
  string `text` defaults to `""`; `format` defaults to `"markdown"`;
  array `embeds` defaults to `[]`. Messages containing only embeds are valid;
  acceptance of empty messages is backend policy. Defaults apply when
  interpreting message bodies; they need not be stored in the message.
- `body.format` ∈ `"plain" | "markdown"`. Both are mandatory to render.
  Markdown uses CommonMark; fenced code blocks with language-tagged syntax
  highlighting are the baseline rich-content path.
  Clients MUST disable raw HTML in Markdown or sanitize rendered HTML using
  the same allowlist policy as HTML embeds (§6.4).
- **Result:** `message` returns `{"message_id": "..."}`, the message's permanent
  ID, whether newly created or replaced. Clients reconcile their own saves by
  this `message_id`, which also appears in the broadcast. The result is the
  confirmation: the broadcast MAY arrive before or after it, and a
  deduplicated retry produces no broadcast at all (§1.2).
- Clients deduplicate replayed transitions by their log IDs (§2).
- `body.embeds`: see §6. **Clients MUST render entries
  of unknown `kind` as a labeled fallback card** (kind name + `url` if
  present).

The message object's defined fields (`message_id` is immutable; unknown keys are
retained in stored snapshots and ignored by renderers):

| field                 | meaning                                      |
|-----------------------|----------------------------------------------|
| `message_id`          | permanent server-assigned message ID (§2)     |
| `from`                | server-assigned inline identity (§3.3)        |
| `body`                | `text`, `format`, `embeds`                    |
| `reply_message_id`     | optional reply target message ID in the same room |
| `thread_id`           | optional thread reference (§6.2)             |
| `deleted`             | boolean tombstone marker, default false (§5.3) |

Message fields supplied in client requests sit in **`message.params`**, alongside
`room_id`. It is routing information; `message_id`, when present, selects an
existing message. Neither is editable state. The server assigns `from` on
creation and preserves it on replacement; any client-supplied `from` MUST be ignored.
Other message fields, including extensions, describe the complete desired
editable state. Servers MAY normalize or reject them according to local
policy; additional server-owned extension fields remain server-controlled.
Clients MUST retain and resubmit extension fields they do not understand
when saving an existing message, so those fields are not lost.

`reply_message_id`, when present, MUST be a string identifying the message
being replied to in the same room (§2). The messages MAY belong to different
threads, including when only one is threaded. The target MUST exist and MUST NOT
be the reply itself; invalid references MUST be rejected with `invalid_params`.
Clients supply it in `params`; server notifications carry it in `params.message`,
and history entries carry it in their `message` snapshots.
Omitting it means the message has no reply reference. It is editable state:
omitting it on replacement removes the reference (§5.3). Reply references
require no capability flag and do not create threads or change thread membership;
`thread_id` is set independently. Clients MUST tolerate a referenced message
being unavailable or deleted and still render the reply's own content.
Deleted targets remain valid references. Moving a message between threads does
not require removing its reply reference or references from other messages.
Reply references do not constrain thread membership.

For example, reply to the message created above:

```jsonc
// ->
{"method": "message", "id": "c4", "params": {
  "room_id": "general", "reply_message_id": "1724803200042",
  "body": {"text": "Hello back!", "format": "plain"}
}}
// <-
{"id": "c4", "result": {"message_id": "1724803200043"}}
// <- (broadcast)
{"method": "message", "params": {
  "room_id": "general", "log_id": "1724803200043",
  "message": {
    "message_id": "1724803200043", "from": {"user_id": "bob", "name": "Bob"},
    "reply_message_id": "1724803200042",
    "body": {"text": "Hello back!", "format": "plain"}
  }
}}
```

### 3.6 Level 0 conformance checklist

Accept connection → emit `server` → accept one auth scheme → emit ≥1 `room`
→ accept creation-only `message`, return a `result` for requests, broadcast `message`
with conforming IDs → reply `error/unsupported` to unsupported requests and
ignore unknown notifications. A server without cap `edit` MUST reject `message`
with `message_id` and client `thread` requests as unsupported. Framing and retries
follow §1.

### 3.7 A complete Level 0 session

```jsonc
// <-
{"method": "server", "params": {"protocol": 2, "name": "demo/1", "caps": [], "auth": ["token"]}}
// ->
{"method": "auth", "id": "a", "params": {"scheme": "token", "token": "hunter2"}}
// <-
{"id": "a", "result": {"you": {"user_id": "alice", "name": "Alice"}}}
// <-
{"method": "room", "params": {"room_id": "general", "name": "General"}}
// ->
{"method": "message", "id": "b", "params": {"room_id": "general", "body": {"text": "hi", "format": "markdown"}}}
// <-
{"id": "b", "result": {"message_id": "1724803200000"}}
// <- (broadcast)
{
  "method": "message",
  "params": {
    "room_id": "general",
    "log_id": "1724803200000",
    "message": {
      "message_id": "1724803200000",
      "from": {"user_id": "alice", "name": "Alice"},
      "body": {"text": "hi", "format": "markdown"}
    }
  }
}
// ->
{"method": "history", "id": "c", "params": {"room_id": "general", "limit": 50}}
// <-
{"id": "c", "error": {"code": -32601, "message": "Unsupported method"}}
```

---

## 4. Capabilities

`server.caps` advertises optional requests. Absence of a cap obligates the
client to the corresponding fallback:

| cap            | fallback behavior                              |
|----------------|------------------------------------------------|
| `history`      | session-only scrollback; divider on reconnect  |
| `edit`         | edit, delete, and thread reassignment/creation/metadata editing UI hidden |
| `rooms`        | fixed room list                                |
| `push`         | no mobile wake-ups                             |

`typing`, server thread announcements, and embeds require no capability flags. Clients
handle supported notifications and content when received; unknown methods and
kinds follow §1 and §3.5. Upload availability follows `server.upload` (§6.1).
Capabilities advertise support, not authorization; servers apply local policy
to each request.

---

## 5. Level 1 features

### 5.1 `history`

Stateless window query over the room's **append-only transition log** (§2).
Every entry has the form `{"log_id": "...", "message": {...}}`: the same
complete snapshot as a server `message` notification (§3.5), without the
`room_id` delivery field. Servers MAY return all source transitions
or compact them as described below.

```jsonc
// ->
{
  "method": "history",
  "id": "c9",
  "params": {"room_id": "general", "after": "1724803200000", "before": "1724806800000", "limit": 200}
}
// <-
{"id": "c9", "result": {
  "entries": [...], "first_id": "1724803200000", "last_id": "1724803200199", "more": true
}}
```

Optional string `thread_id` restricts the query to a thread in the room. Omitting
it queries the whole room, including threaded messages. An unknown thread is
`invalid_params`; a known thread with no matching transitions returns an empty
result. The filter does not change live delivery or create a separate log.

A transition matches when its message belongs to the requested thread
immediately **before or after** that transition. Membership is evaluated at
that point in the log, even when the preceding state lies outside the query
bounds; a creation has no preceding state. This includes arrivals, edits,
deletions, and departures. Departure snapshots carry the new thread assignment
or none, allowing clients to remove the message from the old thread's view.
Clients apply snapshots, then display messages whose resulting `thread_id` matches.

Bounds and ordering:

- `after`/`before` are **inclusive log-ID bounds**; either MAY be omitted.
  They select transitions, not message IDs, creation dates, or current state.
- Apply the bounds and thread filter, then select a contiguous slice of the
  matching transitions. `limit` is a positive matching-entry count, applied
  **before compaction**; servers MAY clamp it to a positive value. An omitted
  limit uses a server default. With `after`, select the oldest matches;
  otherwise select the newest. Matching transitions retain their room log IDs,
  which may have gaps from unrelated room activity.
- `first_id`/`last_id` are the first/last log IDs of that source slice, before
  compaction. Return both for nonempty slices; omit both for an empty slice.
  `more` indicates additional matching source entries in the selected direction
  within the requested bounds. Empty slices return `entries: []` and
  `more: false`.
- Forward continuation uses `after = last_id + 1`; backward continuation uses
  `before = first_id - 1`. Preserve the opposite bound and thread filter.
  Arithmetic is numeric; encode the result as a string. Never derive
  continuation from compacted entries.
- `entries` are always ascending by `log_id`, regardless of query direction
  or compaction.

**Optional compaction.** After filtering and selecting the source slice, a
server MAY return only each message's last transition in that slice. Each
retained transition already contains the complete state at that point:

```json
{"log_id": "1724803312007", "message": {
  "message_id": "1724803200042", "from": {"user_id": "alice", "name": "Alice"},
  "body": {"text": "hello world", "format": "plain"}
}}
```

Retained transitions MUST keep their original log IDs and snapshots, including
unknown fields and tombstones; they MUST NOT incorporate changes after the
slice. Omitted transitions remain covered by `first_id`/`last_id`. Compacted and
uncompacted replies MUST yield the same terminal message state; intermediate
rendering may differ.

**Replay.** Snapshots install complete message state, even when the message
has not been loaded. Clients MUST retain the state with the greatest
`log_id` for each `message_id`; an older snapshot MUST NOT overwrite
a newer snapshot. No earlier message state is needed to apply a replacement.
Caching, eviction, and replay scheduling are implementation-defined.

Naive recovery:

1. Capture `H = room.latest_id`; buffer live transitions above `H`.
2. From empty state, page forward from `after: "0"` through `before: H`.
   Keep the same thread filter, if any, on every page. With state checkpointed
   through `C` for that scope, resume at `after: C+1` instead.
3. Replay pages in order until `more: false`, then apply buffered live entries.

Checkpoints MUST represent processed log coverage and recoverable client state
for their query scope: the whole room or a specific `(room_id, thread_id)` pair.
Thread-filtered recovery MUST NOT advance a room-wide checkpoint or another
thread's checkpoint. Completing forward recovery through fixed `H` covers that
scope through `H`, even if no matching transition occurs at the head. Neither
an announced head, a received live maximum, nor a per-message snapshot alone
establishes a checkpoint. Interrupted recovery resumes from the last valid
checkpoint for the same scope.

Recovery boundary example:

```jsonc
// <-
{"method": "room", "params": {"room_id": "general", "name": "General", "latest_id": "1724803200120"}}
// ->
{"method": "history", "id": "recover1", "params": {
  "room_id": "general", "after": "1724803200101", "before": "1724803200120"
}}
```

Clients can load a shallow recent room view, then fetch a thread's full
available history when it is opened. For example, with captured head
`H = "1724806800000"`:

```jsonc
// -> (recent room history)
{"method": "history", "id": "recent1", "params": {
  "room_id": "general", "before": "1724806800000", "limit": 50
}}
// -> (on opening a thread, recover it independently from the beginning)
{"method": "history", "id": "thread1", "params": {
  "room_id": "general", "thread_id": "t_deploy", "after": "0",
  "before": "1724806800000", "limit": 200
}}
```

Continue the thread query forward while `more` is true, then apply buffered
live transitions above `H`. A shallow room page does not establish coverage of
omitted history. Overlapping snapshots from room history, thread history, and
live delivery follow the same replay rules above.

### 5.2 `typing`

Ephemeral notifications; clients MAY send them without capability discovery.
Servers MAY drop them.

```jsonc
// ->
{"method": "typing", "params": {"room_id": "general", "active": true, "timeout": 8}}
// <- (broadcast)
{
  "method": "typing",
  "params": {"room_id": "general", "from": {"user_id": "alice"}, "active": true, "timeout": 8}
}
```

`timeout` (optional, seconds) is how long the indicator should persist without
refresh; clients expire remote typing state after `timeout`, defaulting to 10s
when absent. There is no presence system.

### 5.3 `edit` — replacing and deleting messages

Clients replace an existing message by sending its `message_id` and complete
editable state through `message` (§3.5). Cap `edit` advertises these saves and
client `thread` requests (§6.2). Servers MUST reject an unknown message ID with
`invalid_params`; supplying an ID never creates a message. Servers authorize
each operation according to local policy and reply `denied` when unauthorized.

A save replaces all editable fields: omitted fields are removed, and objects
and arrays are replaced in full. `null` has no deletion meaning and is valid
only where the field's type permits it. Clients MUST include every editable
field they want to preserve, including embeds, reply reference, thread assignment,
and extensions. The server preserves the message's ID, `from`, and other
server-owned fields. Accepted saves take effect in server processing order;
there is no automatic merge with intervening changes.

For example, replace a message's body and leave it outside any thread:

```jsonc
// ->
{"method": "message", "id": "c12", "params": {
  "room_id": "general", "message_id": "1724803200042",
  "body": {"text": "hello world", "format": "plain"}
}}
// <-
{"id": "c12", "result": {"message_id": "1724803200042"}}
```

An accepted save produces the standard `message` notification (§3.5) with a
new `log_id` and the same `message_id`, and appears in history (§5.1). The
authoritative snapshot MAY differ from the submitted state according to local
policy:

```jsonc
// <- (broadcast)
{
  "method": "message",
  "params": {
    "room_id": "general",
    "log_id": "1724803312007",
    "message": {
      "message_id": "1724803200042",
      "from": {"user_id": "alice", "name": "Alice"},
      "body": {"text": "hello world", "format": "plain"}
    }
  }
}
```

**Deletion is a replacement with a tombstone.** Send the existing `message_id`
and `deleted: true`; `body` is then optional. `deleted` is an optional boolean,
defaulting to false; `deleted: true` on creation MUST be rejected with
`invalid_params`. The server MUST omit `body` from a tombstone, even if the
client supplies it. Other editable fields still follow replacement semantics.
For example, delete a message while retaining its thread assignment:

```jsonc
// ->
{"method": "message", "id": "c14", "params": {
  "room_id": "general", "message_id": "1724803200042",
  "thread_id": "t_deploy", "deleted": true
}}
// <-
{"id": "c14", "result": {"message_id": "1724803200042"}}
// <- (broadcast)
{"method": "message", "params": {
  "room_id": "general", "log_id": "1724803312009",
  "message": {
    "message_id": "1724803200042", "from": {"user_id": "alice", "name": "Alice"},
    "thread_id": "t_deploy", "deleted": true
  }
}}
```

Clients render deleted messages as tombstones. Earlier history may still contain
the content. Restoration permissions and content/media retention policies are
implementation-defined.

---

## 6. Level 2 features

### 6.1 `upload`

Media travels over HTTP, not the socket. The client POSTs
`multipart/form-data` to the `upload` URL from the `server` frame, receiving
`{"url": "..."}`; it then references the URL:

```json
"body": {"text": "look:", "format": "markdown",
         "embeds": [{"kind": "image", "url": "...", "mime": "image/png", "w": 800, "h": 600}]}
```

Upload authentication: with `token` auth, the same token as bearer. With
other schemes there is no reusable credential, so the server SHOULD re-send
the `server` frame after auth carrying a per-session `upload` URL (§3.1).

Media embed kinds: `image`, `video`, `audio`, `file` (with `name`, `size`).
Unknown kinds → fallback card rule (§3.5).

### 6.2 Threads

`thread_id` is an optional opaque ID on messages (§2). The `thread` method creates
a thread or edits its title and summary when sent by a client (cap `edit`),
and announces current metadata when sent by the server:

```json
{
  "method": "thread",
  "params": {
    "room_id": "general",
    "thread_id": "t_deploy",
    "title": "Deploy discussion",
    "summary": "Debugging the 4pm outage",
    "root_message_id": "1724801100007"
  }
}
```

Server announcements require `room_id` and the server-assigned `thread_id`.
`title` and `summary` are optional strings; `title` defaults to `thread_id`.
`summary` is plain text and MAY contain line breaks.
`root_message_id` is an optional advisory message ID in the same room; it does
not assign that message to the thread.

Thread announcements fully replace metadata. After authentication, servers
MUST re-announce current thread metadata for each visible room, following that
room's announcement.

Clients decide when threads are stale and which threads to show, collapse,
or hide. These presentation choices do not change thread metadata or message
membership. Moving all messages out of a thread does not delete its metadata.
Removing a room withdraws its thread metadata along with the room (§3.4).

Threading is server-authoritative and retroactive. The server publishes a
`message` snapshot with the new `thread_id` for each moved message, or omits
`thread_id` to return it to the room. A revised summary is announced through
`thread`. Clients MUST re-home moved messages without treating them as
deleted, and SHOULD indicate the move at the message's original position.

Client participation:

- **Load a thread:** `history` with `room_id` and `thread_id` (cap `history`), using
  the pagination and scoped recovery rules in §5.1.
- **Reply in a thread:** `message` with `"thread_id": "t_deploy"` in `params` (an
  existing thread ID; see the field-placement rule in §3.5).
- **Move a message:** `message` with its `message_id`, complete editable state,
  and the destination `thread_id`, or omit `thread_id` to return it to the room.
  `thread_id`, when present on `message`, MUST be a string naming an existing thread;
  an unknown thread is `invalid_params` and never implicitly creates one.
- **Create a thread:** `thread` (cap `edit`) with required `room_id` and no
  `thread_id`. Optional `title`, `summary`, and `root_message_id` propose
  metadata; the server MAY adjust or supply it according to local policy.
- **Edit thread metadata:** `thread` (cap `edit`) with required `room_id`, an
  existing `thread_id`, and at least one of string `title` or string `summary`.
  Only supplied fields change; omitted fields are preserved. An empty string
  removes that field, restoring the default title or removing the summary.
  Clients MUST omit `root_message_id`; supplying it is `invalid_params`.
  An unknown thread or invalid field type is `invalid_params`; unauthorized
  edits are `denied` according to server policy. Successful edits return
  `result: {"thread_id": "..."}` and broadcast the complete `thread` metadata.

Creation establishes metadata only; messages are added separately through
`message`. On success the server assigns a new thread ID, returns
`result: {"thread_id": "..."}`, and broadcasts a `thread` announcement.
Supplying `thread_id` selects metadata editing and never creates a thread;
unauthorized creation is `denied`. Creation and edit retries follow §1.2.

For example, create a thread, move an existing message into it, then have the
server update its title and summary:

```jsonc
// ->
{"method": "thread", "id": "c13", "params": {"room_id": "general", "title": "Deploy", "summary": "Debugging the 4pm outage"}}
// <-
{"id": "c13", "result": {"thread_id": "t_deploy"}}
// <- (broadcast)
{"method": "thread", "params": {"room_id": "general", "thread_id": "t_deploy", "title": "Deploy", "summary": "Debugging the 4pm outage"}}

// -> (save the message's complete editable state with its new thread assignment)
{"method": "message", "id": "c15", "params": {
  "room_id": "general", "message_id": "1724801100007", "thread_id": "t_deploy",
  "body": {"text": "Is the deployment broken?", "format": "plain"}
}}
// <-
{"id": "c15", "result": {"message_id": "1724801100007"}}
// <- (broadcast)
{"method": "message", "params": {"room_id": "general", "log_id": "1724803312010", "message": {
  "message_id": "1724801100007", "from": {"user_id": "alice", "name": "Alice"},
  "body": {"text": "Is the deployment broken?", "format": "plain"}, "thread_id": "t_deploy"
}}}

// <- (later broadcast)
{"method": "thread", "params": {"room_id": "general", "thread_id": "t_deploy", "title": "Deploy resolved", "summary": "Resolved by rolling back the deployment"}}
```

The later announcement replaces the thread metadata without editing messages.
Clients can update the summary without changing the title or root:

```jsonc
// ->
{"method": "thread", "id": "c16", "params": {"room_id": "general", "thread_id": "t_deploy", "summary": "Resolved by rolling back the deployment\nFollow-up: add a deployment check."}}
// <-
{"id": "c16", "result": {"thread_id": "t_deploy"}}
// <- (broadcast)
{"method": "thread", "params": {"room_id": "general", "thread_id": "t_deploy", "title": "Deploy resolved", "summary": "Resolved by rolling back the deployment\nFollow-up: add a deployment check."}}
```

### 6.3 `rooms`

```jsonc
// ->
{"method": "room_create", "id": "c20", "params": {"name": "Ops"}}
// ->
{"method": "room_join", "id": "c21", "params": {"room_id": "ops"}}
// ->
{"method": "room_leave", "id": "c22", "params": {"room_id": "ops"}}
```

Server confirms requests with `result: {}` and emits the corresponding `room`
notification; successful `room_leave` emits `removed: true`. Visibility and
membership policy are server-defined.

### 6.4 Embeds

`body.embeds` contains media (§6.1) and rich content in display order;
`kind` selects the renderer.

```json
{"kind": "iframe", "url": "https://backend:8443/term/abc", "h": 300}
{"kind": "html", "html": "<table>…</table>"}
```

- `iframe`: clients MUST render with
  `sandbox="allow-scripts"` — **never** `allow-same-origin` together with
  `allow-scripts` — no top-navigation or popups, a restrictive
  Permissions-Policy, clamped dimensions (`h` is a suggestion), lazy loading
  offscreen, and a cap on concurrently-live iframes. Intended use: the backend
  serves live views (streaming terminals, dashboards) adjacent to its socket.
- `html`: clients MUST sanitize with an allowlist sanitizer (e.g. DOMPurify)
  before insertion, regardless of source. Servers make no safety promises and
  clients extend no trust; the trusted-deployment assumption does not cover
  content flowing *through* backends.
- Future typed embeds (`diff`, `poll`, …) use the fallback rule (§3.5).

### 6.5 `push`

UnifiedPush-shaped registration; the client supplies an HTTPS endpoint owned
by its push relay:

```jsonc
// ->
{
  "method": "push_register",
  "id": "c30",
  "params": {"url": "https://relay.example/p/xyz", "token": "..."}
}
// ->
{"method": "push_unregister", "id": "c31", "params": {"url": "https://relay.example/p/xyz"}}
```

When the user should be woken while disconnected, the server POSTs JSON
`{room_id, message_id, from, preview}` to `url` with the token as bearer.
`from` uses the inline identity object (§3.3). Delivery beyond that POST
(APNs/FCM, coalescing) is the relay's concern. Wake policy (mentions, all
messages) is server-defined.

Note: registered endpoints are client-supplied URLs the server will POST to —
an SSRF vector into the server's network. Servers SHOULD accept only `https`
endpoints resolving to non-internal addresses.

---

## Appendix A — Multiplexing envelope (informative)

Multiple logical protocol connections can share one physical WebSocket via an
aggregator that proxies backends. This envelope is **outside the core protocol**.

### A.1 Model

A mux endpoint wraps every core-protocol frame in an envelope carrying an
opaque connection ID:

```json
{
  "conn_id": "b1",
  "frame": {"method": "message", "id": "c3", "params": {"room_id": "general", "body": {...}}}
}
```

Each `conn_id` carries an independent core-protocol session. A demultiplexer
passes inner frames to the corresponding client instance. Frame ordering is
preserved per `conn_id`; no ordering is guaranteed across `conn_id`s.

### A.2 Control frames

Envelope-level control uses unwrapped frames (no `frame` field):

```jsonc
// ->
{"type": "conn_open", "conn_id": "b1", "url": "wss://backend.example/ws"}
// <-
{"type": "conn_ready", "conn_id": "b1"}
// <-
{"type": "conn_error", "conn_id": "b1", "code": "unreachable", "message": "..."}
// <-
{"type": "conn_close", "conn_id": "b1"}
// ->
{"type": "conn_close", "conn_id": "b1"}
```

- `conn_id` is an opaque string chosen by the opener, unique per physical socket.
- After `conn_ready`, the proxied backend's `server` frame arrives wrapped, as
  the first frame on that `conn_id`.
- `conn_close` from either side terminates the logical connection; the
  aggregator closes the upstream socket.
- Aggregator authentication (who may open conns, to where) is out of scope
  here and deployment-defined.

### A.3 Properties

The aggregator forwards inner frames without parsing them and holds only the
`conn_id`↔upstream-socket mapping. Backends remain authoritative; the envelope
can carry encrypted frame contents. Log namespacing remains client-defined (§2).

---

## Appendix B — Out-of-band channel negotiation: WebRTC (informative)

Planned capability `rtc`: the socket carries signaling; media travels out of
band. Future channels (screenshare, collaborative documents, file transfer)
should reuse this pattern: a session announcement with server-authoritative
membership, a join request returning connection configuration, and an opaque
relay frame.

### B.1 Sessions

A call is a server-announced, room-scoped session, following the re-sendable
metadata-frame idiom of `room` and `thread`:

```jsonc
// <-
{
  "method": "rtc",
  "params": {
    "room_id": "general",
    "session_id": "call_7",
    "kind": "voice",
    "members": [{"user_id": "alice", "name": "Alice"}],
    "active": true
  }
}
```

Re-sent on membership change; `"active": false` ends the session.

### B.2 Join / leave

```jsonc
// ->
{"method": "rtc_join", "id": "c40", "params": {"room_id": "general", "session_id": "call_7"}}
// <-
{
  "id": "c40",
  "result": {
    "ice": [{"urls": "stun:stun.example:3478"}, {"urls": "turn:turn.example", "username": "u", "credential": "c"}]
  }
}
// ->
{"method": "rtc_leave", "id": "c41", "params": {"session_id": "call_7"}}
```

ICE server configuration is vended at join time (mirroring the `upload` URL
pattern), since TURN credentials are deployment-specific and often
short-lived. Session creation is server-defined; a client MAY request one via
`rtc_join` with a fresh session ID, which the server confirms with the
authoritative `rtc` frame or rejects with `denied`.

### B.3 Signaling relay

The server relays notifications with opaque `payload` (SDP offers/answers,
ICE candidates, etc.). WebRTC handles loss and renegotiation.

```jsonc
// ->
{
  "method": "rtc_signal",
  "params": {"session_id": "call_7", "to": {"user_id": "bob"}, "payload": {"sdp_type": "offer", "sdp": "v=0..."}}
}
// <-
{
  "method": "rtc_signal",
  "params": {
    "session_id": "call_7",
    "from": {"user_id": "alice", "name": "Alice"},
    "payload": {"sdp_type": "offer", "sdp": "v=0..."}
  }
}
```

The backend routes `rtc_signal` by the required `to.user_id` within the session
and attaches the authenticated user's `from` identity to the forwarded signal.

### B.4 Topology

- **Mesh (normative baseline):** peers negotiate pairwise; the server purely
  relays. No media infrastructure; suitable for small trusted groups. Clients
  SHOULD soft-cap participant count.
- **SFU (future cap `rtc.sfu`):** a media server joins the session as an
  ordinary member with the reserved ID `@sfu`; clients negotiate a single
  PeerConnection with it via `rtc_signal`.

### B.5 Exclusions and knock-ons

- Mute/camera state frames are out of scope: state is derivable from media
  streams; an ephemeral notification may be added if needed.
- Invite/ring/reject state machines are out of scope: an `rtc` frame plus a
  push notification covers call arrival.
- Recording/transcoding is server-side and outside the protocol.
- When `rtc` lands, push payloads (§6.5) gain an optional `kind` hint
  (e.g. `{"kind": "rtc", "session_id": "...", ...}`) so mobile clients can show
  an incoming-call UI instead of a message notification.
- Without `rtc`, hide call UI; without `rtc.sfu`, use mesh only.
