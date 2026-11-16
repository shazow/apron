# `ext:peer`

Adds where a user or a message comes from, for a server that copies another
Apron server's rooms into its own log, as in
[trusted federation](../recipes/trusted_federation.md). That other server is
the origin.

```jsonc
// <- a copy of Carol's message from b.example
{
  "method": "message", "params": {
    "message_id": "1724803600000", "log_id": "1724803600000", "room_id": "general",
    "from": {
      "user_id": "carol@b.example", "name": "Carol",
      "ext": {"peer": {"server": "wss://b.example/ws", "user_id": "carol"}}
    },
    "body": {"text": "The deploy is done."},
    "ext": {"peer": {"server": "wss://b.example/ws", "room_id": "ops", "message_id": "1724803599120"}}
  }
}
```

```ts
class Peer {                    // user.ext.peer, message.ext.peer
  server: string;               // the origin's address (§1)
  user_id?: string;             // on a user: the user's ID on the origin
  room_id?: string;             // on a message: its room on the origin
  message_id?: string;          // on a message: its ID on the origin
}
```

- The server sets `peer` on the users and messages that it copies from the
  origin.
- The server ignores `peer` in requests (otherwise a local user could claim
  another origin).
- `server` is the origin's address ([§1](../PROTOCOL.md#1-transport--framing)),
  as in a link ([Appendix A.4](../PROTOCOL.md#a4-links)).
- The other IDs are the origin's. They refer to nothing on this server.
- Clients show the host of `server` with the user's name, such as
  "Carol (b.example)".
- `message_id` is also the time of the message on the origin
  ([§2.2](../PROTOCOL.md#22-message_id)). Clients MAY show it as the time of
  the message.
- Clients MAY offer a link to the original, built from `server` and the IDs
  ([Appendix A.4](../PROTOCOL.md#a4-links)).
- Without the extension, clients show copied users and messages as local
  ones.
