# Protocol History

Summary of changes to [PROTOCOL.md](PROTOCOL.md) by protocol version (`server.apron`), latest first. Each version sorts its changes by what implementers must do: Breaking, New, Changed, and Clarified. Each entry says briefly what changed on the wire and where, so that readers can decide what to read in PROTOCOL.md. Versions before v10 are not sorted yet.

<!--
Prompt: how to keep this file.

Readers implement the protocol. Every change to the wire goes here, under the
current protocol version, in the same PR. Editorial changes don't, including
moved or renumbered sections. Judge by the diff of PROTOCOL.md, not by how a
commit names it: an editorial pass can change the wire.

Each version sorts its entries into these subsections, in this order, by what
implementers must do. Leave out a subsection that has no entries.
- `### Breaking`: an implementation of the previous version can fail with one
  of this version until it changes, such as a removed or renamed field, a
  changed meaning or error code, or a new MUST that the other side relies on.
  Say which side changes, and how.
- `### New`: an addition that implementations MAY ignore, such as a field,
  capability, scheme, or appendix.
- `### Changed`: a rule is different, and implementations of the previous
  version still interoperate, such as a new rule that the other side does not
  rely on, a loosened MUST, or a rule left to server policy.
- `### Clarified`: the wording now states what the rule already meant. No
  conforming implementation changes.
- `### Under consideration`: proposals that are not yet rules.

Group related changes into arcs: one entry for a reworked sign-in or a new kind
of embed, not one entry per rule. An entry opens with a bold headline of a few
plain words that says what the arc means for implementers, ending with a colon
inside the bold, such as **Sign-in speaks OAuth 2.1:**. The sentences after it
state the rules. An arc that fits more than one subsection goes in the first
that fits. Put the most consequential arc first in each subsection.

When a later PR in the same version extends an arc, update its entry instead of
adding one. A feature that is added and removed in the same version has no
entry. A conflict here with another PR is resolved by keeping both entries,
merged into one if they are about the same arc.

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

### Breaking

- **Sign-in speaks OAuth 2.1:** Scheme `external` (§4.12) is a profile of OAuth 2.1, and replaces the proposal-based sign-in and `return_url`. Begin returns `external` with `url` and `issuer`. The client sends the user to `url` with PKCE and `resource`, and redeems the code on any connection. By default the server is its own authorization server and accepts any client, and a client with a client ID metadata document uses its URL as `client_id`. The server refuses unsafe `redirect_uri` values, and redirects only to clients that the user allowed. Servers that list `email` or `external` MUST also list `token`. Any scheme that the server does not offer is `unsupported`, not `invalid_params` (§3.2). ([#115](https://github.com/shazow/apron/pull/115), [#120](https://github.com/shazow/apron/pull/120))
- **Passkeys go anywhere, and answer only to their own domain:** A `webauthn` begin may carry `external`, a passkey page on the server's domain (§4.10.1). A client that cannot use the RP ID opens `external.url`, and finishes with the code that comes back. A server may send `external` alone, and clients MUST handle that begin. Clients MUST check that a ceremony's RP ID is the host of the server's address, or a domain above it (§4.10). (Otherwise a server could pass another server's challenge through the client, and sign in there as the user.) ([#101](https://github.com/shazow/apron/pull/101), [#115](https://github.com/shazow/apron/pull/115))
- **Email links carry a return address:** A client drops a link with the `state` of its own proposal unless the link's `server` is the server that it proposed to, and drops a link without `server` (§4.11.2). An email with a code gives the server's address. An approval may carry the proposal's `state`, so that a short code works on another connection, and the approval of an addition returns `you` (§4.11.3). (Otherwise a server could get another server's token.) ([#115](https://github.com/shazow/apron/pull/115))
- **Live text replaces `embed:stream`:** `embed:stream` is removed, with the embed fields `format` and `text`. Two capabilities take its place, on shared rules for writing with `PUT` to `write_url`, reading with `GET url`, limits, and disconnects. `embed:append` streams text onto the end of a message's body, such as an LLM reply, and the server merges it into `body.text` when it ends (§4.8.5). `embed:terminal` streams program output for an 80×40 terminal (§4.8.6). A live embed gets its `url` when its write starts, and a writer that disconnects ends the text. ([#101](https://github.com/shazow/apron/pull/101), [#103](https://github.com/shazow/apron/pull/103), [#104](https://github.com/shazow/apron/pull/104), [#106](https://github.com/shazow/apron/pull/106), [#108](https://github.com/shazow/apron/pull/108))
- **Edits merge, and empty messages bounce:** `room_set` with `room_id` merges (§4.2.4): a field that is present replaces the kept value, an empty value clears it, and an absent field stays. A client that cleared a field by leaving it out sends an empty value instead. A new message with no `text` and no `embeds` is `invalid_params` (§3.5.1), so its result always has `message_id`. A save that sends back an `embed_id` the message no longer has is `invalid_params` too (§4.8.2). ([#101](https://github.com/shazow/apron/pull/101), [#120](https://github.com/shazow/apron/pull/120))

### New

- **Sign-in buttons, in the server's own words:** The `server` frame may carry `labels`: a short plain-text noun for each sign-in scheme, such as `{"external": "Acme SSO"}` (§3.2). ([#115](https://github.com/shazow/apron/pull/115))
- **One mention for a whole role:** Appendix A.3 adds the prefix `@&`, which mentions everyone in the room with a role. ([#101](https://github.com/shazow/apron/pull/101))

### Changed

- **Writes open to every origin, and report back:** A write's `PUT` (§4.8.3) is allowed from any origin. The server answers it when the write finishes: an error status with a plain-text reason when it fails or reaches a limit, and 2xx otherwise. ([#106](https://github.com/shazow/apron/pull/106))
- **Fewer rendering duties, firmer line breaks:** Clients no longer have to render both text formats. Clients that render CommonMark MUST render a soft line break as a hard break, which was optional. The fallback card for an unknown embed kind shows its `title` and links to its `url` (§3.5.2). ([#101](https://github.com/shazow/apron/pull/101), [#120](https://github.com/shazow/apron/pull/120))
- **Guest upgrades are the server's call:** On a guest connection, whether signing in with another scheme adds it to the guest's account is server policy (§3.2). ([#115](https://github.com/shazow/apron/pull/115))

### Clarified

- **Four rules, now in writing:** Clients warn on a version mismatch and continue (§3.1). Reactions keep the order in which they first appeared (§4.7). A room `mute` may let mentions through (§4.5.3), and how mutes change `unread` is up to the server (§4.9.3). ([#105](https://github.com/shazow/apron/pull/105), [#112](https://github.com/shazow/apron/pull/112))

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
