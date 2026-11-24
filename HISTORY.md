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
- `### Breaking`: an implementation of the previous version, left unchanged,
  now fails against one of this version: a request it sends is refused, a field
  it reads is gone or means something else, or it loses data. Not breaking: a
  new rule that the other side may adopt or not, an old form that is still
  accepted, a case that already failed, or a change after which an old
  implementation only misses something new or works less well, such as getting
  more pushes.
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

- **Sign-in speaks OAuth 2.1:** Clients and servers that use `external` move to its OAuth 2.1 profile, which replaces proposal-based sign-in, so that a server can hand sign-in to an existing authorization server with PKCE's protections. Servers refuse any scheme that they don't offer with `unsupported`, even one that this document doesn't define. [§4.12](PROTOCOL.md#412-external-sign-in), [§3.2](PROTOCOL.md#32-authentication) ([#115](https://github.com/shazow/apron/pull/115), [#120](https://github.com/shazow/apron/pull/120))
- **`room_set` merges, and empty messages bounce:** Clients that cleared a room field by leaving it out of `room_set` send an empty value instead, since a missing field now keeps its value. Servers refuse a new message with no `text` and no `embeds` with `invalid_params`, so that every new message's result has `message_id`. [§4.2.4](PROTOCOL.md#424-creating-and-editing), [§3.5.1](PROTOCOL.md#351-creating) ([#120](https://github.com/shazow/apron/pull/120))
- **Passkey options carry their RP ID:** Servers put the RP ID in `public_key`, since clients no longer fall back to their own domain. WebAuthn libraries already include it. [§4.10](PROTOCOL.md#410-webauthn-authentication) ([#130](https://github.com/shazow/apron/pull/130))

### New

- **Passkeys go anywhere:** Clients on any domain can use a server's passkeys through its passkey page, which the `webauthn` begin refers to. Before, only clients on the server's domain or a related one could. [§4.10.1](PROTOCOL.md#4101-passkey-page) ([#115](https://github.com/shazow/apron/pull/115))
- **Sign-in buttons, in the server's own words:** Servers can name each sign-in scheme for their users, such as "Acme SSO", in the `server` frame's `labels`. [§3.2](PROTOCOL.md#32-authentication) ([#115](https://github.com/shazow/apron/pull/115))
- **One mention for a whole role:** Clients can mention everyone in a room who has a role, with the prefix `@&`. [A.3](PROTOCOL.md#a3-prefixes-in-text) ([#101](https://github.com/shazow/apron/pull/101))
- **Extension data at sign-in:** Clients can send `ext` in `auth`, for extensions that sign in. Servers without such an extension ignore it. [§3.2](PROTOCOL.md#32-authentication) ([#115](https://github.com/shazow/apron/pull/115))

### Changed

- **Live text replaces `embed:stream`:** `embed:stream` gives way to `embed:append`, for text added to a message such as an LLM reply, and `embed:terminal`, for program output. Peers without them fall back to the finished text, and each kind keeps what fits its use when it ends. [§4.8.5](PROTOCOL.md#485-embedappend), [§4.8.6](PROTOCOL.md#486-embedterminal) ([#101](https://github.com/shazow/apron/pull/101), [#103](https://github.com/shazow/apron/pull/103), [#104](https://github.com/shazow/apron/pull/104), [#106](https://github.com/shazow/apron/pull/106), [#108](https://github.com/shazow/apron/pull/108))
- **Passkeys answer only to their own domain:** Clients check that a passkey ceremony's RP ID belongs to the server and is not a public suffix, so that a server cannot pass on another server's challenge and sign in there as the user. A server's own passkeys already pass. [§4.10](PROTOCOL.md#410-webauthn-authentication), [§5.2](PROTOCOL.md#52-authentication) ([#101](https://github.com/shazow/apron/pull/101), [#130](https://github.com/shazow/apron/pull/130))
- **Passkeys on a shared RP ID stay apart:** Servers give each account a random user handle, so that a registration on another server cannot replace the user's passkey, and use `name` only for `user.displayName`. Clients remove `prf` and `largeBlob`, whose outputs can be secrets of the user's other apps. [§4.10](PROTOCOL.md#410-webauthn-authentication), [§5.2](PROTOCOL.md#52-authentication) ([#130](https://github.com/shazow/apron/pull/130))
- **Email codes and links name their server:** Clients drop a link that carries their own proposal's `state` unless its `server` is the server that they proposed to, and an email with a code gives the server's address, so that one server can't collect another server's token. A short code also works on another connection that sends the proposal's `state`, and approving an addition returns `you`. [§4.11.2](PROTOCOL.md#4112-temporary-tokens), [§4.11.3](PROTOCOL.md#4113-approval) ([#115](https://github.com/shazow/apron/pull/115))
- **Embed writes open to every origin, and report back:** Servers accept a write's `PUT` from any origin, and answer it when the write finishes, so that web clients can write directly and learn whether the write worked. [§4.8.3](PROTOCOL.md#483-writes) ([#106](https://github.com/shazow/apron/pull/106))
- **Fewer rendering duties, firmer line breaks:** Clients no longer have to render both text formats, and show an unknown embed's fallback card with its `title` and a link to its `url`. Clients that render CommonMark show a soft line break as a hard one, so that a typed newline looks the same everywhere. [§3.5.2](PROTOCOL.md#352-rendering) ([#101](https://github.com/shazow/apron/pull/101), [#120](https://github.com/shazow/apron/pull/120))
- **Passkey page after an empty login:** Clients offer the passkey page, without opening it, when their own passkey login ends without a credential, because the page can find passkeys that they cannot, such as ones for the server's previous RP ID. [§4.10.1](PROTOCOL.md#4101-passkey-page) ([#141](https://github.com/shazow/apron/pull/141))
- **Guest upgrades are the server's call:** Servers decide whether signing in on a guest connection adds the scheme to the guest's account. [§3.2](PROTOCOL.md#32-authentication) ([#115](https://github.com/shazow/apron/pull/115))

### Clarified

- **Tokens stay with their server:** Clients send a bearer token only to the server address that they got it from, so that another server cannot sign in as the user with it. [§3.2.1](PROTOCOL.md#321-bearer-tokens) ([#130](https://github.com/shazow/apron/pull/130))
- **`credential` is the browser's JSON:** Clients send `credential` in a WebAuthn `finish` as `toJSON()` returns it. [§4.10](PROTOCOL.md#410-webauthn-authentication) ([#130](https://github.com/shazow/apron/pull/130))
- **Mutes and unread counts follow the server:** Servers may let mentions through a room mute, and decide how mutes change `unread`. A `status` request with `room_id` and no `mute` is no longer refused. [§4.5.3](PROTOCOL.md#453-the-status-request), [§4.9.3](PROTOCOL.md#493-payload) ([#112](https://github.com/shazow/apron/pull/112))
- **Version mismatches warn, and carry on:** Clients that see another protocol version warn, and continue. [§3.1](PROTOCOL.md#31-server-frame) ([#105](https://github.com/shazow/apron/pull/105))
- **Reactions keep their first order:** Servers keep reactions in the order in which they first appeared. [§4.7](PROTOCOL.md#47-reactions) ([#105](https://github.com/shazow/apron/pull/105))

## v9 (2026-10-27)

### Breaking

- **`history` without a room reads every room:** Clients that sent `history` without `room_id` to read the default room now pass its `room_id`, since the request now reads every room that the connection receives, as one log. Servers that don't support that reply `unsupported`. [§4.3](https://github.com/shazow/apron/blob/protocol-v9/PROTOCOL.md#43-history) ([#92](https://github.com/shazow/apron/pull/92), [#99](https://github.com/shazow/apron/pull/99))

### New

- **Sign in through the server's own page:** Servers can offer scheme `external`, a page that signs users in by any method and returns a temporary token to the client's `return_url`, or shows a code to type. It shares proposals, `state`, and approval with `email`, and servers that offer either also offer `token`. [§4.11.5](https://github.com/shazow/apron/blob/protocol-v9/PROTOCOL.md#4115-external), [§4.11.1](https://github.com/shazow/apron/blob/protocol-v9/PROTOCOL.md#4111-proposals) ([#78](https://github.com/shazow/apron/pull/78))
- **Links that any client opens:** Clients can open `https://link.apron.chat/#…` and `apron:?…` links to a server, room, message, user, or invite, and approve a link's token with `scheme: "token"`. [A.4](https://github.com/shazow/apron/blob/protocol-v9/PROTOCOL.md#a4-links), [B.3](https://github.com/shazow/apron/blob/protocol-v9/PROTOCOL.md#b3-an-invite-token-signs-up-several-people) ([#91](https://github.com/shazow/apron/pull/91), [#93](https://github.com/shazow/apron/pull/93), [#94](https://github.com/shazow/apron/pull/94))
- **Servers introduce themselves:** Servers can send `title`, `description`, and `avatar` in the `server` frame, so that clients can tell servers apart. Clients still identify a server by its address, never by its title or avatar. [§3.1](https://github.com/shazow/apron/blob/protocol-v9/PROTOCOL.md#31-server-frame), [§1](https://github.com/shazow/apron/blob/protocol-v9/PROTOCOL.md#1-transport--framing) ([#100](https://github.com/shazow/apron/pull/100))
- **Last seen:** Servers can send `seen`, when a user's shown status last became `offline`. [§4.5.2](https://github.com/shazow/apron/blob/protocol-v9/PROTOCOL.md#452-delivery) ([#96](https://github.com/shazow/apron/pull/96))
- **Custom reactions:** A `reactions` entry may be a key for another kind of reaction, such as a custom emoji. Clients show a key that they don't support as a placeholder, and compare entries without U+FE0F. [§4.7](https://github.com/shazow/apron/blob/protocol-v9/PROTOCOL.md#47-reactions) ([#100](https://github.com/shazow/apron/pull/100))
- **One member at a time:** `room_list` takes a `user_id` filter, which lists only that user in `members`. [§4.2.1](https://github.com/shazow/apron/blob/protocol-v9/PROTOCOL.md#421-listing) ([#91](https://github.com/shazow/apron/pull/91))

### Changed

- **Guest access accepts only offered schemes:** Servers accept only the schemes that they offer, as v8 already asked clients to pick, so that a client can try another. Which credentials an offered scheme accepts, such as any token under guest access, stays server policy. [§3.2](https://github.com/shazow/apron/blob/protocol-v9/PROTOCOL.md#32-authentication) ([#96](https://github.com/shazow/apron/pull/96))
- **Text can't hijack its direction:** Clients isolate the text direction of each user-written string, and ignore bidi embeddings and overrides in it, so that a name or message can't reorder the text around it. [§3.5.2](https://github.com/shazow/apron/blob/protocol-v9/PROTOCOL.md#352-rendering) ([#100](https://github.com/shazow/apron/pull/100))
- **IDs have firm edges:** Servers never assign an empty `room_id` or `user_id`, or one with whitespace or control characters. Clients read a mention as the longest run of the characters that A.3 lists, so `@ada@example.com` is one mention. [§2.4](https://github.com/shazow/apron/blob/protocol-v9/PROTOCOL.md#24-opaque-ids), [A.3](https://github.com/shazow/apron/blob/protocol-v9/PROTOCOL.md#a3-prefixes-in-text) ([#78](https://github.com/shazow/apron/pull/78))
- **Sign-in joins can skip `room_update`:** Servers list in `room_update` `joined` only the rooms joined after sign-in. [§4.2.3](https://github.com/shazow/apron/blob/protocol-v9/PROTOCOL.md#423-updates) ([#88](https://github.com/shazow/apron/pull/88), [#89](https://github.com/shazow/apron/pull/89))
- **Ties and recovery in the log:** At an equal `log_id`, a tombstone wins. Clients that recover without a checkpoint may start at the newest page. [§2.3](https://github.com/shazow/apron/blob/protocol-v9/PROTOCOL.md#23-records-and-replay), [§4.3.5](https://github.com/shazow/apron/blob/protocol-v9/PROTOCOL.md#435-replay-and-recovery) ([#78](https://github.com/shazow/apron/pull/78))
- **Email links carry `state`, and additions stay with their account:** Clients can send `state` with an email proposal, which servers return in every link, and ask before they use a link without their own `state`, so that a link can't sign the user in to someone else's account. Servers approve an addition only on a connection signed in to the account that proposed it, and a disconnect no longer cancels a proposal. [§4.11.1](https://github.com/shazow/apron/blob/protocol-v9/PROTOCOL.md#4111-proposals), [§4.11.3](https://github.com/shazow/apron/blob/protocol-v9/PROTOCOL.md#4113-approval) ([#78](https://github.com/shazow/apron/pull/78))

### Clarified

- **Status has three views:** Servers derive the shown status that others see from the user's chosen status and the presence of their connections. [§4.5.1](https://github.com/shazow/apron/blob/protocol-v9/PROTOCOL.md#451-values) ([#96](https://github.com/shazow/apron/pull/96))
- **`history` room records aren't deliveries:** Clients ignore delivery fields in room records from `history`, and a frame that omits a delivery field doesn't change it. [§4.3.3](https://github.com/shazow/apron/blob/protocol-v9/PROTOCOL.md#433-availability-and-retention) ([#88](https://github.com/shazow/apron/pull/88), [#89](https://github.com/shazow/apron/pull/89))

### Under consideration

- **ICE refresh by deadline:** `rtc_join` may carry `refresh_after` in place of `ice_expires`. [C.1.1](https://github.com/shazow/apron/blob/protocol-v9/PROTOCOL.md#c11-joining) ([#96](https://github.com/shazow/apron/pull/96))

## v8 (2026-10-06)

### Breaking

- **Push payloads wrap the message:** Clients and relays that read a push payload as a message now read it from `message`, since servers send an object of at most 2048 bytes that also carries the registration's `push_id` and an optional `unread` count. The `push_id` tells a client with several servers or accounts which one a push is for. [§4.9](https://github.com/shazow/apron/blob/protocol-v8/PROTOCOL.md#49-push) ([#75](https://github.com/shazow/apron/pull/75))
- **`ext` writes merge:** Clients that removed an `ext` key by leaving it out send it with an empty value instead, since servers with capability `ext` now merge each write one level down and keep keys that are left out. Clients send `ext` only to servers that advertise capability `ext`, so they no longer have to send it back on every save. [§4.12](https://github.com/shazow/apron/blob/protocol-v8/PROTOCOL.md#412-ext) ([#75](https://github.com/shazow/apron/pull/75))

### New

- **Web Push, and encrypted relays:** Servers can offer push kind `webpush` with their VAPID key, so that browsers get pushes without a relay. A `relay` registration can carry `keys`, so that the relay forwards only ciphertext. [§4.9](https://github.com/shazow/apron/blob/protocol-v8/PROTOCOL.md#49-push) ([#75](https://github.com/shazow/apron/pull/75))
- **Wake scopes and badges:** Clients can choose what a push registration wakes for, such as mentions or replies, from the scopes that `server.push.wake` lists. With scope `badge`, a push can carry only the `unread` count, for an app badge. [§4.9](https://github.com/shazow/apron/blob/protocol-v8/PROTOCOL.md#49-push) ([#75](https://github.com/shazow/apron/pull/75))

### Changed

- **Capability `status` replaces `away`:** Clients report an unattended connection with a `status` request's `idle`, which servers use to decide pushes, and users set a presence `status` and mutes. A client that still sends `activity` `away` keeps working, but servers no longer count it as away when they push. [§4.5](https://github.com/shazow/apron/blob/protocol-v8/PROTOCOL.md#45-status), [§4.6](https://github.com/shazow/apron/blob/protocol-v8/PROTOCOL.md#46-activity) ([#75](https://github.com/shazow/apron/pull/75), [#76](https://github.com/shazow/apron/pull/76))
- **`you` in a result is complete:** Servers send every profile field that they publish in the `you` of an `auth` or `me` result. Clients replace their kept user object with it, and with a listing's `users`, but still merge `user` notifications. [§3.3](https://github.com/shazow/apron/blob/protocol-v8/PROTOCOL.md#33-identity), [§4.2.1](https://github.com/shazow/apron/blob/protocol-v8/PROTOCOL.md#421-listing) ([#75](https://github.com/shazow/apron/pull/75))
- **Push registrations belong to a user:** Servers keep a registration for each user and `url` after its connection closes, so that two accounts on one device each keep their own. Servers remove a registration whose `url` stops accepting pushes. [§4.9](https://github.com/shazow/apron/blob/protocol-v8/PROTOCOL.md#49-push) ([#75](https://github.com/shazow/apron/pull/75))
- **Sign-in notifications follow the `auth` result:** Servers send what a sign-in causes on its connection, such as a guest's automatic join, after the `auth` result instead of before it. This lets clients reset kept state at the result and apply what follows. [§3.2](https://github.com/shazow/apron/blob/protocol-v8/PROTOCOL.md#32-authentication) ([#75](https://github.com/shazow/apron/pull/75))
- **Signing in to an existing account is a departure:** Servers announce that the connection's previous identity left. They send `old` only when one account changes its `user_id`. [§3.3](https://github.com/shazow/apron/blob/protocol-v8/PROTOCOL.md#33-identity) ([#75](https://github.com/shazow/apron/pull/75))
- **Error codes follow the kind of failure:** Servers reply `invalid_params` to an unknown or hidden ID or an unknown name, `too_large` to a value over a size limit, and `denied` to a request past a count limit. A reaction past the server's emoji limit is now `denied`, not `invalid_params`. [§1.1](https://github.com/shazow/apron/blob/protocol-v8/PROTOCOL.md#11-envelope-and-replies), [§4.7](https://github.com/shazow/apron/blob/protocol-v8/PROTOCOL.md#47-reactions) ([#75](https://github.com/shazow/apron/pull/75))
- **Unoffered sign-in schemes are `unsupported`:** Servers reply `unsupported` to a scheme that this document defines but they don't offer. Under guest access, servers accept only `token` or an undefined scheme without checking credentials. [§3.2](https://github.com/shazow/apron/blob/protocol-v8/PROTOCOL.md#32-authentication) ([#75](https://github.com/shazow/apron/pull/75), [#76](https://github.com/shazow/apron/pull/76))
- **Each method is a request or a notification:** Clients send the methods that §1.1 and §4 list as requests with an `id`, and the others without. Servers may ignore a request without an `id`, and the `id` on a notification. [§1.1](https://github.com/shazow/apron/blob/protocol-v8/PROTOCOL.md#11-envelope-and-replies), [§4](https://github.com/shazow/apron/blob/protocol-v8/PROTOCOL.md#4-capabilities) ([#75](https://github.com/shazow/apron/pull/75))
- **Extension names start with `ext:`:** Extensions prefix every name that they add with `ext:`, such as methods, auth schemes, and kinds, not only capabilities and push kinds. [§4](https://github.com/shazow/apron/blob/protocol-v8/PROTOCOL.md#4-capabilities) ([#75](https://github.com/shazow/apron/pull/75))
- **CommonMark may use extensions:** Clients may render common CommonMark extensions, such as tables, and may render soft line breaks as hard breaks. [§3.5](https://github.com/shazow/apron/blob/protocol-v8/PROTOCOL.md#35-messages) ([#75](https://github.com/shazow/apron/pull/75))
- **Push carries urgency, and notifications don't repeat:** Servers send `TTL` and `Urgency` headers with every push, relays included, with `Urgency` set by what the push is for. Clients show at most one notification for each `push_id` and `message_id`, and a later one replaces the earlier one. [§4.9](https://github.com/shazow/apron/blob/protocol-v8/PROTOCOL.md#49-push) ([#75](https://github.com/shazow/apron/pull/75))

### Clarified

- **Any sign-in can return a token:** Servers may send a bearer `token` after a sign-in by any scheme, not only passkey or email, and clients save it. [§3.2](https://github.com/shazow/apron/blob/protocol-v8/PROTOCOL.md#32-authentication) ([#75](https://github.com/shazow/apron/pull/75))
- **`ping` works before sign-in:** Servers answer `ping` before `auth`. It is the only notification that they don't ignore at that point. [§3.2](https://github.com/shazow/apron/blob/protocol-v8/PROTOCOL.md#32-authentication), [§1](https://github.com/shazow/apron/blob/protocol-v8/PROTOCOL.md#1-transport--framing) ([#75](https://github.com/shazow/apron/pull/75))

## v7 (2026-09-29)

### Breaking

- **`server` frame fields renamed:** Servers send `apron`, `capabilities`, and `agent` in place of `protocol`, `caps`, and `name`, so clients that read the old names change to the new ones, or they see no capabilities. Clients send `auth`'s `client` as `agent`. [§3.1](https://github.com/shazow/apron/blob/protocol-v7/PROTOCOL.md#31-server-frame), [§3.2](https://github.com/shazow/apron/blob/protocol-v7/PROTOCOL.md#32-authentication) ([#71](https://github.com/shazow/apron/pull/71))
- **Memberships arrive in `room_update`:** Servers deliver membership records in `room_update` `memberships` in place of the `membership` notification, and `history` returns them under `memberships` in place of `membership`. Clients that keep member lists read them in both new places. [§4.3.2](https://github.com/shazow/apron/blob/protocol-v7/PROTOCOL.md#432-membership), [§4.3.3](https://github.com/shazow/apron/blob/protocol-v7/PROTOCOL.md#433-updates), [§4.1](https://github.com/shazow/apron/blob/protocol-v7/PROTOCOL.md#41-history) ([#68](https://github.com/shazow/apron/pull/68), [#73](https://github.com/shazow/apron/pull/73))
- **Room `description` replaces `intro_message`:** Clients and servers drop `intro_message`, a message that a room or thread pointed to, and use `description`, a Markdown string on the room that `room_set` edits. Clients that showed or set `intro_message` switch to `description`. [§3.4](https://github.com/shazow/apron/blob/protocol-v7/PROTOCOL.md#34-rooms), [§4.3.4](https://github.com/shazow/apron/blob/protocol-v7/PROTOCOL.md#434-creating-and-editing) ([#64](https://github.com/shazow/apron/pull/64))

### New

- **Email sign-in:** Servers can offer scheme `email`. An `auth` with `email` proposes signing in, or adding the address to the signed-in account, and an `auth` with the emailed `token` approves the proposal. [§4.10](https://github.com/shazow/apron/blob/protocol-v7/PROTOCOL.md#410-email-authentication), [§3.2](https://github.com/shazow/apron/blob/protocol-v7/PROTOCOL.md#32-authentication) ([#64](https://github.com/shazow/apron/pull/64), [#68](https://github.com/shazow/apron/pull/68))
- **Private rooms:** Clients can create a room with `private: true`, which only its members can see. Servers that don't keep private rooms reject the request as `unsupported`, and clients check the new room's record before they post in it. [§4.3.4](https://github.com/shazow/apron/blob/protocol-v7/PROTOCOL.md#434-creating-and-editing) ([#64](https://github.com/shazow/apron/pull/64), [#68](https://github.com/shazow/apron/pull/68))
- **Joining and removing other users:** Servers can accept a `user_id` in `room_join` and `room_leave`, so that a member can add another user to a room, such as a private room, or remove them. [§4.3.2](https://github.com/shazow/apron/blob/protocol-v7/PROTOCOL.md#432-membership) ([#64](https://github.com/shazow/apron/pull/64))
- **User roles:** Servers can give users `roles`, labels such as `"admin"` or `"bot"`, which clients show beside the name. Roles are for display only and grant nothing on the client. [§3.3](https://github.com/shazow/apron/blob/protocol-v7/PROTOCOL.md#33-identity) ([#64](https://github.com/shazow/apron/pull/64))
- **Sign-up schemes in `server.signup`:** Servers can list in `signup` the schemes that create accounts, apart from the schemes in `auth` that sign in. For example, a user can join by email and later sign in with a passkey. [§3.2](https://github.com/shazow/apron/blob/protocol-v7/PROTOCOL.md#32-authentication) ([#66](https://github.com/shazow/apron/pull/66))
- **Sign-in instructions in `server.welcome`:** Servers can send `welcome`, text that clients show on the sign-in screen to explain how the server's schemes fit together. [§3.2](https://github.com/shazow/apron/blob/protocol-v7/PROTOCOL.md#32-authentication) ([#64](https://github.com/shazow/apron/pull/64))

### Changed

- **Embed writes use `PUT`:** Senders send `upload` and `stream` content as an HTTP `PUT` to `write_url`, the method that v6's examples already used. [§4.6.3](https://github.com/shazow/apron/blob/protocol-v7/PROTOCOL.md#463-writes), [§4.6.5](https://github.com/shazow/apron/blob/protocol-v7/PROTOCOL.md#465-embedstream) ([#68](https://github.com/shazow/apron/pull/68))
- **Any `auth` result can replace the token:** Servers may replace a presented token, such as a shared invite, with a new `token` in the `auth` result, and may reject the old one. Clients that sign in with `scheme: "token"` save the latest token and reconnect with it. [§3.2](https://github.com/shazow/apron/blob/protocol-v7/PROTOCOL.md#32-authentication), [Appendix B](https://github.com/shazow/apron/blob/protocol-v7/PROTOCOL.md#appendix-b--valid-scenarios-informative) ([#64](https://github.com/shazow/apron/pull/64), [#66](https://github.com/shazow/apron/pull/66))
- **System identities take `~`:** Servers send scoped notices from `~server`, `~room`, and `~private` in place of `@server`, `@room`, and `@private`. Clients that style system notices by their sender look for `~`, and clients unaware of the convention still show them as ordinary senders. [A.1](https://github.com/shazow/apron/blob/protocol-v7/PROTOCOL.md#a1-system-identities-and-scoped-notices), [A.3](https://github.com/shazow/apron/blob/protocol-v7/PROTOCOL.md#a3-prefixes-in-text) ([#64](https://github.com/shazow/apron/pull/64))
- **Requests behind a failed `auth` keep the sign-in:** If an `auth` authenticates nothing, such as a failure or a WebAuthn `begin`, servers run the requests behind it as the connection was signed in before. Before, servers denied those requests. [§3.2](https://github.com/shazow/apron/blob/protocol-v7/PROTOCOL.md#32-authentication) ([#68](https://github.com/shazow/apron/pull/68))
- **Retries answer with the current state:** Servers answer a deduplicated retry with the current state in place of the original result, so that the result never contradicts an earlier notification. [§1.2](https://github.com/shazow/apron/blob/protocol-v7/PROTOCOL.md#12-retries-and-deduplication) ([#68](https://github.com/shazow/apron/pull/68))
- **Cleared profile fields stay cleared:** Clients treat an empty value in a current user object as a cleared field and don't fall back to the recorded `from` for that field. A cleared `name` therefore shows as the `user_id`. [§3.3](https://github.com/shazow/apron/blob/protocol-v7/PROTOCOL.md#33-identity) ([#68](https://github.com/shazow/apron/pull/68))
- **Room references use `#`:** Clients write a room in text as `#` followed by its ID. `@` now refers only to a user. [A.3](https://github.com/shazow/apron/blob/protocol-v7/PROTOCOL.md#a3-prefixes-in-text) ([#64](https://github.com/shazow/apron/pull/64))
- **`~private` notices reach one connection:** Servers send a `~private` notice only to the connection it is for, not to every connection of the user. [A.1](https://github.com/shazow/apron/blob/protocol-v7/PROTOCOL.md#a1-system-identities-and-scoped-notices) ([#64](https://github.com/shazow/apron/pull/64))
- **Large rooms can list some members:** Servers can shorten a room's `members` list, such as to the most recently active members. When they do, they should include `member_count`, the total number of members. [§4.3.1](https://github.com/shazow/apron/blob/protocol-v7/PROTOCOL.md#431-listing) ([#64](https://github.com/shazow/apron/pull/64), [#68](https://github.com/shazow/apron/pull/68))
- **Passkeys add to a signed-in account:** When a connection that is already signed in registers a passkey, servers add the passkey to that account, so that users can add a passkey to an account they already have. [§4.9](https://github.com/shazow/apron/blob/protocol-v7/PROTOCOL.md#49-webauthn-authentication) ([#66](https://github.com/shazow/apron/pull/66), [#68](https://github.com/shazow/apron/pull/68))
- **Passkeys carry the requested name:** Servers label a new passkey with the `name` from its `register` begin, so that password managers show the name the user chose. [§4.9](https://github.com/shazow/apron/blob/protocol-v7/PROTOCOL.md#49-webauthn-authentication) ([#74](https://github.com/shazow/apron/pull/74))

### Under consideration

- **WebRTC sessions on rooms:** Capability `rtc` would let a room hold one call at a time, with a seat for each device and signaling relayed by the server. [C.1](https://github.com/shazow/apron/blob/protocol-v7/PROTOCOL.md#c1-webrtc-signaling-for-audio-video-and-peer-to-peer-connections) ([#64](https://github.com/shazow/apron/pull/64))
- **Actions embed:** Embed kind `actions` would offer choices that the server sets, each sent as a command, such as accepting or declining an invitation. [C.3](https://github.com/shazow/apron/blob/protocol-v7/PROTOCOL.md#c3-actions-embed) ([#64](https://github.com/shazow/apron/pull/64))

## v6 (2026-09-26)

### Breaking

- **`history` renames its fields:** Clients read message snapshots from `messages` instead of `entries`. They read page bounds from `first_log_id` and `last_log_id` instead of `first_id` and `last_id`, the names that servers now send. [§4.1](https://github.com/shazow/apron/blob/protocol-v6/PROTOCOL.md#41-history) ([#42](https://github.com/shazow/apron/pull/42))
- **`room_list` takes `filter`, and lists members only on request:** Clients send `filter` instead of `only_joined` and `not_joined`, and read unjoined rooms from `not_joined` instead of `rooms`. Clients that show members ask with `members: true`, since servers otherwise leave out `members` and no longer send `member_count`. [§4.3.1](https://github.com/shazow/apron/blob/protocol-v6/PROTOCOL.md#431-listing) ([#42](https://github.com/shazow/apron/pull/42))

### New

- **Moved messages point back with `prev_room_id`:** Servers mark a moved message's snapshot with `prev_room_id`, the source room, so that clients can keep walking the message's edits back through `history` across a move. [§2](https://github.com/shazow/apron/blob/protocol-v6/PROTOCOL.md#2-identifiers), [§4.2](https://github.com/shazow/apron/blob/protocol-v6/PROTOCOL.md#42-edit) ([#42](https://github.com/shazow/apron/pull/42))
- **Reconnect listings report rooms left:** Clients that list with `latest_log_id` get the rooms they left since then in `left`. If `left` is absent, the server ignored the filter and the result is a full listing. [§4.3.1](https://github.com/shazow/apron/blob/protocol-v6/PROTOCOL.md#431-listing) ([#42](https://github.com/shazow/apron/pull/42))

### Changed

- **Joins and leaves are logged memberships:** Servers record joins, leaves and removals as `membership` records, which also replay from `history`, in place of the optional `user` notifications with `room_id`. A v5 client that relied on those notifications keeps working, with a member list that falls out of date. [§4.3.2](https://github.com/shazow/apron/blob/protocol-v6/PROTOCOL.md#432-membership), [§4.3.3](https://github.com/shazow/apron/blob/protocol-v6/PROTOCOL.md#433-updates), [§3.3](https://github.com/shazow/apron/blob/protocol-v6/PROTOCOL.md#33-identity) ([#42](https://github.com/shazow/apron/pull/42))
- **`auth` is a barrier:** Servers finish an `auth` request before they process any later frame on the connection. This lets clients send requests such as `room_list` right behind it without waiting for its result. [§3.2](https://github.com/shazow/apron/blob/protocol-v6/PROTOCOL.md#32-authentication), [§3.6](https://github.com/shazow/apron/blob/protocol-v6/PROTOCOL.md#36-core-conformance-checklist) ([#42](https://github.com/shazow/apron/pull/42))
- **Results come after the notifications they cause:** Servers send a request's notifications on the requesting connection, such as a broadcast or a `room_update`, before its result. A client that gets a result therefore already holds what the result refers to. [§1](https://github.com/shazow/apron/blob/protocol-v6/PROTOCOL.md#1-transport--framing), [§3.5](https://github.com/shazow/apron/blob/protocol-v6/PROTOCOL.md#35-messages), [§4.3.4](https://github.com/shazow/apron/blob/protocol-v6/PROTOCOL.md#434-creating-and-editing) ([#42](https://github.com/shazow/apron/pull/42))
- **`from` is a fallback, not an update:** Clients merge only current user objects into the user object they keep, and use a message's `from` only for what that object lacks, so that an old or edited message never brings back an old name. `history` pages no longer carry `users`. [§3.3](https://github.com/shazow/apron/blob/protocol-v6/PROTOCOL.md#33-identity), [§4.1](https://github.com/shazow/apron/blob/protocol-v6/PROTOCOL.md#41-history) ([#42](https://github.com/shazow/apron/pull/42))
- **Thread edits reach the parent room:** Servers tell the parent room's members about an edited thread in `room_update` `updated`, as v5 did for a new one. Thread messages still go only to the thread's members, so clients refresh a thread's `latest_log_id` with `room_list`. [§3.4](https://github.com/shazow/apron/blob/protocol-v6/PROTOCOL.md#34-rooms), [§4.3.3](https://github.com/shazow/apron/blob/protocol-v6/PROTOCOL.md#433-updates) ([#42](https://github.com/shazow/apron/pull/42))
- **`@server` notices go in a real room:** Servers post a `@server` notice in a room that clients know, usually the default room, instead of in room `@server`. Every user receives it, whether or not they joined that room. [A.1](https://github.com/shazow/apron/blob/protocol-v6/PROTOCOL.md#a1-system-identities-and-scoped-notices) ([#42](https://github.com/shazow/apron/pull/42))
- **Notices can come before sign-in:** Servers may send notifications before `auth`, such as a `@private` welcome without `room_id`. Clients show such a notice where the user signs in. [§3.2](https://github.com/shazow/apron/blob/protocol-v6/PROTOCOL.md#32-authentication), [A.1](https://github.com/shazow/apron/blob/protocol-v6/PROTOCOL.md#a1-system-identities-and-scoped-notices), [Appendix B](https://github.com/shazow/apron/blob/protocol-v6/PROTOCOL.md#appendix-b--valid-scenarios-informative) ([#48](https://github.com/shazow/apron/pull/48))
- **`Name (@user_id)` for any shared name:** Clients must show `Name (@user_id)` whenever they know another `user_id` with the same display name, not only one in the same room. This way no one can pass as someone else. [§3.3](https://github.com/shazow/apron/blob/protocol-v6/PROTOCOL.md#33-identity) ([#42](https://github.com/shazow/apron/pull/42))
- **Mentions wake users:** Servers that follow the suggested push wake rule also wake a user for a message whose `mentions` list them, in any room that they can see. [§4.7](https://github.com/shazow/apron/blob/protocol-v6/PROTOCOL.md#47-push) ([#42](https://github.com/shazow/apron/pull/42))

## v5 (2026-09-25)

### Breaking

- **Rooms are listed, not announced:** Servers no longer send `room` frames, so clients that waited for them now list their rooms with `room_list`, whose result puts joined rooms in `joined` and other visible rooms in `rooms`. Clients learn of joins, leaves, and edits from `room_update`, or, without cap `rooms`, learn a room from the messages in it. [§3.4](https://github.com/shazow/apron/blob/protocol-v5/PROTOCOL.md#34-rooms), [§4.3.1](https://github.com/shazow/apron/blob/protocol-v5/PROTOCOL.md#431-listing), [§4.3.3](https://github.com/shazow/apron/blob/protocol-v5/PROTOCOL.md#433-updates) ([#34](https://github.com/shazow/apron/pull/34))
- **`room_set` creates and edits rooms:** Clients that create or edit a room with a `room` request send `room_set` instead, because servers no longer accept `room`. The change arrives as a `room_update`, not as a `room` broadcast. [§4.3.4](https://github.com/shazow/apron/blob/protocol-v5/PROTOCOL.md#434-creating-and-editing) ([#34](https://github.com/shazow/apron/pull/34))
- **User objects merge field by field:** Clients merge each user object into the one they keep, so a missing field keeps its value, and they merge a `from` only if its message is newer than the kept object. Servers that removed a field by leaving it out now send its empty value (`""`, `{}`). [§3.3](https://github.com/shazow/apron/blob/protocol-v5/PROTOCOL.md#33-identity) ([#34](https://github.com/shazow/apron/pull/34))

### New

- **`message` without `room_id` goes to the default room:** Clients can leave `room_id` out of `message` and `history` to use the server's default room, so that a minimal client can post without listing rooms. Servers accept this. [§3.5](https://github.com/shazow/apron/blob/protocol-v5/PROTOCOL.md#35-messages), [§4.1](https://github.com/shazow/apron/blob/protocol-v5/PROTOCOL.md#41-history) ([#34](https://github.com/shazow/apron/pull/34))
- **Scoped system notices:** Servers can send notices from `@server`, `@room`, or `@private`, so that clients know whether everyone, the room, or only this user received them. A notice about no particular room goes in room `@server`, which every user receives without joining, and clients render a `message` without `message_id` but never install it as a snapshot. [A.1](https://github.com/shazow/apron/blob/protocol-v5/PROTOCOL.md#a1-system-identities-and-scoped-notices), [§3.5](https://github.com/shazow/apron/blob/protocol-v5/PROTOCOL.md#35-messages) ([#34](https://github.com/shazow/apron/pull/34))
- **Server commands:** Servers can offer cap `command`, which accepts `command` requests for server-specific features such as `/kick` and `/help`. Clients send composer text that starts with `/` as a command. [§4.8](https://github.com/shazow/apron/blob/protocol-v5/PROTOCOL.md#48-command) ([#34](https://github.com/shazow/apron/pull/34))
- **`users` in results:** Servers can add `users`, the current user objects, to a result, such as a history page, so that clients get avatars and current names that `from` leaves out. [§3.3](https://github.com/shazow/apron/blob/protocol-v5/PROTOCOL.md#33-identity), [§4.1](https://github.com/shazow/apron/blob/protocol-v5/PROTOCOL.md#41-history) ([#34](https://github.com/shazow/apron/pull/34))
- **Away connections:** Clients with cap `activity` can send `away` when nobody is attending a connection, such as an unfocused tab, so that servers can decide when to push. [§4.4](https://github.com/shazow/apron/blob/protocol-v5/PROTOCOL.md#44-activity), [§4.7](https://github.com/shazow/apron/blob/protocol-v5/PROTOCOL.md#47-push) ([#34](https://github.com/shazow/apron/pull/34))
- **Ping liveness:** Servers can advertise `server.ping`, and clients then send a fixed `ping` frame at that interval, which servers answer with `pong`. [§1](https://github.com/shazow/apron/blob/protocol-v5/PROTOCOL.md#1-transport--framing), [§3.1](https://github.com/shazow/apron/blob/protocol-v5/PROTOCOL.md#31-server-frame) ([#34](https://github.com/shazow/apron/pull/34))
- **Joins and leaves through `user`:** Servers can tell a room's members about a join or a leave with a `user` notification that carries `room_id`. Without `room_id`, `old` alone says that the user no longer shares any room with the recipient. [§4.3.2](https://github.com/shazow/apron/blob/protocol-v5/PROTOCOL.md#432-membership), [§3.3](https://github.com/shazow/apron/blob/protocol-v5/PROTOCOL.md#33-identity) ([#34](https://github.com/shazow/apron/pull/34))
- **Requested `user_id` at sign-in:** Clients can now ask for a `user_id` in `auth`, as they already could for a `name`. Before, they could not send one. [§3.2](https://github.com/shazow/apron/blob/protocol-v5/PROTOCOL.md#32-authentication) ([#34](https://github.com/shazow/apron/pull/34))
- **Edit history through `prev_log_id`:** Clients can fetch the record that `prev_log_id` names with a `history` request bounded to it, and so walk back through a message's edits. [§2](https://github.com/shazow/apron/blob/protocol-v5/PROTOCOL.md#2-identifiers), [§4.1](https://github.com/shazow/apron/blob/protocol-v5/PROTOCOL.md#41-history) ([#34](https://github.com/shazow/apron/pull/34))

### Changed

- **Avatar uploads move to `/avatar`:** Clients set an avatar by sending the upload with a `/avatar` command, in place of the optional `@avatar` room convention. A client that still posts to room `@avatar` gets the refusal that servers without the convention already sent. [§4.6.6](https://github.com/shazow/apron/blob/protocol-v5/PROTOCOL.md#466-avatars), [§4.8](https://github.com/shazow/apron/blob/protocol-v5/PROTOCOL.md#48-command) ([#34](https://github.com/shazow/apron/pull/34))
- **Mentions are listed in `body.mentions`:** Servers and clients treat as mentioned only the users in `body.mentions`, in place of the optional convention of finding `@user_id` in `text`. A client that mentions only in `text` still posts, but nobody is highlighted or woken. [§3.5](https://github.com/shazow/apron/blob/protocol-v5/PROTOCOL.md#35-messages), [A.3](https://github.com/shazow/apron/blob/protocol-v5/PROTOCOL.md#a3-mention-text) ([#34](https://github.com/shazow/apron/pull/34))
- **Posting without joining:** Servers may accept a post in a room that the poster has not joined without joining them. Such a poster gets the result but not the broadcast. [§4.3.5](https://github.com/shazow/apron/blob/protocol-v5/PROTOCOL.md#435-posting) ([#34](https://github.com/shazow/apron/pull/34))
- **Results follow earlier notifications:** On each connection, servers make every result reflect the notifications sent before it, so that clients can apply frames in arrival order and a stale result never undoes a change. [§1](https://github.com/shazow/apron/blob/protocol-v5/PROTOCOL.md#1-transport--framing) ([#34](https://github.com/shazow/apron/pull/34))
- **Empty messages aren't posted:** Servers neither log nor broadcast a new message that has no `text` and no `embeds`, and answer it with `{}`. [§3.5](https://github.com/shazow/apron/blob/protocol-v5/PROTOCOL.md#35-messages) ([#34](https://github.com/shazow/apron/pull/34))
- **Shared names show `user_id`:** Clients show `Name (@user_id)` when two users in a room share a name, so that no one can pass as someone else. [§3.3](https://github.com/shazow/apron/blob/protocol-v5/PROTOCOL.md#33-identity) ([#34](https://github.com/shazow/apron/pull/34))
- **`from` carries `name`:** Servers should include `name` in `from`, so that clients can render any message without looking up its author. [§3.3](https://github.com/shazow/apron/blob/protocol-v5/PROTOCOL.md#33-identity) ([#34](https://github.com/shazow/apron/pull/34))
- **Hosted embed URLs are unguessable:** Servers make the URLs they host for embeds unguessable, not just derived from `embed_id`, because anyone with such a URL can fetch it. [§4.6.2](https://github.com/shazow/apron/blob/protocol-v5/PROTOCOL.md#462-embed-identity) ([#34](https://github.com/shazow/apron/pull/34))

### Clarified

- **Room delivery fields take the latest values:** Clients take a room record's delivery fields as they arrive, even when its `log_id` hasn't changed. [§3.4](https://github.com/shazow/apron/blob/protocol-v5/PROTOCOL.md#34-rooms) ([#34](https://github.com/shazow/apron/pull/34))
- **Unknown embed kinds render from `og`:** Clients render an embed of a kind they don't support from its `og`, as §3.5 already required. [§4.6.1](https://github.com/shazow/apron/blob/protocol-v5/PROTOCOL.md#461-opengraph-metadata-og) ([#34](https://github.com/shazow/apron/pull/34))

### Under consideration

- **Multiplexing envelope:** Nothing implements the envelope that lets several connections share one WebSocket, so it is a proposal, not part of the protocol. [B.2](https://github.com/shazow/apron/blob/protocol-v5/PROTOCOL.md#b2-multiplexing-envelope) ([#34](https://github.com/shazow/apron/pull/34))
- **WebRTC signaling:** The planned `rtc` capability is listed with the other proposals. [B.1](https://github.com/shazow/apron/blob/protocol-v5/PROTOCOL.md#b1-webrtc-signaling-for-audio-video-and-peer-to-peer-connections) ([#34](https://github.com/shazow/apron/pull/34))

## v4 (2026-09-23)

### Breaking

- **`me` replaces the `name` request:** Clients that renamed the user with `name` send `me` instead, and servers answer `me`, since `name` is gone. `me` also sets `avatar` and `ext`, and leaves the fields it doesn't name unchanged. [§3.3](https://github.com/shazow/apron/blob/protocol-v4/PROTOCOL.md#33-identity) ([#19](https://github.com/shazow/apron/pull/19))
- **Files travel as `upload` embeds:** Clients and servers that shared files through `server.upload` and the `image`, `video`, `audio`, and `file` embeds move to cap `embed:upload`, since `server.upload` is gone. On servers with an `embed:*` cap, clients keep each embed's `embed_id` when they save a message, because an embed sent without it is new and the original is removed. [Appendix E](https://github.com/shazow/apron/blob/protocol-v4/PROTOCOL.md#appendix-e--embeds-uploads-and-avatars), [§4](https://github.com/shazow/apron/blob/protocol-v4/PROTOCOL.md#4-capabilities) ([#19](https://github.com/shazow/apron/pull/19))
- **Push relays receive a message:** Relays read a message object in place of `{room_id, message_id, from, preview}`. Clients find push in `server.push`, which replaces cap `push`, and pass a `kind` to `push_register`, such as `relay`. [Appendix F](https://github.com/shazow/apron/blob/protocol-v4/PROTOCOL.md#appendix-f--push), [§3.1](https://github.com/shazow/apron/blob/protocol-v4/PROTOCOL.md#31-server-frame) ([#19](https://github.com/shazow/apron/pull/19))
- **Rate limits give `retry_after` in seconds:** Servers put the delay in `data.retry_after`, in seconds, in place of `data.ms`, and clients read it there. [§1.1](https://github.com/shazow/apron/blob/protocol-v4/PROTOCOL.md#11-envelope-and-replies) ([#19](https://github.com/shazow/apron/pull/19))

### New

- **`user` notifications carry profile changes:** Servers can send `user` when a user's profile or identity changes, to the user's own connections and to others who share a room. Clients keep the latest user object for each `user_id` and render every message with it. [§3.3](https://github.com/shazow/apron/blob/protocol-v4/PROTOCOL.md#33-identity) ([#19](https://github.com/shazow/apron/pull/19))
- **`room_list` finds rooms and threads:** Clients on servers with cap `rooms` can list the visible rooms, or a room's threads, with their members, including rooms that were never announced. [Appendix C](https://github.com/shazow/apron/blob/protocol-v4/PROTOCOL.md#appendix-c--rooms) ([#19](https://github.com/shazow/apron/pull/19))
- **Live text with `embed:stream`:** Senders can stream text into a message over HTTP, such as a program's output, while readers watch it grow. When the stream ends, the embed keeps the text. [Appendix K](https://github.com/shazow/apron/blob/protocol-v4/PROTOCOL.md#appendix-k--embedstream) ([#19](https://github.com/shazow/apron/pull/19))
- **Embeds describe themselves with `og`:** Servers can describe any embed with OpenGraph properties in `og`, so that clients can render kinds that they don't support. [Appendix E](https://github.com/shazow/apron/blob/protocol-v4/PROTOCOL.md#appendix-e--embeds-uploads-and-avatars), [§3.5](https://github.com/shazow/apron/blob/protocol-v4/PROTOCOL.md#35-messages) ([#19](https://github.com/shazow/apron/pull/19))
- **Records link back with `prev_log_id`:** Servers can send `prev_log_id` on room records and message snapshots, so that clients can see what changed and whether they missed a change. [§2](https://github.com/shazow/apron/blob/protocol-v4/PROTOCOL.md#2-identifiers) ([#19](https://github.com/shazow/apron/pull/19))
- **Mentions are `@` plus an ID:** Clients can mention a user or a room as `@` plus its ID in `body.text`, and render the mention with the user's latest name or as a link to the room. [J.3](https://github.com/shazow/apron/blob/protocol-v4/PROTOCOL.md#j3-mentions), [§2](https://github.com/shazow/apron/blob/protocol-v4/PROTOCOL.md#2-identifiers) ([#19](https://github.com/shazow/apron/pull/19))
- **Avatar uploads go to room `@avatar`:** Clients can set the user's avatar by sending an `upload` to room `@avatar`, which servers that follow the convention use as the avatar instead of delivering the message. [J.4](https://github.com/shazow/apron/blob/protocol-v4/PROTOCOL.md#j4-avatar-uploads) ([#19](https://github.com/shazow/apron/pull/19))
- **`ext` on the server and on users:** Servers can put extension metadata, such as implementation limits, in the `server` frame's `ext`, and user objects can carry `ext` too. [§3.1](https://github.com/shazow/apron/blob/protocol-v4/PROTOCOL.md#31-server-frame), [§3.3](https://github.com/shazow/apron/blob/protocol-v4/PROTOCOL.md#33-identity) ([#19](https://github.com/shazow/apron/pull/19))
- **Third-party caps start with `ext:`:** Caps and push kinds from third parties use an `ext:` prefix, such as `ext:irc`, so that they don't collide with the spec's own. [§4](https://github.com/shazow/apron/blob/protocol-v4/PROTOCOL.md#4-capabilities), [Appendix F](https://github.com/shazow/apron/blob/protocol-v4/PROTOCOL.md#appendix-f--push) ([#19](https://github.com/shazow/apron/pull/19))

### Changed

- **`iframe` embeds take `height`, not `h`:** Senders set `height` and clients read it, so that embedded views keep their suggested size. [Appendix E](https://github.com/shazow/apron/blob/protocol-v4/PROTOCOL.md#appendix-e--embeds-uploads-and-avatars) ([#19](https://github.com/shazow/apron/pull/19))
- **Avatars come with user objects, not `from`:** Servers send `avatar` in `you`, `user`, and `members`, and need not put it in every `from`. A client that reads it only from `from` keeps working, and draws placeholders. [Appendix E](https://github.com/shazow/apron/blob/protocol-v4/PROTOCOL.md#appendix-e--embeds-uploads-and-avatars), [§3.3](https://github.com/shazow/apron/blob/protocol-v4/PROTOCOL.md#33-identity) ([#19](https://github.com/shazow/apron/pull/19))
- **`activity` replaces `typing`:** Clients and servers show typing with the `activity` notification, under cap `activity`, which counts down the seconds to show the indicator and also carries read markers. A client that still sends `typing` keeps working, without typing indicators. [D.1](https://github.com/shazow/apron/blob/protocol-v4/PROTOCOL.md#d1-activity) ([#19](https://github.com/shazow/apron/pull/19))
- **Announced rooms are joined rooms:** Servers SHOULD announce the rooms that the user has joined, where before they MUST announce every visible room, and clients find the rest with `room_list`. A post in a visible room that the user has not joined MAY join them to it, or else is `denied`. [§3.4](https://github.com/shazow/apron/blob/protocol-v4/PROTOCOL.md#34-rooms), [Appendix C](https://github.com/shazow/apron/blob/protocol-v4/PROTOCOL.md#appendix-c--rooms) ([#19](https://github.com/shazow/apron/pull/19))
- **Errors without a request omit `id`:** Servers omit `id`, in place of `id: null`, on errors that no request caused, including new errors about the whole connection. Clients act on those by their code, such as waiting before they reconnect. [§1.1](https://github.com/shazow/apron/blob/protocol-v4/PROTOCOL.md#11-envelope-and-replies) ([#19](https://github.com/shazow/apron/pull/19))
- **Error messages are for people:** Servers write `message` so that clients can show it as is. Clients tell errors apart by `code` alone. [§1.1](https://github.com/shazow/apron/blob/protocol-v4/PROTOCOL.md#11-envelope-and-replies) ([#19](https://github.com/shazow/apron/pull/19))
- **Retired `user_id`s stay retired:** Servers SHOULD NOT reissue a `user_id` to another user, so that old messages and mentions keep pointing to the right person. [§3.3](https://github.com/shazow/apron/blob/protocol-v4/PROTOCOL.md#33-identity), [§3.2](https://github.com/shazow/apron/blob/protocol-v4/PROTOCOL.md#32-authentication) ([#19](https://github.com/shazow/apron/pull/19))

### Clarified

- **`protocol` counts spec revisions:** `protocol` goes up with each revision of the spec. Implementations of different versions still try to work together, and fall back where optional features don't match. [§3.1](https://github.com/shazow/apron/blob/protocol-v4/PROTOCOL.md#31-server-frame) ([#19](https://github.com/shazow/apron/pull/19))
- **Unknown caps are ignored:** Clients ignore caps that they don't recognize. [§4](https://github.com/shazow/apron/blob/protocol-v4/PROTOCOL.md#4-capabilities) ([#19](https://github.com/shazow/apron/pull/19))

## v3 (2026-09-22)

### Breaking

- **Message frames are flat snapshots:** Servers send each `message` notification and each `history` entry as one message object that carries its own `message_id`, `log_id`, and `room_id`, without the `params.message` wrapper. Clients read messages in this shape. [§3.5](https://github.com/shazow/apron/blob/protocol-v3/PROTOCOL.md#35-messages), [Appendix A](https://github.com/shazow/apron/blob/protocol-v3/PROTOCOL.md#appendix-a--history) ([#17](https://github.com/shazow/apron/pull/17))
- **Threads are rooms:** Clients and servers that use threads stop using the `thread` method, the message field `thread_id`, and the `thread_id` filter of `history`, because v3 removes all three. A thread is now a room with `parent_room_id`, and saving a message with a new `room_id` moves it. [§3.4](https://github.com/shazow/apron/blob/protocol-v3/PROTOCOL.md#34-rooms), [Appendix C](https://github.com/shazow/apron/blob/protocol-v3/PROTOCOL.md#appendix-c--rooms), [Appendix B](https://github.com/shazow/apron/blob/protocol-v3/PROTOCOL.md#appendix-b--edit) ([#17](https://github.com/shazow/apron/pull/17))
- **A missing `format` means plain text:** Clients that send Markdown without `body.format` add `"format": "markdown"`, because clients now render a message with no `format` as plain text, not Markdown. [§3.5](https://github.com/shazow/apron/blob/protocol-v3/PROTOCOL.md#35-messages) ([#17](https://github.com/shazow/apron/pull/17))
- **Requests may run out of order:** Clients wait for the reply to a request before they send one that depends on it, such as a `message` right after `auth`, because servers may now process requests concurrently. [§1](https://github.com/shazow/apron/blob/protocol-v3/PROTOCOL.md#1-transport--framing) ([#17](https://github.com/shazow/apron/pull/17))
- **Replies point with `reply_to`:** Clients and servers replace the string `reply_message_id` with `reply_to`, a message object. The message replied to may now be in another room. [§3.5](https://github.com/shazow/apron/blob/protocol-v3/PROTOCOL.md#35-messages) ([#17](https://github.com/shazow/apron/pull/17))
- **Rooms take `title` and `intro_message`, and `room` replaces `room_create`:** Clients and servers rename a room's `name` to `title`, and replace the plain-text `topic` with `intro_message`, a message that holds the room's description. Clients and servers with cap `rooms` create and edit rooms with the `room` request instead of `room_create`. [§3.4](https://github.com/shazow/apron/blob/protocol-v3/PROTOCOL.md#34-rooms), [Appendix C](https://github.com/shazow/apron/blob/protocol-v3/PROTOCOL.md#appendix-c--rooms) ([#17](https://github.com/shazow/apron/pull/17))
- **Extension data moves to `ext`:** Clients and servers that carried extension data in unknown message keys move it into `ext`, which clients send back unchanged on saves. They move it because unknown keys may now be dropped. [§3.5](https://github.com/shazow/apron/blob/protocol-v3/PROTOCOL.md#35-messages), [§1](https://github.com/shazow/apron/blob/protocol-v3/PROTOCOL.md#1-transport--framing) ([#17](https://github.com/shazow/apron/pull/17))
- **`anonymous` sign-in is renamed `guest`:** Clients and servers rename the auth scheme `anonymous` to `guest`. [§3.2](https://github.com/shazow/apron/blob/protocol-v3/PROTOCOL.md#32-authentication) ([#17](https://github.com/shazow/apron/pull/17))

### New

- **Reactions:** Servers can offer cap `reactions`, which lets a client set its own emoji on a message. Each set is logged, so it replays from `history` like messages. [D.2](https://github.com/shazow/apron/blob/protocol-v3/PROTOCOL.md#d2-reactions) ([#17](https://github.com/shazow/apron/pull/17))
- **Frames over byte streams:** Implementations can carry frames over TCP, stdio, or another byte stream as newline-delimited JSON, with one frame per line. WebSocket stays the reference transport. [§1](https://github.com/shazow/apron/blob/protocol-v3/PROTOCOL.md#1-transport--framing) ([#17](https://github.com/shazow/apron/pull/17))
- **`@` system identities:** Servers can give server-controlled senders, such as `@server`, a `user_id` that starts with `@`, and clients may style those senders as system messages. [J.1](https://github.com/shazow/apron/blob/protocol-v3/PROTOCOL.md#j1-system-identities) ([#17](https://github.com/shazow/apron/pull/17))

### Changed

- **One log for the whole server:** Servers number every record, room records included, in one `log_id` sequence for the whole server, taken from the commit time. A `message_id` is then unique across rooms, and a message can be named by its ID alone. [§2](https://github.com/shazow/apron/blob/protocol-v3/PROTOCOL.md#2-identifiers), [§3.4](https://github.com/shazow/apron/blob/protocol-v3/PROTOCOL.md#34-rooms) ([#17](https://github.com/shazow/apron/pull/17))
- **History compacts instead of expiring:** Servers should compact old history rather than discard it, so that `history_log_id` stays in place and clients' checkpoints stay valid. [Appendix A](https://github.com/shazow/apron/blob/protocol-v3/PROTOCOL.md#appendix-a--history) ([#17](https://github.com/shazow/apron/pull/17))
- **Deleted messages can be redacted:** Servers may rewrite earlier snapshots of a deleted message into tombstones at their original `log_id`s. Clients that hold the old content drop it. [Appendix B](https://github.com/shazow/apron/blob/protocol-v3/PROTOCOL.md#appendix-b--edit) ([#17](https://github.com/shazow/apron/pull/17))
- **No `server` frame after `unsupported`:** Servers no longer need to send a fresh `server` frame after they reply `error/unsupported`. [§3.1](https://github.com/shazow/apron/blob/protocol-v3/PROTOCOL.md#31-server-frame) ([#17](https://github.com/shazow/apron/pull/17))
- **History returns every kind of record:** Servers return room records in `rooms` and reaction sets in `reactions`, beside the message snapshots in `entries`. Clients replay all three by `log_id`, so that room changes recover like messages. [Appendix A](https://github.com/shazow/apron/blob/protocol-v3/PROTOCOL.md#appendix-a--history) ([#17](https://github.com/shazow/apron/pull/17))

## v2 (2026-09-19)

v2 is the first published spec, and renames the draft's Bottomless Chat Protocol to Apron Chat Protocol. Its core is JSON-RPC-shaped frames over a WebSocket for a `server` greeting, sign-in, rooms, and messages, with `history`, `edit`, `rooms`, `push`, threads, typing, uploads, and passkey sign-in as optional features.

### Breaking

- **Frames take JSON-RPC 2.0 shapes:** Clients and servers send `method`, `params`, `id`, `result`, and `error` in place of `type` frames and `ok` replies, with integer error codes such as `-32601` and `auth`'s scheme in `params.scheme`. Broadcasts drop `echo`, so clients match their own messages by the `message_id` in the result. [§1](https://github.com/shazow/apron/blob/protocol-v2/PROTOCOL.md#1-transport--framing), [§1.1](https://github.com/shazow/apron/blob/protocol-v2/PROTOCOL.md#11-envelope-and-replies), [§3.2](https://github.com/shazow/apron/blob/protocol-v2/PROTOCOL.md#32-authentication) ([#1](https://github.com/shazow/apron/pull/1), [#10](https://github.com/shazow/apron/pull/10))
- **Messages are snapshots:** Clients send, edit, and delete with `message`, and an edit or delete carries the message's complete editable state, in place of `send`, `update_request`, and merge patches. Servers broadcast each change as a complete snapshot, the tombstone marker is `deleted` in place of `redacted`, and the `edited` marker is gone. [§3.5](https://github.com/shazow/apron/blob/protocol-v2/PROTOCOL.md#35-messages), [§5.3](https://github.com/shazow/apron/blob/protocol-v2/PROTOCOL.md#53-edit--replacing-and-deleting-messages) ([#1](https://github.com/shazow/apron/pull/1), [86ca8c4](https://github.com/shazow/apron/commit/86ca8c4), [#5](https://github.com/shazow/apron/pull/5))
- **`history` pages snapshots, and rooms announce their bounds:** Servers answer `history` with snapshot pages in place of `history_page` and its two modes, and send `latest_log_id` and `history_log_id` with each room and page. Clients recover from those bounds, so that they notice when old history has expired. [§5.1](https://github.com/shazow/apron/blob/protocol-v2/PROTOCOL.md#51-history), [§3.4](https://github.com/shazow/apron/blob/protocol-v2/PROTOCOL.md#34-rooms) ([#1](https://github.com/shazow/apron/pull/1), [#5](https://github.com/shazow/apron/pull/5), [#11](https://github.com/shazow/apron/pull/11))
- **Threads are created with `thread`:** Clients create a thread with a `thread` request, which returns a server-assigned `thread_id`, in place of proposing an ID through `update_request`. Thread metadata takes `title` in place of `name`, and clients move messages into the thread by saving them with that `thread_id`. [§6.2](https://github.com/shazow/apron/blob/protocol-v2/PROTOCOL.md#62-threads) ([#5](https://github.com/shazow/apron/pull/5))
- **IDs end in `_id`, and authors are `from`:** Clients and servers rename ID fields such as `room` to `room_id`, identities' `id` to `user_id`, and `sender` to `from`. The same renames apply to push, which also takes `url` in place of `endpoint`. [§2](https://github.com/shazow/apron/blob/protocol-v2/PROTOCOL.md#2-identifiers-mandatory), [§3.3](https://github.com/shazow/apron/blob/protocol-v2/PROTOCOL.md#33-identity), [§6.5](https://github.com/shazow/apron/blob/protocol-v2/PROTOCOL.md#65-push) ([9072427](https://github.com/shazow/apron/commit/9072427), [#5](https://github.com/shazow/apron/pull/5))
- **Attachments are embeds:** Clients and servers put media in `body.embeds` in place of `body.attachments`. [§6.1](https://github.com/shazow/apron/blob/protocol-v2/PROTOCOL.md#61-upload), [§6.4](https://github.com/shazow/apron/blob/protocol-v2/PROTOCOL.md#64-embeds) ([9072427](https://github.com/shazow/apron/commit/9072427))
- **`nick` is `name`:** Clients rename themselves with `name`, and can also request a display name in `auth`. [§3.3](https://github.com/shazow/apron/blob/protocol-v2/PROTOCOL.md#33-identity), [§3.2](https://github.com/shazow/apron/blob/protocol-v2/PROTOCOL.md#32-authentication) ([#10](https://github.com/shazow/apron/pull/10))

### New

- **Passkey sign-in, with optional resume:** Servers can list `webauthn` in `auth` and run the ceremony that Appendix C defines. A server that also lists `token` can return a token that lets clients sign in again without a ceremony. [Appendix C](https://github.com/shazow/apron/blob/protocol-v2/PROTOCOL.md#appendix-c--webauthn-authentication-optional) ([#11](https://github.com/shazow/apron/pull/11), [#15](https://github.com/shazow/apron/pull/15))
- **Replies point at their message:** Clients can set `reply_message_id` to reply to another message in the same room, in any thread. [§3.5](https://github.com/shazow/apron/blob/protocol-v2/PROTOCOL.md#35-messages) ([a83b0f3](https://github.com/shazow/apron/commit/a83b0f3), [b169faa](https://github.com/shazow/apron/commit/b169faa))
- **Thread history and editable thread metadata:** Clients can load one thread's history with `history` and `thread_id`. On servers with `edit`, they can change a thread's `title` or `summary` with `thread`. [§5.1](https://github.com/shazow/apron/blob/protocol-v2/PROTOCOL.md#51-history), [§6.2](https://github.com/shazow/apron/blob/protocol-v2/PROTOCOL.md#62-threads) ([#5](https://github.com/shazow/apron/pull/5), [1c40bc6](https://github.com/shazow/apron/commit/1c40bc6), [dc4826c](https://github.com/shazow/apron/commit/dc4826c))

### Changed

- **Capabilities narrow to `history`, `edit`, `rooms`, and `push`:** Servers advertise `edit` in place of `redact` and `rooms` in place of `rooms.manage`, and no longer flag typing, threads, embeds, uploads, or passkeys. [§4](https://github.com/shazow/apron/blob/protocol-v2/PROTOCOL.md#4-capabilities) ([#1](https://github.com/shazow/apron/pull/1), [6b5e7b0](https://github.com/shazow/apron/commit/6b5e7b0))
- **Rooms can be withdrawn:** Servers send `room` with `removed: true` when a room leaves the client's view, and each `room` announcement replaces the previous one in full. [§3.4](https://github.com/shazow/apron/blob/protocol-v2/PROTOCOL.md#34-rooms) ([#1](https://github.com/shazow/apron/pull/1))
- **Servers choose how to generate log IDs:** Servers can generate log IDs in any way that keeps them based on epoch milliseconds and strictly increasing per room, in place of seconds plus a counter. [§2](https://github.com/shazow/apron/blob/protocol-v2/PROTOCOL.md#2-identifiers-mandatory) ([#1](https://github.com/shazow/apron/pull/1))
- **Missing fields have defaults:** Senders can leave out a message's `text` and `format`, and receivers use the defaults that PROTOCOL.md lists. [§3.5](https://github.com/shazow/apron/blob/protocol-v2/PROTOCOL.md#35-messages) ([#1](https://github.com/shazow/apron/pull/1))
- **Markdown never passes raw HTML:** Clients must disable or sanitize raw HTML in Markdown, which the draft only recommended. [§3.5](https://github.com/shazow/apron/blob/protocol-v2/PROTOCOL.md#35-messages) ([#1](https://github.com/shazow/apron/pull/1))
- **Sign-in can be waved through:** For open deployments, servers can accept `auth` with any scheme other than `webauthn` and ignore its credentials. [§3.2](https://github.com/shazow/apron/blob/protocol-v2/PROTOCOL.md#32-authentication) ([#1](https://github.com/shazow/apron/pull/1), [#11](https://github.com/shazow/apron/pull/11))
