# Apron Chat Protocol

Apron Chat Protocol is for groups whose members mostly trust each other: a
team, a household, or a set of bots and the people who run them. That trust
keeps the protocol small. There is no public federation, spam defense, or
sybil resistance to coordinate. The server is the authority on identity,
membership, and history, and a client can be little more than a renderer of
what the server sends.

The goal is many Apron Chat apps and servers that work with each other. A
client can connect to any Apron server, and a server can be a full chat
service, a local bridge to another protocol, a coding harness, or a script
that posts deploy notices. To make that practical, the protocol is
incremental. The mandatory core ([§3](#3-core)) is enough for a working chat,
in about a hundred lines of code. Everything else is an optional capability
([§4](#4-capabilities)) that a server advertises, with a fallback for clients
and servers that lack it.

Example of a valid session:

```jsonc
// <- server greeting with capabilities and auth schemes
{"method": "server", "params": {"apron": 8, "capabilities": ["rooms"], "auth": ["guest", "token"]}}

// -> guest auth, requesting a display name (the server may choose something else)
{"method": "auth", "id": "c1", "params": {"scheme": "guest", "name": "Ada"}}

// <- server assigns the identity
{"id": "c1", "result": {"you": {"user_id": "guest_1234", "name": "Ada"}}}

// -> client requests the joined rooms and their members (server may ignore the filters)
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

This example uses capability `rooms` ([§4.3](#43-rooms)) to list rooms.
Without it, the client skips `room_list` and learns the room from the
broadcast.

---

## 1. Transport & framing

Apron runs over any transport that carries whole JSON messages in both
directions. The framing borrows from JSON-RPC, so that a client can match each
reply to its request, and every other frame is a one-way notification.

- WebSocket is the reference transport. Other transports work if they deliver
  whole frames.
- A **frame** is one JSON object: one WebSocket text message, or one line on
  a byte-stream transport such as TCP or stdio (newline-delimited JSON).
- Frames use the shape of [JSON-RPC 2.0](https://www.jsonrpc.org/specification)
  requests, responses, and notifications (`method`, `params`, `id`, `result`,
  `error`). They omit the `"jsonrpc": "2.0"` key, and every `id` is a string.
- Implementations MUST ignore unknown keys, and MAY drop them. Extension data
  goes in `ext` ([§4.12](#412-ext)).
- Servers MAY process requests concurrently and reply in any order. If a
  client needs one request applied before another, it waits for the first
  reply.
- On one connection, a result includes the effect of every notification sent
  before it. Clients apply frames in the order they arrive.
- When a request causes notifications on its own connection, the server sends
  them before the result. Examples are the broadcast of a posted message and
  the `room_update` of a join. A sign-in is the only exception
  ([§3.2](#32-authentication)).
- Server announcements and broadcasts are notifications.
- Servers reply `error/unsupported` to requests with unknown methods.
- Notifications with unknown methods are ignored.
- Implementations SHOULD accept frames up to 256 KiB. They MAY reject a larger
  request with `error/too_large`, and MAY drop a larger notification.
- A server MAY advertise `ping` ([§3.1](#31-server-frame)). Clients that
  support it then send exactly `{"method":"ping"}` at that interval. The
  server answers with `{"method":"pong"}`, also before authentication. A
  server MAY close a connection that sent pings and then stopped.

**Extension names.** A name that this document does not define starts with
`ext:`, such as the capability `ext:irc`. This applies to every name that a
list in this document can extend, such as a method, a capability, an auth
scheme, or a kind. This document never defines a name with that prefix. An
extension named `ext:irc` keeps its data under the key `irc` in `ext` objects
([§4.12](#412-ext)). Display values, such as a status or a role, are free text
and take no prefix.

Receivers handle unknown names as the section that defines them says. As a
rule, a request that depends on an unknown name fails with `invalid_params`,
and an unknown name in a frame that is only read is ignored, or shown with the
fallback of its section.

### 1.1 Envelope and replies

A request carries a string `id` ([§2](#2-identifiers)), and gets exactly one
reply. A frame with a `method` and no `id` is a notification, and gets no
reply.

Each method is either a request or a notification. A method is a request when
its sender needs the reply: data, a confirmation that a change was applied, or
an error. A method that only reports transient state is a notification.
Clients send requests with an `id`, and notifications without one:

| sent by | requests (with `id`) | notifications (without `id`) |
|---------|----------------------|------------------------------|
| client  | `auth`, `me`, `message`, `command`, `history`, `room_list`, `room_join`, `room_leave`, `room_set`, `reactions`, `status`, `push_register`, `push_unregister` | `activity`, `ping` |
| server  | none | `server`, `user`, `message`, `room_update`, `reactions`, `activity`, `status`, `pong` |

A server MAY ignore a request method sent without an `id`. It MAY ignore the
`id` of a notification method, and handle the frame as a notification.

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

A successful reply has a `result` object, which is `{}` when empty. An error
reply has an `error` object with an integer `code`, a string `message`, and
optional `data`:

```json
{"id": "c42", "error": {"code": -32601, "message": "Unsupported method"}}
{"id": "c43", "error": {"code": -32002, "message": "Too Many Requests", "data": {"retry_after": 30}}}
```

This document writes `error/<name>` for these codes:

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

Clients identify an error by its `code` only. `message` is free text for
people. Servers SHOULD make it specific enough to show as is, such as
"Session expired; sign in again" rather than "Denied".

These rules apply to every request:

- A request that refers to an ID that does not exist, or that the user cannot
  see, is `invalid_params`.
- Servers MAY normalize, limit, or reject any value that a client sends, and
  MAY fill in values that it leaves out. Clients use what the server sends
  back, not what they sent.
- A rejected value is `invalid_params`, or `too_large` for its size. `denied`
  is for a well-formed request that the user or server does not allow, such as
  one past a count limit that the server sets.

Other application errors MAY use JSON-RPC codes that are not reserved. A valid
notification never gets an error reply.

An error that is not a reply to a request has no `id`. The server MAY close
the connection after it sends one:

```json
{"error": {"code": -32002, "message": "Server at capacity", "data": {"retry_after": 30}}}
```

After `retry_after`, clients wait for the delay before they reconnect. After
`denied`, clients do not reconnect automatically. They wait for the user to
act.

### 1.2 Retries and deduplication

A retry SHOULD keep the same `id`, `method`, and `params`, also across
reconnects. A new operation MUST use a new `id`, and changed params make a new
operation. Deduplication ignores the order of object keys.

Servers SHOULD deduplicate by `(user_id, id)`, using the authenticated `user_id`:

- The server does not execute or broadcast a duplicate again. The result of a
  duplicate shows the current state ([§1](#1-transport--framing)).
- An `id` used again with a different method or params is `invalid_params`.
- The server handles concurrent duplicates as one request.

How long a server remembers an `id` is implementation-defined. Before
authentication there is no `user_id`, so a request `id` applies only to its
connection. The server MUST execute `auth` on each connection, also when it
repeats an `id`.

---

## 2. Identifiers

Apron keeps state simple by giving every change a place in one log. Each
logged record is the complete state of one thing at one moment. A client can
apply records in any order and from any source, and still end in the same
state. This section defines the IDs that make this work.

All IDs are strings.

**`log_id`** — position of one change in the server's append-only log.

- Decimal string of Unix epoch milliseconds, such as `"1724803200042"`.
- One strictly increasing sequence per server, covering every record: room
  records ([§3.4](#34-rooms)), message snapshots ([§3.5](#35-messages)), reaction sets ([§4.7](#47-reactions)),
  memberships ([§4.3.2](#432-membership)).
- Its value is the commit time. If the clock has not passed the previous
  `log_id`, the value is the previous `log_id + 1`.
- It is the only timestamp in the protocol. Clients MAY show it as a time.
- It is positive and below `2^53`. Compare values as numbers. Clients MAY
  parse them as integers.
- Unique within one server only.
- A room's log is the subsequence of records that touch that room
  ([§4.2](#42-history)).
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

- For each key, clients keep the record with the greatest `log_id`. The source
  (live, history, or embedded) and the arrival order do not matter.
- Server fields are read-only: a request never changes them.
- Room records and message snapshots MAY carry `prev_log_id`, the `log_id`
  of the previous record for the same key. Other records do not.
- To get that record, a client sends `history` with `after` and `before` both
  set to that `log_id` ([§4.2](#42-history)).
- After a move ([§4.4](#44-edit)), a message snapshot whose previous record is
  in another room also carries `prev_room_id`. That is the room to ask.

**Opaque IDs** — `room_id`, `user_id`, `embed_id`, and request
`id`.

- Any string. The side that creates the ID chooses it.
- `room_id` and `user_id` are server-assigned.
- Request `id`s SHOULD be random. They identify operations, not log
  positions.

---

## 3. Core

The core is what every client can count on: a greeting, a way to sign in,
identities, rooms as logs, and messages. Every server implements this section,
and a minimal server implements only this section. That is enough for a plain
but complete chat. Capabilities add the rest ([§4](#4-capabilities)).

### 3.1 `server` frame

```ts
class Server {
  apron: number;                // protocol version
  auth: string[];               // at least one scheme, in preference order (§3.2)

  agent?: string;               // implementation/version string, for debugging
  capabilities?: string[] = []; // §4
  welcome?: string;             // user-readable CommonMark details and auth instructions
  signup?: string[];            // schemes that create accounts; absent: same as auth (§3.2)
  ping?: number;                // seconds between client pings (§1)
  push?: object;                // push kinds and wake scopes; enables push (§4.9)
  status?: string[];            // optional status values accepted (§4.5)
  ext?: object;                 // extension data (§4.12)
}
```

When the server accepts a connection, it MUST send a `server` frame
immediately. The client does not send a hello first.

```json
{
  "method": "server", "params": {
    "apron": 8,
    "agent": "impl-name/1.0",
    "capabilities": ["history", "edit"],
    "auth": ["token"]
  }
}
```

The server MAY send a new `server` frame at any time. Each one **fully
replaces** the previous one. Clients update their feature UI, but MUST NOT
remove content that they already show.

### 3.2 Authentication

A connection starts without an identity. The client picks one of the schemes
that the server offers and sends `auth`, and the server answers with who the
connection now is. Schemes range from guest access with no credentials to
passkeys.

```ts
class Auth {
  scheme: string;               // one of server.auth or server.signup

  name?: string;                // requested display name
  user_id?: string;             // requested user_id
  agent?: string;               // implementation/version string, for debugging

  // "token" and "email" schemes
  token?: string;

  // "email" scheme (§4.11)
  email?: string;

  // "webauthn" scheme (§4.10)
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
- `token`: a bearer string. This is the reference default.
- `webauthn`: optional passkey scheme ([§4.10](#410-webauthn-authentication)).
- `email`: optional sign-in by a code sent to an email address
  ([§4.11](#411-email-authentication)).

A scheme that this document defines but the server does not offer is
`unsupported`.

Under a guest-access policy, a server MAY accept `auth` with any `scheme` and
ignore the credentials. This does not apply to `webauthn` and `email`.

`name` and `user_id` are optional requests, and work with any scheme. `you` is
what the server assigned. Servers SHOULD NOT assign a `user_id` that was used
before, unless they authenticate its owner.

**Bearer tokens.** A successful `auth` result MAY carry `token`. The client
uses it with `scheme: "token"` on later connections.

- It can follow any sign-in, such as a WebAuthn or email sign-in
  ([§4.10](#410-webauthn-authentication), [§4.11](#411-email-authentication)).
- Servers also send it in reply to `scheme: "token"` when they rotate the
  token that the client sent.
- Clients save the latest `token`, which replaces any earlier one, and
  reconnect with it.
- A server MAY reject a token that it replaced. Expired and revoked tokens are
  `denied`.
- Lifetime, rotation, and revocation are server policy.

**Sign-up.** With `signup`, `auth` lists the schemes that sign in, and
`signup` lists the schemes that create an account. For example, `"auth":
["webauthn"], "signup": ["email"]` means: join by email, then sign in with a
passkey.

- If a token is the only way back into an account, the client SHOULD encourage
  its user to add another scheme ([§4.10](#410-webauthn-authentication),
  [§4.11](#411-email-authentication)).
- Suggested convention: server commands ([§4.1](#41-command)) list and remove
  the sign-in methods of an account.

**Welcome.** `server.welcome` is free text for the sign-in screen. It tells
users how the schemes of this server fit together, such as "Create an account
with email, then add a passkey to sign in with it. Email codes expire after 5
minutes." It is CommonMark ([§3.5](#35-messages)). Clients never parse it.

**Order.** `auth` is a barrier. The server finishes an `auth` request before
it processes any later frame on the connection.

- Clients MAY send `auth` before `server` arrives. They MAY send other
  requests right after `auth`, without waiting for its result.
- Later requests use the authentication that the `auth` left on the
  connection. An `auth` that authenticates nothing, such as a failure or a
  WebAuthn `begin` step, changes nothing.
- Before a successful `auth`, other requests get `denied`. The server ignores
  other notifications, except `ping` ([§1](#1-transport--framing)).
- The server MAY send notifications before `auth`, such as a `~private`
  welcome ([Appendix A.1](#a1-system-identities-and-scoped-notices),
  [Appendix B](#appendix-b--valid-scenarios-informative)).
- A **sign-in** is an `auth` that signs the connection in as a user that it is
  not already signed in as. An `auth` that adds a passkey or an address to the
  account is not a sign-in.
- Every notification that a sign-in causes on its connection comes after the
  `auth` result.

### 3.3 Identity

The server decides who everyone is. A client never asserts its own identity.
It learns it from `you`, and learns about other users from the user objects
that the server sends.

```ts
class User {
  user_id: string;

  name?: string;                // absent: shown as user_id
  avatar?: string;              // image URL
  roles?: string[];             // server-defined labels, such as "admin" or "bot"
  status?: string;              // current objects only (§4.5)
  ext?: object;                 // "ext" capability (§4.12)
}
```

Every message carries its author in `from`:

```json
"from": {"user_id": "alice", "name": "Alice"}
```

**User objects.** Every identity on the wire uses the `User` shape: `you`,
`new`, `old`, `from`, `members`, `users`, and the `user` of a membership.
`user_id` is required and stable. The other fields are optional: `name`,
`avatar` ([§4.8.6](#486-avatars)), `roles` (below), and, with capabilities,
`status` ([§4.5](#45-status)) and `ext` ([§4.12](#412-ext)).

There are two kinds of user objects:

- **Current** objects describe the user now. They are `you` in `auth` and `me`
  results, `you` and `new` in a `user` notification, and room `members` and
  `users` in `room_list` and `room_update` ([§4.3](#43-rooms)).
  - `you` in a result, and `users`, are **complete**: they carry every profile
    field that the server publishes.
  - A `user` notification carries `user_id` and at least the fields that
    changed. It carries a cleared field as its empty value.
  - `members` MAY carry only `user_id`.
- **Recorded** objects describe the user at the time of a record. They are the
  `from` of a message or a reaction, and the `user` of a membership
  ([§4.3.2](#432-membership)). They carry `user_id`, and SHOULD carry `name`.
  Later snapshots MAY keep them unchanged.

Clients keep one user object for each `user_id`:

- Clients replace the kept object with a complete object.
- Clients merge every other current object into the kept object. Each field
  that it carries replaces the kept value. An empty value (`""`, `[]`, `{}`)
  clears the field, except `ext`, which merges by its keys
  ([§4.12](#412-ext)). Fields that it does not carry stay the same. `null` is
  an ordinary value.
- Clients never merge recorded objects.
- Clients show each field from the kept object. If the kept object does not
  have a field, they use the recorded object in the frame.
- An empty or unknown `name` shows as `user_id`.
- Clients SHOULD show a user as `Name (@user_id)` where there is space. They
  MUST do this when they know another `user_id` with the same name.

**Profile.** A `me` request changes the user's own profile after
authentication. It merges by the same rules as a current object. The settable
fields are `name` and `avatar`, `status` with capability `status`
([§4.5](#45-status)), and `ext` with capability `ext` ([§4.12](#412-ext)).
`roles` is not settable. Servers announce a cleared field as its empty value:

```jsonc
// -> rename and clear the avatar
{"method": "me", "id": "c2", "params": {"name": "Alice ⚙", "avatar": ""}}
// <-
{"id": "c2", "result": {"you": {"user_id": "alice", "name": "Alice ⚙", "avatar": ""}}}
```

**Changes.** After authentication, the server MAY send a `user` notification
when a user object changes. It sends `you` to the user's own connections, and
`new` to others who share a room with the user. `new` is the current object of
the user. Joins and leaves are memberships, not `user` notifications
([§4.3.2](#432-membership)).

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

- `you` replaces the identity of the connection. If its `user_id` changes, the
  connection acts as the new identity. It receives the deliveries for the
  rooms of the new identity ([§3.4](#34-rooms)). Clients derive per-user state
  again, such as their room list ([§4.3.1](#431-listing)) and their own
  reactions ([§4.7](#47-reactions)).
- `old` means that the same account changed its `user_id` from `old.user_id`
  to `new.user_id`. An example is a guest that becomes a new account.
- When a connection signs in ([§3.2](#32-authentication)) to an existing
  account, servers announce that the previous identity left. They do not send
  `old`.
- After a `user_id` change, logged records keep the old `user_id`. Clients MAY
  treat it as the new identity.
- Servers SHOULD NOT give a retired `user_id` to another user.

**Roles.** Bots and agents are ordinary senders. Servers MAY assign `roles`,
which are labels such as `"admin"`, `"moderator"`, or `"trusted"`. Suggested
convention: `"bot"` marks an automated user, and `"admin"` marks a server
operator.

- Clients show roles separately from the name, such as badges. They show
  unknown roles as written.
- Roles are only for display, and give no permissions on the client.
- A role change is a `user` notification, like any profile change.

### 3.4 Rooms

Rooms are where messages live. In the core, a room is only a log with an ID. A
server can have just one, and a client can learn about rooms from the messages
it receives. Capability `rooms` ([§4.3](#43-rooms)) adds the ways to find,
join, and create them, and adds threads.

```ts
class Room {
  room_id: string;

  parent_room_id?: string;      // fixed once the room is created
  private?: boolean = false;    // members only (§4.3.4)
  title?: string;               // absent: shown as room_id
  description?: string;         // CommonMark by convention

  // "history" capability: required when advertised
  log_id?: string;
  prev_log_id?: string;
  latest_log_id?: string;
  history_log_id?: string | null;

  // "rooms" capability
  members?: User[];             // only in some frames
  member_count?: number;        // total members, when `members` is truncated

  // "ext" capability
  ext?: object;                 // §4.12
}
```

A room is a log with a `room_id` that the server chooses. Every message refers
to its room ([§3.5](#35-messages)). A server without capability `rooms` MAY
have only one room. Clients learn its `room_id` from its messages. If a client
has no other data about a room, it uses the `room_id` as the title.

**Delivery.** A connection receives the messages and other records of each
room that its user joined. Without capability `rooms`, that is every room. For
a thread (below) of a joined room, the connection receives only the changes to
the room record of the thread ([§4.3.3](#433-updates)). System notices go by
their scope instead
([Appendix A.1](#a1-system-identities-and-scoped-notices)).

A **room record** describes one room, as `room_list` and `room_update` carry
it ([§4.3](#43-rooms)):

```json
{
  "room_id": "general", "log_id": "1724800000000", "title": "General",
  "description": "Ops chatter: deploys, alerts, *incidents*.",
  "latest_log_id": "1724803200042", "history_log_id": "1724800000000"
}
```

The "set by" column means:

- `server`: the server assigns the field. It is read-only
  ([§2](#2-identifiers)).
- `client`: the client supplies the field. A save replaces it whole, except
  `ext`, which merges ([§4.12](#412-ext)).
- `delivery`: the view of this client. It is not logged. Clients always use
  the latest value, even if `log_id` did not change.

| field                     | set by   | meaning                                                                           |
|---------------------------|----------|-----------------------------------------------------------------------------------|
| `room_id`                 | server   | required                                                                          |
| `log_id`                  | server   | position of this room record ([§2](#2-identifiers))                               |
| `prev_log_id`             | server   | optional; this room's previous record ([§2](#2-identifiers))                      |
| `parent_room_id`          | client   | optional; fixed at creation; marks a thread ([§4.3.4](#434-creating-and-editing)) |
| `private`                 | client   | optional; visible only to members ([§4.3.4](#434-creating-and-editing))           |
| `title`                   | client   | optional plain string; absent falls back to `room_id`                             |
| `description`             | client   | optional string, CommonMark by convention: what the room is about                 |
| `ext`                     | client   | optional extension data; merges by key ([§4.12](#412-ext))                         |
| `latest_log_id`           | delivery | greatest `log_id` in the room's log, memberships included                         |
| `history_log_id`          | delivery | inclusive lower bound of retrievable history, or `null` if none                   |
| `members`                 | delivery | on request in `room_list`, and in `room_update` `joined` ([§4.3](#43-rooms))       |
| `member_count`            | delivery | optional; how many users have joined, when `members` is truncated ([§4.3.1](#431-listing)) |

A room record is complete ([§2](#2-identifiers)). A field that it omits is
cleared. `members` and `member_count` are exceptions, because only some frames
carry them.

With capability `history`, `log_id`, `latest_log_id`, and `history_log_id` are
REQUIRED. Without it, they are OPTIONAL. [§4.2](#42-history) defines how to
use them.

`description` is the summary of the room, such as its purpose or the state of
its conversation. Users who can edit the room can change it with `room_set`
([§4.3.4](#434-creating-and-editing)). It is CommonMark
([§3.5](#35-messages)).

A **thread** is a room with a `parent_room_id`. A client that ignores this
field shows threads as ordinary rooms. A client that uses it groups threads
under their parent, and MAY collapse or hide them. Servers set `title` on
threads.

### 3.5 Messages

Messages are the center of the protocol. A client sends only what it controls.
The server fills in the rest, and broadcasts the result as a snapshot that
every client keeps by the same rule as any other record.

```ts
class Message {
  body?: {                      // required on creation; absent on tombstones (§4.4)
    text?: string = "";
    format?: "plain" | "markdown" = "plain";
    mentions?: string[] = [];   // user_ids
    embeds?: Embed[] = [];      // §4.8
  };

  room_id?: string;             // absent: the server's default room
  reply_to?: { message_id: string } | Message;   // bare from clients

  // set by the server
  message_id?: string;          // absent on transient notices; sent by clients only to save (§4.4)
  log_id?: string;              // absent on transient notices
  from: User;

  prev_log_id?: string;
  prev_room_id?: string;        // only after a move

  // "edit" capability
  deleted?: boolean = false;

  // "ext" capability
  ext?: object;                 // absent on tombstones (§4.12)
}
```

A message is one object. The server broadcasts the complete object as an
authoritative **snapshot** at one log position.

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
| `deleted`      | client | tombstone marker, default false ([§4.4](#44-edit))                      |
| `ext`          | client | optional extension data; merges by key ([§4.12](#412-ext))               |

**Creating.**

- `body` is required when a client creates a message. `text` defaults to `""`.
  `embeds` and `mentions` default to `[]`. `format` is `"plain"` or
  `"markdown"`, and the default is `"plain"`.
- A request without `room_id` posts to the default room of the server. The
  snapshot refers to that room.
- Posting does not require joining the room.
- A new message with no `text` and no `embeds` SHOULD NOT be logged or
  broadcast. Its result is then `{}`.
- **Result:** `{"message_id": "..."}`, the permanent ID. The result is the
  confirmation.

**Rendering.**

- Clients MUST render both formats. `"markdown"` text is
  [CommonMark](https://commonmark.org/). Clients MAY render common extensions,
  such as tables, and MAY render soft line breaks as hard breaks.
- Other fields that this document calls CommonMark follow the same rules.
  Clients MAY show them as plain text.
- Clients MUST disable raw HTML in CommonMark, or sanitize it with the same
  allowlist as HTML embeds ([§4.8](#48-embeds-and-avatars)).
- Clients MUST render an embed of unknown `kind` from its `og`, if it has one.
  Otherwise they render a labeled fallback card: the kind name, plus `url` or
  plain `text` if present.

**Delivery.**

- The broadcast goes to the connections that receive the deliveries of the
  room ([§3.4](#34-rooms)).
- On a live connection, servers deliver the snapshots of each room in
  ascending `log_id`, and each snapshot one time for each connection.
- **Snapshots replace** earlier ones under the replay rule
  ([§2](#2-identifiers)), also for messages that the client has not loaded.
- Servers MAY publish a snapshot of any message at any time. Clients MUST
  accept it, also without capability `edit`.
- A `message` notification without `message_id` is a transient notice, such as
  a private system notice
  ([Appendix A.1](#a1-system-identities-and-scoped-notices)). Clients show it,
  but never install it as a snapshot.

**References.**

- `reply_to` holds a message object. Clients send it bare, with only
  `message_id`. Servers MAY send a full snapshot, and clients install it like
  any other. Embedded snapshots carry a bare `reply_to`.
- `reply_to.message_id` MUST refer to an existing message other than the
  message itself. It MAY be in another room.
- Clients show the replying message even when the target is missing or
  deleted.

**Mentions.** A message lists the users that it mentions in `body.mentions`.
Usually its `body.text` also shows each one
([Appendix A.3](#a3-prefixes-in-text)):

```json
"body": {
  "text": "@guest_1234 can you check `@property` in https://example.com/@bob?",
  "format": "markdown",
  "mentions": ["guest_1234"]
}
```

- Servers ([§4.9](#49-push)) and clients treat only the users in `mentions` as
  mentioned. The content of `text` does not change this.
- Servers never parse `text` to find mentions.
- An edit ([§4.4](#44-edit)) mentions only the users that it adds to
  `mentions`. Users that were already in the list are not mentioned again.
- When the user picks someone to mention, the composer adds that user to
  `mentions`, and writes the mention in `text`.
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
`rooms`. A minimal server skips `room_list`. Its client posts without
`room_id`, and learns the room from the broadcast.

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

Everything beyond the core is optional. Each capability adds one coherent
feature, such as history, rooms, or reactions, and says what a client does
without it. So a client written for the core keeps working on any server, and
a server can grow one capability at a time. The sections start with the
capabilities closest to the core.

`server.capabilities` lists the optional features of the server. A capability
shows support, not permission. Servers still apply local policy to each
request. Nothing is negotiated. Clients ignore capabilities that they do not
know ([§1](#1-transport--framing)). If the server does not have a capability,
the client uses the fallback in this table:

| capability     | adds                                                        | fallback                     | spec                       |
|----------------|-------------------------------------------------------------|------------------------------|----------------------------|
| `command`      | commands from client to server, such as `/kick`             | no commands                  | [§4.1](#41-command)        |
| `history`      | page and recover a room's log                               | session-only scrollback      | [§4.2](#42-history)        |
| `rooms`        | `room_list`, `room_join`, `room_leave`, `room_set`, updates | one default room, no threads | [§4.3](#43-rooms)          |
| `edit`         | `message` saves: edit, move, delete                         | no edit/move/delete UI       | [§4.4](#44-edit)           |
| `status`       | user `status`, idle connections, and mutes                  | no online indicators         | [§4.5](#45-status)         |
| `activity`     | typing and read markers                                     | no typing or read indicators | [§4.6](#46-activity)       |
| `reactions`    | emoji reactions on messages                                 | reaction controls hidden     | [§4.7](#47-reactions)      |
| `embed:upload` | `upload` embeds: files the sender writes over HTTP          | no attachments               | [§4.8.4](#484-embedupload) |
| `embed:stream` | live-streamed text in a message                             | post the finished text       | [§4.8.5](#485-embedstream) |
| `ext`          | extension data kept on users, messages, and rooms           | servers may drop `ext`       | [§4.12](#412-ext)          |

Some features have no capability:

- Embeds other than `upload` and `stream` are body content
  ([§4.8](#48-embeds-and-avatars)).
- `server.push` enables push ([§4.9](#49-push)).
- `server.auth` enables passkeys and email sign-in
  ([§4.10](#410-webauthn-authentication), [§4.11](#411-email-authentication)).
- `server.ping` enables liveness checks ([§1](#1-transport--framing)).

Six frame patterns cover everything that is logged or announced:

- **Records** (room records, `message`): the complete state at a `log_id`
  ([§2](#2-identifiers)).
- **Per-user state** (`reactions`, memberships): the user and their complete
  state for a scope. The newest wins for each user. Logged
  ([§2](#2-identifiers)).
- **Activity** (`activity`): `from` and changes to the transient state of the
  user. Absent fields do not change it. Not logged.
- **Announcements** (`server`): not logged, and sent again in full. Each one
  replaces the last.
- **Room updates** (`room_update`): changes to the rooms of the user. They
  carry room records and memberships, never a full list
  ([§4.3.3](#433-updates)).
- **Users** (`user`, and every current user object): not logged. Each one
  merges into the kept object ([§3.3](#33-identity)).

### 4.1 `command`

Capability `command`. A `command` request sends an instruction to the server.
It takes the same params as a new message ([§3.5](#35-messages)). Only its
effect is different:

- `body.text` is the command line as the user typed it, slash included.
  The server parses it.
- If composer text starts with `/`, clients send it as a `command`. If it
  starts with `//`, clients send it as a message that starts with `/`.
- A command is never logged, broadcast, or saved. It has no `message_id`. A
  command with `message_id` or `deleted` is `invalid_params`.
- `mentions`, `reply_to`, `embeds`, and `ext` are arguments. Mentioned users
  are not notified, and `ext` is not kept.
- The result is `{}`, or `{"embeds": [...]}` with write URLs for new `upload`
  embeds ([§4.8.3](#483-writes)). A failure is an ordinary error, and the
  client shows its `message`.
- The server replies as needed with system notices ([Appendix A.1](#a1-system-identities-and-scoped-notices)).
  It sends `~private` to the sender, `~room` to the room, and `~server` to
  everyone.
- Effects arrive as the frames they cause, such as `room_update`.
- Commands are for what a server provides beyond this spec, such as
  `/ban` with the server's own moderation rules.
- Which commands exist, their arguments, and who may use them are server
  policy.
- Servers that support commands SHOULD provide `/help`. It replies with a
  `~private` notice. The notice lists the commands that the sender can use,
  with their arguments and what they do.
- Clients MAY handle a command themselves when it matches a request, such as
  `/nick` as `me` or `/join` as `room_join`. They send the other commands as
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
      {"log_id": "1724803900001", "room_id": "general", "members": [{"user": {"user_id": "guest_1234", "name": "Guest"}, "joined": false}]}
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

// -> set an avatar from an upload (§4.8.6)
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

### 4.2 `history`

Live delivery covers only the time that a client is connected. `history` fills
the gaps. It pages through the log of a room, so that a client can show older
messages and recover what it missed while it was away.

Capability `history`. A `history` request is a stateless query for a window of
the **log** of a room. Without `room_id`, it queries the default room
([§3.5](#35-messages)). The result splits the records by kind:

- `rooms`: room records ([§3.4](#34-rooms)).
- `messages`: message snapshots ([§3.5](#35-messages)).
- `reactions`: reaction sets ([§4.7](#47-reactions)).
- `memberships`: memberships ([§4.3.2](#432-membership)).

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

**Which rooms a record is in.** A record about a message, such as a snapshot
or a reaction set, is in each room that the message is in just before or just
after the record. Room records and memberships are in their own room. The
earlier history of a moved message stays in the source room, and
`prev_room_id` points there ([§2](#2-identifiers)).

**Bounds and order.**

- `after` and `before` are inclusive `log_id` bounds. Either one MAY be
  omitted.
- The server limits the bounds to the available history. Then it selects a
  contiguous slice of the changes in the room, of any kind.
- `limit` is a positive count of changes, applied before compaction. Servers
  MAY supply a default.
- With `after`, the server selects the oldest matches. Otherwise it selects
  the newest.
- `first_log_id` and `last_log_id` are the first and last `log_id`s of the
  slice before compaction. The result has both or neither.
- `more` shows that more changes match in the selected direction. An empty
  slice returns `more: false` and neither bound.
- `rooms`, `messages`, `reactions`, and `memberships` MAY each be omitted when
  empty. Clients treat a missing array as empty. Each array is in ascending
  `log_id` order.
- To continue forward, use `after = last_log_id + 1`. To continue backward,
  use `before = first_log_id - 1`. Calculate these as numbers, and encode them
  as strings. Never calculate a continuation from compacted records.

**Availability.** Every result includes `latest_log_id` and `history_log_id`
([§3.4](#34-rooms)). The server reads them at the same time as the page. They
describe the room, not the page. Retention can advance between requests, so
clients check each response before they apply it. If the server rejects a
request for lack of resources, it returns an error, not an empty result.

**Retention.**

- Servers SHOULD compact old history at rest, and not discard it. Compaction
  keeps the latest record for each key, under the rules below.
- Compacted history is still available. It does not move `history_log_id`.
- A server that discards the start of the log advances `history_log_id`.
- The effective lower bound is `history_log_id`. If `history_log_id` is
  `null`, it is `latest_log_id + 1`. The effective lower bound MUST NOT
  decrease.
- Before a server discards a part that holds memberships, it appends one
  membership record. This record lists every current member, with `joined:
  true` only.

**Compaction (optional).** After the server selects the slice, it MAY compact
it:

- It MAY keep only the last room record and the last snapshot of each message
  in the slice.
- It MAY fold the reaction sets of each message into one record. That record
  carries the last set of each user in the slice, at the greatest folded
  `log_id`.
- It MAY fold the memberships of the room into one record in the same way.
  That record carries the last membership of each user.
- It keeps empty sets and leaves.
- Kept records keep their original `log_id`s and contents. They never include
  changes after the slice.
- A compacted page and an uncompacted page give the same final state.

**Replay** follows [§2](#2-identifiers). A client can apply a record without
earlier state. The order across the arrays does not matter.

**Recovery**, for each room:

1. When live delivery starts, after authentication or after a join, buffer the
   live records for the room.
2. Get the `latest_log_id` of the room from its room record
   ([§4.3.1](#431-listing)) or from a `history` page. Call it H. Keep only the
   buffered records above H.
3. Page forward with `before: H` until `more: false`. If the client has a
   checkpoint C, start at `after: C + 1`. Otherwise start at `after:
   history_log_id`.
4. Apply the buffered records. The checkpoint is now H.

If the effective lower bound of a response is past the next position that the
client needs, the client clears the state of the room. It then starts again
from that bound. Clients recover each room that they show independently. A
thread loads when the user opens it.

### 4.3 `rooms`

Capability `rooms` lets users find, join, and create rooms and threads. It
adds the requests `room_list`, `room_join`, `room_leave`, and `room_set`, and
the notification `room_update`. Visibility and membership are server policy.

#### 4.3.1 Listing

`room_list` returns the rooms that match its filters, as room records
([§3.4](#34-rooms)). The result has up to two arrays. `joined` holds the rooms
that the user joined. `not_joined` holds the visible rooms that the user did
not join. Listing never joins a room.

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
- `parent_room_id` lists only the threads of that room. Without it, `joined`
  holds joined rooms at all depths, threads included, and `not_joined` holds
  only top-level rooms.
- `room_id` lists only that room, in the array that matches its membership. It
  overrides `parent_room_id`. Servers SHOULD support this filter.
- `members: true` adds each room's `members` and the result's `users`
  (below); without it, a result carries neither.
- `latest_log_id` lists only the rooms whose `latest_log_id` is greater. A
  server MAY ignore this filter. Its result is then a full listing without
  `left`.
  - A server that applies this filter includes `left`, also when it is empty.
  - When the result has `joined`, `left` lists the rooms that the user left
    since then, as `[{room_id}]` like `room_update` ([§4.3.3](#433-updates)).
  - Rooms that were deleted or became invisible since then SHOULD also be in
    `left`.

A result lists the matching rooms, with the most recently active first.
`joined` lists every match. For `not_joined`, servers MAY list only the most
recently active rooms. Servers list a private room only to its members
([§4.3.4](#434-creating-and-editing)).

With `members: true`, each room in `joined` and `not_joined` carries
`members`. This lists every user who joined the room, as complete or partial
user objects ([§3.3](#33-identity)). The result SHOULD carry `users`, the
complete objects of the users in `members`, each one time.

In a large room, a server MAY truncate `members`, for example to the most
recently active users. It then SHOULD include `member_count`, the number of
users who joined.

#### 4.3.2 Membership

`room_join` and `room_leave` take a `room_id`. They return `{}`.

A server MAY also accept a `user_id`, to add or remove another user. A server
that does not support `user_id` replies `unsupported`. The change is an
ordinary join or leave by that user.

```jsonc
// -> Alice adds Bob to her private room
{"method": "room_join", "id": "c3", "params": {"room_id": "1724803950000", "user_id": "bob"}}
```

A join subscribes every connection of the user to the deliveries of the room
([§3.4](#34-rooms)). Users join a thread like any room.

Every membership change is a logged record in the room. This includes the
creation of a room with `room_set`, and changes that the server makes. A
membership record carries `members`, with one entry for each user. Each entry
has the user as a recorded object ([§3.3](#33-identity)), and `joined`.
`room_update` delivers membership records in `memberships`
([§4.3.3](#433-updates)):

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
      {"log_id": "1724803450200", "room_id": "1724803312001", "members": [{"user": {"user_id": "ada", "name": "Ada"}, "joined": false}]}
    ]
  }
}
{"id": "c25", "result": {}}
```

- The key of a membership is `(room_id, user.user_id)`. The record with the
  greatest `log_id` wins ([§2](#2-identifiers)). Live records carry one entry.
  Compacted history records MAY carry more ([§4.2](#42-history)), and each
  entry replaces the membership of that user.
- The server delivers a membership record to the members of the room before
  and after the change. The record advances the `latest_log_id` of the room.
- Clients start the member list of a room from its `members` in `room_list` or
  in `room_update` `joined`. They update it from the memberships that they
  receive, live and in history.
- A server MAY keep some memberships outside the log, such as for temporary
  guests. It then sends no membership records for them, and ignores
  `latest_log_id` in `room_list` ([§4.3.1](#431-listing)).
- Posting in a room does not require a join ([§3.5](#35-messages)). The server
  MAY join the poster. A poster who did not join does not receive the
  broadcast.

#### 4.3.3 Updates

`room_update` tells the connections of the user what changed. It never carries
the full list:

- `joined`: the room records of rooms that the user joined, by any means. Each
  has its `members`, as in `room_list` ([§4.3.1](#431-listing)). `users` MAY
  come with them.
- `left`: `[{room_id}]` for each room that the user is no longer in, for any
  reason.
- `memberships`: membership records ([§4.3.2](#432-membership)), to the
  members of the room.
- `updated`: room records that are new or changed, when the membership of the
  user did not change. These are edits to a joined room, and new or edited
  threads of a joined room.
  - The changes to the record of a thread go to the members of the parent,
    also if they did not join the thread. This does not apply to a private
    thread.
  - Messages in a thread do not cause `updated`. So the `latest_log_id` of a
    thread in `updated` is from its last record change.

```jsonc
// <- after the join above
{"method": "room_update", "params": {"joined": [{"room_id": "1724803399000", "parent_room_id": "general", "title": "Incident", ...}]}}
// <- after the leave above
{"method": "room_update", "params": {"left": [{"room_id": "1724803312001"}]}}
// <- a joined room was renamed
{"method": "room_update", "params": {"updated": [{"room_id": "general", "log_id": "1724803600000", "title": "General (ops)", ...}]}}
```

#### 4.3.4 Creating and editing

`room_set` without `room_id` creates a room, and joins the creator to it.
`room_set` with `room_id` replaces the client fields of that room
([§3.4](#34-rooms)). Fields that end in `_id` are fixed at creation. `private`
is also fixed if the server fixes it. If an edit omits `private`, the room
keeps its value. `ext` merges ([§4.12](#412-ext)). Other omitted fields are
cleared. Both forms return `{"room_id": "..."}`.

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

- `parent_room_id` MUST refer to an existing visible room.
- `private: true` makes the room visible only to its members. A thread that is
  created without `private` takes the value of its parent. Members add other
  users by joining them ([§4.3.2](#432-membership)), if the server supports
  it.
- A server includes `private: true` only on a room that it keeps private. A
  server without private rooms MUST reject a creation with `private: true` as
  `unsupported`.
- A client that asks for a private room checks for `private: true` in the
  `room_update` `joined` record before it posts in the room. If the value is
  missing, the client tells the user, and does not use the room.
- Suggested convention: members of a room may edit it.

### 4.4 `edit`

A message is a record, so an edit is only a new snapshot of it at a later log
position. The same mechanism moves and deletes messages.

Capability `edit`. A `message` request with an existing `message_id` **saves**
that message:

- A save replaces every client field ([§3.5](#35-messages)) with the submitted
  state, except `ext`, which merges ([§4.12](#412-ext)). It removes omitted
  fields, and replaces objects and arrays whole.
- `null` does not mean deletion.
- Clients MUST send again every client field that they want to keep, except
  `ext`.
- The server keeps `message_id`, `from`, and the other server fields.
- Saves apply in server order, and the later save wins.

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

**Move.** A save with a different `room_id` moves the message. The destination
MUST exist, and the caller MUST be able to see it. The server delivers the
snapshot to both rooms ([§4.2](#42-history)). Clients move the message, and do
not treat it as deleted. The snapshot carries `prev_room_id`, the source room
([§2](#2-identifiers)). If the message has reactions, the server then logs one
reactions record ([§4.7](#47-reactions)) in the destination, with every set
that is not empty.

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
server MUST omit `body` and `ext` from the tombstone. `deleted: true` on
creation is `invalid_params`.

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

Clients show tombstones, and hide their reactions.

**Redaction.** Earlier snapshots of a deleted message still hold its content.
A server MAY rewrite them, and embedded copies of them ([§3.5](#35-messages)),
into tombstones at their original `log_id`s. This is the only permitted
rewrite of a logged record. Clients that hold the old content drop it when
they receive the new tombstone.

### 4.5 `status`

Presence and notification control share a capability, because both answer one
question: is now a good time to reach this user? A status tells others whether
the user is around. Idle reports and mutes tell the server when to hold back
notifications.

Capability `status`. Users set a presence `status` with `me`
([§3.3](#33-identity)). Clients use the `status` request to report idle
connections, and to set the mutes of the user.

```jsonc
// <- the server frame accepts dnd and invisible
{
  "method": "server", "params": {
    "apron": 8, "capabilities": ["status"], "auth": ["token"],
    "status": ["dnd", "invisible"]
  }
}
// -> do not disturb
{"method": "me", "id": "c40", "params": {"status": "dnd"}}
// <-
{"id": "c40", "result": {"you": {"user_id": "alice", "name": "Alice", "status": "dnd"}}}
// <- to others who share a room
{"method": "user", "params": {"new": {"user_id": "alice", "status": "dnd"}}}
```

**Values.**

- A user sets one of these values:
  - `online`: the default. Others see the derived status below.
  - `""`: no status. Users set it to opt out. Servers set it when they do not
    accept a value.
  - `dnd` (optional): others see `dnd` while the user has a connection, and
    `offline` when the user has none. It silences the notifications of the
    user, as `mute` does.
  - `invisible` (optional): others see `offline`.
- When the status of a user is `online`, others see one of these derived
  values:
  - `online`: a connection is attended.
  - `idle`: the user is connected, but no connection is attended.
  - `offline`: the user has no connections.
- `server.status` ([§3.1](#31-server-frame)) lists the optional values that
  the server accepts. Only servers with capability `status` send it. Servers
  always accept `online` and `""`, and do not list them.
- Clients offer only the listed optional values.
- A server without `idle` shows `online` for a connected user.

**Delivery.**

- `status` is only in current user objects ([§3.3](#33-identity)). A change is
  a `user` notification. Servers MAY delay it.
- Clients take the user's own `status` only from `you`. Other objects about
  the user carry what others see. A complete object about the user, other than
  `you`, does not replace the user's own `status`.
- Complete user objects carry `status` also when it is `offline` or `""`.
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

**The `status` request.**

- Clients send `status` as a request. The server replies `{}` when it applies
  the change.
- If there is an error, such as `retry_after` or `invalid_params`, nothing
  changes.
- A `status` from the server is a notification.
- Absent fields do not change.

**Idle.**

- `idle` (boolean) is about the sending connection. It is `true` when nobody
  attends that connection.
- A connection starts as attended. It keeps nothing from earlier connections.
  Its client sends `idle: true` when nobody attends it, and `idle: false` when
  somebody attends it again.
- Clients MAY wait about 30 seconds after attention stops before they send
  `idle: true`. They do not wait on a connection that starts unattended.
- Servers never send `idle`.

**Mute.**

- `mute` is `true`, `false`, or a positive integer number of seconds. It
  silences the notifications of the user everywhere. With `room_id`, it
  silences them only in that room and its threads. A `status` request with
  `room_id` and no `mute` is `invalid_params`.
- `mute` is private. Others never see it.
- Servers without timed mutes treat seconds as `true`.
- Servers send each change to the mutes of the user to all connections of the
  user, as `status`. When a mute ends or is cleared, they send `mute: false`.
- Clients apply a `status` that they receive as their own setting.

**Sign-in.** At each sign-in ([§3.2](#32-authentication)), clients drop the
statuses and mutes that they kept, and apply the ones that arrive. After the
`auth` result, the server sends:

- One `user` notification for each user who shares a room with the user,
  carrying in `new` the `status` that others see, except `offline` and `""`.
  Servers MAY limit these to the users that they would list in `members`
  ([§4.3.1](#431-listing)).
- One `status` notification for each mute in effect, with the seconds left or
  `true`.

### 4.6 `activity`

Capability `activity`. A client sends an `activity` notification when its
activity changes. Activity is typing, and how far the user has read in a room.
Each field that is present updates that state. Absent fields do not change it.
Activity is not logged. Servers MAY ignore `typing` and `read_message_id`.

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

- `typing` (seconds): show the user as typing for up to this time, or until a
  new message from the user arrives. `0` stops it.
- `read_message_id`: the user read the room up to and including this message.
  Clients only move it forward. Servers MAY ignore a cursor that moves back.
- Server policy decides the delivery, such as to the room, or only to the
  user's own connections.
- Servers MAY keep the latest `read_message_id` of each user in each room.
  They then send it to the connections of the user after those connections
  list the room ([§4.3.1](#431-listing)).

### 4.7 `reactions`

Capability `reactions`. A client sets its own complete set of emoji on one
message. The server logs the change with a `log_id`, and broadcasts it to the
room of the message. The result is `{}`.

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

- The request refers only to the message. The logged record carries the room
  of the message at that time ([§4.2](#42-history)).
- The `reactions` array of the notification holds one element for each user.
  Live broadcasts carry one element. Compacted history records
  ([§4.2](#42-history)) MAY carry more. Each element replaces the set of that
  user on that message.
- Clients keep state for each `(message_id, user_id)`, and calculate the
  totals. They accept reactions for messages that they have not loaded.
- `emojis` entries are strings. Duplicates collapse, and the order does not
  matter. One emoji sequence in each entry is the interoperable baseline.
- Servers MAY limit the number of distinct emoji on each message or from each
  user.
- The server MAY log nothing for a request that does not change the state.

### 4.8 Embeds and avatars

Messages can carry more than text: files, live output, previews of links, or
interactive content. Each embed has a `kind` that selects how to render it,
and every client has a fallback for kinds that it does not know. Avatars are
here because they use the same uploads.

```ts
class Embed {
  kind: string;                 // "upload", "stream", "iframe", "html", or another

  embed_id?: string;            // set by servers with any embed:* capability (§4.8.2)
  title?: string;
  url?: string;                 // where a click goes; the server's own for upload and stream
  og?: object;                  // OpenGraph description (§4.8.1)

  // "iframe" kind
  height?: number;              // suggested height

  // "html" kind
  html?: string;

  // "stream" kind (§4.8.5)
  format?: string = "plain";
  text?: string;                // the kept text, once the stream ends
}
```

`body.embeds` holds rich content in display order. `kind` selects the
renderer. Clients render an unknown kind from `og`, or else as the fallback
card ([§3.5](#35-messages)).

```json
{"embed_id": "embed_1240", "kind": "upload", "title": "report.pdf", "url": "https://chat.example/f/Qm7xk2…"}
{"embed_id": "embed_1241", "kind": "iframe", "url": "https://backend:8443/term/abc", "height": 300}
{"embed_id": "embed_1242", "kind": "html", "html": "<table>…</table>"}
```

- `iframe`: render with `sandbox="allow-scripts"`, and **never** with
  `allow-same-origin` too. Allow no top navigation and no popups. Use a
  restrictive Permissions-Policy. Clamp the dimensions, because `height` is
  only a suggestion. Load lazily, and limit the number of live iframes at one
  time.
- `html`: sanitize it with an allowlist sanitizer, such as DOMPurify, before
  insertion. Do this for every source.
- `upload` is [§4.8.4](#484-embedupload), and `stream` is [§4.8.5](#485-embedstream).

#### 4.8.1 OpenGraph metadata (`og`)

Any embed MAY carry `og`, an [OpenGraph](https://ogp.me/) description of its
content as JSON. Property names drop the `og:` prefix. Structured properties
are nested: `og:image:width` becomes `image.width`.

```json
"og": {
  "title": "before.png",
  "image": {"url": "https://chat.example/f/Zr8Tq1…/thumb", "type": "image/webp", "width": 320, "height": 180, "alt": "Dashboard before the fix"}
}
```

- Clients use the `og` properties `title`, `description`, `site_name`,
  and `image`, `video`, and `audio` (each with `url`, `type`, `width`,
  `height`, `alt`). They ignore other properties.
- `og.image` is a preview to show. `og.video` and `og.audio` are what a player
  loads. The `url` of the embed is where a click goes.
- Servers SHOULD set `og` in the broadcast. They MAY keep, replace, or drop an
  `og` that a client sent.
- Servers SHOULD host or proxy the media that `og` refers to, and set its
  dimensions. Clients SHOULD NOT load `og` media from other origins.

#### 4.8.2 Embed identity

Servers that advertise any `embed:*` capability assign an opaque `embed_id` to
each embed. Other servers MAY store embeds as they receive them.

- A save keeps an embed when it sends the embed back with its `embed_id`. An
  embed without an `embed_id` is new. A save that leaves out an `embed_id`
  removes that embed.
- The server owns `embed_id`, the `url` of an upload, and the `url` and `text`
  of a stream. It ignores them in requests, and restores them from its records
  on a save.
- Servers SHOULD delete the content that they host for an embed when the embed
  is removed, or when its message is deleted or redacted.
- Servers SHOULD make the URLs they host unguessable, such as with a random
  path segment rather than just the `embed_id`.

#### 4.8.3 Writes

New `upload` and `stream` embeds get their content over HTTP. The result of
the `message` or `command` ([§4.1](#41-command)) lists them, in request order:

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

- The sender sends the content as the body of an HTTP `PUT` to `write_url`.
  `write_url` is a credential. It expires if it is not used.
- The server finishes each write exactly one time. On success, it publishes a
  snapshot with the completed embed. If the write fails or does not start in
  time, it publishes a snapshot without the embed.
- For a command, the server uses the finished write instead, such as to set an
  avatar ([§4.8.6](#486-avatars)).

#### 4.8.4 `embed:upload`

Capability `embed:upload`. The sender gives an optional `title`, such as the
file name. While `url` is absent, the upload is pending, and clients show a
placeholder. On success, the server sets `url` to the file that it hosts.

- The server SHOULD add `og` describing the file: `image` for a preview,
  and `video` or `audio` for playable media. It MAY keep what the sender
  gave, such as `og.image.alt`.
- Without `og`, clients show a file card: `title`, with a link to `url`.

#### 4.8.5 `embed:stream`

Capability `embed:stream`. A message can carry live text. The sender writes it
over HTTP, and readers see it grow. Stream embeds follow the rules for embed
identity ([§4.8.2](#482-embed-identity)) and writes ([§4.8.3](#483-writes)).

```jsonc
// -> the embed in a message request; the result and write follow §4.8.3
{"kind": "stream", "format": "terminal"}
// sender: foo 2>&1 | curl -T - <write_url>
// <- the embed as broadcast: live at its url, then finished with the kept text
{"embed_id": "embed_1234", "kind": "stream", "format": "terminal", "url": "https://chat.example/s/p3Wn9d…"}
{"embed_id": "embed_1234", "kind": "stream", "format": "terminal", "text": "…"}
```

- `format` defines how to render the text. The default, `"plain"`, shows the
  text as is, with its line breaks. Clients MAY support other formats
  natively, such as `"markdown"` (CommonMark, [§3.5](#35-messages)) or
  `"terminal"`. They render unknown formats as plain.
- Write: the sender sends UTF-8 text as a streaming `PUT` body to
  `write_url` ([§4.8.3](#483-writes)). The end of the body ends the stream.
- Read: `GET url` returns the text that the server kept. It continues as more
  text arrives, and ends when the stream ends. A reader that reconnects
  replaces the text that it showed with the new response.
- Finish: when the stream ends, the server publishes a snapshot whose embed
  carries the kept text as `text`, in place of `url`. Both URLs then stop
  working. If the server has capability `edit`, the sender MAY save the
  message without the embed before that. This ends the stream.
- Server policy sets how much text the server keeps, the size and time limits,
  and the grace period after a writer disconnects. At a limit, the server ends
  the stream, and keeps the last part of the text.
- The chat server serves `url`. Clients SHOULD NOT connect to stream URLs on
  other origins.

#### 4.8.6 Avatars

A user object ([§3.3](#33-identity)) MAY carry `avatar`, an image to show next
to the name of the user.

- Servers SHOULD send only `https:` URLs, or small
  `data:image/{png,jpeg,gif,webp};base64,` URLs.
- A larger image goes through an upload, with capabilities `command` and
  `embed:upload`. A `/avatar` command ([§4.1](#41-command)) with one `upload`
  embed asks the server to use that file as the avatar of the sender. When the
  upload completes, the server sets `avatar` and sends `user`
  ([§3.3](#33-identity)).
- Clients choose which avatar sources to load, and MAY ignore any avatar. They
  load avatars only as images, never as documents. They bind or escape the
  values, and never insert them into HTML as raw text.
- Without a usable avatar, clients draw a placeholder such as initials.

### 4.9 Push

Push reaches users when no client is open, such as a phone in a pocket. The
server sends a small payload to a push service that the client registered, and
the client shows it as a notification. Push has no capability of its own.
`server.push` advertises it.

`server.push` ([§3.1](#31-server-frame)) maps each supported push kind to its
public configuration. Its `wake` key lists the wake scopes that the server
supports. If `server.push` is present, the server accepts `push_register` and
`push_unregister`. A server that advertises `push` SHOULD advertise `status`
([§4.5](#45-status)).

```jsonc
// <- the server frame offers relay and webpush
{
  "method": "server", "params": {
    "apron": 8, "capabilities": ["status"], "auth": ["webauthn", "token"],
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

**Registration.**

- `kind` is a key of `server.push` other than `wake`. Fields other than `url`,
  `push_id`, and `wake` are specific to the kind. Unknown kinds are
  `invalid_params`. Third-party kinds ([§1](#1-transport--framing)) define
  their own delivery.
- `url` is required. A registration belongs to the authenticated user and its
  `url`. It stays after the connection that made it closes.
- A registration with the same `url` replaces the earlier registration of the
  user. `push_unregister` removes it. Unregistering an unknown `url` succeeds.
- Servers MAY refuse a registration with `denied`, such as from a guest
  ([§3.2](#32-authentication)). An endpoint that the server will not send to
  is `invalid_params`.
- Servers SHOULD accept only `https` push endpoints that resolve to addresses
  that are not internal.
- `push_id` (optional) is 1 to 64 characters from `A-Z a-z 0-9 - _`. Clients
  choose one for each server and account. It is an opaque value that shows
  neither the server nor the account.
- Clients SHOULD register on each connection. Servers MAY drop a registration
  that the client did not renew within a server-defined period. Servers MAY
  also drop the least recently renewed registrations above a server-defined
  number for each user.
- Clients SHOULD unregister before they sign out. Servers MAY remove the
  registrations of a user when they revoke the sessions of that user.
- Servers remove a registration whose `url` does not accept pushes, such as
  one that answers 404 or 410.

**Kinds.**

- `relay`: the server sends the payload in a POST to `url`, with `token`
  (optional) as a bearer token. The relay is responsible for delivery after
  that POST. Native apps use a relay that their vendor runs.
  - `keys` (optional) holds a `p256dh` and an `auth` that the client
    generated, as for `webpush`.
  - With `keys`, the body is the payload, encrypted as for `webpush`. It has
    `Content-Type: application/octet-stream` and `Content-Encoding:
    aes128gcm`.
  - Without `keys`, the body is the payload with `Content-Type:
    application/json`.
- `webpush`: Web Push ([RFC 8030](https://www.rfc-editor.org/rfc/rfc8030)).
  - `key` is the VAPID public key of the server
    ([RFC 8292](https://www.rfc-editor.org/rfc/rfc8292)): an uncompressed
    P-256 point in unpadded base64url. Clients subscribe with it as the
    application server key. They subscribe again when it changes.
  - `url` is the subscription endpoint. `keys` (required) holds its `p256dh`
    and `auth` in unpadded base64url, as in `PushSubscription.toJSON()`.
  - Servers encrypt the payload as one `aes128gcm` record
    ([RFC 8291](https://www.rfc-editor.org/rfc/rfc8291)), and sign with the
    private key for `key`.
- Servers send `TTL` and `Urgency` headers
  ([RFC 8030](https://www.rfc-editor.org/rfc/rfc8030)) with every push, also
  to relays. `Urgency` is:
  - `low` for a push without `message`.
  - `normal` for a push that only `joined` selects.
  - `high` for all other pushes.

**Payload.** Every kind delivers the same payload: a UTF-8 JSON object of at
most 2048 bytes.

- `push_id`: the `push_id` of the registration, if it has one. Clients drop a
  payload with a `push_id` that they do not know. A client that registered a
  `push_id` MAY drop a payload without one.
- `unread` (optional): the unread count of the user, as the server counts it,
  such as messages after the read cursors of the user ([§4.6](#46-activity)).
  It is the same for all registrations of the user. Clients MAY show it as an
  app badge.
    - Servers whose `server.push.wake` lists `badge` send `unread`.
  - Servers MAY leave messages that a room `mute` silences out of `unread`. A
    `mute` without `room_id` does not change `unread`.
- `message`: the message ([§3.5](#35-messages)) without `log_id`. Clients
  never install it as a snapshot. Servers do not push transient notices.
  - Servers SHOULD omit `format`, `embeds`, and `ext`.
  - To fit the limit, servers MAY truncate `body.text`, and leave out any
    field except `message_id`, `room_id`, and `from.user_id`.
  - A payload without `message` shows no notification.
- Clients SHOULD show at most one notification for each `push_id` and
  `message_id`. A later notification for the same pair replaces the earlier
  one, from a push or from the client's own connection.

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

**Wake.**

- `wake` (optional) lists the scopes that a registration wakes for. Each scope
  except `badge` selects new messages in rooms that the user can see:
  - `mentions`: messages whose `mentions` list the user
    ([§3.5](#35-messages)). Servers MAY also wake for an edit that adds the
    user to `mentions`.
  - `private`: messages in private rooms ([§4.3.4](#434-creating-and-editing))
    that the user joined, and in their threads.
  - `replies`: messages whose `reply_to` refers to a message of the user
    ([§3.5](#35-messages)).
  - `joined`: messages in rooms that the user joined
    ([§4.3.2](#432-membership)).
  - `badge`: every change to `unread`. A push for a change that no other scope
    selects has no `message`. Servers ignore `badge` for `webpush`. Servers
    MAY skip intermediate values of `unread`, and send only the latest.
- Servers advertise only the scopes that they implement, and ignore other
  scopes in `wake`. An empty `wake` wakes for nothing. Without `wake`, the
  server uses its default scopes. These SHOULD be `mentions` and `replies`,
  where advertised.
- A push that `mute` or a `dnd` status ([§4.5](#45-status)) silences has no
  `message`. It goes only to registrations that wake for `badge`.
- Servers do not wake a user for the user's own messages. Server policy
  decides other wake rules, such as rate limits.
- Suggested convention: wake a user only when every connection of the user is
  idle ([§4.5](#45-status)) or closed. Servers MAY wait a short time first,
  and skip the push if the `read_message_id` of the user is past the message.

### 4.10 WebAuthn authentication

Passkeys let users sign in without passwords or shared tokens, with a
credential that their device keeps.

Servers that list `webauthn` in `server.auth` MUST use this exchange. No
separate capability is necessary.

Both steps are `auth` requests with `scheme: "webauthn"`. `action: "register"`
creates a credential, and `action: "login"` signs in. Both steps use the same
`action`.

| Step     | Additional request fields                      | Successful result                                        |
|----------|------------------------------------------------|----------------------------------------------------------|
| `begin`  | `step: "begin"`                                | `challenge_id` (opaque), `public_key` (WebAuthn options) |
| `finish` | `step: "finish"`, `challenge_id`, `credential` | `you` ([§3.3](#33-identity))                                             |

`public_key` holds creation options for a registration, or request options for
a login. It uses standard
[WebAuthn JSON](https://www.w3.org/TR/webauthn-3/#sctn-parseCreationOptionsFromJSON),
with binary fields as unpadded base64url. Clients pass it to
`navigator.credentials.create` or `.get`, and return the credential in
`finish`.

- Registration MUST require discoverable credentials.
- Login omits `allowCredentials`, or sends an empty array.
- Both actions require user verification.
- Servers SHOULD use the `name` ([§3.2](#32-authentication)) of a `register`
  begin step for `user.name` and `user.displayName` in `public_key`.

Challenges MUST be unpredictable, and MUST expire. They MUST be bound to the
connection, the action, the RP ID, the allowed origin, and any proposed
registration identity.

- A connection has one pending ceremony. A new begin step replaces it, and a
  disconnect cancels it. A matching finish step uses it up, also when the step
  fails.
- Servers MUST perform
  [WebAuthn verification](https://www.w3.org/TR/webauthn-3/#sctn-rp-operations)
  before they record a credential or authenticate.
- Only a verified finish step returns `you`.
- A registration on a connection that is already signed in adds the passkey to
  that account.
- Server policy decides who can register, and who can authenticate again.
- Invalid challenges and failed verification are `denied`.

**Session resume (optional).** A verified `finish` result MAY carry a bearer
`token` ([§3.2](#32-authentication)) if the server also lists `token`. Servers
MUST bind such a token to the allowed origin of the ceremony, and MUST make it
expire. A mismatched origin is `denied`.

### 4.11 Email authentication

Email sign-in proves that a user controls an address. It suits sign-up and
account recovery, and works on any device that gets mail.

Servers that list `email` in `server.auth` verify an address with a temporary
token that they send to it. An `auth` request with `email` proposes a sign-in
or an addition. An `auth` request with `token` approves it:

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

- A proposal returns `{}`, whether or not the address has an account. On a
  connection that is signed in to an account, guests included, it proposes to
  add the address to that account. Otherwise it proposes a sign-in.
- The server emails a temporary token for the proposal, as a link, a code to
  type, or both. A token that is short enough to type, such as six digits,
  works only on the connection that made the proposal. A token that works on
  other connections MUST be unguessable.
- A connection has one pending proposal, and a new one replaces it. A proposal
  expires within minutes. Approval uses it up. A few failed attempts cancel
  it.
- Approval of a sign-in authenticates the connection that presents the token.
  That connection MUST NOT be signed in already. The result carries `you` and
  a bearer `token` for later connections ([§3.2](#32-authentication)).
- Approval of an addition adds the address to the account that proposed it,
  and returns `{}`.
- An invalid, expired, or used token is `denied`. A sign-in token on a
  signed-in connection is also `denied`, and so is an address that belongs to
  another account.
- The server builds any link from its own configuration and puts the token
  in the URL fragment.
- The suggested fragment is `#token=…`, plus `&server=…` with the server's
  WebSocket URL when the link opens a client that is not tied to one
  server.
- Account creation for unknown addresses, send rate limits (`retry_after`),
  and the bearer token's lifetime are server policy.

### 4.12 `ext`

Some data has no field in this document: a bridge's IDs for the messages it
relays, an agent's settings for a room, or a user's time zone. Capability
`ext` gives that data a place that survives other clients' saves.

Capability `ext`. Servers keep the `ext` that clients write on users,
messages, and rooms, and merge it as below. `ext` is an object whose keys are
extension names without the `ext:` prefix ([§1](#1-transport--framing)), such
as `irc`:

```json
"ext": {"irc": {"network": "libera", "channel": "#ops", "nick": "ada_", "msgid": "a1b2c3"}}
```

- A write merges `ext` one level down. Each key that it carries replaces the
  kept value, an empty value (`""`, `[]`, `{}`) clears that key, and keys that
  it leaves out stay. The value under a key is replaced whole. `null` is an
  ordinary value, and `"ext": {}` changes nothing.
- Writes are `me` ([§3.3](#33-identity)), `message` requests
  ([§3.5](#35-messages), [§4.4](#44-edit)), and `room_set`
  ([§4.3.4](#434-creating-and-editing)). A write that creates a record, or
  saves a message whose current snapshot is a tombstone, merges into an empty
  `ext`. A save with `deleted: true` drops `ext`.
- Complete user objects and records carry their complete `ext`. A `user`
  notification carries at least each key that changed, with a cleared key as
  its empty value, and clients merge it the same way.
- Clients do not have to parse `ext`, or send it back.
- Size limits apply to the merged `ext`. A write whose merged `ext` is over a
  limit is `too_large`, and changes nothing.
- Clients send `ext` only to a server that advertises capability `ext`, or the
  capability of the extension that defines the key.
- Without capability `ext`, servers MAY drop the `ext` that clients send.
- An extension keeps its own data under its name in `ext`, on whatever object
  it defines, such as the `server` frame. It needs only its own capability.

```jsonc
// kept: "ext": {"irc": {"nick": "ada_"}, "tz": "Europe/Oslo"}
// -> change the time zone only
{"method": "me", "id": "c50", "params": {"ext": {"tz": "America/Toronto"}}}
// <-
{"id": "c50", "result": {"you": {"user_id": "ada", "name": "Ada", "ext": {"irc": {"nick": "ada_"}, "tz": "America/Toronto"}}}}
// -> clear irc
{"method": "me", "id": "c51", "params": {"ext": {"irc": ""}}}
// <-
{"id": "c51", "result": {"you": {"user_id": "ada", "name": "Ada", "ext": {"tz": "America/Toronto"}}}}
```

---

## Appendix A — Conventions (informative)

### A.1 System identities and scoped notices

System identities are server-controlled `user_id`s with the `~` prefix
([A.3](#a3-prefixes-in-text)), such as `~server`. They carry an
ordinary `from` and render like any sender. Clients MAY style them as
system messages.

Three system identities tell the receiver who else got the message:

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
- A `~private` notice MAY omit `room_id`, like any message
  ([§3.5](#35-messages)). A client shows it even when it has no room to show
  it in yet, such as while it signs in.

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
  {"method": "server", "params": {"apron": 8, "capabilities": ["rooms"], "auth": ["webauthn", "token", "guest"]}}
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
  {"method": "server", "params": {"apron": 8, "capabilities": ["rooms"], "auth": ["token"]}}
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
  server commands ([§4.1](#41-command)). A used-up or expired invite is `denied`.

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
them ([§4.9](#49-push)).

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
poll. It requires capability `command` ([§4.1](#41-command)).

```ts
class Embed {   // "actions" kind, besides the fields of §4.8
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
  as the request it refers to, such as `/join` ([§4.1](#41-command)). When the message has
  a `message_id`, the request's `reply_to` refers to it.
- Clients ignore groups they do not know ([§1](#1-transport--framing)).
- Clients without `actions` support render the fallback card ([§3.5](#35-messages)).
  Its `og` can spell out the commands to type.
