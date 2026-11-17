# Protocol History

Summary of changes to [PROTOCOL.md](PROTOCOL.md) by protocol version (`server.apron`), latest first. Each point starts with what implementers must do (Breaking, New, Changed, or Clarified), then says briefly what changed on the wire and where, so that readers can decide what to read in PROTOCOL.md. Entries before v10 have no labels.

<!--
Prompt: how to keep this file.

Readers implement the protocol. Every change to the wire goes here, under the
current protocol version, in the same PR. Editorial changes don't, including
moved or renumbered sections. Judge by the diff of PROTOCOL.md, not by how a
commit names it: an editorial pass can change the wire.

Each entry starts with the label of what implementers must do:
- "Breaking:" an implementation of the previous version can fail with one of
  this version until it changes, such as a removed or renamed field, a changed
  meaning or error code, or a new MUST that the other side relies on. Say which
  side changes, and how.
- "New:" an addition that implementations MAY ignore, such as a field,
  capability, scheme, or appendix.
- "Changed:" a rule is different, and implementations of the previous version
  still interoperate, such as a new rule that the other side does not rely on,
  a loosened MUST, or a rule left to server policy.
- "Clarified:" the wording now states what the rule already meant. No
  conforming implementation changes.
- "Under consideration:" a proposal that is not yet a rule.

If a change fits more than one label, use the first that fits, in the order
above. Order a version's entries by label in the same order, with the most
consequential first under each label.

Give each feature one entry. When a later PR in the same version changes the
feature, update its entry instead of adding one. A feature that is added and
removed in the same version has no entry. A conflict here with another PR is
resolved by keeping both entries, merged into one if they are about the same
feature.

