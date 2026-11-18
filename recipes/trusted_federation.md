# Trusted federation

**Status**: Under consideration, untested.

**Can two Apron servers share rooms?** Yes, when their operators trust each
other. Each server sends the records of its own users in a shared room to
the other server, which writes them as those users. Clients see an ordinary
server, and need no changes.

## How it works

Each server gives the other one **link**: an account that writes as the other
server's users ([`ext:remote`](#draft-extension-extremote)). The rooms that a
link has joined are the rooms that the two servers share.

1. An admin of A runs `/remote invite wss://b.example/ws` in A's room, public
   or private. A joins its link for B to the room, and makes the link first if
   it has none. A replies with an **invite**: a link
   ([Appendix A.4](../PROTOCOL.md#a4-links)) that carries the room and the
   link's `token`.
2. An admin of B runs `/remote connect` with that invite in B's room. B joins
   its link for A to the room in the same way. Then B connects to A as A's
   link, and sends its own invite and A's room back with an `ext:remote`
   request. Now the two rooms are a pair, and each server can send to the
   other.
3. When a user of A writes in the room, A connects to B, signs in as its link
   with the `token` ([§3.2.1](../PROTOCOL.md#321-bearer-tokens)), and sends
   the record with `ext.remote.user_id`. B writes it as a remote user. Carol's
   message on A becomes a message on B from `carol@a.example`. B sends to A
   in the same way.
4. The side that connects can close the connection at any time, such as after
   a minute without anything to send. It connects again when it has more.
5. Each server keeps its place in its own log: the last record that the other
   server accepted. After a close, a crash, or an outage, it sends again from
   there. A pair starts where the log was when the pair was made, so older
   records of its room are never sent.
6. Each server stays the authority for its own room and log. A server writes
   as the other server's users only for the link that is bound to it.

To share another room, the admins run the same two commands in that room.
Each admin chooses the rooms on their own server, so neither server can share
a room for the other. The servers keep using the same links, and one
connection carries every room that they share.

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
| Edits, moves, and deletes | A save of the copy, with every client field ([§4.4](../PROTOCOL.md#44-edit)). A move between two rooms shared with the same server moves the copy. A move out of the shared rooms deletes the copy. A move into them creates one. When a create returns a copy that exists, also one deleted since, the sender saves it with the message's current state, which restores it. |
| Reactions | The user's whole set on the message, sent to its copy, or to the original of a copy. |
| Memberships | A remote user joins the room with its first write. A leave of a user that the sender has sent is a `room_leave` through the link. Leaves that the server makes on its own, such as when it retires a guest, need not be sent. |
| Profiles | A `me` request through the link when the sender first sends for a user, and after each change: `name`, and a [`bio`](../extensions/ext_bio.md). Profile changes are not in the log, so the sender watches them, such as through `user` notifications ([§3.3.3](../PROTOCOL.md#333-changes)). Its `you` gives the user's ID on the other server. A mention of a user who has never written makes that remote user too. `roles` stay each server's own, because a remote server's `"admin"` is not this server's admin. |
| Rooms | Each pair of shared rooms is set up once, with the two commands. `title` and `description` stay each server's own. |
| Threads | A thread of a shared room is shared with it ([§4.2](../PROTOCOL.md#42-rooms)), also a thread of a thread. A thread that only some members of the room can see is not shared, and neither is one started before its room was shared. When a user of this server starts a thread, the sender creates it on the other server with a `room_set` through the link, whose `parent_room_id` is the paired room. The two threads are then a pair, which starts empty and ends with its parent's pair. A save of the thread's `title` or `description` is a `room_set` of the other thread, as the user who saved it. A server whose room records do not say who saved them sends saves as the thread's creator. When the other server refuses the thread, such as one that allows no threads in a private room, the thread stays on this server, and the server says so in it (below). |
| System notices | Never sent. `~server` and `~room` speak for one server ([Appendix A.1](../PROTOCOL.md#a1-system-identities-and-scoped-notices)). |
| Custom emoji | Keys in reactions and text belong to the sender's catalog ([`ext:emoji`](../extensions/ext_emoji.md)). The other server can refuse a key that it does not have. The sender then leaves the key out, or writes it as text. |
| Uploads, avatars, emoji images, and live text | Copy them with a new `upload` embed ([§4.8.4](../PROTOCOL.md#484-embedupload)), or write a link to the original. Clients load `og` media and live text only from the server's own origins ([§4.8.1](../PROTOCOL.md#481-opengraph-metadata-og), [`ext:media`](../extensions/ext_media.md)). Live text can wait until it ends, when the snapshot holds it in `body.text` or `output`. |
| Loops | Send only records of this server's own users: never a record of a remote user, a link, or a system identity. Read the origin from `ext.remote` on the user, not from the `user_id`. |

## Running it

Sending:

- Make each request `id` from the record's `log_id` and the request's
  params, such as with a hash. A request sent again after a close is then a
  duplicate ([§1.2](../PROTOCOL.md#12-retries-and-deduplication)), and one
  whose params changed in between, such as a mention mapped since, is a new
  request rather than a refused one. A create is safe either way, because
  the other server finds the copy by its original `message_id`.
- Send the records of every shared room from one place in the log, in the
  order of the log, on one connection. Wait for each result before the place
  in the log moves past it.
- Write the sender to fit the other server's limits on frames and requests for
  each connection. A link carries every remote user's writes, so a server can
  give it larger limits.
- A sender needs to know who saved each room record, so that it sends its
  own users' thread saves and not those that arrived through the link.
- A Durable Object can stop while it holds a connection. Keep the place in the
  log in storage, and set an alarm to send again if records are left.
- A server that cannot connect out can have a bridge send for it: a process
  that reads its room, and sends through the other server's link.

Refusals:

- A record that the other server refuses for a limit, or that does not
  arrive because of an outage, is sent again, and needs no notice.
- Any other refused record is not sent again. Log it, so that an admin can see
  what did not arrive.
- When the other server refuses a thread, the server posts one `~room`
  notice in the thread
  ([Appendix A.1](../PROTOCOL.md#a1-system-identities-and-scoped-notices)),
  such as "This thread is not shared with b.example." It sends nothing more
  of that thread.
- When the other server refuses a message because its author was removed
  from the room there, the server tells the author with a `~private`
  notice, such as "Not sent to b.example: you were removed from this room
  there."

Server policies:

- A server that refuses connections from automated clients or cloud
  platforms, such as requests from other Cloudflare Workers, needs to let
  links connect.
- A remote user is an account, so policies that remove idle accounts, or
  rooms without new records, need to leave remote users, links, and shared
  rooms alone.
- The receiving server keeps the key of each copy for as long as the copy
  exists, also after a delete, so that a create sent again finds it.
- A copy sends pushes like any message ([§4.9](../PROTOCOL.md#49-push)). After
  a long outage, the sender can leave old messages out, or post a summary
  instead.

Sharing:

- To stop sharing one room, either admin runs `/remote unshare` in it. The
  server removes its link from the room, and tells the other server, which
  removes its link from its room too. To stop sharing every room, either
  admin revokes the link. Remote users and their messages stay.
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
class Remote {                  // user.ext.remote, message.ext.remote, room.ext.remote
  server: string;               // the remote server's address (§1)
  user_id?: string;             // the user on the remote server; absent on a link
  room_id?: string;             // on a message or a thread: its room on the remote server
  message_id?: string;          // on a message: its ID on the remote server
}
```

Remote users:

- The server sets `remote` on the user object of each remote user and link,
  on the messages of remote users, and on the threads that a link creates.
  Recorded user objects of remote users carry it too.
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
- Clients show a room that a link has joined, and its threads, as shared with
  the link's `server`, such as "Shared with a.example".
- `message_id` is also the time of the message on the remote server
  ([§2.2](../PROTOCOL.md#22-message_id)). Clients can show it as the time of
  the message.

Links:

- A link is bound to one remote server, and writes only for it. How an
  operator makes a link is server policy. Suggested convention: an admin's
  `/remote invite <address>` in a room joins the server's link for that
  address to the room, and replies with an invite: a link
  ([Appendix A.4](../PROTOCOL.md#a4-links)) with `server`, `room`, and the
  link's `token`. `/remote connect <invite>` does the same for the invite's
  `server`, and sends this server's own invite back with an `ext:remote`
  request. Both commands make the link only if there is none.
- The server keeps a link's `token`, and every invite, off user objects.
- A link's connection can close at any time. Nothing that the server keeps
  depends on it.

Pairs:

- An `ext:remote` request from a link carries `room_id`, a room of this
  server, and `link`: an invite of the link's server. It pairs the two rooms,
  and gives this server the way to send the records of its room back. A
  later request for the same room replaces the pair. The result is `{}`.
- The server refuses the request with `invalid_params` when the link has not
  joined `room_id` (otherwise the other server could choose which of this
  server's rooms it receives), or when the invite's `server` is not the
  link's server (otherwise whoever holds the token could make the server
  connect elsewhere, or show its users as another server's). A request from
  any other user is `denied`.
- An `ext:remote` request without `link` ends the pair of `room_id`, and the
  server removes the link from the room. Either server can end a pair, but
  only the server whose room it is can start one.
- The server sends the records of a room only while the room has a pair, and
  the link has joined the room. When the link leaves the room, the server
  ends the pair, and tells the other server with an `ext:remote` request
  without `link`.

```jsonc
// -> from B, signed in as A's link for B: pair A's room ops with B's room 1724803399000
{
  "method": "ext:remote", "id": "r1", "params": {
    "room_id": "ops",
    "link": "https://link.apron.chat/#server=wss://b.example/ws&room=1724803399000&token=apron_invite_Hk41x9…"
  }
}
// <-
{"id": "r1", "result": {}}
```

Acting as remote users:

- A `message`, `reactions`, `me`, `room_leave`, or `room_set` request from a
  link with `ext.remote.user_id` acts as the remote user with that `user_id`
  on the link's server. The server makes the remote user if it does not
  exist. A link's requests without `ext.remote.user_id` act as the link.
- These requests follow the rules for that user. For example, only the remote
  user who sent a message can save it ([§4.4](../PROTOCOL.md#44-edit)).
- A link acts only in rooms that it has joined, and in their threads. The
  error for any other room, `denied`, or `invalid_params` for a room that the
  link cannot see ([§1.1](../PROTOCOL.md#11-envelope-and-replies)), carries
  `"data": {"ext": {"remote": "not_joined"}}`. The sender then ends its pair
  for that room.
- A remote user's first write in a room joins it to the room
  ([§4.2.2](../PROTOCOL.md#422-membership)), also after it left. A remote
  user that another user removed is not joined again.
- The server sets `server` in `remote` to the link's server. It keeps
  `room_id` and `message_id` from the request, or from the saved message when
  the request leaves them out.
- A create from a link whose `message_id` in `remote` matches a message that
  the link already wrote, also one moved or deleted since, is a duplicate
  ([§1.2](../PROTOCOL.md#12-retries-and-deduplication)): its result carries
  that message's `message_id`. (A `message_id` is unique across the remote
  server's rooms, [§2.2](../PROTOCOL.md#22-message_id).)
- The result of a `me` request from a link carries the remote user as `you`.
- A `room_set` from a link creates or saves a thread of a room that the link
  has joined, and nothing else. Everyone who can see the parent can see a
  thread that it creates. Saves of a thread's `title` and `description`
  follow the rules for the remote user, such as that any member may save a
  thread.
- A thread that a link creates is paired with the thread on the link's server
  that its `ext.remote.room_id` refers to. A create whose
  `ext.remote.room_id` matches a thread that the link already created is a
  duplicate: its result carries that thread's `room_id`.
- Threads that remote users create count toward the server's limits on
  threads. Suggested convention: a limit for each link, below the server's
  own.

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
- **Refused threads.** A thread that the other server refuses stays on one
  server. Its notice says so, but the people on the other server do not see
  it.
- **Pairs.** A remote user's records are never sent on, so rooms on three
  servers need links between each pair of servers.
- **One shared log.** Rooms that both servers write in a single order would
  need state resolution, as in Matrix. Copying avoids that by design.
