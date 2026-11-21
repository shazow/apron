# Welcome lobby

**Can a server keep newcomers in a public lobby until someone welcomes them
in?** Yes. The server shows newcomers one public room, the lobby, and hides
every other room from them. Newcomers introduce themselves there. An admin or
moderator then welcomes them in with a command, and the server shows them the
rest of the server. Clients learn all of this from frames that they already
handle, and need no changes.

## How it works

1. **The server keeps one public room as the lobby,** such as `lobby`, titled
   "Public Lobby". Members join it like any other public room
   ([§4.2.2](../PROTOCOL.md#422-membership)). Admins and moderators join it to
   see introductions. Only they edit its record, because its description
   speaks for the server (step 3).
2. **Newcomers see only the lobby and its threads.** Guests and waiting
   accounts (step 4) are the **restricted users**:
   - Every other room answers as a room that does not exist
     ([§1.1](../PROTOCOL.md#11-envelope-and-replies)), in every request that
     refers to it, such as `history`, `room_join`, or `reply_to`.
     `room_list` never lists it ([§4.2.1](../PROTOCOL.md#421-listing)).
   - The lobby is their default room
     ([§3.5.1](../PROTOCOL.md#351-creating)). A request without `room_id`
     goes there.
   - They post, edit their own messages, and react in the lobby and its
     threads. They see each other there.
   - They start no room or thread, and nobody adds them to another room. The
     server refuses these requests with `denied`.
   - Admins, moderators, and bots are never restricted.
3. **The lobby's description tells newcomers what to do.** The server puts it
   in the `description` of the `server` frame
   ([§3.1](../PROTOCOL.md#31-server-frame)) for a connection that has not
   signed in, and for a restricted user. A server that sets no `welcome` of
   its own can use it as `welcome` too. After an edit of the description, or
   a sign-in that changes which description applies, the server sends a new
   `server` frame. At each later step, a `~private` notice tells the newcomer
   what happened
   ([Appendix A.1](../PROTOCOL.md#a1-system-identities-and-scoped-notices)).
4. **A newcomer who signs up becomes a waiting account.** Self sign-up makes
   an account that is still restricted
   ([§3.2](../PROTOCOL.md#32-authentication)). Examples are a passkey
   registration, a new email address or external identity, and a guest who
   adds one of these. The account lasts across connections, so that someone
   can welcome it later. The server adds the role `waiting` to its user
   objects ([§3.3.4](../PROTOCOL.md#334-roles)). Nobody grants this role, and
   the server computes it each time. An account from an invite
   ([Appendix B.3](../PROTOCOL.md#b3-an-invite-token-signs-up-several-people))
   is a member at once.
5. **An admin or moderator runs `/welcome`** ([§4.1](../PROTOCOL.md#41-command)).
   The command finds its target in this order:
   - a `user_id` that is the one word after the command, with or without a
     leading `@`;
   - else the one user in `mentions`, whatever the text of the mention, such
     as a display name like "@Guest 5" ([§3.5.5](../PROTOCOL.md#355-mentions));
   - else the author of the message in `reply_to`.

   So a moderator can reply `/welcome` to an introduction. Several words
   without a mention, or several mentions, refer to no one, and the command
   is `invalid_params`. An unknown user is `invalid_params` too. Other users
   get `denied`. A member stays as it is.
   Before the result, the welcomer gets a `~private` notice that says what
   happened.
6. **A welcomed guest adds a sign-in to become a member.** The guest gets the
   role `welcomed` in `user` notifications: `you` to its own connections, and
   `new` to the users who share the lobby with it
   ([§3.3.3](../PROTOCOL.md#333-changes)). Its notice says what to do next,
   such as "@grace welcomed you. Add a passkey to finish joining; until you
   do, closing this page ends your visit." The guest is still restricted.
   When it adds a passkey ([§4.10](../PROTOCOL.md#410-webauthn-authentication)),
   an email address ([§4.11](../PROTOCOL.md#411-email-sign-in)), or an
   external identity ([§4.12](../PROTOCOL.md#412-external-sign-in)), its
   account is a member, not a waiting account. If the server gives the
   account a new `user_id`, the `user` notification carries `old`.
7. **A waiting account becomes a member at once.** The server stores the
   change. It sends `user` notifications whose `roles` no longer hold
   `waiting`, and a new `server` frame if the description changes.
8. **The server shows a new member its rooms in one `room_update`**
   ([§4.2.3](../PROTOCOL.md#423-updates)). It joins the member to the default
   room, which the member sees in `joined`, with its members and the
   membership. The member keeps the lobby. `updated` holds the records of the
   other rooms that the member can now see and has not joined: the rooms that
   `room_list` would put in `not_joined`. The client adds them as rooms not
   joined, without a new `room_list`, and nothing reconnects. A welcomed
   guest gets this frame after the result of its sign-up. A waiting account
   gets it with the welcome, and then a `~private` notice in the lobby, such
   as "@grace welcomed you in."

A newcomer sees the lobby before sign-in:

```jsonc
// <- to a new connection while the lobby is open
{
  "method": "server", "params": {
    "apron": 10,
    "capabilities": ["command", "rooms", "history", "edit", "reactions"],
    "auth": ["webauthn", "token", "guest"], "signup": ["webauthn", "guest"],
    "title": "Example Chat",
    "description": "**Public Lobby.** Say hello, and tell us why you came. An admin or moderator will welcome you in. Add a passkey to keep your place while you wait."
  }
}
```

Grace, a moderator, welcomes Ada, a waiting account, by a reply to Ada's
introduction:

```jsonc
// -> from Grace
{
  "method": "command", "id": "c40", "params": {
    "room_id": "lobby", "reply_to": {"message_id": "1724804000000"},
    "body": {"text": "/welcome"}
  }
}
// <- to Ada's connections
{"method": "user", "params": {"you": {"user_id": "ada", "name": "Ada", "roles": []}}}
// <- to the users who share a room with Ada
{"method": "user", "params": {"new": {"user_id": "ada", "name": "Ada", "roles": []}}}
// <- to Ada's connections: the description for members
{
  "method": "server", "params": {
    "apron": 10,
    "capabilities": ["command", "rooms", "history", "edit", "reactions"],
    "auth": ["webauthn", "token", "guest"], "signup": ["webauthn", "guest"],
    "title": "Example Chat",
    "description": "A chat for the Example project: releases, help, and *off-topic*."
  }
}
// <- to Ada's connections: the default room, and a room that she can now see
{
  "method": "room_update", "params": {
    "joined": [
      {
        "room_id": "general", "log_id": "1724800000000", "title": "General",
        "latest_log_id": "1724804100001", "history_log_id": "1724800000000",
        "members": [{"user_id": "ada"}, {"user_id": "bob"}, {"user_id": "grace"}]
      }
    ],
    "memberships": [
      {"log_id": "1724804100001", "room_id": "general", "members": [{"user": {"user_id": "ada", "name": "Ada"}, "joined": true}]}
    ],
    "users": [
      {"user_id": "ada", "name": "Ada"},
      {"user_id": "bob", "name": "Bob"},
      {"user_id": "grace", "name": "Grace", "roles": ["moderator"]}
    ],
    "updated": [
      {
        "room_id": "1724803399000", "log_id": "1724803399000", "title": "Ops",
        "latest_log_id": "1724803900000", "history_log_id": "1724803399000"
      }
    ]
  }
}
// <- to Ada's connections
{
  "method": "message", "params": {
    "room_id": "lobby",
    "from": {"user_id": "~private", "name": "Only you"},
    "body": {"text": "@grace welcomed you in."}
  }
}
// <- to Grace's connection
{
  "method": "message", "params": {
    "room_id": "lobby",
    "from": {"user_id": "~private", "name": "Only you"},
    "body": {"text": "@ada is in: they are a member now."}
  }
}
// <-
{"id": "c40", "result": {}}
```

## Closing the lobby

An admin or moderator can close the lobby to newcomers, such as during a
raid, and open it again. Suggested command: `/toggle lobby`. While the lobby
is closed:

- A new connection gets a `server` frame without `guest` in `auth`, and
  without the sign-up schemes that work without an invite. Its description
  does not come from the lobby. A guest `auth` is `unsupported`
  ([§3.2](../PROTOCOL.md#32-authentication)).
- Each connected guest, also a welcomed one, gets a `~private` notice, such
  as "The Public Lobby is closed." Then the server closes its connection,
  such as with WebSocket status 1008 (policy violation).
- Waiting accounts still sign in, see the lobby, and can be welcomed.
- Members still see the lobby.

Each change sends every connection a new `server` frame. When the lobby opens
again, all of its history is public again, also what members posted while it
was closed.

```jsonc
// <- to each connected guest; then the server closes the connection
{
  "method": "message", "params": {
    "room_id": "lobby",
    "from": {"user_id": "~private", "name": "Only you"},
    "body": {"text": "The Public Lobby is closed."}
  }
}
// <- to a new connection while the lobby is closed
{
  "method": "server", "params": {
    "apron": 10,
    "capabilities": ["command", "rooms", "history", "edit", "reactions"],
    "auth": ["webauthn", "token"], "signup": [],
    "title": "Example Chat"
  }
}
```

## Other modes

A server can offer the lobby as one of three access modes:

- **Public**: guests see every room that is not private
  ([§4.2.4](../PROTOCOL.md#424-creating-and-editing)), as usual.
- **Lobby**: this recipe.
- **Private**: no guests. New people come in with an invite
  ([Appendix B.3](../PROTOCOL.md#b3-an-invite-token-signs-up-several-people)),
  or with a sign-in that the server trusts. Before sign-in, the `server`
  frame holds only what signing in needs.

A closed lobby is private for newcomers, while waiting accounts keep their
place. Invites work in every mode, and make members.

## Clients

Clients need nothing special. They already show the server's `description`
and `welcome`, show `~private` notices, merge `user` notifications, and add
rooms from `room_update`. A client can help in these ways:

- The client keeps `reply_to` on a command that the user sends as a reply.
  Then `/welcome` as a reply works.
- The client shows roles as badges ([§3.3.4](../PROTOCOL.md#334-roles)).
  Then moderators see who is `waiting` or `welcomed`.
- The client offers a restricted guest a way to add a passkey, an email
  address, or an external identity to its account.
- After the server closes a connection, the client reads the next `server`
  frame before it signs in again. When `auth` no longer lists `guest`, the
  client shows the sign-in screen, and does not sign in as a guest again.

## Limits

- **Guests are ephemeral.** A welcome lasts only as long as the guest's
  connection. A welcomed guest who leaves before it signs up loses the
  welcome, and comes back as a new guest. A welcomed guest who signs in to an
  existing account takes that account's place, waiting or not.
- **Roles are labels.** `waiting` and `welcomed` are only for display
  ([§3.3.4](../PROTOCOL.md#334-roles)). Clients learn which rooms the user
  sees from `room_list` and `room_update`, not from roles.
- **No signal for the lobby.** No capability or `ext` key says that a server
  has a lobby, which room it is, or whether it is open. Members learn that
  the lobby is public only from its title or description.
- **`updated` for rooms not joined.** [§4.2.3](../PROTOCOL.md#423-updates)
  describes `updated` for joined rooms and their threads. A client that adds
  records from `updated` only for rooms that it knows shows the new rooms
  after its next `room_list`.
- **One shared lobby.** Every newcomer sees every other newcomer, and what
  they post. Everything in the lobby is public while it is open, also a
  message that a moderator moves in ([§4.4](../PROTOCOL.md#44-edit)).
- **No way back.** A member does not become a waiting account again. The
  server's moderation, such as `/kick`, handles a member who misbehaves.
