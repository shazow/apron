# Public demo authentication and policy

The demo speaks Apron protocol **3**, advertising `history`, `edit`, `rooms`,
and `reactions`. History availability uses each room's `latest_log_id` and
nullable `history_log_id`, without extension negotiation. See
[history and recovery](../../../PROTOCOL.md#appendix-a--history) and the
[retention implementation specification](../SPEC.md#9-rolling-history-and-base-protocol-availability).

WebAuthn uses the canonical [optional authentication scheme](../../../PROTOCOL.md#appendix-i--webauthn-authentication-optional),
advertised through `auth: ["webauthn", "token", "guest"]` only on connections whose
origin is in `RP_ORIGINS`. Other connections advertise `auth: ["guest"]`
and reject WebAuthn requests. Guest user IDs begin with `guest_`. Server
announcements are complete replacements.

Production admits guest connections from any frontend origin, including opaque
origins and clients without Origin. This does not relax passkey verification,
IP attribution, quotas, or the fixed shared room. See the
[custom frontend example](../README.md#connecting-a-custom-frontend).

The implementation follows the current repository protocol. Local policy
within it:

- Rooms: every room is visible to every client. Only thread rooms under
  `general` may be created (top-level rooms and nested threads are `denied`);
  any participant may save a thread's `title`, `intro_message`, and `ext`, while
  `general` is fixed. Threads always carry a title (`Thread` by default).
  `room_join` re-sends a room's record; `room_leave` is `denied`.
- Messages: author-only edit, delete, restore, and move. `reply_to` and
  `intro_message` must name a retained message when set or changed; resubmitting
  an unchanged reference stays valid after its target expires, and expiration
  never invalidates an accepted snapshot. The server keeps references bare.
- Reactions: at most 8 distinct emoji (each at most 64 UTF-8 bytes, no control
  characters) per user per message and 32 reacting users per message. New
  reactions on a deleted message are rejected; clearing is allowed. An
  unchanged set is accepted without a new record.
- `me` renames registered users only; `name: ""` removes the name. `avatar`
  and `ext` are ignored.

## Authentication policy

An authenticated guest may begin registration while retaining guest rights.
A new credential creates a separate registered identity; it does not transfer
ownership of guest messages. A registered identity must reconnect before
switching identities.

The canonical begin/finish exchange, JSON credential encoding, and verification
rules are defined in protocol Appendix I. This demo limits challenges to 120
seconds and requires user presence and verification. A new begin replaces the
pending challenge without extending the initial 30-second authentication
deadline. A matching finish attempt consumes the challenge even on failure.
A verified login or registration returns a bearer `token` (protocol Appendix I,
session resume). Presenting it with `scheme: "token"` on a later connection from
the same origin resumes the registered identity without a ceremony and renews
the session for another 12 hours; the token itself does not change. Sessions
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

`server.params.ext.demo` describes retention and selected payload/posting policies.
The demo's 16 KiB frame policy is an explicit exception to the base protocol's
advisory 256 KiB recommendation. Payload lengths count UTF-8 bytes. Errors use
the base protocol codes; `retry_after` includes `data.retry_after`, whole
seconds rounded up. Permanent identity/thread-room ceilings return `denied`, not a fabricated replenishment time.

Guest posting allowances are shared across a normalized IP; native IPv6
addresses share a /64 bucket. Registered users also share the aggregate IP
limit. NAT users can therefore limit one another. Passkeys do not provide
one-person-one-account or prevent Sybil attacks.
