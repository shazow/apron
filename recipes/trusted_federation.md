# Trusted federation

**Can two Apron servers share rooms?** Yes, when their operators trust each
other. Each server mirrors the other's rooms into its own log. Clients see an
ordinary server, and need no changes.

## How it works

1. A mirror connects to the other server as a client: a bot user
   (`roles: ["bot"]`) that signs in with `token` and joins the shared rooms
   ([§3.2](../PROTOCOL.md#32-authentication),
   [§4.2.2](../PROTOCOL.md#422-membership)). It keeps the latest `token` that
   the other server sends ([§3.2.1](../PROTOCOL.md#321-bearer-tokens)).
2. It receives the other server's records live, and catches up with `history`
   after an outage ([§4.3.5](../PROTOCOL.md#435-replay-and-recovery)).
3. The mirror runs in its own server. It writes each record into that
   server's log, as the server. The server sets `from`, so remote users appear
   as themselves, not as the bot ([§3.5](../PROTOCOL.md#35-messages)).
4. The other server runs the same mirror in the other direction. Each server
   is the authority for its own copy of the room.

Each side writes only into its own log, so no server ever posts as another
server's user. The mirror's account is a full account on the other server, so
give it only the rooms and rights that it needs.

## Mapping

| Thing | How the mirror handles it |
|---|---|
| Messages | A new snapshot with the mirror's own `message_id`, `log_id`, and `embed_id`s ([§2](../PROTOCOL.md#2-identifiers), [§4.8.2](../PROTOCOL.md#482-embed-identity)). The mirror keeps a two-way map of these IDs. The copy carries the original's IDs in [`ext.remote`](../extensions/ext_remote.md). |
| Replies, mentions, and text | Map `reply_to.message_id` and the IDs in `mentions`. Rewrite each `@id` and `#id` in `body.text` to the mapped ID ([Appendix A.3](../PROTOCOL.md#a3-prefixes-in-text)). A link without `server` in the text refers to the origin, so add the origin's `server` to it ([Appendix A.4](../PROTOCOL.md#a4-links)). |
| Edits, moves, and deletes | The origin publishes a new snapshot, and the mirror saves its copy the same way ([§4.4](../PROTOCOL.md#44-edit)). A move into a room that the mirror does not share deletes the copy. The origin does not announce a redaction ([§4.4](../PROTOCOL.md#44-edit)), so a delete on the origin can also redact the copy. |
| Reactions and memberships | Map both parts of the key: `(message_id, user_id)` and `(room_id, user_id)`. |
| Remote users | Ordinary users on the mirror, with IDs that it assigns, such as `carol@b.example`, which stays mentionable ([Appendix A.3](../PROTOCOL.md#a3-prefixes-in-text)). The mirror never gives a local user an ID in a remote user's form, and never reuses a `user_id` that was used before ([§3.2](../PROTOCOL.md#32-authentication)). IDs are opaque, so clients read the origin from [`ext.remote`](../extensions/ext_remote.md) on the user object, not from the ID. |
| Profiles | Copy them from `user` notifications ([§3.3.3](../PROTOCOL.md#333-changes)), such as `name`, `avatar`, and a [`bio`](../extensions/ext_bio.md). `roles` stay the mirror's own, because a remote server's `"admin"` is not the mirror's admin. |
| Custom emoji | Keys in reactions and text belong to the origin's catalog ([`ext:emoji`](../extensions/ext_emoji.md)). The mirror adds the ones that it sees to its own catalog as `hidden` keys, unless it already has the key. |
| Uploads, avatars, emoji images, and live text | Copy or proxy them. Clients load `og` media and live text only from the server's own origins ([§4.8.1](../PROTOCOL.md#481-opengraph-metadata-og), [§4.8.5](../PROTOCOL.md#485-embedappend), [`ext:media`](../extensions/ext_media.md)). Live text can also wait until it ends, when the origin's snapshot holds it in `body.text` or `output`. |
| Loops | Never mirror a copy that the mirror wrote, a record by a remote user, or a record by the other server's mirror, such as its joins. The ID map tells these apart. |
| Sign-in | Optional: a server's sign-in page can let the other server's users sign in with their account there, with that server as an OpenID Connect provider ([§4.12](../PROTOCOL.md#412-external-sign-in), with [`ext:oauth`](../extensions/ext_oauth.md#identity-provider-optional)). Such an account is a local user, separate from the mirror's copy of the same person. |

## Limits

- **Times.** A `log_id` is the commit time on its server, and only increases.
  A record that is mirrored late, such as after an outage, shows the time it
  was mirrored, at the end of the room. Clients with
  [`ext.remote`](../extensions/ext_remote.md) can show the original time.
- **Order.** Concurrent messages can appear in a different order on each
  server.
- **Moderation.** Deleting a remote user's message on one server deletes only
  that server's copy. To forward the deletion, the mirror needs a moderator
  account on the other server. Moves and redactions work the same way.
- **Shared editing.** Only the origin's users can save a message that
  [`ext:editors`](../extensions/ext_editors.md) shares. The mirror leaves the
  grant off its copy, and maps `edited_by`.
- **One shared log.** Rooms that both servers write in a single order would
  need state resolution, as in Matrix. Mirroring avoids that by design.