Say what changed on the wire and where (§x.y), briefly: enough for a reader to
decide whether to read the change in PROTOCOL.md. Lead with what a change lets
implementations do, or what it guards against, when that is not obvious from
the rule. A reason MAY end the entry in a short parenthesis, as in §5. Write as
AGENTS.md says for PROTOCOL.md: short sentences, an explicit subject, and the
same word for the same thing. End each entry with links to its PRs, such as
([#115](https://github.com/shazow/apron/pull/115)).

To check or catch up a version, compare its entries with
`git diff <last commit of the previous version> HEAD -- PROTOCOL.md`. Commit
messages can describe plans that changed, so read the diff. Add what is
missing, and fix what is wrong.

A new version starts a heading above the others, in the form `vN (YYYY-MM-DD)`
as a level-2 heading, and PROTOCOL.md's front matter (`version`, `updated`)
matches it.
-->

## v10 (2026-11-16)

- Breaking: Scheme `external` (§4.12) is a profile of OAuth 2.1, and replaces the proposal-based sign-in and `return_url`. Begin returns `external` (`url`, `issuer`). The client sends the user to `url` with PKCE and `resource`, and redeems the code on any connection. By default the server is its own authorization server, and accepts any client; `issuer` refers to another one, which an extension can add, such as `ext:oauth`. A client whose client ID metadata document lists its `redirect_uri` uses the document's URL as `client_id`. A failed redemption may use up the code. The server refuses a `redirect_uri` that is not `https`, a scheme with a `.`, or loopback `http`. Its sign-in page shows request errors itself, redirects only with a code or `access_denied`, and only to a client that the user allowed: an `https` `redirect_uri` once per account, any other at each sign-in. ([#115](https://github.com/shazow/apron/pull/115))
- Breaking: A `webauthn` begin may carry `external`, a passkey page on the server's domain (§4.10.1), so that clients on any domain can use the server's passkeys. A client that cannot use the RP ID, or whose platform refuses it, opens `external.url` and finishes `webauthn` with the code that comes back. A server may send `external` alone, without `challenge_id` and `public_key`, such as to a connection whose origin cannot use the RP ID; clients MUST handle that begin. A token from a code works from any `Origin`. ([#115](https://github.com/shazow/apron/pull/115))
- Breaking: `embed:stream` is removed, with the embed fields `format` and `text`. Capabilities `embed:append` and `embed:terminal` replace it. ([#101](https://github.com/shazow/apron/pull/101))
- Breaking: Clients MUST check that a passkey ceremony's RP ID is the host of the server's address, or a domain above it (§4.10). A server whose RP ID is elsewhere cannot use passkeys with these clients. (Otherwise a server could pass another server's challenge through the client, and sign in there as the user.) ([#101](https://github.com/shazow/apron/pull/101))
- Breaking: A client drops an email link with the `state` of its own proposal unless the link's `server` is the server that it proposed to, and drops a link without `server` (§4.11.2). Servers put `server` in their links, and an email with a code gives the server's address. (Otherwise a server could get another server's token.) ([#115](https://github.com/shazow/apron/pull/115))
- Breaking: Servers that list `email` or `external` MUST also list `token` (§4.11, §4.12). ([#115](https://github.com/shazow/apron/pull/115))
- Breaking: Any auth scheme that the server does not offer is `unsupported` (§3.2), also one that PROTOCOL.md does not define. It was `invalid_params`. ([#120](https://github.com/shazow/apron/pull/120))
- Breaking: `room_set` with `room_id` merges (§4.2.4): a field that is present replaces the kept value, an empty value clears it, and an absent field stays. An edit used to clear every field that it left out, so clients that cleared a field by leaving it out send an empty value instead. ([#120](https://github.com/shazow/apron/pull/120))
- Breaking: A new message with no `text` and no `embeds` is `invalid_params` (§3.5.1). Its result was `{}`, so the result of a new message now always has `message_id`. ([#120](https://github.com/shazow/apron/pull/120))
- New: `embed:append` (§4.8.5): text streamed onto the end of a message's body, such as an LLM reply, which backspace and form feed can revise. The server merges it into `body.text` when it ends, and a sender that edits in place, such as a composer, should end it with a save of its text. ([#101](https://github.com/shazow/apron/pull/101), [#103](https://github.com/shazow/apron/pull/103), [#104](https://github.com/shazow/apron/pull/104))
- New: `embed:terminal` (§4.8.6): live program output for an 80×40 terminal, kept as `output` when it ends. ([#101](https://github.com/shazow/apron/pull/101))
- New: Live text (§4.8.5): rules that `embed:append` and `embed:terminal` share for writing with `PUT` to `write_url` and reading `GET url`, limits, disconnects, how `url` is served, a redirect for browsers to a page that shows the text, and UTF-8 decoding. A live embed has no `url` until its write starts, when a snapshot adds it. A writer that disconnects ends the text. ([#101](https://github.com/shazow/apron/pull/101), [#106](https://github.com/shazow/apron/pull/106), [#108](https://github.com/shazow/apron/pull/108))
- New: The `server` frame may carry `labels`: a short plain-text noun for each sign-in scheme, such as `{"external": "Acme SSO"}`, that fits on one button (§3.2). ([#115](https://github.com/shazow/apron/pull/115))
- New: Appendix A.3 adds the prefix `@&` to mention everyone in the room with a role. ([#101](https://github.com/shazow/apron/pull/101))
- Changed: An email approval may carry the proposal's `state`, so that a short code works on a connection other than the one that proposed (§4.11.3). The approval of an addition returns `you`, not `{}`. ([#115](https://github.com/shazow/apron/pull/115))
- Changed: A write's `PUT` (§4.8.3) is allowed from any origin. The server answers it when the write finishes: an error status with a plain-text reason when it fails or reaches a limit, and 2xx otherwise. ([#106](https://github.com/shazow/apron/pull/106))
- Changed: Clients that render CommonMark MUST render a soft line break as a hard break (§3.5.2), so a newline that the sender types shows as one. It was optional. ([#120](https://github.com/shazow/apron/pull/120))
- Changed: Clients no longer have to render both text formats (§3.5.2). ([#120](https://github.com/shazow/apron/pull/120))
- Changed: A save that sends back an `embed_id` the message no longer has is `invalid_params` (§4.8.2). ([#101](https://github.com/shazow/apron/pull/101))
- Changed: The fallback card for an unknown embed kind shows its `title` and a link to its `url` (§3.5.2). ([#101](https://github.com/shazow/apron/pull/101))
- Changed: On a guest connection, whether signing in with another scheme adds it to the guest's account is server policy (§3.2). ([#115](https://github.com/shazow/apron/pull/115))
- Clarified: clients warn on a version mismatch and continue (§3.1), reactions keep the order in which they first appeared (§4.7), a room `mute` may let mentions through (§4.5.3), and how mutes change `unread` is up to the server (§4.9.3). ([#105](https://github.com/shazow/apron/pull/105), [#112](https://github.com/shazow/apron/pull/112))

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
