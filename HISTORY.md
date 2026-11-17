# Protocol History

Summary of changes to [PROTOCOL.md](PROTOCOL.md) by protocol version (`server.apron`).

<!--
Prompt: how to keep this file.

Readers implement the protocol. Every change to the wire goes here, under the
current protocol version, in the same PR. Editorial changes, such as moved or
renumbered sections, don't. Judge by the diff of PROTOCOL.md, not by how a
commit names it: an editorial pass can change the wire.

Sort each version's entries into these subsections, in this order, and leave
out empty ones. An entry that fits more than one goes in the first that fits.
- `### Breaking`: implementations that worked together under the previous
  version stop working together until one of them changes, such as after a
  removed or renamed field, a changed meaning or error code, or a new MUST that
  the other side relies on. A change that touches only cases that already
  failed, or that conforming implementations already met, is not breaking.
- `### New`: an addition that implementations MAY ignore, such as a field,
  capability, scheme, or appendix.
- `### Changed`: a rule is different, and implementations of the previous
  version still interoperate, such as a new rule that the other side does not
  rely on, a loosened MUST, or a rule left to server policy.
- `### Clarified`: the wording now states what the rule already meant.
- `### Under consideration`: proposals that are not yet rules.

Each entry is one arc: related changes together, such as a reworked sign-in,
and unrelated changes apart. An entry has three parts:
- A bold headline of a few plain words that names the subject, ending with a
  colon inside the bold: **Sign-in speaks OAuth 2.1:**. Whoever made the change
  recognizes it from the headline alone; "Four rules, now in writing" fails.
- One or two sentences: who is affected (clients, servers, or both, and which
  ones), what they do differently, and why it matters. Leave the details to
  PROTOCOL.md.
- Links to the sections to read more, then to the PRs:
  `[§4.10.1](PROTOCOL.md#4101-passkey-page) ([#115](https://github.com/shazow/apron/pull/115))`.
  The current version links to PROTOCOL.md. An older version links to
  PROTOCOL.md at its tag, so that section numbers match:
  `https://github.com/shazow/apron/blob/protocol-v9/PROTOCOL.md#4115-external`.

Write as AGENTS.md says for PROTOCOL.md: short sentences, an explicit subject,
and the same word for the same thing. Put the most consequential entry first in
each subsection.

When a later PR in the same version extends an arc, update its entry. A feature
that is added and removed in the same version has no entry. A conflict with
another PR keeps both entries, merged if they are about the same arc.

To check or catch up a version, compare its entries with its diff, not with
commit messages, which can describe plans that changed: for v9,
`git diff protocol-v8 protocol-v9 -- PROTOCOL.md`, and for the current version,
`git diff protocol-v<previous> -- PROTOCOL.md`. Add what is missing, and fix
what is wrong.

A new version starts with the annotated tag `protocol-vN` on the last commit of
the previous version N, and that version's links move to the tag. The new
version gets a level-2 heading `vN (YYYY-MM-DD)` above the others, and
PROTOCOL.md's front matter (`version`, `updated`) matches it.
-->

## v10 (2026-11-16)

### Breaking

