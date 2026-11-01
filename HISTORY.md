# Protocol History

Summary of changes to [PROTOCOL.md](PROTOCOL.md) by protocol version (`server.apron`), latest first. Each point says briefly what changed on the wire and where, so that readers can decide what to read in PROTOCOL.md.

## v10 (2026-10-30)

- `embed:stream` is removed, with the embed fields `format` and `text`. Capabilities `embed:append` and `embed:terminal` replace it.
- Live text (§4.8.5): rules that both new kinds share for writing with `PUT` to `write_url` and reading `GET url`, limits, disconnects, how `url` is served, and UTF-8 decoding.
- `embed:append` (§4.8.5): text streamed onto the end of a message's body, such as an LLM reply, which backspace and form feed can revise. The server merges it into `body.text` when it ends, and a sender that edits in place, such as a composer, ends it with a save of its text.
- `embed:terminal` (§4.8.6): live program output for an 80×40 terminal, kept as `output` when it ends.
- A save that sends back an `embed_id` the message no longer has is `invalid_params` (§4.8.2).
- The fallback card for an unknown embed kind shows its `title` and a link to its `url` (§3.5.2).
- Clients check that a passkey ceremony's RP ID is the host of the server's address, or a domain above it (§4.10).
- Appendix A.3 adds the prefix `@&` to mention everyone in the room with a role.

## v9 (2026-10-27)

- A server is identified by its address, the URI that clients connect to (§1), never by its `title` or `avatar`.
- The `server` frame may carry `title`, `description`, and `avatar` (§3.1).
- A `reactions` entry is an emoji sequence (UTS #51) or a key for another kind of reaction, such as a custom emoji.
- Clients isolate the text direction of each user-written string (§3.5.2).
- `history` without `room_id` queries every room that the connection receives.
- A user's status has three views: chosen, presence, and shown (§4.5.1).
- User objects may carry `seen`, when the shown status last became `offline`.
- A scheme that the server does not offer fails, so that a client can try another.
- Scheme `external` (§4.11) signs users in through a page of the server. It shares §4.11 with `email`, and proposals may carry `state`.
- Appendix A.4 defines links that any client opens: `https://link.apron.chat/#` and `apron:?`.
- Approval takes `scheme: "token"` for the token of a link, such as an invite (Appendix B.3).
- `room_list` takes a `user_id` filter.
- At an equal `log_id`, a tombstone wins. Recovery without a checkpoint may start at the newest page.
- `idle` is `false`, or the seconds since nobody attended the connection.
- `room_update` `joined` lists only the rooms joined after sign-in.
- IDs are never empty and contain no whitespace or control characters. Appendix A.3 defines which characters a mention's ID takes.
- Under consideration: `rtc_join` may carry `refresh_after` in place of `ice_expires`.

## v8 (2026-10-06)

- Capability `status`: users choose `online`, `dnd`, or `invisible`, and others see `online`, `idle`, `offline`, or `dnd`. It replaces `activity` `away`.
- The `status` request reports idleness per connection and sets mutes, globally or per room.
- Push kind `webpush` (VAPID). Registrations carry a `push_id` and `wake` scopes, and the payload is at most 2048 bytes.
- `you` and listing `users` are complete user objects. `user` notifications carry what changed.
- `ext` moves into capability `ext` (§4.12), and extension names start with `ext:`.
- Notifications that a sign-in causes follow the `auth` result. A sign-in to an existing account is announced as a departure.
- General errors: unknown or hidden IDs are `invalid_params`, size limits `too_large`, and policy and count limits `denied` (§1.1).
- `markdown` means CommonMark.

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
