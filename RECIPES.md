# Recipes

How to build common things on Apron without changing the protocol. Each recipe
answers "Can Apron do X?" with an outline that stays within
[PROTOCOL.md](PROTOCOL.md). Recipes are informative. Where a recipe and
PROTOCOL.md disagree, PROTOCOL.md wins.

## Trusted federation

**Can two Apron servers share rooms?** Yes, when their operators trust each
other. Each server mirrors the other's rooms into its own log. Clients see an
ordinary server, and need no changes.

### How it works

1. A mirror connects to the other server as a client: a bot user
   (`roles: ["bot"]`) that signs in with `token` and joins the shared rooms
   ([§3.2](PROTOCOL.md#32-authentication),
   [§4.2.2](PROTOCOL.md#422-membership)).
2. It receives the other server's records live, and catches up with `history`
   after an outage ([§4.3](PROTOCOL.md#43-history)).
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
| Remote users | Ordinary users on the mirror, with IDs that it assigns, such as `carol.b.example`. Use `[A-Za-z0-9_.-]` to keep them mentionable ([Appendix A.3](PROTOCOL.md#a3-prefixes-in-text)), and never reuse a retired ID ([§3.3](PROTOCOL.md#33-identity)). |
| Uploads and streams | Copy or proxy them. Clients do not load media from other origins ([§4.8.1](PROTOCOL.md#481-opengraph-metadata-og), [§4.8.2](PROTOCOL.md#482-embed-identity)). |
| Loops | Mark mirrored records, such as `"ext": {"peer": {"origin": "b.example", "message_id": "…"}}` ([§4.12](PROTOCOL.md#412-ext)). Never mirror a record that carries the other server's mark. |
| Sign-in | Optional: one server's `external` sign-in can use the other server as its identity provider ([§4.11](PROTOCOL.md#411-email-and-external-sign-in)). |

### Limits

- **Times.** A `log_id` is the commit time on its server, and only increases.
  A record that is mirrored late, such as after an outage, shows the time it
  was mirrored, at the end of the room. The original time can travel in
  `ext.peer`, which clients ignore.
- **Order.** Concurrent messages can appear in a different order on each
  server.
- **Moderation.** Deleting a remote user's message on one server deletes only
  that server's copy. To forward the deletion, the mirror needs a moderator
  account on the other server. Moves and redactions work the same way.
- **One shared log.** Rooms that both servers write in a single order would
  need state resolution, as in Matrix. Mirroring avoids that by design.