- **Sign-in speaks OAuth 2.1:** Clients and servers that use `external` move to its OAuth 2.1 profile, which replaces proposal-based sign-in, so that a server can hand sign-in to an existing authorization server with PKCE's protections. Servers that list `email` or `external` also list `token`, and refuse any scheme that they don't offer with `unsupported`. [§4.12](PROTOCOL.md#412-external-sign-in), [§3.2](PROTOCOL.md#32-authentication) ([#115](https://github.com/shazow/apron/pull/115), [#120](https://github.com/shazow/apron/pull/120))
- **Live text replaces `embed:stream`:** Clients and servers that use `embed:stream` move to `embed:append`, for text added to a message such as an LLM reply, or `embed:terminal`, for program output. Each kind keeps what fits its use when it ends: text merges into the message, and a terminal keeps its screen. [§4.8.5](PROTOCOL.md#485-embedappend), [§4.8.6](PROTOCOL.md#486-embedterminal) ([#101](https://github.com/shazow/apron/pull/101), [#103](https://github.com/shazow/apron/pull/103), [#104](https://github.com/shazow/apron/pull/104), [#106](https://github.com/shazow/apron/pull/106), [#108](https://github.com/shazow/apron/pull/108))
- **Edits merge, and empty messages bounce:** Clients that cleared a field by leaving it out of `room_set` send an empty value instead, since a missing field now keeps its value. Servers refuse a new message with no `text` and no `embeds`, so that every new message's result has `message_id`. [§4.2.4](PROTOCOL.md#424-creating-and-editing), [§3.5.1](PROTOCOL.md#351-creating) ([#101](https://github.com/shazow/apron/pull/101), [#120](https://github.com/shazow/apron/pull/120))

### New

- **Passkeys go anywhere:** Clients on any domain can use a server's passkeys through its passkey page, which the `webauthn` begin refers to. Before, only clients on the server's domain or a related one could. [§4.10.1](PROTOCOL.md#4101-passkey-page) ([#115](https://github.com/shazow/apron/pull/115))
- **Sign-in buttons, in the server's own words:** Servers can name each sign-in scheme for their users, such as "Acme SSO", in the `server` frame's `labels`. [§3.2](PROTOCOL.md#32-authentication) ([#115](https://github.com/shazow/apron/pull/115))
- **One mention for a whole role:** Clients can mention everyone in a room who has a role, with the prefix `@&`. [A.3](PROTOCOL.md#a3-prefixes-in-text) ([#101](https://github.com/shazow/apron/pull/101))

### Changed

- **Passkeys answer only to their own domain:** Clients check that a passkey ceremony's RP ID belongs to the server, so that a server cannot pass on another server's challenge and sign in there as the user. A server's own passkeys already pass. [§4.10](PROTOCOL.md#410-webauthn-authentication) ([#101](https://github.com/shazow/apron/pull/101))
- **Email links carry a return address:** Clients drop an email link unless its `server` is the server that they proposed to, so that one server cannot collect another server's token. Servers' links already carry `server`. [§4.11.2](PROTOCOL.md#4112-temporary-tokens) ([#115](https://github.com/shazow/apron/pull/115))
- **Embed writes open to every origin, and report back:** Servers accept a write's `PUT` from any origin, and answer it when the write finishes, so that web clients can write directly and learn whether the write worked. [§4.8.3](PROTOCOL.md#483-writes) ([#106](https://github.com/shazow/apron/pull/106))
- **Fewer rendering duties, firmer line breaks:** Clients no longer have to render both text formats. Clients that render CommonMark show a soft line break as a hard one, so that a typed newline looks the same everywhere. [§3.5.2](PROTOCOL.md#352-rendering) ([#101](https://github.com/shazow/apron/pull/101), [#120](https://github.com/shazow/apron/pull/120))
- **Guest upgrades are the server's call:** Servers decide whether signing in on a guest connection adds the scheme to the guest's account. [§3.2](PROTOCOL.md#32-authentication) ([#115](https://github.com/shazow/apron/pull/115))

### Clarified

- **Mutes and unread counts follow the server:** Servers may let mentions through a room mute, and decide how mutes change `unread`. [§4.5.3](PROTOCOL.md#453-the-status-request), [§4.9.3](PROTOCOL.md#493-payload) ([#112](https://github.com/shazow/apron/pull/112))
- **Version mismatches warn, and carry on:** Clients that see another protocol version warn, and continue. [§3.1](PROTOCOL.md#31-server-frame) ([#105](https://github.com/shazow/apron/pull/105))
- **Reactions keep their first order:** Servers keep reactions in the order in which they first appeared. [§4.7](PROTOCOL.md#47-reactions) ([#105](https://github.com/shazow/apron/pull/105))

## v9 (2026-10-27)

### Breaking

- **`history` without a room reads every room:** Clients that sent `history` without `room_id` to read the default room now pass its `room_id`, since the request now reads every room that the connection receives, as one log. Servers that don't support that reply `unsupported`. [§4.3](https://github.com/shazow/apron/blob/protocol-v9/PROTOCOL.md#43-history) ([#92](https://github.com/shazow/apron/pull/92), [#99](https://github.com/shazow/apron/pull/99))
- **Idle reports seconds, not `true`:** Clients send `idle` as the seconds since attention stopped instead of `true`, so that servers know when the connection went idle. [§4.5.3](https://github.com/shazow/apron/blob/protocol-v9/PROTOCOL.md#453-the-status-request) ([#78](https://github.com/shazow/apron/pull/78))

### New

- **Sign in through the server's own page:** Servers can offer scheme `external`, a page that signs users in by any method and returns a temporary token to the client's `return_url`, or shows a code to type. It shares proposals, `state`, and approval with `email`, and servers that offer either also offer `token`. [§4.11.5](https://github.com/shazow/apron/blob/protocol-v9/PROTOCOL.md#4115-external), [§4.11.1](https://github.com/shazow/apron/blob/protocol-v9/PROTOCOL.md#4111-proposals) ([#78](https://github.com/shazow/apron/pull/78))
- **Links that any client opens:** Clients can open `https://link.apron.chat/#…` and `apron:?…` links to a server, room, message, user, or invite, and approve a link's token with `scheme: "token"`. [A.4](https://github.com/shazow/apron/blob/protocol-v9/PROTOCOL.md#a4-links), [B.3](https://github.com/shazow/apron/blob/protocol-v9/PROTOCOL.md#b3-an-invite-token-signs-up-several-people) ([#91](https://github.com/shazow/apron/pull/91), [#93](https://github.com/shazow/apron/pull/93), [#94](https://github.com/shazow/apron/pull/94))
- **Servers introduce themselves:** Servers can send `title`, `description`, and `avatar` in the `server` frame, so that clients can tell servers apart. Clients still identify a server by its address, never by its title or avatar. [§3.1](https://github.com/shazow/apron/blob/protocol-v9/PROTOCOL.md#31-server-frame), [§1](https://github.com/shazow/apron/blob/protocol-v9/PROTOCOL.md#1-transport--framing) ([#100](https://github.com/shazow/apron/pull/100))
- **Last seen:** Servers can send `seen`, when a user's shown status last became `offline`. [§4.5.2](https://github.com/shazow/apron/blob/protocol-v9/PROTOCOL.md#452-delivery) ([#96](https://github.com/shazow/apron/pull/96))
- **Custom reactions:** A `reactions` entry may be a key for another kind of reaction, such as a custom emoji. Clients show a key that they don't support as a placeholder. [§4.7](https://github.com/shazow/apron/blob/protocol-v9/PROTOCOL.md#47-reactions) ([#100](https://github.com/shazow/apron/pull/100))
- **One member at a time:** `room_list` takes a `user_id` filter, which lists only that user in `members`. [§4.2.1](https://github.com/shazow/apron/blob/protocol-v9/PROTOCOL.md#421-listing) ([#91](https://github.com/shazow/apron/pull/91))

### Changed

- **Unoffered sign-in schemes fail:** Servers refuse a scheme that they don't offer, so that a client can try another. [§3.2](https://github.com/shazow/apron/blob/protocol-v9/PROTOCOL.md#32-authentication) ([#96](https://github.com/shazow/apron/pull/96))
- **Text can't hijack its direction:** Clients isolate the text direction of each user-written string, and ignore bidi embeddings and overrides in it, so that a name or message can't reorder the text around it. [§3.5.2](https://github.com/shazow/apron/blob/protocol-v9/PROTOCOL.md#352-rendering) ([#100](https://github.com/shazow/apron/pull/100))
- **IDs have firm edges:** Servers never send an empty ID, or one with whitespace or control characters. Clients read a mention as the longest run of the characters that A.3 lists, so `@ada@example.com` is one mention. [§2.4](https://github.com/shazow/apron/blob/protocol-v9/PROTOCOL.md#24-opaque-ids), [A.3](https://github.com/shazow/apron/blob/protocol-v9/PROTOCOL.md#a3-prefixes-in-text) ([#78](https://github.com/shazow/apron/pull/78))
- **Sign-in joins can skip `room_update`:** Servers list in `room_update` `joined` only the rooms joined after sign-in. [§4.2.3](https://github.com/shazow/apron/blob/protocol-v9/PROTOCOL.md#423-updates) ([#88](https://github.com/shazow/apron/pull/88), [#89](https://github.com/shazow/apron/pull/89))
- **Ties and recovery in the log:** At an equal `log_id`, a tombstone wins. Clients that recover without a checkpoint may start at the newest page. [§2.3](https://github.com/shazow/apron/blob/protocol-v9/PROTOCOL.md#23-records-and-replay), [§4.3.5](https://github.com/shazow/apron/blob/protocol-v9/PROTOCOL.md#435-replay-and-recovery) ([#78](https://github.com/shazow/apron/pull/78))

### Clarified

- **Status has three views:** Servers derive the shown status that others see from the user's chosen status and the presence of their connections. [§4.5.1](https://github.com/shazow/apron/blob/protocol-v9/PROTOCOL.md#451-values) ([#96](https://github.com/shazow/apron/pull/96))
- **`history` room records aren't deliveries:** Clients ignore delivery fields in room records from `history`, and a frame that omits a delivery field doesn't change it. [§4.3.3](https://github.com/shazow/apron/blob/protocol-v9/PROTOCOL.md#433-availability-and-retention) ([#88](https://github.com/shazow/apron/pull/88), [#89](https://github.com/shazow/apron/pull/89))

### Under consideration

- **ICE refresh by deadline:** `rtc_join` may carry `refresh_after` in place of `ice_expires`. [C.1.1](https://github.com/shazow/apron/blob/protocol-v9/PROTOCOL.md#c11-joining) ([#96](https://github.com/shazow/apron/pull/96))

## v8 (2026-10-06)

- Capability `status`: users choose `online`, `dnd`, or `invisible`, and others see `online`, `idle`, `offline`, or `dnd`. It replaces `activity` `away`.
- The `status` request reports idleness per connection and sets mutes, globally or per room.
- Push kind `webpush` (VAPID). Registrations carry a `push_id` and `wake` scopes, and the payload is at most 2048 bytes.
- `you` and listing `users` are complete user objects. `user` notifications carry what changed.
- `ext` moves into capability `ext` (§4.12), and extension names start with `ext:`.
- Notifications that a sign-in causes follow the `auth` result. A sign-in to an existing account is announced as a departure.
- General errors: unknown or hidden IDs are `invalid_params`, size limits `too_large`, and policy and count limits `denied` (§1.1).
- `markdown` means CommonMark.

Entries for v7 and earlier use the previous section numbers, as in [PROTOCOL.md at v7](https://github.com/shazow/apron/blob/protocol-v7/PROTOCOL.md).

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
