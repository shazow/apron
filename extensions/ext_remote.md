# `ext:remote`

Adds remote users: users of another Apron server, the remote server, who
appear on this server as its own users. A link, an account that the operator
binds to the remote server, writes as them. This lets one bridge share rooms
between two servers, as in
[trusted federation](https://github.com/shazow/apron/blob/main/recipes/trusted_federation.md).

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

## Remote users

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
  ([Appendix A.4](../PROTOCOL.md#a4-links)). Clients MAY offer a link to the
  original message, built from them.
- Clients show the host of `server` with the user's name, such as
  "Carol (a.example)". Clients read the origin from `remote`, never from the
  `user_id`.
- Clients show a room that a link has joined as shared with the link's
  `server`, such as "Shared with a.example".
- `message_id` is also the time of the message on the remote server
  ([§2.2](../PROTOCOL.md#22-message_id)). Clients MAY show it as the time of
  the message.

## Links

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
  a room joins it to the room ([§4.2.2](../PROTOCOL.md#422-membership)). A
  remote user who left or was removed is not joined again.
- The result of a `me` request from a link carries the remote user as `you`.
- A create from a link whose `room_id` and `message_id` match a message that
  the link already wrote is a duplicate ([§1.2](../PROTOCOL.md#12-retries-and-deduplication)):
  its result carries that message's `message_id`.
- A link's own requests, without `ext.remote.user_id`, act as the link.

Without the extension, clients show remote users and their messages as local
ones, and servers drop `remote` from requests.
