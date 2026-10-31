# Protocol History

Summary of changes to [PROTOCOL.md](PROTOCOL.md) by protocol version (`server.apron`), latest first.

## v10 (2026-10-30)

- `embed:stream` is removed, with the embed fields `format` and `text`. Capabilities `embed:append` and `embed:terminal` replace it.
- Live text (§4.8.3): rules that both new kinds share for writing with `PUT` to `write_url` and reading `GET url`, limits, disconnects, how `url` is served, and UTF-8 decoding.
- `embed:append` (§4.8.5): text streamed onto the end of a message's body, such as an LLM reply. The server merges it into `body.text` when it ends.
- `embed:terminal` (§4.8.6): live program output for an 80×40 terminal, kept as `output` when it ends.
- A save that sends back an `embed_id` the message no longer has is `invalid_params` (§4.8.2).
- The fallback card for an unknown embed kind shows its `title` and a link to its `url` (§3.5.2).
- Appendix A.3 adds the prefix `@&` to mention everyone in the room with a role.
- Avatars move from §4.8.6 to §4.8.7.

## v9 (2026-10-27)

- A server's address is the URI that clients connect to (§1). Clients should identify a server by its address, compared after RFC 3986 normalization, and never by its `title` or `avatar`.
- The `server` frame may carry `title`, `description`, and `avatar` (§3.1), so that clients can show which server is which, such as in a list of servers. `avatar` follows the rules for user avatars (§4.8.6), which now suggest a square image at least 256 pixels wide. `description` says what the server is about, and `welcome` stays for the sign-in screen. Clients show the server's address with `title` where the user signs in or picks a server.
- A `reactions` entry is one emoji sequence (UTS #51), such as a ZWJ sequence or a skin tone, and any other entry is a key for another kind of reaction, such as a custom emoji, as server policy allows. Clients show a key they do not support as a placeholder, with the key as its hover text. Entries that differ only in U+FE0F are the same entry, and servers should store emoji sequences fully qualified.
- Clients isolate the text direction of each user-written string, such as a name, a title, or a message, from the text around it, and ignore the bidirectional embeddings and overrides U+202A to U+202E in it (§3.5.2).
- `history` without `room_id` queries every room the connection receives as one log, instead of the default room, with the server's effective lower bound. Servers should support it, or reply `unsupported`.
- A user's status has three views (§4.5.1): the chosen status, set with `me` and carried in `you`; the presence, the server's view of the user's connections (`online`, `idle`, or `offline`); and the shown status, which the server derives from the two and which is all that others see.
- User objects may carry `seen`, the time when the shown status last became `offline`, in the format of a `log_id`. It changes only when the shown status changes to `offline`, so it never shows when a user with a chosen `invisible` connects or disconnects. A user object carries `seen` only with a shown `offline`, so `you` never carries it. A server that sends `seen` includes it in each complete user object with a shown `offline`, such as in `room_list` `users`, and in each `user` notification that changes the shown status to `offline`. Other timestamps use the format of a `log_id` (§2.1).
- A scheme that the server does not offer fails, so a client can try another: `unsupported` for a scheme that PROTOCOL.md defines, and `invalid_params` for any other. Which credentials an offered scheme accepts is server policy, such as any token under a guest-access policy that offers `token`.
- Under consideration: `rtc_join` may carry `refresh_after`, the seconds after which the client refreshes `ice` or `transport`, in place of `ice_expires`.
- Scheme `external` (§4.11): a proposal returns `url`, a page of the server that signs the user in by any method. The page redirects to the client's `return_url` with a temporary token in the fragment, or shows a code to type. Servers accept only a `return_url` on an origin they trust.
- `email` and `external` share §4.11, "Email and external sign-in". A proposal may carry `state`, which links return. Approval takes either scheme, and an addition approves only on a connection of the proposing account. A disconnect keeps a proposal, and temporary tokens expire within minutes of delivery. Servers that offer either scheme also offer `token`.
- Appendix A.4 defines links that any client opens, as a convention: the `https://link.apron.chat/#` and `apron:?` forms, with the keys `server` (a URI of any transport), `room` (also of a thread), `message`, `user`, `token` and `state`. Links are serialized as `application/x-www-form-urlencoded`, and clients use the first value of a repeated key. Clients only connect to `server`, and never open it as a web page or in another app. Only servers write links with `token`, never as `apron:`, and a sign-in link always carries `server`. A link without `server` in a server's content refers to that server. Interactive clients ask before they connect to a server the user has not used, and never send or join because of a link.
- Approval also takes `scheme: "token"`, which a client uses for the token of a link without the `state` of its own proposal, as for an invite (Appendix B.3).
- `room_list` takes an optional `user_id` filter, which lists only that user in `members` and `users`.
- At an equal `log_id`, a tombstone wins. Recovery without a checkpoint may start at the newest page.
- `idle` is `false`, or the seconds since nobody attended the connection, so servers can treat the connection as idle from then.
- §4.2 is now `rooms` and §4.3 `history`, which renumbers both. Room records are defined in §4.2, and extension names in the §4 intro.
- §1.1 lists the core request and notification methods, and the §4 intro the rest.
- `room_update` `joined` lists the rooms that the user joined after signing in, so a join at sign-in need not be in it.
- A `room_id` or `user_id` is never empty, and contains no whitespace or control characters. A mention in text (Appendix A.3) is the longest run of `[A-Za-z0-9_.+@:-]` that starts and ends with a letter, a digit, or `_`, so `@ada@example.com` and `@carol:b.example` are mentions. A suggested convention keeps ordinary and user-chosen IDs to letters, digits, `_`, `.`, and `-`.

## v8 (2026-10-06)

- Capability `status`: users set `status` with `me` (`online`, `""`, and optionally `dnd` or `invisible`, listed in `server.status`); others see `online`, `idle`, `offline`, or `dnd`. Replaces `activity` `away`.
- The `status` request reports `idle` per connection and sets the user's private `mute` (`true`, `false`, or seconds), globally or per room. Servers echo mutes to all the user's connections.
- Push kind `webpush` (VAPID); `relay` may carry `keys` for ciphertext. Registrations carry a `push_id` and `wake` scopes (`mentions`, `private`, `replies`, `joined`, `badge`). The payload is `{push_id, unread, message}` of at most 2048 bytes, with `TTL` and `Urgency` headers.
- `you` in `auth` and `me` results and listing `users` are complete and replace the kept object; `user` notifications carry what changed.
- `ext` moves out of the core into capability `ext` (§4.12): servers keep the `ext` clients write on users, messages, and rooms, and writes merge it one level deep. Clients need not send `ext` back.
- Extension names start with `ext:`; an extension `ext:foo` keeps its data under `ext.foo`.
- Every notification a sign-in causes follows the `auth` result, and clients drop kept statuses and mutes at each sign-in. A sign-in to an existing account is announced as a departure; `old` is only for a new `user_id` on the same account.
- §1.1 lists request and notification methods, and gathers general errors: unknown or hidden IDs and rejected values are `invalid_params`, size limits `too_large`, policy and count limits `denied`.
- `markdown` means CommonMark.
- §4 is reordered by how commonly each capability is implemented, which renumbers it.

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
