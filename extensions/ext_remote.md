# `ext:remote`

Adds where a user or a message comes from, for a server that copies another
Apron server's rooms into its own log, as in
[trusted federation](../recipes/trusted_federation.md). That other server is
the remote server.

```jsonc
// <- a copy of Carol's message from b.example
{
  "method": "message", "params": {
    "message_id": "1724803600000", "log_id": "1724803600000", "room_id": "general",
    "from": {
      "user_id": "carol@b.example", "name": "Carol",
      "ext": {"remote": {"server": "wss://b.example/ws", "user_id": "carol"}}
    },
    "body": {"text": "The deploy is done."},
    "ext": {"remote": {"server": "wss://b.example/ws", "room_id": "ops", "message_id": "1724803599120"}}
  }
}
```

```ts
class Remote {                  // user.ext.remote, message.ext.remote
  server: string;               // the remote server's address (§1)
  user_id?: string;             // on a user: the user's ID on the remote server
  room_id?: string;             // on a message: its room on the remote server
  message_id?: string;          // on a message: its ID on the remote server
}
```

- The server sets `remote` on the users and messages that it copies from the
  remote server.
- The server ignores `remote` in requests (otherwise a local user could claim
  to come from another server).
- The fields hold the values of the link keys `server`, `user`, `room`, and
  `message` ([Appendix A.4](../PROTOCOL.md#a4-links)). Clients MAY offer a
  link to the original, built from them.
- The IDs are the remote server's. They refer to nothing on this server.
- Clients show the host of `server` with the user's name, such as
  "Carol (b.example)".
- `message_id` is also the time of the message on the remote server
  ([§2.2](../PROTOCOL.md#22-message_id)). Clients MAY show it as the time of
  the message.
- Without the extension, clients show copied users and messages as local
  ones.
