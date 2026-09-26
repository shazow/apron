# Public demo authentication and policy

The demo speaks Apron protocol **6**, advertising `history`, `edit`, `rooms`,
`reactions`, and `command`, and `server.ping` (45 seconds). `activity`
(typing) is implemented but off unless the deployment sets `ACTIVITY=true`. History availability uses each room's `latest_log_id` and
nullable `history_log_id`, without extension negotiation. See
[history and recovery](../../../PROTOCOL.md#41-history) and the
[retention implementation specification](../SPEC.md#9-rolling-history-and-base-protocol-availability).

WebAuthn uses the canonical [optional authentication scheme](../../../PROTOCOL.md#49-webauthn-authentication),
advertised through `auth: ["webauthn", "token", "guest"]` only on connections whose
origin is in `RP_ORIGINS`. Other connections advertise `auth: ["guest"]`
and reject WebAuthn requests. Guest user IDs are `guest_<n>` from a
server-wide counter, with the name `Guest <n>`; a requested `user_id` or
`name` is ignored. Numbers are reserved in blocks of `guestNumberBlock` (10)
with one durable write per block, are never reissued (not across restarts,
hibernation, or schema resets either), and skip the unused rest of a block
after a restart or wake, so the latest number overstates the guest count by
at most a block per wake. Server
announcements are complete replacements.

Production admits guest connections from any frontend origin, including opaque
origins and clients without Origin. This does not relax passkey verification,
IP attribution, quotas, or the fixed shared room. See the
[custom frontend example](../README.md#connecting-a-custom-frontend).

The implementation follows the current repository protocol. Local policy
within it:

- Rooms: every room is visible to every client, and a connection receives
  deliveries only for the rooms its user has joined. A new guest or passkey
  identity has joined `general`; posting to a room does not require joining it.
  Only thread rooms under `general` may be created with `room_set` (top-level
  rooms and nested threads are `denied`), which joins the creator; any
  participant may save a thread's `title`, `intro_message`, and `ext`, while
  `general` is fixed. Threads always carry a title (`Thread` by default).
  `room_join` and `room_leave` work for `general` and threads, and changes
  arrive as `room_update` before the result. A thread's messages go to its
  members only. A guest's rooms last for its connection and are not logged; a
  registered identity keeps its rooms across connections, its joins and leaves
  count as posts, and each is a logged `membership` record delivered to the
  room's members before the `room_update` and kept in history. Joins and
  leaves are never `user` notifications. `room_list` takes `filter`,
  `parent_room_id`, and `room_id`, and with `members: true` lists each room's
  members (every connected one and at most 100 registered ones) and their
  current objects in `users`; it ignores `latest_log_id` and always returns a
  full listing, since guest memberships are not logged. A client that sends
  the `{"method":"ping"}` liveness ping every 45 seconds and then goes quiet
  for 150 is disconnected, so a peer that vanished without closing is not
  listed.
- Activity (only with `ACTIVITY=true`): typing is relayed to the room's other
  members and never stored, at most 10 relays per user per minute; past that, updates are dropped and the
  sender gets one `@private` notice a minute saying so. Read cursors are
  neither kept nor relayed. `away` is accepted and ignored: the demo has no push.
- Commands: `/help` replies with a `@private` notice; other commands are
  `invalid_params`.
- Messages: a request without `room_id` is in `general`. A new message with
  empty text and no embeds is not logged and returns `{}`; an empty save is
  `invalid_params` (delete instead). `body.mentions` is stored as sent, and
  text is never parsed for mentions. Author-only edit, delete, restore, and move. `reply_to` and
  `intro_message` must name a retained message when set or changed; resubmitting
  an unchanged reference stays valid after its target expires, and expiration
  never invalidates an accepted snapshot. The server keeps references bare.
- Reactions: at most 8 distinct emoji (each at most 64 UTF-8 bytes, no control
  characters) per user per message and 32 reacting users per message. New
  reactions on a deleted message are rejected; clearing is allowed. An
  unchanged set is accepted without a new record.
- Load: the whole server processes at most 300 frames a minute. Past that,
  requests get `retry_after` and notifications are dropped; sockets stay open.
- `me` renames registered users only; given fields replace, omitted ones stay,
  and `name: ""` removes the name (announced as `name: ""`). `avatar` and `ext`
  are ignored. A rename sends `user` notifications to the user's other
  connections and to users who share a room with them, as does signing in on
  a guest's connection (`new` with the retired guest as `old`). History pages
  carry no `users`: records keep the names they were logged with, and
  listings carry current ones. A `user_id` or `name` requested in `auth` is
  not honored.
- Records: message snapshots carry `prev_log_id` when the previous snapshot is
  still stored, and a move's snapshot also `prev_room_id`; reaction sets and
  memberships carry neither. Deletion does not redact earlier snapshots; they
  expire with the retention window.
- Ordering: `auth` finishes before any later frame on its connection, and the
  notifications a request causes on its connection come before its result.

## Authentication policy

An authenticated guest may begin registration while retaining guest rights.
A new credential creates a separate registered identity; it does not transfer
ownership of guest messages. A registered identity must reconnect before
switching identities.

The canonical begin/finish exchange, JSON credential encoding, and verification
rules are defined in protocol [§4.9](../../../PROTOCOL.md#49-webauthn-authentication). This demo limits challenges to 120
seconds and requires user presence and verification. A new begin replaces the
pending challenge without extending the initial 30-second authentication
deadline. A matching finish attempt consumes the challenge even on failure.
A verified login or registration returns a bearer `token` (protocol [§4.9](../../../PROTOCOL.md#49-webauthn-authentication),
session resume). Presenting it with `scheme: "token"` on a later connection from
the same origin resumes the registered identity without a ceremony; once less
than half of its 12 hours remain, the resume renews it for another 12. The token
itself does not change. Sessions
are stored hashed in the object and swept on expiry. Signing out is local to
the client: it drops the stored token, and the connection returns as a fresh
guest.

Guest identities last for a socket, including hibernation. Repeated guest
authentication on that socket preserves the identity. Reconnecting creates a
new guest identity, so guest ownership and deduplication cannot span reconnects.
Registered identities remain stable after verified login. Successful mutations
with IDs are deduplicated per identity for 24 hours; clients must not retry
older operations indefinitely. Matching retries do not consume posting quota,
but do consume frame and lookup resources.

## Demo policy metadata

`server.params.ext.demo` describes retention and selected payload/posting policies,
and what the demo does not keep: `read_cursors: false` (read markers are
dropped), so clients can skip sending them. The ping interval is the standard
`server.params.ping`.
The demo's 16 KiB frame policy is an explicit exception to the base protocol's
advisory 256 KiB recommendation. Payload lengths count UTF-8 bytes. Errors use
the base protocol codes; `retry_after` includes `data.retry_after`, whole
seconds rounded up. Permanent identity/thread-room ceilings return `denied`, not a fabricated replenishment time.

Guest posting allowances are shared across a normalized IP; native IPv6
addresses share a /64 bucket. Registered users also share the aggregate IP
limit. NAT users can therefore limit one another. Passkeys do not provide
one-person-one-account or prevent Sybil attacks.
