# Protocol History

Summary of changes to [PROTOCOL.md](PROTOCOL.md) by protocol version (`server.apron`), latest first.

## v8 (2026-10-06)

- A `user` notification carries `old` only when the same account takes a new `user_id`, such as a guest becoming a new account. Signing in to an existing account is announced as the previous identity's departure.
- Capability `status`: users set `status` with `me`: `online` (the default), `""` (none), and optionally `dnd` or `invisible`, which `server.status` lists when accepted. Others see `online` as `online` (attended), `idle` (connected, none attended), or `offline` (no connections), `dnd` as `dnd` only while the user is connected, and `invisible` as `offline`. Clients take their own status from `you`. A sign-in is an `auth` that signs the connection in as a user it isn't already signed in as, not one that adds a passkey or address. A change is a `user` notification. After a sign-in, servers send, after the `auth` result, the status others see of each user who shares a room, other than `offline` and `""`; clients drop kept statuses at each sign-in. Current user objects in `room_list` and `room_update` carry `status`, `offline` and `""` included. A user without a status has no known status, and unknown values show as unknown.
- The `status` request carries `idle` for the sending connection and the user's private `mute` (`true`, `false`, or seconds), everywhere or, with `room_id`, in one room and its threads. Its result is `{}`, and on an error nothing changes. Clients don't send it before sign-in. A connection starts attended. Servers send each mute change to all the user's connections, and the mutes in effect after the result of a sign-in, as `status` notifications. `room_id` scopes only `mute`. `dnd` silences like `mute`. Replaces `activity` `away`.
- A method is a request when its sender needs the reply (data, a confirmation, or an error), and a notification when it only reports transient state. §1.1 lists which methods clients send with an `id` and which without.
- Push kind `webpush` (Web Push with a VAPID `key`) is defined. A `relay` registration may carry `keys` so the relay forwards only ciphertext. Pushes carry `TTL` and `Urgency` headers. A server with `push` should advertise `status`.
- A registration belongs to its user and `url`, and carries an optional client-chosen `push_id` that every payload repeats; clients keep one notification per `push_id` and `message_id`. Servers may refuse a registration with `denied`, and an endpoint they won't send to is `invalid_params`. Unregistering an unknown `url` succeeds, and clients should unregister before signing out. Servers may expire registrations that clients don't renew or that exceed a per-user limit, and remove any registration whose `url` won't accept pushes, such as on 404 or 410.
- `server.push.wake` advertises wake scopes (`mentions`, `private`, `replies`, `joined`, `badge`), and a registration's `wake` picks among them; the default is `mentions` and `replies`. `wake` is not a push kind. Servers don't wake a user for their own messages, and send what `mute` or `dnd` silences only as `badge` pushes without `message`.
- The payload is an object of at most 2048 bytes with `push_id`, an optional `unread` count and the `message`, replacing the bare message object. Servers may truncate `body.text` and drop any `message` field but `message_id`, `room_id`, and `from.user_id` to fit. `badge` pushes count changes without `message`.
- `you` in `auth` and `me` results and the `users` of listings are complete user objects, and clients replace their kept object with them. A `user` notification carries `user_id` and at least the changed fields, with cleared ones as empty values. General rules in §1.1 replace per-section ones: an ID the user can't see is `invalid_params`, a rejected value is `invalid_params` or `too_large`, what policy forbids is `denied`, and servers may normalize what clients send. `markdown` means CommonMark.
- Writes merge `ext` one level deep (`me`, message saves, `room_set`): each key replaces the kept value, an empty value clears it, keys left out stay, and `"ext": {}` changes nothing. `null` is an ordinary value. Clients need not send `ext` back on saves. A tombstone carries no `ext`.
- Every notification a sign-in causes on its connection follows the `auth` result. At a sign-in, clients drop kept statuses and mutes and apply the ones that arrive. `mute` seconds are a positive integer, and `room_id` without `mute` is `invalid_params`.
- Every name an extension adds (methods, capabilities, auth schemes, push kinds, wake scopes, embed kinds) starts with `ext:`, which this document never uses. An extension named `ext:foo` keeps its data under `ext.foo`.
- Capability sections in §4 are ordered by how commonly they are implemented, which renumbers them: `command` 4.1, `history` 4.2, `rooms` 4.3, `edit` 4.4, `status` 4.5, `activity` 4.6, `reactions` 4.7, embeds and avatars 4.8, push 4.9, WebAuthn 4.10, email 4.11. The posting rules of `rooms` move into §4.3.2, and the definition of a sign-in into §3.2.

