# Candidates for RECIPES.md, EXTENSIONS.md, and FAQ.md

Local draft, not committed. Each section says which file it is for. Links use
the paths that they would have in the repository.

Scope: trusted bridging between servers whose operators trust each other,
and signing in to one server with an account on another. General federation
stays out of scope.

---

## For RECIPES.md: Trusted bridging

Replaces "Trusted federation", with the same mechanism.

**Can two Apron servers share a room?** Yes, when their operators trust each
other. Each server mirrors the other's room into its own log. Users stay on
their own server, and talk with the other server's users in the shared room.
Clients see an ordinary server.

### How it works

1. A mirror connects to the other server as a client: a bot user
   (`roles: ["bot"]`) that signs in with `token` and joins the shared rooms
   ([§3.2](PROTOCOL.md#32-authentication),
   [§4.2.2](PROTOCOL.md#422-membership)).
2. It receives the other server's records live, and catches up with `history`
   after an outage ([§4.3.5](PROTOCOL.md#435-replay-and-recovery)).
3. It writes each record into its own server's log, as that server. The server
   sets `from`, so remote users appear as themselves, not as the bot
   ([§3.5](PROTOCOL.md#35-messages)).
4. The other server runs the same mirror in the other direction. Each server
   is the authority for its own copy of the room.

Each side writes only into its own log, so no server ever posts as another
server's user. The mirror's account is a full account on the other server, so
give it only the rooms and rights that it needs.

### Mapping

| Thing | How the mirror handles it |
|---|---|
| Messages | A new snapshot with the mirror's own `message_id` and `log_id` ([§2](PROTOCOL.md#2-identifiers)). The mirror keeps a two-way map of IDs. |
| Replies and mentions | Map `reply_to.message_id` and the IDs in `mentions` through the map. |
| Edits and deletes | The origin publishes a new snapshot. The mirror writes a new snapshot of its copy. |
| Reactions and memberships | Map both parts of the key: `(message_id, user_id)` and `(room_id, user_id)`. |
| Remote users | Ordinary users on the mirror, with IDs in the form `carol@b.example`, which stay mentionable ([Appendix A.3](PROTOCOL.md#a3-prefixes-in-text)). The mirror never gives a local user an ID in a peer's form, and never reuses a retired ID ([§3.3.3](PROTOCOL.md#333-changes)). |
| Where a record comes from | [`ext:peer`](EXTENSIONS.md#extpeer) on remote users, mirrored messages, and the bridged room. Clients read the origin from it, not from the ID. |
| Loops | Never mirror a record whose `ext.peer.origin` is the server that it would go to. |
| Profiles | Copy a remote user's `name` and `avatar` from the origin's `user` notifications. Copy the avatar's image, or proxy it. |
| Uploads and live text | Copy or proxy them. Clients do not load media from other origins ([§4.8.1](PROTOCOL.md#481-opengraph-metadata-og), [§4.8.2](PROTOCOL.md#482-embed-identity), [§4.8.3](PROTOCOL.md#483-writes)). |
| Typing and status | Optional. Forward the origin's `activity` and shown `status` as the remote user's own ([§4.5](PROTOCOL.md#45-status), [§4.6](PROTOCOL.md#46-activity)). They are not logged, so nothing needs mapping. |
| Sign-in | Optional: users can also sign in to the other server with their own account ([Sign in with another Apron server](#sign-in-with-another-apron-server)). |

### Ownership

- A mirrored message belongs to its origin. Only the origin's copy is edited,
  moved, or deleted; the mirror then copies the new snapshot.
- When a remote user edits on the mirror's server, such as after signing in
  there, the server sends the change to the origin rather than editing its
  copy.

### Moderation

- Deleting a remote user's message on one server deletes only that server's
  copy, unless the mirror forwards it.
- Suggested convention: each mirror holds moderator rights in the shared room
  on the other server. A moderator's delete, ban, or removal of a remote user
  is then forwarded to the room on that user's server.
- A server can always stop mirroring, which ends the bridge on its side.

### Private rooms

- Bridging a private room gives the other server's operator a full copy of
  it, including its members.
- Bridge a private room only when the operators of both servers, and the
  room's members, agree to it. Mark the room as bridged
  ([`ext:peer`](EXTENSIONS.md#extpeer)), so that members can see it.

### Limits

- **Times.** A `log_id` is the commit time on its server, and only increases.
  A record that is mirrored late, such as after an outage, shows the time it
  was mirrored, at the end of the room. The original time travels in
  `ext.peer.log_id`, which clients MAY show.
- **Order.** Concurrent messages can appear in a different order on each
  server.
- **One shared log.** Rooms that both servers write in a single order would
  need state resolution, as in Matrix. Mirroring avoids that by design.

---

## For RECIPES.md: Sign in with another Apron server

**Can I sign in to one Apron server with my account on another?** Yes, when
the first server's operator trusts the second. Bob, who has an account on
`a.example`, signs in to `b.example` without new credentials. `b.example`
keeps its own account for him, named `bob@a.example`.

### How it works

1. A client proposes `external` sign-in to `b.example`
   ([§4.11](PROTOCOL.md#411-email-and-external-sign-in)), as for any other
   sign-in.
2. `b.example`'s sign-in page offers its trusted servers, such as "Sign in
   with a.example".
3. `b.example` sends Bob to `a.example` with OpenID Connect (OIDC), as a
   relying party. Bob signs in there, with his `a.example` passkey, and
   `a.example` asks him to allow it: "b.example wants to know that you are
   Bob."
4. `a.example` returns to `b.example`'s callback. `b.example` checks the ID
   token: its `iss` is `a.example`, and its `aud` is `b.example`.
5. `b.example` signs Bob in to `bob@a.example`, and finishes the `external`
   sign-in back to the client.

Clients see only `external`. Steps 2 to 4 are between the two servers and
the browser. Bob's passkey stays with `a.example`: `b.example` never sees it.

### Conventions

- **Discovery:** a server that offers its users' sign-in publishes OIDC
  metadata at `https://<host>/.well-known/openid-configuration`, where
  `<host>` is the host of its address.
- **Registration:** `b.example` registers with `a.example` as an OIDC client,
  or identifies itself with a client metadata document, such as
  `https://b.example/oidc-client.json`, where `a.example` accepts those.
- **`sub`:** a permanent account ID, not the `user_id`, which can change
  ([§3.3.3](PROTOCOL.md#333-changes)).
- **Accounts:** `b.example` names the account `<user>@<issuer host>`, the same
  ID that a [Trusted bridging](#trusted-bridging) mirror gives the user, so
  a mirrored user who signs in gets the same account.
- **Namespaces:** only `a.example`'s ID tokens create or sign in to
  `*@a.example` accounts. `b.example` keeps a list of the issuers that it
  trusts.
- **Consent:** `a.example` asks the first time that a user signs in to a
  server, and MAY remember the answer.

### Limits

- `b.example` depends on `a.example` to sign Bob in. Bob can add his own
  `b.example` passkey afterwards, as an addition
  ([§4.10](PROTOCOL.md#410-webauthn-authentication)), so that his account
  does not depend on `a.example` staying up.
- When `a.example` removes Bob, his `b.example` tokens keep working until they
  expire, unless `a.example` sends a backchannel logout to `b.example`.
- A message that Bob writes on `b.example` belongs to `b.example`. It is
  mirrored to `a.example` only through a bridge.

---

## For RECIPES.md: An identity provider behind `external`

**Can a server use an existing sign-in service, such as Pocket ID?** Yes. The
server is the provider's OIDC client, and offers it to clients through
`external`. Clients need no changes. (This is the flow under v10's
`external`. Under [PLAN_OAUTH.md](PLAN_OAUTH.md), Pocket ID is the
authorization server itself, and this recipe becomes a short operator guide.)

1. A client proposes `external`
   ([§4.11](PROTOCOL.md#411-email-and-external-sign-in)).
2. The proposal's `url` is a page of the server, which redirects to the
   provider.
3. The user signs in at the provider, such as with a passkey on Pocket ID's
   domain.
4. The provider returns to the server's callback. The server checks the ID
   token, and maps the provider's user to an account: `sub` to the account,
   `preferred_username` as the requested `user_id`, `name` and `picture` to
   `name` and `avatar`, and groups to `roles`.
5. The server finishes the `external` sign-in back to the client.

- The server offers `"auth": ["external", "token"]`, and no `webauthn`: the
  passkeys are at the provider.
- [`ext:auth_external`](EXTENSIONS.md#extauth_external) can label the sign-in,
  such as "Pocket ID".
- Suggested: revoke a user's tokens on the provider's backchannel logout.

---

## For EXTENSIONS.md: `ext:peer`

Marks users, messages, and rooms that a bridge copied from another server,
so that clients show where they come from, and bridges do not copy them
back. See [Trusted bridging](RECIPES.md#trusted-bridging).

```json
"ext": {"peer": {"origin": "b.example", "message_id": "1724803200042", "log_id": "1724803200042"}}
```

```ts
class Peer {                  // ext.peer on a user or a message
  origin: string;             // the host of the server it comes from
  user_id?: string;           // on a user: the user's ID on origin
  message_id?: string;        // on a message: its ID on origin
  log_id?: string;            // on a message: its log_id on origin
}

class PeerRoom {              // ext.peer on a room
  origins: string[];          // the hosts of the servers it is bridged with
}
```

- A server that lists `ext:peer` in `server.capabilities` sets `ext.peer` on
  each remote user, mirrored message, and bridged room.
- `origin` is the host of the server where the user's account, or the
  message's original, is.
- Clients show `origin` next to a remote user's name, such as
  "Carol · b.example".
- Clients show a bridged room's `origins`, such as "Bridged with b.example".
- Clients MAY show `log_id` as the message's original time. The room's order
  stays the local `log_id` order.
- A bridge never copies a record whose `origin` is the server that it would
  copy to.
- `ext.peer` is the server's claim, and clients trust it as they trust the
  server.

Without the extension, remote users appear as ordinary users, and their
`@host` IDs are opaque.

---

## For FAQ.md: Can Apron servers talk to each other?

Yes, between servers whose operators trust each other. Two servers can bridge
a room, so that their users talk together while each stays on their own
server ([Trusted bridging](RECIPES.md#trusted-bridging)). A server can also
let users sign in with their account on another server
([Sign in with another Apron server](RECIPES.md#sign-in-with-another-apron-server)).

Apron does not support general federation: an open network of servers that
do not know each other, with shared rooms that no single server owns. That
needs message signing, state resolution, and spam defenses, which Apron
leaves out to stay small.
