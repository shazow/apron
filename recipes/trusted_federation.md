# Trusted federation

**Can two Apron servers share rooms?** Yes, when their operators trust each
other. A bridge copies each record of a shared room into the other server's
room, and writes it there as the user who wrote it. Clients see an ordinary
server, and need no changes.

## How it works

1. Each server makes a **link** for the other server: an account that writes
   as the other server's users ([`ext:remote`](../extensions/ext_remote.md)).
   An admin of server B runs `/remote invite wss://a.example/ws` in B's room.
   B joins the link to that room, also to a private room, and replies with a
   link that carries the link's `token`
   ([Appendix A.4](../PROTOCOL.md#a4-links)).
2. B's admin gives that link to A's operator, as an invitation to the room.
   A's operator gives it to the bridge, with the room on A that it shares.
3. The bridge signs in to B with the `token`
   ([§3.2.1](../PROTOCOL.md#321-bearer-tokens)), and to A with A's link for
   B, made the same way. It
   receives both rooms live, and catches up with `history` after an outage
   ([§4.3.5](../PROTOCOL.md#435-replay-and-recovery)).
4. The bridge writes each record of one room into the other room, through
   that server's link, with `ext.remote.user_id`. Carol's message on A
   becomes a message on B from `carol@a.example`.
5. Each server stays the authority for its own room and log. A server writes
   into its log only through its link, and only as users of the server that
   the link is bound to.

One bridge holds the whole mapping, so it can run anywhere: next to one of
the servers, or inside it, where that server's side needs no link and no
connection. A server that only accepts connections, such as one on a
serverless platform, never connects to the other server.

The copies carry the original IDs in `ext.remote`. So the bridge can rebuild
its map of IDs from both rooms, and needs to keep only where it is in each
room.

## Mapping

| Thing | How the bridge handles it |
|---|---|
| Messages | A new message with the other server's own `message_id`, `log_id`, and `embed_id`s ([§2](../PROTOCOL.md#2-identifiers), [§4.8.2](../PROTOCOL.md#482-embed-identity)). Its `ext.remote` carries the original's `room_id` and `message_id`. |
| Replies, mentions, and text | Map `reply_to.message_id` and the IDs in `mentions`. A reply to a message that the bridge never copied, such as one older than the bridge, drops `reply_to`. Rewrite each `@id` in `body.text` whose ID is in `mentions`, outside code ([Appendix A.3](../PROTOCOL.md#a3-prefixes-in-text)). A remote user maps back to its original user. A link without `server` in the text refers to the origin, so add the origin's `server` to it ([Appendix A.4](../PROTOCOL.md#a4-links)). |
| Edits, moves, and deletes | A save of the copy, with every client field ([§4.4](../PROTOCOL.md#44-edit)). A move out of the shared room deletes the copy. A move into it copies the message. |
| Reactions | A `reactions` request through the link, with the user's whole set. A record with several users, such as after a move or in compacted history, is one request for each user who is not a remote user. |
| Memberships | A remote user joins the room with its first write. The bridge copies leaves with `room_leave`. |
| Profiles | A `me` request through the link, from `user` notifications ([§3.3.3](../PROTOCOL.md#333-changes)) and from `from` when the bridge first sees a user: `name`, and a [`bio`](../extensions/ext_bio.md). `roles` stay each server's own, because a remote server's `"admin"` is not this server's admin. |
| Rooms and threads | Each pair of shared rooms is set up once, with its own link. `title` and `description` stay each server's own. A thread of a shared room needs its own pair. |
| System notices | Never copied. `~server` and `~room` speak for one server ([Appendix A.1](../PROTOCOL.md#a1-system-identities-and-scoped-notices)). |
| Custom emoji | Keys in reactions and text belong to the origin's catalog ([`ext:emoji`](../extensions/ext_emoji.md)). A server can refuse a key that it does not have. The bridge then leaves the key out, or writes it as text. |
| Uploads, avatars, emoji images, and live text | Copy them with a new `upload` embed ([§4.8.4](../PROTOCOL.md#484-embedupload)), or write a link to the original. Clients load `og` media and live text only from the server's own origins ([§4.8.1](../PROTOCOL.md#481-opengraph-metadata-og), [`ext:media`](../extensions/ext_media.md)). Live text can wait until it ends, when the origin's snapshot holds it in `body.text` or `output`. |
| Loops | Never copy a record from a remote user of the other server, from a link, or from a system identity. Read the origin from `ext.remote.server` on the user, not from the `user_id`. After it signs in, the bridge reads the address that the other server knows it by from `you.ext.remote.server`. |
| Sign-in | Optional: a server's sign-in page can let the other server's users sign in with their account there, with that server as an OpenID Connect provider ([§4.12](../PROTOCOL.md#412-external-sign-in), with [`ext:oauth`](../extensions/ext_oauth.md#identity-provider-optional)). Such an account is a local user, separate from the remote user of the same person. |

## Running it

- The bridge needs one connection to each server that it does not run in.
  Write it to fit that server's limits on frames and requests for each
  connection. A link carries every remote user's writes, so a server can give
  it larger limits.
- The bridge receives each copy that it writes, on the link's own
  connection, and skips it.
- A copy sends pushes like any message ([§4.9](../PROTOCOL.md#49-push)). After
  a long outage, the bridge can leave old messages out, or post a summary
  instead.
- A remote user is an account, so server policies that remove idle accounts,
  or rooms without new records, need to leave remote users, links, and
  shared rooms alone.
- To stop sharing, B's admin revokes the link. Remote users and their
  messages stay.

## Limits

- **Times.** A `log_id` is the commit time on its server, and only increases.
  A record that is copied late, such as after an outage, shows the time it
  was copied, at the end of the room. Clients with
  [`ext.remote`](../extensions/ext_remote.md) can show the original time.
- **Order.** Concurrent messages can appear in a different order on each
  server.
- **Throughput.** Every message of one server goes through one connection to
  the other. Catching up after a long outage takes as long as that
  connection's limits allow.
- **Moderation.** Each server moderates its own room. Deleting a remote
  user's message on one server deletes only that server's copy, and a
  tombstone has no `ext`, so the copy no longer shows its origin. Removing a
  remote user from the room stops its copies on that server: the link cannot
  write as it there again.
- **Shared editing.** Only the origin's users can save a message that
  [`ext:editors`](../extensions/ext_editors.md) shares. The bridge leaves the
  grant off its copy, and maps `edited_by`.
- **Pairs.** A remote user is never copied again, so rooms on
  three servers need a bridge for each pair of servers.
- **One shared log.** Rooms that both servers write in a single order would
  need state resolution, as in Matrix. Copying avoids that by design.