Entries for v7 and earlier use the previous section numbers, as in [PROTOCOL.md at v7](https://github.com/shazow/apron/blob/d44564a1e4da7087321ff566fa0d5624c9718566/PROTOCOL.md).

## v7 (2026-09-29)

- Rooms carry a Markdown `description`, edited with `room_set`, replacing `intro_message`; threads no longer point to a message.
- Private rooms (`private: true`) are visible only to their members, and new threads inherit it; `room_join` and `room_leave` may take a `user_id` to add or remove others.
- Optional `member_count` when a server truncates `members`.
- Membership records arrive in `room_update` `memberships`, replacing the `membership` notification. The `history` key is renamed `memberships`.
- Email sign-in scheme (`email`): a request with `email` proposes a sign-in or an addition, and one with `token` approves it. Any `auth` result may carry a rotated bearer `token`.
- `server.signup` lists the schemes that create accounts.
- A passkey registration's `name` labels the passkey (`user.name` and `user.displayName`).
- `server.welcome` for sign-in instructions.
- User objects may carry server-defined `roles`. An empty value (`""`, `[]`, `{}`) clears a field and is kept, so it never falls back to a recorded `from`.
- System identities use `~` (`~server`, `~room`, `~private`); text prefixes are `@user`, `#room`, `~system`.
- `server.protocol` is renamed `apron`, `server.caps` is renamed `capabilities`, and `server.name` and `auth.client` are renamed `agent`.
- Upload and stream writes use HTTP `PUT`.
- Server fields are read-only; a deduplicated retry's result reflects the current state.
- Sections open with TypeScript-like type blocks; `Embed` is defined.
- Under consideration: WebRTC sessions on rooms with per-device seats, and an `actions` embed.

## v6 (2026-09-26)

- Joins and leaves are logged `membership` records instead of `user` notifications.
- `user` notifications carry only identity changes.
- `auth` is a barrier: requests sent behind it run after it succeeds.
- `from` is a recorded display fallback; only current user objects (`you`, `new`, `members`, `users`) update the kept profile.
- `room_list` takes `filter` (`joined` / `not_joined` / `all`), returns `joined` and `not_joined` arrays, members only with `members: true`, and `left` rooms when `latest_log_id` is given.
- Thread messages go only to thread members; parent room members get thread room changes via `room_update`.
- `history` returns `messages` with `first_log_id`/`last_log_id` (renamed from `entries`, `first_id`/`last_id`).
- `@server`, `@room`, `@private` are scope identities, not rooms.
- Notifications a request causes precede its result.
- Server notices may be sent before auth; added a valid scenarios appendix.

## v5 (2026-09-25)

- Rooms are no longer announced: `room_list` by request, `room_update` for joined/left/updated, `room_set` to create and edit.
- Core no longer requires rooms: message `room_id` is optional and defaults to the server's default room.
- Ping liveness via `server.ping`.
- `auth` accepts a requested `user_id`.
- Mentions listed explicitly in `body.mentions`.
- User objects merge field by field; an older `from` doesn't overwrite a newer profile.
- `activity` gains optional `away`.
- New `command` cap for server-specific slash commands (with `/help`).
- Scoped system notices from `@server`, `@room`, `@private`.
- Capabilities restructured as numbered sections (§4.x); appendices are informative.
- Multiplexing moved to Under consideration.

## v4 (2026-09-23)

- `protocol` increments with each spec revision; best-effort interoperability with fallbacks.
- Unknown caps ignored; third-party caps use an `ext:` prefix.
- `user` notification (`you` / `new` / `old`) replaces `you`; `room_list` added (cap `rooms`).
- Servers SHOULD (not MUST) announce rooms after auth.
- Optional `prev_log_id` links records to their predecessor.
- `activity` cap replaces typing, with read markers (`read_message_id`).
- `me` replaces `name` for profile updates.
- Embeds get `embed_id`; new `embed:upload` and `embed:stream` caps; OpenGraph `og` describes embeds.
- Push kinds via `server.push`; payload is a message object.
- Errors not tied to a request omit `id`; rate limits use `retry_after` in seconds.

## v3 (2026-09-22)

- Rooms are the only scope: threads are rooms with `parent_room_id` (thread method and `thread_id` removed).
- Server-wide log sequence; `log_id` is the commit timestamp; `message_id` globally unique.
- Self-describing message objects (no `params.message` wrapper); `reply_to` and `intro_message` are message objects.
- `room` is bidirectional and replaces `room_create`; `title`/`intro_message` replace `name`/`topic`.
- Room state is logged; new `reactions` cap.
- Redaction via tombstones; compacted retention instead of discarding history.
- No request-order guarantee; transport-neutral framing (WebSocket or NDJSON).
- Opaque `ext` field replaces retained unknown keys.
- Auth scheme `anonymous` renamed `guest`.
- Spec restructured into mandatory core plus capabilities; "Level 0" replaced by core / minimal server.

## v2 (2026-09-19)

- Initial published spec.
- Single envelope form (JSON-RPC 2.0 shapes without `jsonrpc`).
- `auth` accepts a requested display name; `nick` renamed `name`.
- Removed `echo` field from message broadcasts.
- Optional passkey session resume via `token`.
