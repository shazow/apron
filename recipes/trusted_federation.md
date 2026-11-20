# Trusted federation

**Status**: Under consideration, untested.

**Can two Apron servers share rooms?** Yes, when their operators trust each
other. One server hosts the room, and the other mirrors it: it shows the room
to its own users, and passes their writes to the host. Clients see an
ordinary server, and need no changes.

## How it works

The **owner** is the server that hosts the room. The **mirror** is the server
that shows it to its own users. The owner gives the mirror a **link**: an
account that reads the room, and writes as the mirror's users
([`ext:remote`](#draft-extension-extremote)).

1. An admin of the owner A runs `/remote invite wss://b.example/ws` in A's
   room, public or private. A joins its link for B to the room, and makes the
   link first if it has none. A replies with an **invite**: a link
   ([Appendix A.4](../PROTOCOL.md#a4-links)) that carries the room and the
   link's `token`.
2. An admin of the mirror B runs `/remote connect` with that invite. B signs
   in with the invite's `token`, and checks that the link is bound to B's own
   address (`you.ext.remote.server`). B reads A's room record
   ([§4.2.1](../PROTOCOL.md#421-listing)), and makes a **mirror room** for it,
   with A's title. The mirror room is private exactly when A's room is, so
   that its lock tells the truth. B's admin adds B's users to it as to any
   room, and is a member too.
3. B signs in to A as the link
   ([§3.2.1](../PROTOCOL.md#321-bearer-tokens)), and reads A's room: with
   `history` from where it stopped, and then live
   ([§4.3.5](../PROTOCOL.md#435-replay-and-recovery)). B writes each record
   into the mirror room, inside B. Carol's message on A becomes a message in
   B's mirror room from `carol@a.example`.
4. When a user of B writes in the mirror room, B sends the request to A
   through the link, with `ext.remote.user_id`. A writes it as a remote user,
   such as `bob@b.example`. The record then reaches B like any other record
   of the room, and B answers its user.
5. B can stay connected, or close the connection when the room is quiet. A
   wakes it with a push when the room changes
   ([§4.9](../PROTOCOL.md#49-push)).
6. A is the authority for the room: its order, its threads, and its
   moderation. B decides which of its users are in the mirror room.

Records flow one way, from the owner to the mirror. Requests flow the other
way, from the mirror to the owner. So the two servers never disagree about
the room, and a delete or an edit on the owner reaches every mirror.

To share another room, the admins run the same two commands for that room.
The owner keeps one link for each mirror server, and one connection carries
every room that the two servers share. A room can have several mirrors on
different servers. Each mirror shows the other mirrors' users as remote
users, with the server that `ext.remote` names.

## Mapping

| Thing | How the mirror handles it |
|---|---|
| Messages | The mirror writes a copy with its own `message_id` and `log_id`. The copy's `ext.remote` carries the owner's `room_id` and `message_id`. A mirror user's message is a `message` request through the link. The mirror writes the copy when the owner's record arrives, and answers its user with the copy's `message_id`. |
| Users | A record of the owner's user, or of another mirror's user, is written as a remote user ([Appendix A.3](../PROTOCOL.md#a3-prefixes-in-text)). A record of a remote user whose `ext.remote.server` is this mirror is written as the mirror's own user, `ext.remote.user_id`. The mirror keeps each user's ID on the owner, to map requests back. |
| Replies, mentions, and text | The mirror maps `reply_to.message_id` and the IDs in `mentions` both ways, through the copies' `ext.remote` and the users' IDs on the owner. It rewrites each `@id` in `body.text` whose ID is in `mentions`, outside code ([Appendix A.3](../PROTOCOL.md#a3-prefixes-in-text)). A link without `server` in the text refers to the owner, so the mirror adds the owner's `server` to it ([Appendix A.4](../PROTOCOL.md#a4-links)). |
| Edits, moves, and deletes | A new snapshot from the owner is a new snapshot of the copy. A mirror user's save is a `message` request through the link ([§4.4](../PROTOCOL.md#44-edit)). A move out of the shared rooms deletes the copy. |
| Reactions | The owner's reactions record replaces the copy's. A mirror user's reaction is a `reactions` request through the link. |
| Memberships | Like messages: the owner's membership records are copied, and the mirror's joins and leaves are requests. When it makes the mirror room, the mirror joins the owner's members to it as remote users, from the owner's member list ([§4.2.1](../PROTOCOL.md#421-listing)). It then copies each membership record, except those of links and of its own users' remote users, also after a close, from `history`. A member list that the owner cut short only adds members: the mirror cannot tell who left from it. When a user of the mirror joins or leaves the mirror room, the mirror sends a `room_join` or `room_leave` through the link. So both servers list the same people, admins included, and show the same joins and leaves. A mirror with limits on accounts or private rooms can seed fewer members, such as those who wrote recently. |
| Profiles | The mirror updates its remote users from the owner's records and `user` notifications ([§3.3.3](../PROTOCOL.md#333-changes)). It sends a `me` request through the link for its own users: when it first sends for a user, and after each change. Its `you` gives the user's ID on the owner. `roles` stay each server's own. |
| Rooms | The mirror room's `title` and `description` are the mirror's own. Its `private` is set when the mirror makes it. When the owner's room later becomes private, a public mirror room stops mirroring. When it becomes public, a private mirror room stays private. |
| Threads | The owner joins the link to each thread of a shared room that every member of the room can see. The mirror makes a thread of the mirror room for each, and writes its records there. A mirror user's new thread, or save of a thread's `title`, is a `room_set` request through the link. |
| System notices | Never copied. `~server` and `~room` speak for one server ([Appendix A.1](../PROTOCOL.md#a1-system-identities-and-scoped-notices)). |
| Custom emoji | Keys in reactions and text belong to the owner's catalog ([`ext:emoji`](../extensions/ext_emoji.md)). The owner can refuse a key that it does not have, which the mirror user sees as an error. |
| Uploads, avatars, emoji images, and live text | The mirror copies them with a new `upload` embed ([§4.8.4](../PROTOCOL.md#484-embedupload)), or writes a link to the original. Clients load `og` media and live text only from the server's own origins ([§4.8.1](../PROTOCOL.md#481-opengraph-metadata-og), [`ext:media`](../extensions/ext_media.md)). Live text can wait until it ends, when the snapshot holds it in `body.text` or `output`. |

## Running it

Reading:

- The mirror keeps its place in the owner's log, and reads from there after a
  close, a crash, or an outage. Each mirror room starts where the owner's log
  was when its `/remote connect` ran, so older records of the room are not
  copied.
- `history` without `room_id` leaves out the rooms that the link has left,
  so it never shows the link's own removal. On each connection, the mirror
  lists the link's joined rooms (`room_list`), and stops the mirror rooms
  whose room is not among them.
- A mirror that stays connected receives the room live. A mirror that sleeps
  between requests, such as a Cloudflare Durable Object, registers a `relay`
  push for the link with the wake scope `ext:remote`, closes its connection,
  and reads again when the push arrives. It also reads after its own users'
  requests, and now and then, in case a push was lost.
- The mirror reads the owner's records only from the link's connection, so
  it needs no map to tell copies from originals.

Writing:

- The mirror sends each of its users' requests with a request `id` made from
  the user and the user's own request `id`, such as a hash of the two. A
  request sent again after a close is then a duplicate
  ([§1.2](../PROTOCOL.md#12-retries-and-deduplication)).
- The owner sends the record of a request before its result
  ([§1](../PROTOCOL.md#1-transport--framing)). So when the result arrives,
  the mirror has received the record. A mirror that handles notifications
  apart from results first finishes every notification that arrived before
  the result, then answers its user. A `reactions` result carries no ID, so
  only this order ties it to its record.
- The mirror sends its users' joins and leaves in the background. One that
  the owner did not answer, such as when the connection closed, is sent
  again on the next connection.
- When the owner refuses a request, the mirror answers its user with the
  owner's error. When the owner cannot be reached, the mirror answers with an
  error, such as `retry_after`.
- When the owner accepted a request, the mirror answers with the copy, also
  when the record has not arrived yet, such as just after a new connection.
  It reads until the copy is written, for a limited time. (An error would
  make the user send the message again.) If the time runs out, its error
  is safe: the user's resend has the same request `id`, so the owner treats
  it as a duplicate.
- Write the mirror to fit the owner's limits on frames, requests, and
  `history` pages. A link carries every remote user's writes, and reads the
  whole room after an outage, so an owner can give it larger limits.

Server policies:

- A server that refuses connections from automated clients or cloud
  platforms, such as requests from other Cloudflare Workers, needs to let
  links connect, and to accept their pushes.
- A remote user is an account, so policies that remove idle accounts, or
  rooms without new records, need to leave remote users, links, and shared
  rooms alone.
- A copy sends pushes like any message ([§4.9](../PROTOCOL.md#49-push)). After
  a long outage, the mirror can leave old messages out of pushes.
- A mirror's admin or moderator who deletes a copy that they did not write
  hides it for the mirror's users: the mirror does not send the delete to the
  owner, and its later reads leave the copy hidden. The mirror keeps its
  hides apart from the owner's deletes, so that an owner's later restore of
  a deleted message still reaches the copy. A remote user that the
  mirror's admin removes from the mirror room is left out the same way.
- The owner's moderators need to be able to delete any message in the room,
  because that is the only delete that reaches every mirror.

Sharing:

- To stop sharing a room, the owner's admin removes the link from the room,
  or the mirror's admin runs `/remote unshare` in the mirror room, which makes
  the link leave the room. The mirror room then stays, with its copies, and
  takes no more writes.
- Copies need no accounts on the owner. People who also want one can sign in
  there with their own server as an OpenID Connect provider
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
// -> from the link that a.example's operator bound to wss://b.example/ws: Bob's message on b.example
{
  "method": "message", "id": "bob:c19", "params": {
    "room_id": "ops",
    "body": {"text": "The deploy is done."},
    "ext": {"remote": {"user_id": "bob"}}
  }
}
// <- to the room, the link included: the message, from Bob's remote user
{
  "method": "message", "params": {
    "message_id": "1724803600000", "log_id": "1724803600000", "room_id": "ops",
    "from": {
      "user_id": "bob@b.example", "name": "Bob",
      "ext": {"remote": {"server": "wss://b.example/ws", "user_id": "bob"}}
    },
    "body": {"text": "The deploy is done."},
    "ext": {"remote": {"server": "wss://b.example/ws", "user_id": "bob"}}
  }
}
// <-
{"id": "bob:c19", "result": {"message_id": "1724803600000"}}
```

```ts
class Remote {                  // user.ext.remote, message.ext.remote, room.ext.remote
  server: string;               // the remote server's address (§1)
  user_id?: string;             // the user on the remote server; absent on a link
  room_id?: string;             // on a copy or a mirror room: its room on the remote server
  message_id?: string;          // on a copy: its ID on the remote server
}
```

Remote users and copies:

- The server sets `remote` on the user object of each remote user and link,
  on the messages of remote users, and on copies and mirror rooms that it
  writes. Recorded user objects of remote users carry it too.
- The server ignores `remote` in requests, except from a link (otherwise a
  local user could claim to come from another server).
- A remote user is an ordinary user. Its `user_id` is the user's ID on the
  remote server, `@`, and the host of `server` with its port, if any, such as
  `carol@a.example` ([Appendix A.3](../PROTOCOL.md#a3-prefixes-in-text)). The
  server never assigns it to another user. (A mirror maps a mention of a user
  that it has not seen yet by this form.)
- Servers compare addresses, and take the host and port for a `user_id`,
  after normalization ([§1](../PROTOCOL.md#1-transport--framing)).
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
  the link's `server`, such as "Shared with b.example". They show a room with
  `remote`, and its threads, as hosted by its `server`, such as "Hosted by
  a.example".
- `message_id` is also the time of the message on the remote server
  ([§2.2](../PROTOCOL.md#22-message_id)). Clients can show it as the time of
  the message.

Links:

- A link is bound to one remote server, and writes only for it. How an
  operator makes a link is server policy. Suggested convention: an admin's
  `/remote invite <address>` in a room joins the server's link for that
  address to the room, making the link if there is none, and replies with an
  invite: a link ([Appendix A.4](../PROTOCOL.md#a4-links)) with `server`,
  `room`, and the link's `token`.
- The server keeps a link's `token`, and every invite, off user objects.
- The server joins the link to each thread of a room that the link has
  joined, when every member of the room can see the thread: to the threads
  that exist when the link joins, and to each new one.
- A link's `push_register` can carry the wake scope `ext:remote`. It wakes the
  link for every record of the rooms that the link has joined
  ([§4.9.4](../PROTOCOL.md#494-wake)), with a payload without `message`, also
  while one of the link's connections is open. The server can wait a moment,
  and send one push for several records.
- The server accepts such a registration only when its `url` is on the host
  of the link's server (otherwise a link could make the server send requests
  elsewhere). It accepts it also when it offers no other push.
- A link's connection can close at any time. Nothing that the server keeps
  depends on it.
- When a link leaves a room, or another user removes it, the server also
  removes the link's remote users from the room and its threads.

Acting as remote users:

- A `message`, `reactions`, `me`, `room_join`, `room_leave`, or `room_set`
  request from a link with `ext.remote.user_id` acts as the remote user with
  that `user_id` on the link's server. The server makes the remote user if it
  does not exist. A link's requests without `ext.remote.user_id` act as the
  link.
- `reactions`, `room_join`, and `room_leave` take `ext` for this, as `me`,
  `message`, and `room_set` do ([§4.13](../PROTOCOL.md#413-ext)).
- These requests follow the rules for that user. For example, only the remote
  user who sent a message can save it ([§4.4](../PROTOCOL.md#44-edit)).
- A link acts only in rooms that it has joined, and in their threads. The
  error for any other room, `denied`, or `invalid_params` for a room that the
  link cannot see ([§1.1](../PROTOCOL.md#11-envelope-and-replies)), carries
  `"data": {"ext": {"remote": "not_joined"}}`.
- A remote user's first write in a room joins it to the room
  ([§4.2.2](../PROTOCOL.md#422-membership)), also after it left. A remote
  user that another user removed is not joined again: the error for its
  writes and its `room_join` in that room carries
  `"data": {"ext": {"remote": "removed"}}`.
- A `room_set` from a link creates or saves a thread of a room that the link
  has joined, and nothing else.
- The server sets `server` in `remote` to the link's server.
- The result of a `me` request from a link carries the remote user as `you`.
- Threads that remote users create count toward the server's limits on
  threads. Suggested convention: a limit for each link, below the server's
  own.

Without the capability, clients show remote users and their messages as local
ones, and servers drop `remote` from requests.

## Limits

- **The owner must be up.** While the mirror cannot reach the owner, its users
  can read the mirror room, but not write in it.
- **Latency.** A mirror user's write waits for the owner. After a close, it
  also waits for a new connection and sign-in.
- **Times.** A copy's `log_id` is its commit time on the mirror. A record
  that is copied late, such as after an outage, shows the time it arrived, at
  the end of the room. Clients with
  [`ext.remote`](#draft-extension-extremote) can show the original time.
- **Moderation.** The owner's moderators moderate the room for every server.
  A mirror's admins can hide copies and remove remote users only for their
  own users. A tombstone has no `ext`, so a deleted copy no longer shows its
  origin.
- **Threads.** A thread that only some members of the owner's room can see is
  not mirrored. Some servers make each thread of a private room visible only
  to its members, and some allow no threads in a private room. So the
  threads of a private shared room are mirrored only where the owner makes
  them visible to every member, and the mirror allows them.
- **Shared editing.** Only the owner's rules decide who can save a message
  that [`ext:editors`](../extensions/ext_editors.md) shares. The mirror
  leaves the grant off its copy, and maps `edited_by`.
- **One owner.** Moving a shared room to another owner means a new room.
