# Trusted federation

**Status**: Under consideration, untested.

**Can two Apron servers share rooms?** Yes, when their operators trust each
other. A bridge copies each record of a shared room into the other server's
room, and writes it there as the user who wrote it. Clients see an ordinary
server, and need no changes.

## How it works

Server A runs the bridge. Server B gives it a **link**: an account that writes
as A's users ([`ext:remote`](#draft-extension-extremote)).

1. An admin of B runs `/remote invite wss://a.example/ws` in B's room, also a
   private one. B joins a new link to the room, and replies with a link that
   carries the link's `token` ([Appendix A.4](../PROTOCOL.md#a4-links)).
2. B's admin gives that link to A's operator, as an invitation to the room.
   A's operator gives it to the bridge, with the room on A that it shares.
3. The bridge signs in to B with the `token`
   ([§3.2.1](../PROTOCOL.md#321-bearer-tokens)), and keeps that one
   connection. B sends it the room's records live, and it catches up with
   `history` after an outage
   ([§4.3.5](../PROTOCOL.md#435-replay-and-recovery)).
4. The bridge writes each record of B's room into A's room, inside A, as a
   remote user of A. Carol's message on B becomes a message on A from
   `carol@b.example`.
5. The bridge writes each record of A's room into B through the link, with
   `ext.remote.user_id`. B writes it as a remote user of B.
6. Each server stays the authority for its own room and log. B writes as A's
   users only for the link, and only for the server that the link is bound to.

Only A connects, and only A needs to write as remote users inside itself. So
a server that only accepts connections, such as one on a serverless
platform, is best as B. A bridge that runs outside both servers needs a link
on each, and a connection to each.

The copies carry the original IDs in `ext.remote`, and a repeated create
through the link returns the copy that exists. So the bridge keeps only its
place in each room, not a map of IDs.

## Mapping

| Thing | How the bridge handles it |
|---|---|
| Messages | A new message with the other server's own `message_id`, `log_id`, and `embed_id`s ([§2](../PROTOCOL.md#2-identifiers), [§4.8.2](../PROTOCOL.md#482-embed-identity)). Its `ext.remote` carries the original's `room_id` and `message_id`. |
| Replies, mentions, and text | Map `reply_to.message_id` and the IDs in `mentions`. A reply to a message that the bridge never copied, such as one older than the bridge, drops `reply_to`. Rewrite each `@id` in `body.text` whose ID is in `mentions`, outside code ([Appendix A.3](../PROTOCOL.md#a3-prefixes-in-text)). A remote user maps back to its original user. A link without `server` in the text refers to the origin, so add the origin's `server` to it ([Appendix A.4](../PROTOCOL.md#a4-links)). |
| Edits, moves, and deletes | A save of the copy, with every client field ([§4.4](../PROTOCOL.md#44-edit)). A move out of the shared room deletes the copy. A move into it copies the message. |
| Reactions | The user's whole set, as the remote user. A record with several users, such as after a move or in compacted history, is one request for each user who is not a remote user. |
| Memberships | A remote user joins the room with its first write, and leaves when its user leaves. |
| Profiles | The remote user's profile, from `user` notifications ([§3.3.3](../PROTOCOL.md#333-changes)) and from `from` when the bridge first sees a user: `name`, and a [`bio`](../extensions/ext_bio.md). `roles` stay each server's own, because a remote server's `"admin"` is not this server's admin. |
| Rooms and threads | Each pair of shared rooms is set up once, with its own link. `title` and `description` stay each server's own. A thread of a shared room needs its own pair. |
| System notices | Never copied. `~server` and `~room` speak for one server ([Appendix A.1](../PROTOCOL.md#a1-system-identities-and-scoped-notices)). |
| Custom emoji | Keys in reactions and text belong to the origin's catalog ([`ext:emoji`](../extensions/ext_emoji.md)). A server can refuse a key that it does not have. The bridge then leaves the key out, or writes it as text. |
| Uploads, avatars, emoji images, and live text | Copy them with a new `upload` embed ([§4.8.4](../PROTOCOL.md#484-embedupload)), or write a link to the original. Clients load `og` media and live text only from the server's own origins ([§4.8.1](../PROTOCOL.md#481-opengraph-metadata-og), [`ext:media`](../extensions/ext_media.md)). Live text can wait until it ends, when the origin's snapshot holds it in `body.text` or `output`. |
| Loops | Never copy a record from a remote user of the other server, from a link, or from a system identity. Read the origin from `ext.remote.server` on the user, not from the `user_id`. After it signs in, the bridge reads the address that the other server knows it by from `you.ext.remote.server`. |

## Running it

- Write the bridge to fit B's limits on frames and requests for each
  connection. A link carries every remote user's writes, so B can give it
  larger limits.
- B sends the bridge each copy that it writes through the link, and the
  bridge skips it.
- A copy sends pushes like any message ([§4.9](../PROTOCOL.md#49-push)). After
  a long outage, the bridge can leave old messages out, or post a summary
  instead.
- A remote user is an account, so server policies that remove idle accounts,
  or rooms without new records, need to leave remote users, links, and
  shared rooms alone.
- To stop sharing, B's admin revokes the link. Remote users and their
  messages stay.
- Copies need no accounts on the other server. People who also want one can
  sign in there with their own server as an OpenID Connect provider
  ([§4.12](../PROTOCOL.md#412-external-sign-in), with
  [`ext:oauth`](../extensions/ext_oauth.md#identity-provider-optional)).
  Such an account is a local user, separate from the remote user of the same
  person.

## Draft extension: `ext:remote`

This recipe needs one change to the wire, which servers advertise as the
capability `ext:remote`. It is a draft: it can still change, and it moves to
the [extensions](../EXTENSIONS.md) once it has proved itself.

Adds remote users: users of another Apron server, the remote server, who
appear on this server as its own users. A link, an account that the operator
binds to the remote server, writes as them.

```jsonc
// -> from the link that b.example's operator bound to wss://a.example/ws: Carol's message on a.example
{
  "method": "message", "id": "l9", "params": {
    "room_id": "1724803399000",
    "body": {"text": "The deploy is done."},
    "ext": {"remote": {"user_id": "carol", "room_id": "ops", "message_id": "1724803599120"}}
  }
}
// <- to the room: the message, from Carol's remote user
{
  "method": "message", "params": {
    "message_id": "1724803600000", "log_id": "1724803600000", "room_id": "1724803399000",
    "from": {
      "user_id": "carol@a.example", "name": "Carol",
      "ext": {"remote": {"server": "wss://a.example/ws", "user_id": "carol"}}
    },
    "body": {"text": "The deploy is done."},
    "ext": {"remote": {"server": "wss://a.example/ws", "user_id": "carol", "room_id": "ops", "message_id": "1724803599120"}}
  }
}
// <-
{"id": "l9", "result": {"message_id": "1724803600000"}}
```

```ts
class Remote {                  // user.ext.remote, message.ext.remote
  server: string;               // the remote server's address (§1)
  user_id?: string;             // the user on the remote server; absent on a link
  room_id?: string;             // on a message: its room on the remote server
  message_id?: string;          // on a message: its ID on the remote server
}
```

Remote users:

- The server sets `remote` on the user object of each remote user and link,
  and on the messages of remote users. Recorded user objects of remote users
  carry it too.
- The server ignores `remote` in requests, except from a link (otherwise a
  local user could claim to come from another server).
- A remote user is an ordinary user. The server assigns its `user_id`, such
  as `carol@a.example` ([Appendix A.3](../PROTOCOL.md#a3-prefixes-in-text)).
  It is the same for each pair of `server` and `user_id`, and the server never
  assigns it to another user.
- The IDs in `remote` are the remote server's. They refer to nothing on this
  server.
- `server`, `user_id`, `room_id`, and `message_id` hold the values of the link
  keys `server`, `user`, `room`, and `message`
  ([Appendix A.4](../PROTOCOL.md#a4-links)). Clients can offer a link to the
  original message, built from them.
- Clients show the host of `server` with the user's name, such as
  "Carol (a.example)". Clients read the origin from `remote`, never from the
  `user_id`.
- Clients show a room that a link has joined as shared with the link's
  `server`, such as "Shared with a.example".
- `message_id` is also the time of the message on the remote server
  ([§2.2](../PROTOCOL.md#22-message_id)). Clients can show it as the time of
  the message.

Links:

- A link is bound to one remote server, and writes only for it. How an
  operator makes a link is server policy. Suggested convention: an admin's
  `/remote invite <address>` in a room makes a link, joins it to the room,
  and replies with a link that carries the link's `token`
  ([Appendix A.4](../PROTOCOL.md#a4-links)).
- A `message`, `reactions`, `me`, or `room_leave` request from a link with
  `ext.remote.user_id` acts as the remote user with that `user_id` on the
  link's server. The server makes the remote user if it does not exist.
- These requests follow the rules for that user. For example, only the remote
  user who sent a message can save it ([§4.4](../PROTOCOL.md#44-edit)).
- The server sets `server` in `remote` to the link's server. It keeps
  `room_id` and `message_id` from the request, or from the saved message when
  the request leaves them out.
- A link acts only in rooms that it has joined. A remote user's first write in
  a room joins it to the room ([§4.2.2](../PROTOCOL.md#422-membership)), also
  after it left. A remote user that another user removed is not joined again.
- The result of a `me` request from a link carries the remote user as `you`.
- A create from a link whose `message_id` in `remote` matches a message that
  the link already wrote, also one moved or deleted since, is a duplicate
  ([§1.2](../PROTOCOL.md#12-retries-and-deduplication)): its result carries
  that message's `message_id`. (A `message_id` is unique across the remote
  server's rooms, [§2.2](../PROTOCOL.md#22-message_id).)
- A link's own requests, without `ext.remote.user_id`, act as the link.

Without the capability, clients show remote users and their messages as local
ones, and servers drop `remote` from requests.

## Limits

- **Times.** A `log_id` is the commit time on its server, and only increases.
  A record that is copied late, such as after an outage, shows the time it
  was copied, at the end of the room. Clients with
  [`ext.remote`](#draft-extension-extremote) can show the original time.
- **Order.** Concurrent messages can appear in a different order on each
  server.
- **Throughput.** Every record of both rooms goes through the link's one
  connection. Catching up after a long outage takes as long as that
  connection's limits allow.
- **Moderation.** Each server moderates its own room. Deleting a remote
  user's message on one server deletes only that server's copy, and a
  tombstone has no `ext`, so the copy no longer shows its origin. Removing a
  remote user from the room stops its copies on that server: the bridge
  cannot write as it there again.
- **Shared editing.** Only the origin's users can save a message that
  [`ext:editors`](../extensions/ext_editors.md) shares. The bridge leaves the
  grant off its copy, and maps `edited_by`.
- **Pairs.** A remote user is never copied again, so rooms on
  three servers need a bridge for each pair of servers.
- **One shared log.** Rooms that both servers write in a single order would
  need state resolution, as in Matrix. Copying avoids that by design.
