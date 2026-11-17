# Trusted federation

**Status**: Under consideration, untested.

**Can two Apron servers share rooms?** Yes, when their operators trust each
other. Each server sends the records of its own users in a shared room to
the other server, which writes them as those users. Clients see an ordinary
server, and need no changes.

## How it works

Each server gives the other a **link**: an account that writes as the other
server's users ([`ext:remote`](#draft-extension-extremote)).

1. An admin of A runs `/remote invite wss://b.example/ws` in A's room, also a
   private one. A joins a new link to the room, and replies with a link that
   carries the link's `token` ([Appendix A.4](../PROTOCOL.md#a4-links)).
2. An admin of B runs `/remote connect` with that link in B's room. B keeps
   it, makes its own link for A in the same way, and replies with that link.
3. A's admin runs `/remote connect` with B's link in A's room. Now each
   server has the other's link, for the room that it shares.
4. When a user of A writes in the room, A connects to B, signs in as its link
   with the `token` ([§3.2.1](../PROTOCOL.md#321-bearer-tokens)), and sends
   the record with `ext.remote.user_id`. B writes it as a remote user. Carol's
   message on A becomes a message on B from `carol@a.example`. B sends to A
   in the same way.
5. The side that connects can close the connection at any time, such as after
   a minute without anything to send. It connects again when it has more.
6. Each server keeps its place in its own log: the last record that the other
   server accepted. After a close, a crash, or an outage, it sends again from
   there.
7. Each server stays the authority for its own room and log. A server writes
   as the other server's users only for the link that is bound to it.

Each server sends only the changes of its own users, when they happen. Neither
server keeps a connection open, or waits to hear from the other. So a server
that sleeps between requests, such as a Cloudflare Durable Object, works on
either side: its own user's write wakes it, and it can close the connection
and sleep again. While it is connected, the link also receives the room's
records ([§3.4](../PROTOCOL.md#34-rooms)), and the sender skips them.

A sender needs no map of the other server's IDs, except to its own messages'
copies. A copy on this server holds the original's IDs in `ext.remote`, and a
repeated create through the link returns the copy that exists.

## Mapping

| Thing | How the sender handles it |
|---|---|
| Messages | A create through the link. Its `ext.remote` carries the original's `room_id` and `message_id`. The result gives the copy's `message_id` on the other server. |
| Replies, mentions, and text | A reply to this server's own message refers to that message's copy. A reply to a copy refers to the original, from the copy's `ext.remote.message_id`. A reply to a message that was never copied, such as one older than the link, drops `reply_to`. A mention of a remote user refers to its original user, from the user's `ext.remote.user_id`. A mention of this server's own user refers to that user's remote user on the other server, from the result of a `me` request (below). Rewrite each `@id` in `body.text` whose ID is in `mentions`, outside code ([Appendix A.3](../PROTOCOL.md#a3-prefixes-in-text)). A link without `server` in the text refers to this server, so add its `server` to it ([Appendix A.4](../PROTOCOL.md#a4-links)). |
| Edits, moves, and deletes | A save of the copy, with every client field ([§4.4](../PROTOCOL.md#44-edit)). A move out of the shared room deletes the copy. A move into it creates one. |
| Reactions | The user's whole set on the message, sent to its copy, or to the original of a copy. |
| Memberships | A remote user joins the room with its first write. A leave is a `room_leave` through the link. |
| Profiles | A `me` request through the link when the sender first sends for a user, and after each change: `name`, and a [`bio`](../extensions/ext_bio.md). Its `you` gives the user's ID on the other server. `roles` stay each server's own, because a remote server's `"admin"` is not this server's admin. |
| Rooms and threads | Each pair of shared rooms is set up once, with a link on each side. `title` and `description` stay each server's own. A thread of a shared room needs its own pair. |
| System notices | Never sent. `~server` and `~room` speak for one server ([Appendix A.1](../PROTOCOL.md#a1-system-identities-and-scoped-notices)). |
| Custom emoji | Keys in reactions and text belong to the sender's catalog ([`ext:emoji`](../extensions/ext_emoji.md)). The other server can refuse a key that it does not have. The sender then leaves the key out, or writes it as text. |
| Uploads, avatars, emoji images, and live text | Copy them with a new `upload` embed ([§4.8.4](../PROTOCOL.md#484-embedupload)), or write a link to the original. Clients load `og` media and live text only from the server's own origins ([§4.8.1](../PROTOCOL.md#481-opengraph-metadata-og), [`ext:media`](../extensions/ext_media.md)). Live text can wait until it ends, when the snapshot holds it in `body.text` or `output`. |
| Loops | Send only records of this server's own users: never a record of a remote user, a link, or a system identity. Read the origin from `ext.remote` on the user, not from the `user_id`. |

## Running it

- Give each record that the sender sends a request `id` of its own, such as
  one made from its `log_id`. A record sent again after a close is then a
  duplicate ([§1.2](../PROTOCOL.md#12-retries-and-deduplication)).
- Send the records in the order of the log, and wait for each result before
  the place in the log moves past it.
- Write the sender to fit the other server's limits on frames and requests for
  each connection. A link carries every remote user's writes, so a server can
  give it larger limits.
- A Durable Object can stop while it holds a connection. Keep the place in the
  log in storage, and set an alarm to send again if records are left.
- A server that cannot connect out can have a bridge send for it: a process
  that reads its room, and sends through the other server's link.
- A copy sends pushes like any message ([§4.9](../PROTOCOL.md#49-push)). After
  a long outage, the sender can leave old messages out, or post a summary
  instead.
- A remote user is an account, so server policies that remove idle accounts,
  or rooms without new records, need to leave remote users, links, and
  shared rooms alone.
- To stop sharing, either admin revokes the link on their server. That stops
  the other server's records from arriving. Remote users and their messages
  stay.
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
  ([Appendix A.4](../PROTOCOL.md#a4-links)). `/remote connect <link>` keeps
  the other server's link for the room, and replies with a new link of this
  server for the other server, unless it has one.
- A link's connection can close at any time. Nothing that the server keeps
  depends on it.
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
  A record that is sent late, such as after an outage, shows the time it
  arrived, at the end of the room. Clients with
  [`ext.remote`](#draft-extension-extremote) can show the original time.
- **Order.** Concurrent messages can appear in a different order on each
  server.
- **Latency.** The first record after a close waits for a new connection and
  sign-in.
- **Throughput.** Each server's records go through one connection at a time.
  Sending after a long outage takes as long as the link's limits allow.
- **Moderation.** Each server moderates its own room. Deleting a remote
  user's message on one server deletes only that server's copy, and a
  tombstone has no `ext`, so the copy no longer shows its origin. Removing a
  remote user from the room stops its copies on that server: the link cannot
  write as it there again.
- **Shared editing.** Only the origin's users can save a message that
  [`ext:editors`](../extensions/ext_editors.md) shares. The sender leaves the
  grant off its copy, and maps `edited_by`.
- **Pairs.** A remote user's records are never sent on, so rooms on three
  servers need links between each pair of servers.
- **One shared log.** Rooms that both servers write in a single order would
  need state resolution, as in Matrix. Copying avoids that by design.
