# Apron Chat Protocol

Apron Chat Protocol is designed to be easy to implement in semi-trusted
environments. It runs over a WebSocket, or most other transports. The goal is
an ecosystem of many Apron Chat apps and servers that can speak with each
other: local bridges to other protocols, coding harnesses, internal message
rooms.

The protocol is incremental. The mandatory core ([§3](#3-core)) is all a minimal
implementation needs, about a hundred lines. Everything else is an optional
capability ([§4](#4-capabilities)).

[`schema/apron.schema.json`](schema/apron.schema.json) is an informative
JSON Schema of the frames, for validation and editor completion. Where it
disagrees with this document, this document wins.

Here's an example exchange to get a taste:

```jsonc
// <- server greeting with capabilities and auth schemes
{"method": "server", "params": {"apron": 7, "capabilities": ["rooms"], "auth": ["guest", "token"]}}

// -> guest auth, requesting a display name (the server may choose something else)
{"method": "auth", "id": "c1", "params": {"scheme": "guest", "name": "Ada"}}

// <- server assigns the identity
{"id": "c1", "result": {"you": {"user_id": "guest_1234", "name": "Ada"}}}

// -> client requests the joined rooms and its members (server may ignore the filters)
{"method": "room_list", "id": "c2", "params": {"filter": "joined", "members": true}}

// <- one room
{
  "id": "c2", "result": {
    "joined": [
      {"room_id": "general", "title": "General", "members": [{"user_id": "guest_1234", "name": "Ada"}]}
    ]
  }
}

// -> post a message
{"method": "message", "id": "c3", "params": {"room_id": "general", "body": {"text": "Hello"}}}

// <- server broadcasts to everyone in the room
{
  "method": "message", "params": {
    "message_id": "1724803200042", "log_id": "1724803200042", "room_id": "general",
    "from": {"user_id": "guest_1234", "name": "Ada"},
    "body": {"text": "Hello"}
  }
}

// <- confirmation, after the broadcast is complete
{"id": "c3", "result": {"message_id": "1724803200042"}}
```

This example uses the rooms capability. An implementation without it
ignores room fields and shows a single room.

---

## 1. Transport & framing

- WebSocket is the reference transport; others work if they deliver whole
  frames.
- A **frame** is one JSON object: one WebSocket text message, or one line on
  a byte-stream transport such as TCP or stdio (newline-delimited JSON).
- Frames are modeled on [JSON-RPC 2.0](https://www.jsonrpc.org/specification)
  requests, responses, and notifications (`method`, `params`, `id`, `result`,
  `error`), without the `"jsonrpc": "2.0"` key and with string `id`s only.
- Unknown keys MUST be ignored and MAY be dropped. Extension data goes in
  `ext` ([§3.5](#35-messages)).
- Servers MAY process requests concurrently and reply in any order. A client
  that needs one request applied before another waits for the first reply.
- On one connection, a result reflects every notification sent before it.
  Clients apply frames in arrival order.
- Notifications a request causes on the requesting connection, such as the
  broadcast of a posted message or the `room_update` of a join, are sent
  before its result.
- Server announcements and broadcasts are notifications.
- Servers reply `error/unsupported` to requests with unknown methods.
- Notifications with unknown methods are ignored.
- Servers ignore an `id` on a method that is only a notification, such as
  `activity`, and send no reply, even when its params are invalid.
- Implementations SHOULD accept frames up to 256 KiB. They MAY reject
  larger requests with `error/too_large`. Larger notifications may be
  dropped.
- A server MAY advertise `ping` ([§3.1](#31-server-frame)). Clients that support it
  then send exactly `{"method":"ping"}` at that interval. The server answers
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
people. Servers SHOULD make it specific enough to show as is, such as
"Session expired; sign in again" rather than "Denied".

Other application errors MAY use non-reserved JSON-RPC codes. Valid
notifications never receive error replies.

An error not tied to a request omits `id`. The server MAY close the
connection after sending one:

```json
{"error": {"code": -32002, "message": "Server at capacity", "data": {"retry_after": 30}}}
```

After `retry_after`, clients wait before reconnecting. After `denied`,
they do not reconnect automatically until the user acts.

### 1.2 Retries and deduplication

Retries SHOULD preserve `id`, `method`, and `params` across reconnects. New
operations, including changed parameters, MUST use a new `id`. Deduplication
ignores object key order.

Servers SHOULD deduplicate by `(user_id, id)`, using the authenticated `user_id`:

- A duplicate is not executed or broadcast again, and its result reflects
  the current state ([§1](#1-transport--framing)).
- Reuse with a different method or params is `invalid_params`.
- Concurrent duplicates are handled as one.

How long a server remembers an `id` is implementation-defined.
Request `id`s sent before authentication are connection-scoped;
authentication MUST execute on each connection.

---

## 2. Identifiers

All IDs are strings.

**`log_id`** — position of one change in the server's append-only log.

- Decimal string of Unix epoch milliseconds, e.g. `"1724803200042"`.
- One strictly increasing sequence per server, covering every record: room
  records ([§3.4](#34-rooms)), message snapshots ([§3.5](#35-messages)), reaction sets ([§4.5](#45-reactions)),
  memberships ([§4.3.2](#432-membership)).
- Value is the commit time, or the previous `log_id + 1` if the clock has not
  advanced past it.
- Clients MAY use it as a timestamp (this is the only one).
- Positive, below `2^53`, compared numerically. Clients MAY parse as integers.
- Unique within one server only.
- A room's log is the subsequence of records that touch that room
  ([§4.1](#41-history)).
- Reference generator: `str(max(unix_epoch_ms(), last_id + 1))`.

**`message_id`** — permanent identity of a message.

- Equal to the `log_id` of its creation; never changes.
- Unique across rooms.
- `log_id == message_id` marks the creation; later changes have greater
  `log_id`s.

**Records and replay.** Every record is the complete state for its key at its
`log_id`:

| record           | key                     |
|------------------|-------------------------|
| room record      | `room_id`               |
| message snapshot | `message_id`            |
| reaction set     | `(message_id, user_id)` |
| membership       | `(room_id, user_id)`    |

- Clients keep the record with the greatest `log_id` per key, regardless of
  source (live, history, embedded) or arrival order.
- Server fields are read-only: a request never changes them.
- Room records and message snapshots MAY carry `prev_log_id`, the `log_id`
  of the previous record for the same key. Other records do not.
- A client can fetch that record with `history`, with `after` and `before`
  both equal to it ([§4.1](#41-history)).
- A message snapshot whose previous record is in another room, after a move
  ([§4.2](#42-edit)), also carries `prev_room_id`, the room to ask.

**Opaque IDs** — `room_id`, `user_id`, `embed_id`, and request
`id`.

- Arbitrary strings chosen by whichever side creates them.
- `room_id` and `user_id` are server-assigned.
- Request `id`s SHOULD be random. They identify operations, not log
  positions.

---

## 3. Core

Every server implements this section; a minimal server implements only this
section. Optional features are advertised through capabilities ([§4](#4-capabilities)).

### 3.1 `server` frame

```ts
class Server {
  apron: number;                // protocol version
  auth: string[];               // at least one scheme, in preference order (§3.2)

  agent?: string;               // implementation/version string, for debugging
  capabilities?: string[] = []; // §4
  welcome?: string;             // user-readable Markdown details and auth instructions
  signup?: string[];            // schemes that create accounts; absent: same as auth (§3.2)
  ping?: number;                // seconds between client pings (§1)
  push?: object;                // push kinds and wake scopes; enables push (§4.7)
  status?: string[];            // optional status values accepted (§4.11)
  ext?: object;                 // opaque extension data (§3.5)
}
```

Upon accepting a connection, the server MUST immediately send a `server`
frame, unprompted. There is no client hello.

```json
{
  "method": "server", "params": {
    "apron": 7,
    "agent": "impl-name/1.0",
    "capabilities": ["history", "edit"],
    "auth": ["token"]
  }
}
```

The server MAY send a new `server` frame at any time; each **fully replaces**
the previous. Clients re-evaluate feature UI but MUST NOT un-render existing
content.

### 3.2 Authentication

```ts
class Auth {
  scheme: string;               // one of server.auth or server.signup

  name?: string;                // requested display name
  user_id?: string;             // requested user_id
  agent?: string;               // implementation/version string, for debugging

  // "token" and "email" schemes
  token?: string;

  // "email" scheme (§4.10)
  email?: string;

  // "webauthn" scheme (§4.9)
  action?: "register" | "login";
  step?: "begin" | "finish";
  challenge_id?: string;        // finish
  credential?: object;          // finish
}

class AuthResult {
  you?: User;                   // absent: nothing was authenticated
  token?: string;               // save the latest; it replaces any earlier one

  // "webauthn" scheme, begin step
  challenge_id?: string;
  public_key?: object;          // WebAuthn options
}
```

```jsonc
// ->
{
  "method": "auth", "id": "c1", "params": {
    "scheme": "token",
    "token": "...",
    "name": "Alice",
    "agent": "bottomless-web/0.3"
  }
}
// <-
{"id": "c1", "result": {"you": {"user_id": "alice", "name": "Alice"}}}
```

`params.scheme` selects the scheme:

- `guest`: no credentials. The server assigns the identity. Suggested
  convention: `guest_` plus a global counter, such as `guest_1234`
  ([§3.3](#33-identity)).
- `token`: bearer string. The reference default.
- `webauthn`: optional passkey scheme ([§4.9](#49-webauthn-authentication)).
- `email`: optional sign-in by a code sent to an email address ([§4.10](#410-email-authentication)).

Except for `webauthn` and `email`, servers MAY accept `auth` regardless of `scheme` and
ignore credentials under guest-access policies.

A successful `auth` result MAY carry `token`, a bearer token for signing in
with `scheme: "token"` on later connections. It is sent after a WebAuthn or
email sign-in ([§4.9](#49-webauthn-authentication), [§4.10](#410-email-authentication)), or in reply to `scheme: "token"` when
the server rotates the presented token. Clients save the latest `token`,
replacing any earlier one, and reconnect with it. A server MAY reject a
token it has replaced. Expired and revoked tokens are `denied`.
Lifetime, rotation, and revocation are server policy.

`server.welcome` is free text for the sign-in screen. It explains how this
server's schemes fit together, such as "Create an account
with email, then add a passkey to sign in with it. Email codes expire after
5 minutes."
Clients render it as Markdown under [§3.5](#35-messages)'s rules and MAY show it as
plain text. They never parse it.

With `signup`, `auth` lists the schemes that sign in and `signup` lists
those that create an account. For example, `"auth": ["webauthn"],
"signup": ["email"]` means join by email and sign in with a passkey after. A client whose only way back into
an account is a token SHOULD encourage its user to add another scheme
([§4.9](#49-webauthn-authentication), [§4.10](#410-email-authentication)). Suggested convention: listing and removing an
account's sign-in methods are server commands ([§4.8](#48-command)).

`name` and `user_id` are optional requests, valid with any scheme; `you`
is what the server assigned. Servers SHOULD NOT give out a previously used
`user_id` without authenticating its owner.

Clients MAY pipeline `auth` before `server` arrives. Before successful auth,
other requests get `denied` and other notifications are ignored.
The server MAY send notifications before auth, such as a `~private` welcome
([Appendix A.1](#a1-system-identities-and-scoped-notices), [Appendix B](#appendix-b--valid-scenarios-informative)).

`auth` is a barrier. The server finishes an `auth` request before it
processes any later frame on the connection. Clients MAY send requests
right behind it without waiting for its result. Later requests use the
connection's authentication as the `auth` left it. An `auth` that
authenticates nothing, such as a failure or a WebAuthn `begin` step,
leaves it unchanged.

### 3.3 Identity

```ts
class User {
  user_id: string;

  name?: string;                // absent: shown as user_id
  avatar?: string;              // image URL
  roles?: string[];             // server-defined labels, such as "admin" or "bot"
  status?: string;              // current objects only (§4.11)
  ext?: object;                 // opaque extension data (§3.5)
}
```

The server assigns identity. Every message carries its author in `from`.

```json
"from": {"user_id": "alice", "name": "Alice"}
```

`user_id` is required and stable. `name`, `avatar` ([§4.6.6](#466-avatars)), `roles`
(below), and `ext` ([§3.5](#35-messages)) are optional. Every identity on the wire
(`you`, `new`, `old`, `from`, `members`, `users`, a membership's `user`, a
room's `rtc` members and peers) uses this shape. Servers MAY send only
`user_id`.

User objects come in two kinds:

- **Current** objects describe the user now: `you` and `new` in a `user`
  notification, and room `members` and `users` in `room_list` and
  `room_update` ([§4.3](#43-rooms)). Clients keep one user object per `user_id` and merge every
  current object into it. Each field it carries replaces the kept value.
  An empty value (`""`, `[]`, `{}`) means the field was cleared. Fields it
  leaves out stay as they were.
- **Recorded** objects describe the user as of a record: a message's `from`,
  a reaction's `from`, a membership's `user` ([§4.3.2](#432-membership)). Later snapshots MAY keep
  them unchanged. Clients never merge them.

Clients render a user field by field from the kept object. They fall back
to the recorded object the frame carries only for fields the kept object
lacks. An empty or unknown `name` shows as `user_id`. Servers SHOULD
include `name` in `from`.

Clients SHOULD show a user as `Name (@user_id)` where space allows. They
MUST when they know another `user_id` with the same display name.

A `me` request updates the user's own profile after authentication. It
merges by the same rule as current objects. `name`, `avatar`, `ext`, and,
with capability `status`, `status` ([§4.11](#411-status)) are settable. `roles` is not.
The server MAY comply, decline, or alter any of them.
Servers announce a cleared field as its empty value:

```jsonc
// -> rename and clear the avatar; ext is untouched
{"method": "me", "id": "c2", "params": {"name": "Alice ⚙", "avatar": ""}}
// <-
{"id": "c2", "result": {"you": {"user_id": "alice", "name": "Alice ⚙", "avatar": ""}}}
```

After authentication, the server MAY send a `user` notification whenever a
user object changes. It carries `you` to the user's own connections, or
`new` to others who share a room with the user. `new` is the user's current
object. When `old` is also present, the user's `user_id` changed from
`old.user_id` to `new.user_id`. Joins and leaves are
memberships, not `user` notifications ([§4.3.2](#432-membership)).

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

Bots and agents are ordinary senders. Servers MAY assign `roles`, labels
such as `"admin"`, `"moderator"`, or `"trusted"` that clients show beside
the user's name. Suggested
convention: `"bot"` marks an automated user and `"admin"` a server operator;
clients show other roles as written.

- Roles are for display and grant nothing on the client. The server answers
  a disallowed request with `denied` ([§1.1](#11-envelope-and-replies)).
- Servers that publish roles SHOULD include them in `you` and in the
  `users` of `room_list` and `room_update` ([§4.3](#43-rooms)), and MAY in any other
  current object. A role change is a `user` notification like any profile
  change.
- Clients render roles distinctly from the name, such as badges.

### 3.4 Rooms

```ts
class Room {
  room_id: string;

  parent_room_id?: string;      // fixed once the room is created
  private?: boolean = false;    // members only (§4.3.4)
  title?: string;               // absent: shown as room_id
  description?: string;         // Markdown by convention
  ext?: object;                 // opaque extension data (§3.5)

  // "history" capability: required when advertised
  log_id?: string;
  prev_log_id?: string;
  latest_log_id?: string;
  history_log_id?: string | null;

  // "rooms" capability
  members?: User[];             // only in some frames
  member_count?: number;        // total members, when `members` is truncated
}
```

A room is a log with a server-chosen `room_id`. Every message refers to its room
([§3.5](#35-messages)). A server without capability `rooms` MAY have a single room. Clients learn
its `room_id` from the messages in it. They title any room they know nothing
more about by its `room_id`. Listing, joining, creating, and threads are capability
`rooms` ([§4.3](#43-rooms)).

A connection receives the messages and other records of the rooms its user
has joined. On servers without capability `rooms`, that is every room. For the
threads (below) of a joined room, it receives only changes to their room
records, as `room_update` ([§4.3.3](#433-updates)). A thread's messages go to the thread's
members. System notices are delivered by their scope instead
([Appendix A.1](#a1-system-identities-and-scoped-notices)).

A **room record** describes one room, as `room_list` and `room_update`
carry it ([§4.3](#43-rooms)):

```json
{
  "room_id": "general", "log_id": "1724800000000", "title": "General",
  "description": "Ops chatter: deploys, alerts, *incidents*.",
  "latest_log_id": "1724803200042", "history_log_id": "1724800000000"
}
```

`server`: assigned by the server, read-only ([§2](#2-identifiers)). `client`: supplied by the
client, replaced whole by a save. `delivery`: this client's view, not logged.
Clients always take the latest values, even if `log_id` did not change.

| field                     | set by   | meaning                                                                           |
|---------------------------|----------|-----------------------------------------------------------------------------------|
| `room_id`                 | server   | required                                                                          |
| `log_id`                  | server   | position of this room record ([§2](#2-identifiers))                               |
| `prev_log_id`             | server   | optional; this room's previous record ([§2](#2-identifiers))                      |
| `parent_room_id`          | client   | optional; fixed at creation; marks a thread ([§4.3.4](#434-creating-and-editing)) |
| `private`                 | client   | optional; visible only to members ([§4.3.4](#434-creating-and-editing))           |
| `title`                   | client   | optional plain string; absent falls back to `room_id`                             |
| `description`             | client   | optional string, Markdown by convention: what the room is about                   |
| `ext`                     | client   | optional opaque extension data ([§3.5](#35-messages))                             |
| `latest_log_id`           | delivery | greatest `log_id` in the room's log, memberships included                         |
| `history_log_id`          | delivery | inclusive lower bound of retrievable history, or `null` if none                   |
| `members`                 | delivery | on request in `room_list`, and in `room_update` `joined` ([§4.3](#43-rooms))       |
| `member_count`            | delivery | optional; how many users have joined, when `members` is truncated ([§4.3.1](#431-listing)) |

A room record is complete ([§2](#2-identifiers)). Omitted fields are cleared, except
`members` and `member_count`, which only some frames carry.

`description` is the room's summary, such as its purpose or the state of its
conversation. Anyone allowed to edit the room can change it with `room_set`
([§4.3.4](#434-creating-and-editing)). Clients render it as Markdown under [§3.5](#35-messages)'s rules
and MAY show it as plain text. `log_id`, `latest_log_id`, and
`history_log_id` are REQUIRED when capability `history` is advertised and OPTIONAL
otherwise; [§4.1](#41-history) defines their use.

Threads are rooms with a `parent_room_id`. Clients that ignore the field
render them as ordinary rooms. Clients that understand it group them under
the parent and MAY collapse or hide them. Servers set `title` on threads.

### 3.5 Messages

```ts
class Message {
  body?: {                      // required on creation; absent on tombstones (§4.2)
    text?: string = "";
    format?: "plain" | "markdown" = "plain";
    mentions?: string[] = [];   // user_ids
    embeds?: Embed[] = [];      // §4.6
  };

  room_id?: string;             // absent: the server's default room
  reply_to?: { message_id: string } | Message;   // bare from clients
  ext?: object;                 // opaque extension data (§3.5)

  // set by the server
  message_id?: string;          // absent on transient notices; sent by clients only to save (§4.2)
  log_id?: string;              // absent on transient notices
  from: User;

  prev_log_id?: string;
  prev_room_id?: string;        // only after a move

  // "edit" capability
  deleted?: boolean = false;
}
```

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
// <- broadcast to every client in the room, including the sender
{
  "method": "message", "params": {
    "message_id": "1724803200042", "log_id": "1724803200042", "room_id": "general",
    "from": {"user_id": "alice", "name": "Alice"},
    "body": {"text": "hello *world*", "format": "markdown"}
  }
}
// <-
{"id": "c3", "result": {"message_id": "1724803200042"}}
```

| field          | set by | meaning                                                                 |
|----------------|--------|-------------------------------------------------------------------------|
| `message_id`   | server | permanent ID ([§2](#2-identifiers))                                     |
| `log_id`       | server | position of this snapshot in the log ([§2](#2-identifiers))             |
| `prev_log_id`  | server | optional; this message's previous snapshot ([§2](#2-identifiers))       |
| `prev_room_id` | server | the previous snapshot's room, when it differs ([§2](#2-identifiers))    |
| `from`         | server | author identity ([§3.3](#33-identity)), preserved across changes        |
| `room_id`      | client | the room the message is in; omitted, the default room                   |
| `body`         | client | `text`, `format`, `embeds`, `mentions`                                  |
| `reply_to`     | client | optional message object referring to the message replied to             |
| `deleted`      | client | tombstone marker, default false ([§4.2](#42-edit))                      |
| `ext`          | client | optional object of namespaced, opaque extension data                    |

**Extensions.** `ext` carries data the spec does not define, keyed by
namespace:

```json
"ext": {"irc": {"network": "libera", "channel": "#ops", "nick": "ada_", "msgid": "a1b2c3"}}
```

Clients need not parse `ext`. They MUST send it back unchanged when saving a
message ([§4.2](#42-edit)) or room ([§4.3.4](#434-creating-and-editing)) unless they mean to change it.
Data that must survive other clients' saves belongs in `ext`, not in unknown
top-level keys. Servers MAY limit `ext` or normalize or reject any field by
local policy.

- `body` is required on creation. `text` defaults to `""`, and `embeds`
  and `mentions` default to `[]`. `format` is `"plain"` or `"markdown"`,
  default `"plain"`.
- Both formats are mandatory to render. Markdown is CommonMark with fenced
  code blocks.
- Clients MUST disable raw HTML in Markdown or sanitize it under the same
  allowlist as HTML embeds ([§4.6](#46-embeds-and-avatars)).
- Clients MUST render embeds of unknown `kind` from `og` if present,
  otherwise as a labeled fallback card (kind name, plus `url` or plain
  `text` if present).
- A request without `room_id` posts to the server's default room. The
  snapshot refers to that room.
- Posting does not require joining the room. Servers MAY deny it by policy
  (`denied`).
- An unknown or invisible `room_id` is `invalid_params`.
- A new message with no `text` and no `embeds` SHOULD be neither logged nor
  broadcast; its result is then `{}`.
- **Result:** `{"message_id": "..."}`, the permanent ID. It is the
  confirmation.
- The broadcast goes to the connections that receive the room's deliveries
  ([§3.4](#34-rooms)). When the sender's connection is one of them, the broadcast comes
  before the result ([§1](#1-transport--framing)).
- A deduplicated retry ([§1.2](#12-retries-and-deduplication)) produces no broadcast.
- **Snapshots replace** under the replay rule ([§2](#2-identifiers)), including for messages
  the client has not loaded.
- Servers MAY publish a snapshot of any message at any time. Support is
  mandatory regardless of capability `edit`.
- **References.** `reply_to` holds a message object. Clients send it bare,
  with only `message_id`. Servers optionally send a full snapshot, which
  clients install like any other. Embedded snapshots carry a bare
  `reply_to`.
- Clients render the referring message even when the target is missing or
  deleted.
- `reply_to.message_id` MUST refer to an existing message other than the message
  itself; it MAY be in another room. Invalid references are `invalid_params`.
- On a live connection, servers deliver each room's snapshots in ascending
  `log_id`, and each snapshot once per connection.
- A `message` notification without `message_id` is a transient notice, such
  as a private system notice ([Appendix A.1](#a1-system-identities-and-scoped-notices)). Clients render it but never
  install it as a snapshot.

**Mentions.** A message lists the users it mentions in `body.mentions`, and
usually shows each one in `body.text` ([Appendix A.3](#a3-prefixes-in-text)):

```json
"body": {
  "text": "@guest_1234 can you check `@property` in https://example.com/@bob?",
  "format": "markdown",
  "mentions": ["guest_1234"]
}
```

- Servers ([§4.7](#47-push)) and clients treat as mentioned only the users in
  `mentions`, whatever `text` contains.
- Servers never parse `text` to find mentions.
- An edit ([§4.2](#42-edit)) mentions only the users it adds to `mentions`; users
  already listed are not mentioned again.
- Composers add a user to `mentions` when the user picks them, and write
  the mention in `text`.
- Mentions that notify a whole room are not defined.

### 3.6 Core conformance checklist

Every server:

1. Sends a `server` frame on connect ([§3.1](#31-server-frame)).
2. Accepts at least one `auth` scheme, replies with `you`, and finishes
   `auth` before processing later frames ([§3.2](#32-authentication)).
3. Accepts `message` without `room_id` into its default room ([§3.5](#35-messages)).
4. Accepts `message` creation: replies with `message_id` and broadcasts the
   snapshot to the room ([§3.5](#35-messages)).
5. Replies `error/unsupported` to unknown requests, including `message` with
   a `message_id` when capability `edit` is absent; ignores unknown notifications.
6. Follows [§1](#1-transport--framing) for framing and retries and [§2](#2-identifiers) for identifiers.

The opening example is a complete session with a server that has capability
`rooms`. A minimal server skips `room_list`: its client posts without
`room_id` and learns the room from the broadcast.

A minimal client (informative):

1. Authenticates with `auth` once `server` arrives, and posts with `message`
   ([§3.2](#32-authentication), [§3.5](#35-messages)).
2. Groups messages by `room_id`, titling a room by its `room_id` unless it
   knows its record ([§3.4](#34-rooms)).
3. Keeps each message's snapshot with the greatest `log_id`, from any
   source, and renders tombstones ([§2](#2-identifiers), [§3.5](#35-messages)).
4. Keeps one user object per `user_id`, merged from current objects and
   falling back to `from`, and shows `Name (@user_id)` when two `user_id`s
   share a name ([§3.3](#33-identity)).
5. Renders `plain` and `markdown` text with raw HTML disabled, and a
   fallback card for embed kinds it does not support ([§3.5](#35-messages)).
6. Matches replies by `id`, acts on error codes, and ignores unknown
   notifications and keys ([§1](#1-transport--framing)).

---

## 4. Capabilities

`server.capabilities` advertises optional requests. Capabilities advertise support,
not authorization. Servers still apply local policy per request. Nothing is
negotiated. Clients ignore capabilities they do not recognize ([§1](#1-transport--framing)). A client
whose server lacks a capability falls back as below:

| capability     | adds                                                         | fallback                     | spec                       |
|----------------|--------------------------------------------------------------|------------------------------|----------------------------|
| `history`      | page and recover a room's log                                | session-only scrollback      | [§4.1](#41-history)        |
| `edit`         | `message` saves: edit, move, delete                          | no edit/move/delete UI       | [§4.2](#42-edit)           |
| `rooms`        | `room_list`, `room_join`, `room_leave`, `room_set`, updates  | one default room, no threads | [§4.3](#43-rooms)          |
| `activity`     | typing and read markers                                      | no typing or read indicators | [§4.4](#44-activity)       |
| `reactions`    | emoji reactions on messages                                  | reaction controls hidden     | [§4.5](#45-reactions)      |
| `embed:upload` | `upload` embeds: files the sender writes over HTTP           | no attachments               | [§4.6.4](#464-embedupload) |
| `embed:stream` | live-streamed text in a message                              | post the finished text       | [§4.6.5](#465-embedstream) |
| `command`      | commands from client to server, such as `/kick`              | no commands                  | [§4.8](#48-command)        |
| `status`       | user `status`, idle connections, and mutes                   | no online indicators         | [§4.11](#411-status)       |

Some features have no capability. Other embeds are body content ([§4.6](#46-embeds-and-avatars)).
Push follows `server.push` ([§4.7](#47-push)). Passkeys and email sign-in follow
`server.auth` ([§4.9](#49-webauthn-authentication), [§4.10](#410-email-authentication)). Liveness follows `server.ping`
([§1](#1-transport--framing)).

By convention, third-party extension capabilities use an `ext:` prefix, such as
`ext:irc`.

Six frame idioms cover everything logged or announced:

- **Records** (room records, `message`): complete state at a `log_id` ([§2](#2-identifiers)).
- **Per-user state** (`reactions`, memberships): the user plus their complete
  state for a scope; newest wins per user. Logged ([§2](#2-identifiers)).
- **Activity** (`activity`): `from` plus changes to the user's transient
  state. Absent fields leave it unchanged. Unlogged.
- **Announcements** (`server`): unlogged, re-sent in full; each
  replaces the last.
- **Room updates** (`room_update`): changes to the user's rooms, carrying
  room records and memberships, never a full list ([§4.3.3](#433-updates)).
- **Users** (`user`, and every current user object): unlogged; each merges
  into the kept object ([§3.3](#33-identity)).

### 4.1 `history`

Stateless window query over a room's **log**. A result splits the log by
kind. `rooms` holds room records ([§3.4](#34-rooms)), `messages` message snapshots
([§3.5](#35-messages)), `reactions` reaction sets ([§4.5](#45-reactions)), and `memberships` memberships
([§4.3.2](#432-membership)). Without `room_id`, it pages the default room ([§3.5](#35-messages)).

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
    "messages": [
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
    "memberships": [
      {
        "log_id": "1724803300000", "room_id": "general",
        "members": [{"user": {"user_id": "dave", "name": "Dave"}, "joined": true}]
      }
    ],
    "first_log_id": "1724803200042", "last_log_id": "1724803312011", "more": true,
    "latest_log_id": "1724806800000", "history_log_id": "1724800000000"
  }
}
```

**Which rooms a record is in.** A record belongs to every room its message is
in just before or after it. Room
records and memberships belong to their own room. Earlier history of a moved
message stays in the source room; `prev_room_id` points there ([§2](#2-identifiers)).

**Bounds and ordering.**

- `after`/`before` are inclusive `log_id` bounds; either MAY be omitted.
- Intersect the bounds with available history, then select a contiguous
  slice of the room's changes of any kind. `limit` is a positive count of
  changes, applied before compaction. Servers MAY clamp it and supply a
  default. With `after`, select the oldest matches; otherwise the newest.
- `first_log_id`/`last_log_id` are the slice's first and last `log_id`s
  before compaction. Return both or neither. `more` indicates further
  matching changes in the selected direction. An empty slice returns
  `more: false` and neither bound.
- `rooms`, `messages`, `reactions`, and `memberships` MAY each be omitted when
  empty; clients treat a missing array as empty. Each is ascending by
  `log_id`.
- Continue forward with `after = last_log_id + 1`, backward with
  `before = first_log_id - 1`, computed numerically and encoded as strings.
  Never derive continuation from compacted records.

**Availability.** Every result includes `latest_log_id` and `history_log_id`
([§3.4](#34-rooms)), captured consistently with the page. They describe the room, not the
page. Retention may advance between requests. Clients check each response
before applying it. A resource rejection is an error, not an empty result.

**Retention.** Servers SHOULD compact old history at rest rather than discard
it. Compaction keeps the latest record per key under the rules below.
Compacted history still counts as available and leaves `history_log_id` in
place. A server that discards a prefix advances `history_log_id`. The
effective lower bound is `history_log_id`, or `latest_log_id + 1` when
null. It MUST NOT decrease. Before discarding a prefix that holds
memberships, a server appends one membership record listing every current
member (`joined: true` only).

**Compaction (optional).** After selecting the slice, a server MAY keep only
the last room record and each message's last snapshot in the slice. It MAY
fold each message's reaction sets into one record carrying each user's last
set in the slice, under the greatest folded `log_id`. It MAY likewise fold
the room's memberships into one record carrying each user's last
membership. Empty sets and leaves are kept. Retained records keep
their original `log_id`s and contents and never incorporate changes after
the slice. Compacted and uncompacted pages yield the same terminal state.

**Replay** follows [§2](#2-identifiers). No earlier state is needed to apply a record, and
order across the arrays is irrelevant.

**Recovery**, per room:

1. When live delivery starts, after authentication or on joining, buffer
   live records for the room. Take `H` as its `latest_log_id`, from its room
   record ([§4.3.1](#431-listing)) or a `history` page, and keep the buffered records
   above H.
2. Page forward with `before: H`, from `after: C + 1` given a checkpoint C,
   otherwise from `after: history_log_id`, until `more: false`.
3. Apply the buffered records. The checkpoint is now H.

If a response's effective lower bound passes the next position needed,
clear the room's state and restart from that bound. Clients recover each
room they display independently. Threads load when opened.

### 4.2 `edit`

A `message` request carrying an existing `message_id` **saves** that message.
A save replaces every client field ([§3.5](#35-messages)) with the submitted state. Omitted
fields are removed. Objects and arrays are replaced whole. `null` has no
deletion meaning. Clients MUST resubmit every client field they want kept. The server preserves
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
// <- snapshot with a new log_id
{
  "method": "message", "params": {
    "message_id": "1724803200042", "log_id": "1724803312007", "room_id": "general",
    "prev_log_id": "1724803200042",
    "from": {"user_id": "alice", "name": "Alice"},
    "body": {"text": "hello world", "format": "plain"}
  }
}
// <-
{"id": "c12", "result": {"message_id": "1724803200042"}}
```

An unknown `message_id` is `invalid_params`.
Unauthorized saves are `denied` by server policy. The authoritative snapshot
MAY differ from the submitted state.

**Move.** A save with a different `room_id` moves the message. The
destination MUST exist and be visible to the caller. The snapshot is
delivered to both rooms ([§4.1](#41-history)). Clients move the message rather than
treating it as deleted. The snapshot carries `prev_room_id`, the source
room ([§2](#2-identifiers)). If the message has reactions, the server then logs one
reactions record ([§4.5](#45-reactions)) in the destination carrying every non-empty set.

```jsonc
// -> move Bob's reply into thread room 1724803312001
{
  "method": "message", "id": "c15", "params": {
    "message_id": "1724803200043", "room_id": "1724803312001",
    "reply_to": {"message_id": "1724803200042"},
    "body": {"text": "Hello back!"}
  }
}
// <- to both rooms
{
  "method": "message", "params": {
    "message_id": "1724803200043", "log_id": "1724803312020", "room_id": "1724803312001",
    "prev_log_id": "1724803200043", "prev_room_id": "general",
    "from": {"user_id": "bob", "name": "Bob"},
    "reply_to": {"message_id": "1724803200042"},
    "body": {"text": "Hello back!"}
  }
}
```

**Delete** is a save with `deleted: true`. `body` is then optional, and the
server MUST omit it from the tombstone. `deleted: true` on creation is
`invalid_params`.

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
of a logged record. Clients holding the old content drop it on the new
tombstone.

### 4.3 `rooms`

Capability `rooms` adds rooms and threads, which users find, join, and create. It
adds the requests `room_list`, `room_join`, `room_leave`, and `room_set`,
and the notification `room_update`. Visibility and membership are server
policy.

#### 4.3.1 Listing

`room_list` answers with the rooms matching its filters, as room records
([§3.4](#34-rooms)) in up to two arrays: `joined`, rooms the user has joined, and
`not_joined`, visible rooms the user has not joined. Listing never joins.

```jsonc
// -> my rooms, threads included, with their members
{"method": "room_list", "id": "c20", "params": {"filter": "joined", "members": true}}
// <-
{
  "id": "c20", "result": {
    "joined": [
      {
        "room_id": "general", "log_id": "1724800000000", "title": "General",
        "latest_log_id": "1724803500000", "history_log_id": "1724800000000",
        "members": [{"user_id": "alice"}, {"user_id": "bob"}, {"user_id": "carol"}]
      },
      {
        "room_id": "1724803312001", "log_id": "1724803312001",
        "parent_room_id": "general", "title": "Deploy", "description": "Why the 4pm deploy failed",
        "latest_log_id": "1724803400000", "history_log_id": "1724803312001",
        "members": [{"user_id": "alice"}, {"user_id": "bob"}]
      }
    ],
    "users": [
      {"user_id": "alice", "name": "Alice", "avatar": "https://..."},
      {"user_id": "bob", "name": "Bob"},
      {"user_id": "carol", "name": "Carol"}
    ]
  }
}
// -> reconnecting: my rooms that changed since a position, and those I left
{"method": "room_list", "id": "c21", "params": {"filter": "joined", "latest_log_id": "1724803450000"}}
// <-
{
  "id": "c21", "result": {
    "joined": [{"room_id": "general", "latest_log_id": "1724803500000", ...}],
    "left": [{"room_id": "1724803399000"}]
  }
}
// -> general's threads I have not joined
{"method": "room_list", "id": "c22", "params": {"parent_room_id": "general", "filter": "not_joined"}}
// -> one room, with its members
{"method": "room_list", "id": "c23", "params": {"room_id": "1724803312001", "members": true}}
```

Every filter is optional:

- `filter`: `"joined"` lists only `joined`, `"not_joined"` only
  `not_joined`, and `"all"`, the default, both. An array the filter asks
  for is present even when empty, and the other is omitted.
- `parent_room_id` lists only that room's threads. Without it, `joined`
  holds joined rooms at every depth, threads included, and `not_joined`
  only top-level rooms.
- `room_id` lists only that room, in the array its membership selects. It
  overrides `parent_room_id`. An unknown or invisible `room_id` is
  `invalid_params`. Servers SHOULD accept it.
- `members: true` adds each room's `members` and the result's `users`
  (below); without it, a result carries neither.
- `latest_log_id` lists only rooms whose `latest_log_id` is greater. When
  the result has `joined`, rooms the user left since then are in `left`, as
  `[{room_id}]` like `room_update` ([§4.3.3](#433-updates)). Rooms deleted or no longer
  visible since then SHOULD be in `left` too. A server applying this filter
  includes `left`, even when empty. A server MAY ignore the filter. Its
  result then has no `left` and is a full listing.

A result lists matching rooms, most recently active first. `joined` lists
every match. Servers MAY list only the most recently active of
`not_joined`. Private rooms are listed only to their members
([§4.3.4](#434-creating-and-editing)).

With `members: true`, each room in `joined` and `not_joined` carries
`members`, every user who has joined it, as complete or partial user
objects ([§3.3](#33-identity)). The result MAY carry `users`, the complete current objects
for the users in its `members`, each listed once.

A server MAY truncate `members` in a large room, such as to the most
recently active. It then SHOULD include `member_count`, the number of users
who have joined.

#### 4.3.2 Membership

`room_join` and `room_leave` take a `room_id` and return `{}`, after the
notifications they cause ([§1](#1-transport--framing)). An unknown or invisible `room_id` is
`invalid_params`. The server MAY deny either by policy.

A server MAY also accept a `user_id`, to join or remove another user. Who
may do either is server policy. A server that does not support it replies
`unsupported`. The change is an ordinary join or leave by that user.

```jsonc
// -> Alice adds Bob to her private room
{"method": "room_join", "id": "c3", "params": {"room_id": "1724803950000", "user_id": "bob"}}
```

Joining subscribes every connection of the user to the room's deliveries
([§3.4](#34-rooms)). A thread is joined like any room. Members of its parent room
receive only its room record changes ([§4.3.3](#433-updates)).

Every membership change is a logged record in the room, including a
creation with `room_set` and changes the server makes. A membership record carries `members`, one entry per user, each
with the user as a recorded object ([§3.3](#33-identity)) and `joined`. `room_update`
delivers it in `memberships` ([§4.3.3](#433-updates)):

```jsonc
// ->
{"method": "room_join", "id": "c24", "params": {"room_id": "1724803399000"}}
// <- to the room's other members
{
  "method": "room_update", "params": {
    "memberships": [
      {"log_id": "1724803450100", "room_id": "1724803399000", "members": [{"user": {"user_id": "ada", "name": "Ada"}, "joined": true}]}
    ]
  }
}
// <- to the joining user's connections: the room with its members, and the membership
{
  "method": "room_update", "params": {
    "joined": [{"room_id": "1724803399000", ..., "members": [{"user_id": "ada"}, {"user_id": "bob"}]}],
    "memberships": [
      {"log_id": "1724803450100", "room_id": "1724803399000", "members": [{"user": {"user_id": "ada", "name": "Ada"}, "joined": true}]}
    ],
    "users": [{"user_id": "ada", "name": "Ada"}, {"user_id": "bob", "name": "Bob"}]
  }
}
// <-
{"id": "c24", "result": {}}

// ->
{"method": "room_leave", "id": "c25", "params": {"room_id": "1724803312001"}}
// <- to the leaving user's connections; the room's other members get the membership alone
{
  "method": "room_update", "params": {
    "left": [{"room_id": "1724803312001"}],
    "memberships": [
      {"log_id": "1724803450200", "room_id": "1724803312001", "members": [{"user": {"user_id": "ada"}, "joined": false}]}
    ]
  }
}
{"id": "c25", "result": {}}
```

- A membership's key is `(room_id, user.user_id)`, and the record with the
  greatest `log_id` wins ([§2](#2-identifiers)). Live records carry one entry; compacted
  history records MAY carry several ([§4.1](#41-history)), each replacing that user's
  membership.
- A membership record is delivered to the room's members both before and
  after the change. It advances the room's `latest_log_id`.
- Clients start a room's member list from its `members` in `room_list` or
  `room_update` `joined`. They keep it current from the memberships they
  receive, live and in history.
- A server MAY keep membership outside the log, such as for ephemeral
  guests. It then sends no membership records for them and ignores
  `latest_log_id` in `room_list` ([§4.3.1](#431-listing)).

#### 4.3.3 Updates

`room_update` tells the user's connections what changed, never the full
list:

- `joined`: room records of rooms the user joined by any means, each with
  its `members` as in `room_list` ([§4.3.1](#431-listing)). `users` MAY accompany them.
- `left`: `[{room_id}]` of rooms the user is no longer in, for any reason.
- `memberships`: membership records ([§4.3.2](#432-membership)), to the room's members.
- `updated`: room records that are new or changed while membership is not.
  These are edits to a joined room and new or edited threads of one. A
  thread's record changes reach the parent's members, joined to the thread
  or not, unless the thread is private. Messages in a thread do not produce
  `updated`, so its `latest_log_id` there is as of the last record change.

```jsonc
// <- after the join above
{"method": "room_update", "params": {"joined": [{"room_id": "1724803399000", "parent_room_id": "general", "title": "Incident", ...}]}}
// <- after the leave above
{"method": "room_update", "params": {"left": [{"room_id": "1724803312001"}]}}
// <- a joined room was renamed
{"method": "room_update", "params": {"updated": [{"room_id": "general", "log_id": "1724803600000", "title": "General (ops)", ...}]}}
```

#### 4.3.4 Creating and editing

`room_set` without `room_id` creates a room and joins the creator. With
`room_id` it replaces the client fields ([§3.4](#34-rooms)). Fields ending in `_id`
are fixed at creation, and so is `private` where the server fixes it. An
omitted `private` is kept, and other omitted fields are cleared. Both
return `{"room_id": "..."}` after the resulting `room_update`.

```jsonc
// -> start a thread in general
{
  "method": "room_set", "id": "c26", "params": {
    "parent_room_id": "general", "title": "Deploy",
    "description": "Why the 4pm deploy failed"
  }
}
// <- to the creator: the room with its members, and the creator's membership
{
  "method": "room_update", "params": {
    "joined": [
      {
        "room_id": "1724803312001", "log_id": "1724803312001",
        "parent_room_id": "general", "title": "Deploy",
        "description": "Why the 4pm deploy failed",
        "latest_log_id": "1724803312002", "history_log_id": "1724803312001",
        "members": [{"user_id": "ada"}]
      }
    ],
    "memberships": [
      {"log_id": "1724803312002", "room_id": "1724803312001", "members": [{"user": {"user_id": "ada", "name": "Ada"}, "joined": true}]}
    ]
  }
}
// <- then the result
{"id": "c26", "result": {"room_id": "1724803312001"}}

// -> later, a summarizer bot rewrites the description, resubmitting the title
{
  "method": "room_set", "id": "s9", "params": {
    "room_id": "1724803312001", "title": "Deploy",
    "description": "Root cause: **expired cert** on the build runner. Fix is rolling out."
  }
}
// <- to the thread's members and to general's members
{
  "method": "room_update", "params": {
    "updated": [
      {
        "room_id": "1724803312001", "log_id": "1724803900000", "prev_log_id": "1724803312001",
        "parent_room_id": "general", "title": "Deploy",
        "description": "Root cause: **expired cert** on the build runner. Fix is rolling out.",
        "latest_log_id": "1724803900000", "history_log_id": "1724803312001"
      }
    ]
  }
}
{"id": "s9", "result": {"room_id": "1724803312001"}}
```

- `parent_room_id` MUST refer to an existing visible room. Nesting depth is
  server policy.
- `private: true` makes the room visible only to its members. To anyone
  else, its `room_id` is `invalid_params` like an unknown one. A thread
  created without `private` takes its parent's. Members bring others in by
  joining them ([§4.3.2](#432-membership)), where the server supports it.
- A server includes `private: true` only on a room it keeps private. A
  server that does not keep private rooms MUST reject a creation with
  `private: true` as `unsupported`.
- A client that asks for a private room checks its `room_update` `joined`
  record for `private: true` before posting in the room. Without it, the
  client tells the user rather than using the room.
- Editing a room is server policy. Suggested convention: members of a room
  may edit it.
- The server MAY adjust or supply metadata by policy. Unknown `room_id`,
  unknown `parent_room_id`, or invalid types are `invalid_params`;
  unauthorized requests are `denied`.

#### 4.3.5 Posting

Posting in a room does not require joining it ([§3.5](#35-messages)). The server MAY
deny the post or join the poster. A poster who has not joined does not
receive the broadcast.

### 4.4 `activity`

Capability `activity`. A client reports changes to its activity as a
notification: typing, and how far it has read in a room. Each present
field updates that state, and absent fields leave it unchanged. Activity
is not logged. Servers MAY drop `typing` and `read_message_id`.

```jsonc
// -> start typing
{"method": "activity", "params": {"room_id": "general", "typing": 8}}
// -> stop typing
{"method": "activity", "params": {"room_id": "general", "typing": 0}}
// -> advance the read cursor
{"method": "activity", "params": {"room_id": "general", "read_message_id": "1724803312050"}}
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
- Delivery is server policy, such as to the room or only to the user's own
  connections.
- Servers MAY keep each user's latest `read_message_id` per room and send
  it to the user's connections after they list the room ([§4.3.1](#431-listing)).

### 4.5 `reactions`

Capability `reactions`. A client sets its own complete set of emoji on one
message. The server logs the change with a `log_id` and broadcasts it to
the message's room. The result is `{}`.

```jsonc
// ->
{"method": "reactions", "id": "c17", "params": {"message_id": "1724803200043", "emojis": ["👍"]}}
// <- (broadcast)
{
  "method": "reactions", "params": {
    "log_id": "1724803312011", "message_id": "1724803200043", "room_id": "1724803312001",
    "reactions": [{"from": {"user_id": "carol", "name": "Carol"}, "emojis": ["👍"]}]
  }
}
// <-
{"id": "c17", "result": {}}
```

- The request refers only to the message. The logged record carries the
  message's room at that moment ([§4.1](#41-history)).
- The notification's `reactions` array holds one element per user. Live
  broadcasts carry one; compacted history records ([§4.1](#41-history)) MAY carry
  several. Each element replaces that user's set on that message.
- Clients keep state per `(message_id, user_id)` and derive the aggregate.
  They tolerate
  reactions for messages they have not loaded.
- `emojis` entries are strings. Duplicates collapse, and order is
  insignificant. One emoji sequence per entry is the interoperable baseline.
  Servers MAY normalize, reject other strings, or cap distinct emoji per
  message or per user, all `invalid_params`. An unknown `message_id` is
  `invalid_params`. A request that leaves state unchanged MAY produce no
  change.
- Retries follow [§1.2](#12-retries-and-deduplication). Push wake-ups for reactions are server policy.

### 4.6 Embeds and avatars

```ts
class Embed {
  kind: string;                 // "upload", "stream", "iframe", "html", or another

  embed_id?: string;            // set by servers with any embed:* capability (§4.6.2)
  title?: string;
  url?: string;                 // where a click goes; the server's own for upload and stream
  og?: object;                  // OpenGraph description (§4.6.1)

  // "iframe" kind
  height?: number;              // suggested height

  // "html" kind
  html?: string;

  // "stream" kind (§4.6.5)
  format?: string = "plain";
  text?: string;                // the kept text, once the stream ends
}
```

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
  loading; a cap on concurrently live iframes.
- `html`: sanitize with an allowlist sanitizer (e.g. DOMPurify) before
  insertion, regardless of source.
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

- Clients use the `og` properties `title`, `description`, `site_name`,
  and `image`, `video`, and `audio` (each with `url`, `type`, `width`,
  `height`, `alt`). They ignore other properties.
- `og.image` is a preview to show, `og.video` and `og.audio` are what a
  player loads, and the embed's own `url` is where a click goes.
- Servers SHOULD set `og` in the broadcast. They MAY keep, replace, or
  drop one a client sent. They SHOULD
  host or proxy the media it references and set its dimensions. Clients
  SHOULD NOT load `og` media from other origins.

#### 4.6.2 Embed identity

Servers that advertise any `embed:*` capability assign each
embed an opaque `embed_id`; other servers MAY store embeds as given.

- A save keeps an embed by sending it back with its `embed_id`. An embed
  without one is new. A save that leaves out an `embed_id` removes that
  embed. An unknown `embed_id` is `invalid_params`.
- The server owns `embed_id`, an upload's `url`, and a stream's `url` and
  `text`. It ignores them on input and restores them on a save from
  its records.
- Servers SHOULD delete content they host for an embed when the embed is
  removed or its message is deleted or redacted.
- Servers SHOULD make the URLs they host unguessable, such as with a random
  path segment rather than just the `embed_id`.

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
// <- the broadcast first, with the embed pending
{"embed_id": "embed_1235", "kind": "upload", "title": "before.png"}
// <- then the result, with the write URL for the sender only
{
  "id": "c8", "result": {
    "message_id": "1724803500000",
    "embeds": [{"embed_id": "embed_1235", "kind": "upload", "write_url": "https://chat.example/w/4c7a…"}]
  }
}
// sender: curl -T before.png https://chat.example/w/4c7a…
// <- the embed as broadcast in a later snapshot, completed
{
  "embed_id": "embed_1235", "kind": "upload", "title": "before.png",
  "url": "https://chat.example/f/Zr8Tq1…",
  "og": {
    "title": "before.png",
    "image": {"url": "https://chat.example/f/Zr8Tq1…/thumb", "type": "image/webp", "width": 320, "height": 180}
  }
}
```

- The sender sends the content as the body of an HTTP `PUT` to
  `write_url`. `write_url` is a credential and expires if unused.
- The server finishes each write exactly once. On success it publishes a
  snapshot with the embed completed. If the write fails or does not start
  in time, it publishes a snapshot without the embed. For a command, the server
  acts on the finished write instead, such as setting an avatar ([§4.6.6](#466-avatars)).

#### 4.6.4 `embed:upload`

Capability `embed:upload`. The sender gives an optional `title`, such
as the file name. While `url` is absent the upload is pending, and clients
show a placeholder. On success the server sets `url` to the file it hosts.

- The server SHOULD add `og` describing the file: `image` for a preview,
  and `video` or `audio` for playable media. It MAY keep what the sender
  gave, such as `og.image.alt`.
- Without `og`, clients show a file card: `title` linking to `url`.

#### 4.6.5 `embed:stream`

Capability `embed:stream`. A message can carry live text that the sender writes over
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

- `format` defines how to render the text. The default, `"plain"`, is
  shown as is with line breaks kept. Clients MAY support other formats natively, such as
  `"markdown"` (rendered under [§3.5](#35-messages)'s rules) or `"terminal"`, and render
  unknown formats as plain.
- Write: the sender sends UTF-8 text as a streaming `PUT` body to
  `write_url` ([§4.6.3](#463-writes)). The end of the body ends the stream.
- Read: `GET url` returns the text the server has kept, continues as more
  arrives, and ends when the stream does. A reader that reconnects replaces
  what it has shown with the new response.
- Finish: when the stream ends, the server publishes a snapshot whose embed
  carries the kept text as `text` in place of `url`, and both URLs stop
  working. A sender with capability `edit` MAY save the message without the embed
  first, which ends the stream.
- How much text the server keeps, size and time limits, and the grace period
  after a writer disconnects are server policy. At a limit, the server ends
  the stream and keeps the trailing text.
- `url` is served by the chat server; clients SHOULD NOT connect to stream
  URLs on other origins.

#### 4.6.6 Avatars

A user object ([§3.3](#33-identity)) MAY carry `avatar`, an image shown beside
the user's name.

- Servers send `avatar` in current user objects ([§3.3](#33-identity)): `you`, `user`,
  and room `members` and `users`, not in every `from`.
- Servers SHOULD return only `https:` URLs or small
  `data:image/{png,jpeg,gif,webp};base64,` URLs. A larger image goes through
  an upload (capabilities `command` and `embed:upload`). A `/avatar` command
  ([§4.8](#48-command)) with one `upload` embed asks the server to use that file as the
  sender's avatar. When the upload completes, the server sets `avatar` and
  sends `user` ([§3.3](#33-identity)).
- Clients choose which avatar sources to load and MAY ignore any avatar.
  They load values only as images, never as documents, and bind or escape
  them rather than interpolating them into HTML.
- Without a usable avatar, clients draw a placeholder such as initials.

### 4.7 Push

`server.push` ([§3.1](#31-server-frame)) maps each supported push kind to its public
configuration, and `wake` to the wake scopes it supports. Its presence
enables `push_register` and `push_unregister`.

```jsonc
// <- the server frame offers relay and webpush
{
  "method": "server", "params": {
    "apron": 7, "capabilities": ["status"], "auth": ["webauthn", "token"],
    "push": {"relay": {}, "webpush": {"key": "BNcR..."}, "wake": ["mentions", "replies", "private"]}
  }
}
// ->
{
  "method": "push_register", "id": "c30", "params": {
    "kind": "relay", "url": "https://relay.example/p/xyz", "token": "...", "push_id": "t65S5XBst9bSDpjJ",
    "keys": {"p256dh": "BKx...", "auth": "Q2w..."}
  }
}
// ->
{
  "method": "push_register", "id": "c31", "params": {
    "kind": "webpush", "url": "https://push.example/s/abc", "push_id": "t65S5XBst9bSDpjJ",
    "keys": {"p256dh": "BOr...", "auth": "Hn3..."}, "wake": ["mentions", "private"]
  }
}
// ->
{"method": "push_unregister", "id": "c32", "params": {"url": "https://relay.example/p/xyz"}}
```

- `kind` is a key of `server.push` other than `wake`. Fields other than
  `url`, `push_id`, and `wake` are specific to that kind. Unknown kinds are
  `invalid_params`. Third-party kinds use the `ext:` prefix ([§4](#4-capabilities)) and define their own delivery.
- `url` is required. A registration belongs to the authenticated user and
  its `url`, and outlasts the connection that made it. Registering the
  same `url` again replaces the user's registration; `push_unregister`
  removes it. Unregistering an unknown `url` succeeds.
- Servers MAY refuse a registration with `denied`, such as from a guest
  ([§3.2](#32-authentication)). An endpoint the server will not send to is `invalid_params`.
- Clients SHOULD register on each connection. Servers MAY drop a
  registration the client has not renewed within a server-defined period,
  or the least recently renewed beyond a server-defined number per user.
- Clients SHOULD unregister before signing out. Servers MAY remove a user's
  registrations when they revoke the user's sessions.
- A server that advertises `push` SHOULD advertise `status` ([§4.11](#411-status)).
- A push that `mute` or a `dnd` status ([§4.11](#411-status)) silences has no `message`
  and goes only to registrations that wake for `badge`.
- `push_id` (optional) is 1 to 64 characters from `A-Z a-z 0-9 - _`.
  Clients choose one per server and account, as an opaque value that
  reveals neither the server nor the account. An invalid `push_id` is
  `invalid_params`.
- Servers remove a registration whose `url` will not accept pushes, such as
  one that answers 404 or 410.
- Servers send `TTL` and `Urgency` headers ([RFC 8030](https://www.rfc-editor.org/rfc/rfc8030))
  with every push, to relays too. `Urgency` is `low` for a push without
  `message`, `normal` for one that only `joined` selects, and `high`
  otherwise.
- `relay`: the server POSTs the payload to `url`, with `token` (optional)
  as bearer. Delivery beyond that POST is up to the relay. Native apps use
  a relay run by their vendor.
  - `keys` (optional) holds a `p256dh` and `auth` the client generated, as
    for `webpush`. With `keys`, the body is the payload encrypted as for
    `webpush`, sent with `Content-Type: application/octet-stream` and
    `Content-Encoding: aes128gcm`. Without `keys`, the body is the payload
    sent as `Content-Type: application/json`.
- `webpush`: Web Push ([RFC 8030](https://www.rfc-editor.org/rfc/rfc8030)).
  - `key` is the server's VAPID public key ([RFC 8292](https://www.rfc-editor.org/rfc/rfc8292)):
    an uncompressed P-256 point in unpadded base64url. Clients subscribe
    with it as the application server key, and subscribe again when it
    changes.
  - `url` is the subscription endpoint. `keys` (required) holds its
    `p256dh` and `auth` in unpadded base64url, as in `PushSubscription.toJSON()`.
  - Servers encrypt the payload as one `aes128gcm` record
    ([RFC 8291](https://www.rfc-editor.org/rfc/rfc8291)), and sign with the
    private key for `key`.
- Every kind delivers the same payload: an object of at most 2048 bytes as
  UTF-8 JSON.
  - `push_id`: the registration's, if it has one. Clients drop a payload
    whose `push_id` they don't recognize.
  - `unread` (optional): the user's unread count as the server counts it,
    such as messages after the user's read cursors ([§4.4](#44-activity)). It is the
    same for all of the user's registrations. Servers that advertise
    `badge` send `unread`. Servers MAY leave what a room's `mute` silences
    out of `unread`; a `mute` without `room_id` doesn't change it. Clients MAY show
    it as an app badge.
  - `message`: the message ([§3.5](#35-messages)) without `log_id`. Clients never
    install it as a snapshot. Servers SHOULD omit `format` and `embeds`.
    To fit, they MAY truncate `body.text` and leave out any field but
    `message_id`, `room_id`, and `from.user_id`. A payload without
    `message` shows no notification.
- Clients SHOULD show at most one notification per `push_id` and
  `message_id`. A later one for the same pair replaces the earlier one,
  whether it came from a push or from the client's own connection.
- `wake` (optional) lists the scopes a registration wakes for. Each scope
  selects new messages in rooms the user can see, except `badge`:
  - `mentions`: messages whose `mentions` list the user ([§3.5](#35-messages)).
    Servers MAY also wake for an edit that newly mentions the user.
  - `private`: messages in private rooms ([§4.3.4](#434-creating-and-editing)) the user has joined,
    and in their threads.
  - `replies`: messages whose `reply_to` refers to the user's message ([§3.5](#35-messages)).
  - `joined`: messages in rooms the user has joined ([§4.3.2](#432-membership)).
  - `badge`: every change to `unread`. A push for a change that no other
    scope selects has no `message`. Servers ignore `badge` for `webpush`.
    Servers MAY skip intermediate values of `unread`, sending only the
    latest.
- Servers advertise only scopes they implement, and ignore others in
  `wake`. An empty `wake` wakes for nothing. Without `wake`, the server
  uses its default scopes, which SHOULD be `mentions` and `replies` where
  advertised.
- Third-party scopes use the `ext:` prefix.
- Servers don't wake a user for their own messages. Other wake policy,
  such as rate limits, is server-defined.
- Suggested convention: wake a user only when every connection of theirs
  is idle ([§4.11](#411-status)) or gone. Servers MAY wait briefly first and
  skip the push if the user's `read_message_id` has passed the message.

```jsonc
// a message push
{
  "push_id": "t65S5XBst9bSDpjJ", "unread": 2,
  "message": {
    "message_id": "1724803200042", "room_id": "general",
    "from": {"user_id": "alice", "name": "Alice"},
    "body": {"text": "Deploy is done, can someone check the dashboards?"}
  }
}
// a badge push, after the user read on another device
{"push_id": "t65S5XBst9bSDpjJ", "unread": 0}
```

Servers SHOULD accept only `https` push endpoints that resolve to
non-internal addresses.

### 4.8 `command`

Capability `command`. A `command` request sends an instruction to the server. It
takes the same params as creating a message ([§3.5](#35-messages)) and differs only in what
happens to it:

- `body.text` is the command line as the user typed it, slash included.
  The server parses it.
- Clients send composer text that starts with `/` as a `command`, and text
  that starts with `//` as a message starting with `/`.
- A command is never logged, broadcast, or saved, and has no `message_id`.
  `message_id` and `deleted` are `invalid_params`.
- `mentions`, `reply_to`, and `embeds` are arguments. Mentioned users are
  not notified.
- The result is `{}`, or `{"embeds": [...]}` with write URLs for new
  `upload` embeds ([§4.6.3](#463-writes)). A failure is an ordinary error whose
  `message` the client shows.
- The server replies as needed with system notices ([Appendix A.1](#a1-system-identities-and-scoped-notices)).
  It sends `~private` to the sender, `~room` to the room, and `~server` to
  everyone.
- Effects arrive as the frames they cause, such as `room_update`.
- Retries follow [§1.2](#12-retries-and-deduplication).
- Commands are for what a server provides beyond this spec, such as
  `/ban` with the server's own moderation rules.
- Which commands exist, their arguments, and who may use them are server
  policy.
- Servers that support commands SHOULD provide `/help`. It replies
  with a `~private` notice that lists the commands available to the sender,
  with their arguments and what they do.
- Clients MAY handle commands that match a request themselves, such as
  `/nick` as `me` or `/join` as `room_join`. They send the rest as
  `command`.

```jsonc
// -> remove a user from the room; mentions refer to the target
{
  "method": "command", "id": "c30", "params": {
    "room_id": "general",
    "body": {"text": "/kick @guest_1234 spamming", "mentions": ["guest_1234"]}
  }
}
// <- to guest_1234's connections; the room's other members get the membership alone
{
  "method": "room_update", "params": {
    "left": [{"room_id": "general"}],
    "memberships": [
      {"log_id": "1724803900001", "room_id": "general", "members": [{"user": {"user_id": "guest_1234"}, "joined": false}]}
    ]
  }
}
// <- to the room's remaining members: the notice
{
  "method": "message", "params": {
    "message_id": "1724803900002", "log_id": "1724803900002", "room_id": "general",
    "from": {"user_id": "~room", "name": "General"},
    "body": {"text": "@guest_1234 was removed by @alice: spamming"}
  }
}
// <- then the result
{"id": "c30", "result": {}}

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
// <- to the sender only
{
  "method": "message", "params": {
    "room_id": "general",
    "from": {"user_id": "~private", "name": "Only you"},
    "body": {
      "text": "- `/kick @user [reason]`: remove someone from this room\n- `/avatar` with an image: set your avatar",
      "format": "markdown"
    }
  }
}
// <-
{"id": "c32", "result": {}}

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
`finish`. Registration MUST require discoverable credentials. Login omits
`allowCredentials` or sends an empty array. Both require user verification.
Servers SHOULD use a `register` begin's `name` ([§3.2](#32-authentication)) for
`user.name` and `user.displayName` in `public_key`.

Challenges MUST be unpredictable, expiring, and bound to the connection,
action, RP ID, allowed origin, and any proposed registration identity. A
connection has one pending ceremony. A new begin replaces it, disconnect
invalidates it, and a matching finish consumes it even on failure. Servers
MUST perform
[WebAuthn verification](https://www.w3.org/TR/webauthn-3/#sctn-rp-operations)
before recording credentials or authenticating.

Only a verified finish returns `you`. A registration on a connection that
is already signed in adds the passkey to that account. Registration
eligibility and reauthentication permission are server policy. Malformed
fields are `invalid_params`. Invalid challenges, failed verification, and
policy rejections are `denied`.

**Session resume (optional).** A server that also advertises `token` MAY
include a bearer `token` for later connections ([§3.2](#32-authentication)) in a
verified `finish` result. Servers MUST bind such tokens to the ceremony's
allowed origin, MUST expire them, and reject unknown, expired, or
mismatched tokens with `denied`. Clients MAY ignore `token`.

### 4.10 Email authentication

Servers advertising `email` in `server.auth` verify an address with a
temporary token sent to it. An `auth` request with `email` proposes a
sign-in or an addition, and one with `token` approves it:

```jsonc
// -> propose signing in with this address
{"method": "auth", "id": "c1", "params": {"scheme": "email", "email": "ada@example.com"}}
// <- nothing is authenticated yet
{"id": "c1", "result": {}}

// email: "Your code is 418092, or open https://chat.example/login#token=Hk41x9…"

// -> on any connection not signed in, such as one opened by the link
{"method": "auth", "id": "c2", "params": {"scheme": "email", "token": "Hk41x9…"}}
// <- signed in, with a bearer token for later connections
{"id": "c2", "result": {"you": {"user_id": "ada", "name": "Ada"}, "token": "st_Hk41…"}}
```

- A proposal returns `{}` whether or not the address has an account. On a
  connection signed in to an account, guests included, it proposes adding
  the address to that account. Otherwise it proposes signing in.
- The server emails a temporary token for the proposal, as a link, a code
  to type, or both. A token short enough to type, such as six digits,
  works only on the connection that made the proposal. A token that works
  on other connections must be unguessable.
- A connection has one pending proposal, and a new one replaces it. A
  proposal expires within minutes, is consumed when approved, and is
  invalidated after a few failed attempts.
- Approving a sign-in authenticates the connection that presents the
  token, which must not be signed in already. The result carries `you`
  and a bearer `token` for later connections ([§3.2](#32-authentication)).
- Approving an addition adds the address to the proposing account and
  returns `{}`.
- An invalid, expired, or used token is `denied`. So is a sign-in token
  on a signed-in connection, or an address that belongs to another account.
- The server builds any link from its own configuration and puts the token
  in the URL fragment.
- The suggested fragment is `#token=…`, plus `&server=…` with the server's
  WebSocket URL when the link opens a client that is not tied to one
  server.
- Account creation for unknown addresses, send rate limits (`retry_after`),
  and the bearer token's lifetime are server policy.

### 4.11 `status`

Capability `status`. Users set a presence `status` with `me` ([§3.3](#33-identity)).
Clients report idle connections and set the user's mutes with the `status`
request.

```jsonc
// <- the server frame accepts dnd and invisible
{
  "method": "server", "params": {
    "apron": 7, "capabilities": ["status"], "auth": ["token"],
    "status": ["dnd", "invisible"]
  }
}
// -> do not disturb
{"method": "me", "id": "c40", "params": {"status": "dnd"}}
// <-
{"id": "c40", "result": {"you": {"user_id": "alice", "status": "dnd"}}}
// <- to others who share a room
{"method": "user", "params": {"new": {"user_id": "alice", "status": "dnd"}}}
```

- Users set one of these values:
  - `online`: the default. Others see the derived status below.
  - `""`: no status, to opt out. Servers set it for a value they don't
    accept.
  - `dnd` (optional): others see `dnd` while the user has a connection,
    and `offline` otherwise. It silences the user's notifications as `mute`
    does.
  - `invisible` (optional): others see `offline`.
- Others see a user whose `status` is `online` as one of:
  - `online`: a connection is attended.
  - `idle`: connected, but no connection is attended.
  - `offline`: no connections.
- `server.status` ([§3.1](#31-server-frame)) lists the optional values the server accepts.
  Only servers with capability `status` send it. Servers always accept
  `online` and `""` and don't list them.
- Clients offer only the listed optional values.
- A server without `idle` shows `online` for a connected user.
- `status` is only in current user objects ([§3.3](#33-identity)). A change is a `user`
  notification. Servers MAY delay it.
- Clients take the user's own `status` from `you`. Other objects about the
  user carry what others see.
- A sign-in is an `auth` that signs the connection in as a user it isn't
  already signed in as. An `auth` that adds a passkey or address is not one.
- After a sign-in, servers send, for each user who shares a room with the
  user, the `status` others see, other than `offline` and `""`. They send
  it after the `auth` result.
- Clients drop kept `status` values at each sign-in.
- Servers include `status` in each current user object that `room_list`
  and `room_update` carry, `offline` and `""` included.
- A user without a `status` has no known status.
- Clients show an unknown `status` value as unknown, with the value.

```jsonc
// -> nobody has attended this connection for a while
{"method": "status", "id": "c41", "params": {"idle": true}}
// <-
{"id": "c41", "result": {}}
// <- to others who share a room, if Alice has no attended connection
{"method": "user", "params": {"new": {"user_id": "alice", "status": "idle"}}}
// -> mute #random until unmuted, and everything for an hour
{"method": "status", "id": "c42", "params": {"room_id": "random", "mute": true}}
{"method": "status", "id": "c43", "params": {"mute": 3600}}
// <- to each of Alice's connections
{"method": "status", "params": {"room_id": "random", "mute": true}}
{"method": "status", "params": {"mute": 3600}}
// <-
{"id": "c42", "result": {}}
{"id": "c43", "result": {}}
// -> too many changes
{"method": "status", "id": "c44", "params": {"mute": false}}
// <-
{"id": "c44", "error": {"code": -32002, "message": "Too Many Requests", "data": {"retry_after": 5}}}
// <- after a later sign-in, the mutes in effect
{"method": "status", "params": {"room_id": "random", "mute": true}}
{"method": "status", "params": {"mute": 1800}}
```

- Clients send `status` as a request. The server replies `{}` once it
  applies the change.
- On an error, such as `retry_after` or `invalid_params`, nothing changes.
- Server-sent `status` is a notification.
- Absent fields are unchanged.
- `idle` (boolean) is about the sending connection: whether nobody is
  attending it. `idle` ignores `room_id`.
- A connection starts attended, with nothing kept from earlier
  connections. Its client sends `idle: true` when nobody is attending it,
  and `idle: false` when someone is again.
- Clients MAY wait about 30 seconds after attention ends before sending
  `idle: true`, but not on a connection that starts unattended.
- Servers never send `idle`.
- `mute` is `true`, `false`, or seconds. It silences the user's
  notifications everywhere or, with `room_id`, in that room and its
  threads. `room_id` scopes only `mute`.
- `mute` is private. Others never see it.
- Servers without timed mutes treat seconds as `true`, and `0` as `false`.
- Servers send each change to the user's mutes to all the user's
  connections as `status`. A mute that ends or is cleared is sent as
  `mute: false`.
- After a sign-in, servers send one `status` for each mute in effect, with
  the seconds left or `true`. They send them after the `auth` result.
- After a sign-in, clients treat any scope not sent as unmuted.
- Clients apply a received `status` as their own setting.

---

## Appendix A — Conventions (informative)

### A.1 System identities and scoped notices

System identities are server-controlled `user_id`s with the `~` prefix
([A.3](#a3-prefixes-in-text)), such as `~server`. They carry an
ordinary `from` and render like any sender. Clients MAY style them as
system messages.

Three of them tell the receiver who else got the message:

| `from.user_id` | received by                   | logged | for example                                  |
|----------------|-------------------------------|--------|---------------------------------------------|
| `~server`      | every user on the server      | yes    | maintenance notices, announcements           |
| `~room`        | every member of the room      | yes    | removals with a reason, poll results         |
| `~private`     | only this connection          | no     | welcomes, command replies, errors, reminders |

- `room_id` is where the message is shown, as for any message.
- A server-wide notice also refers to a room, usually the default room
  ([§3.5](#35-messages)). It reaches every user whether or not they joined it.
- These are sender identities that state a scope, not rooms.
- Joins and leaves are memberships ([§4.3.2](#432-membership)), not `~room` messages.
- `~private` messages are transient notices ([§3.5](#35-messages)). A private notice
  that should last belongs in a room of its own.
- A `~private` notice MAY omit `room_id` like any message ([§3.5](#35-messages)). A
  client with no room to show it in yet, such as one still signing in,
  still shows it.

```jsonc
// <- to everyone on the server, shown in the default room
{
  "method": "message", "params": {
    "message_id": "1724803500001", "log_id": "1724803500001", "room_id": "general",
    "from": {"user_id": "~server", "name": "Server"},
    "body": {"text": "Maintenance at 17:00 UTC."}
  }
}
// <- to everyone in general
{
  "method": "message", "params": {
    "message_id": "1724803500002", "log_id": "1724803500002", "room_id": "general",
    "from": {"user_id": "~room", "name": "General"},
    "body": {"text": "Poll closed: Tuesday wins, 7 votes to 4."}
  }
}
// <- to the new member's connection only, shown in general
{
  "method": "message", "params": {
    "room_id": "general",
    "from": {"user_id": "~private", "name": "Only you"},
    "body": {"text": "Welcome to General! Deploy chatter goes in threads."}
  }
}
```

### A.2 Field naming

Entity ID fields use the `_id` suffix (`user_id`, `room_id`, `message_id`,
`embed_id`, `parent_room_id`). Embedded objects use descriptive
names (`from`, `body`, `reply_to`). JSON-RPC's envelope `id` keeps its
name. Extensions and future methods should follow the same pattern.

### A.3 Prefixes in text

A prefix says what kind of ID follows:

| prefix | refers to         | in `body.text`                                              |
|--------|-------------------|-------------------------------------------------------------|
| `@`    | a user            | a mention ([§3.5](#35-messages)), listed in `body.mentions` too |
| `#`    | a room            | a reference to the room; it mentions no one                 |
| `~`    | a system identity | never; it appears only as a sender ([A.1](#a1-system-identities-and-scoped-notices))     |

- After `@` or `#`, the ID is a run of `[A-Za-z0-9_.-]`. Trailing `.` and
  `-` are not part of it.
- The prefix is not preceded by a letter or digit, so `foo@bar.com` and
  `tag#ops` contain neither.
- Servers that want users and rooms to be mentionable mint IDs from
  `[A-Za-z0-9_.-]`, such as `guest_1234`.
- `user_id`s beginning with `~` are reserved for system identities. Servers
  SHOULD NOT assign them to users.
- How `text` renders is up to the client.
- Clients MAY show an `@id` that refers to a known user with the user's
  latest display name ([§3.3](#33-identity)), such as a chip. They MAY show a `#id` that
  refers to a known room as a link with its title. Unknown IDs render as
  written.

---

## Appendix B — Valid scenarios (informative)

Exchanges that are valid under this spec but easy to get wrong, collected so
implementations accept them. Each follows from the sections it cites.

- **The server sends a welcome before `auth`.** Authentication gates what a
  client sends, not what it receives ([§3.2](#32-authentication)). A server MAY follow its
  `server` frame with a `~private` notice ([Appendix A.1](#a1-system-identities-and-scoped-notices)), such as how to
  sign in. It omits `room_id`, since the client knows no rooms yet. Sent
  before the server reads any frame, it precedes the `auth` result even
  when the client pipelined `auth`. The server sends it on each
  connection. Clients MAY replace the previous one rather than show both.

  ```jsonc
  // <-
  {"method": "server", "params": {"apron": 7, "capabilities": ["rooms"], "auth": ["webauthn", "token", "guest"]}}
  // <- before any auth
  {
    "method": "message", "params": {
      "from": {"user_id": "~private", "name": "Only you"},
      "body": {"text": "Guests can read along. **Sign in with a passkey** to post.", "format": "markdown"}
    }
  }
  // ->
  {"method": "auth", "id": "c1", "params": {"scheme": "guest"}}
  // <-
  {"id": "c1", "result": {"you": {"user_id": "guest_1234"}}}
  ```

- **A bot connects, posts once, and disconnects.** A deploy hook or cron
  job needs no rooms. It MAY send `auth` and `message` together without
  waiting for `server`, since `auth` is a barrier ([§3.2](#32-authentication)). Posting does
  not require joining ([§3.5](#35-messages)), so the bot receives no broadcast. The
  `message_id` result is its confirmation. It closes the connection once
  that arrives. If the connection drops first, it resends the same
  `id` and `params` on a new connection, and the server returns the
  original result rather than posting twice ([§1.2](#12-retries-and-deduplication)).

  ```jsonc
  // -> both at once, before server arrives
  {"method": "auth", "id": "c1", "params": {"scheme": "token", "token": "...", "agent": "deploy-hook/1.0"}}
  {"method": "message", "id": "deploy-7f3a", "params": {"room_id": "ops", "body": {"text": "Deployed v1.4.2"}}}
  // <-
  {"method": "server", "params": {"apron": 7, "capabilities": ["rooms"], "auth": ["token"]}}
  // <-
  {"id": "c1", "result": {"you": {"user_id": "deploy-bot", "name": "Deploy"}}}
  // <- then the bot closes the connection
  {"id": "deploy-7f3a", "result": {"message_id": "1724803200042"}}
  ```

- **An invite token signs up several people.** A server MAY treat a
  `token` as an invitation that creates a new identity on each use, up to a
  limit it sets, such as ten sign-ups from one link. Each result carries the
  new identity's own `token`. The client saves it and reconnects with it
  rather than the invite ([§3.2](#32-authentication)). Issuing and revoking invites are
  server commands ([§4.8](#48-command)). A used-up or expired invite is `denied`.

  ```jsonc
  // -> each invitee signs in with the shared invite
  {"method": "auth", "id": "c1", "params": {"scheme": "token", "token": "inv_Qm7x...", "name": "Bob"}}
  // <- a new identity, with its own token for later connections
  {"id": "c1", "result": {"you": {"user_id": "bob", "name": "Bob"}, "token": "st_Hk41..."}}
  ```

---

## Appendix C — Under consideration

Designs that are not yet part of the protocol, kept here so implementations
can experiment and converge on them.

### C.1 WebRTC: signaling for audio, video, and peer-to-peer connections

Planned capability `rtc` requires capability `rooms`. Any room can hold one
WebRTC session at a time, and its members may join it ([§4.3.2](#432-membership)). The
socket carries signaling. Media and data travel peer to peer.

```ts
class Room {    // besides the fields of §3.4
  // "rtc" capability
  rtc?: { members: User[] };    // delivery; present while a session is in progress
}

class User {    // in rtc_* frames, besides the fields of §3.3
  peer_id: string;              // one client's seat in the session, assigned by the server
}
```

**Who is in a session.** A room's `rtc` is a delivery field ([§3.4](#34-rooms)).
It is present while the room has a session, lists each user in it once,
and is absent otherwise. It reaches the room's members, and a public
thread's parent members, through `room_list` and `room_update` `updated`.
It lists users, not seats. Its appearance on a room is the ring. To reach a member who is
offline, a caller's client also posts an ordinary message that mentions
them ([§4.7](#47-push)).

**Seats.** Room membership is per user; a session is per device. Each
connection in a session holds a seat. The server assigns each seat a
`peer_id` that is unguessable and unique within the session. User objects
in `rtc_*` frames are recorded objects ([§3.3](#33-identity)), never merged. Each carries
the `peer_id` of one seat. Clients key peers on `(user_id, peer_id)`.

**Joining.** `rtc_join` takes a seat, starting the session if there is
none. The result carries the joiner's `peer_id`, its ICE configuration with
the time it expires, and `peers`, the seats already in the session, oldest
first. The server handles one join per session at a time, so of two joins
the later one's `peers` includes the earlier. The joiner offers to each
peer, and they learn of it from its offer. Clients SHOULD NOT answer
offers until their user has joined the session. Clients MAY use
relay-only ICE, so servers SHOULD include TURN in `ice`.

```jsonc
// -> Bob's phone joins
{"method": "rtc_join", "id": "c41", "params": {"room_id": "1724803950000"}}
// <-
{
  "id": "c41", "result": {
    "peer_id": "p3",
    "ice": [{"urls": "stun:stun.example:3478"}, {"urls": "turn:turn.example", "username": "u", "credential": "c"}],
    "ice_expires": 1724807500,
    "peers": [{"user_id": "alice", "name": "Alice", "peer_id": "p1"}]
  }
}
```

**Reclaiming and leaving.** A session outlives a dropped chat connection. `rtc_join` with a
`peer_id` reclaims that seat for the same user after a reconnect, or
refreshes `ice` before it expires (with a new request `id`, [§1.2](#12-retries-and-deduplication)); the
other peers see no change. After reclaiming, a client restarts ICE with
every peer not connected, using the fresh `ice`. Only a client that still
holds its peer connections reclaims; otherwise it leaves and joins anew. A
seat ends with `rtc_leave`, or when its connection stays closed past a
grace period set by server policy. The session ends with its last seat.

```jsonc
// -> after reconnecting and authenticating
{"method": "rtc_join", "id": "c47", "params": {"room_id": "1724803950000", "peer_id": "p3"}}
// ->
{"method": "rtc_leave", "id": "c48", "params": {"room_id": "1724803950000"}}
```

**Signaling.** `rtc_signal` is a notification relayed between seats. The
sender refers to a seat in `to`. The server delivers it with the sender's
seat in `from`. Only a connection holding a seat may send one. Signals
from one seat to another arrive in order. The server drops signals to a
seat whose connection is closed, that match no seat, or that exceed its
rate or size limits. When a seat ends, the
server sends each remaining peer a signal from it with `payload: null`.

```jsonc
// -> Alice (p1) to Bob's phone (p3)
{
  "method": "rtc_signal", "params": {
    "room_id": "1724803950000", "to": {"user_id": "bob", "peer_id": "p3"},
    "payload": {"sdp_type": "offer", "sdp": "v=0..."}
  }
}
// <- delivered to p3
{
  "method": "rtc_signal", "params": {
    "room_id": "1724803950000", "from": {"user_id": "alice", "name": "Alice", "peer_id": "p1"},
    "payload": {"sdp_type": "offer", "sdp": "v=0..."}
  }
}
```

A `payload` is one of these:

- `{"sdp_type": "offer" | "answer", "sdp": "..."}` is a session description.
- `{"candidate": {"candidate": "candidate:...", "sdp_mid": "0",
  "sdp_m_line_index": 0, "username_fragment": "..."}}` is an ICE candidate.
  Receivers apply it once the remote description is set.
- `{"candidate": null}` ends the candidates.
- `null` comes from the server only, and means the sending seat ended.

Peers use perfect negotiation ([WebRTC §10.7](https://www.w3.org/TR/webrtc/#perfect-negotiation-example)). In each pair, the seat
with the greater `peer_id` is polite. Receivers ignore unknown `payload` keys.

**Topology.** Mesh is the baseline. Peers negotiate pairwise and the server
only relays. Clients SHOULD soft-cap participants. A server MAY instead put
a session on a media server. `rtc_join` then returns a `transport`, such as
`{"type": "livekit", "url": "wss://sfu.example", "token": "..."}`, in place
of `ice` and `peers`, and the client follows that transport's own
signaling. The server drives the room's `rtc` from it.

**Apron over a data channel.** A data channel whose WebRTC `protocol` is
`apron/<protocol>`, with the version of [§3.1](#31-server-frame), carries Apron frames,
one per ordered, reliable data channel message no larger than the remote
peer's SCTP maximum. The oldest seat in the session hosts the room and
runs the server side of Apron on its own device. That is `peers[0]`, or the
joiner itself when there are no peers. Each other seat opens a channel to
it. A guest authenticates with `guest`, and the host assigns it the
identity of its seat. When the host's seat ends, the next oldest seat hosts
a new Apron session on new channels. Earlier history stays with the
clients that received it. A reclaimed seat keeps its age. Clients route
other data channels by their `protocol` and close ones they do not
support. In a mesh, DTLS encrypts the channel end to end. Its fingerprints
travel through the chat server's signaling, so clients MAY pin or compare
them.

**Exclusions.** Mute and camera state, recording, and transcoding are left
to clients and servers.

### C.2 Multiplexing envelope

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
forwards inner frames unparsed and holds only the `conn_id`↔upstream mapping.
Backends remain authoritative, and frames may be encrypted end to end.
Aggregator authentication is deployment-defined.

### C.3 Actions embed

Embed kind `actions` offers the reader choices, grouped by what choosing
does, such as an invitation to accept or decline, a permission prompt, or a
poll. It requires capability `command` ([§4.8](#48-command)).

```ts
class Embed {   // "actions" kind, besides the fields of §4.6
  // set by the server
  commands?: { label: string; command: string }[];
}
```

```jsonc
// <- to Bob only
{
  "method": "message", "params": {
    "room_id": "general",
    "from": {"user_id": "~private", "name": "Only you"},
    "body": {
      "text": "Ada invited you to a room titled \"Hi\".",
      "embeds": [{
        "kind": "actions",
        "commands": [
          {"label": "Accept", "command": "/join #1724803950000"},
          {"label": "Decline", "command": "/leave #1724803950000"}
        ],
        "og": {"description": "Type /join #1724803950000 to accept."}
      }]
    }
  }
}
```

- Only servers set actions. A server drops or rebuilds an `actions` embed
  that a client sends.
- Choosing one of `commands` sends its `command` as a `command` request, or
  as the request it refers to, such as `/join` ([§4.8](#48-command)). When the message has
  a `message_id`, the request's `reply_to` refers to it.
- Clients ignore groups they do not know ([§1](#1-transport--framing)).
- Clients without `actions` support render the fallback card ([§3.5](#35-messages)).
  Its `og` can spell out the commands to type.
