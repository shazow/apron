# Welcome lobby

**Can a server keep newcomers in a public lobby until someone welcomes them
in?** Yes. The server shows newcomers one public room, the lobby, and hides
every other room from them. Newcomers introduce themselves there. An admin or
moderator then welcomes them in with a command, and the server shows them the
rest of the server. Clients learn all of this from frames that they already
handle. One of these frames goes past what §4.2.3 lists (step 8).

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
   - The server joins each new restricted user to the lobby, in place of the
     room where members start ([§4.2.2](../PROTOCOL.md#422-membership)).
   - The lobby is their default room
     ([§3.5.1](../PROTOCOL.md#351-creating)). A request without `room_id`
     goes there.
   - They post, edit their own messages, and react in the lobby and its
     threads. They see each other there.
   - They set a display name with `me` ([§3.3.2](../PROTOCOL.md#332-profile)),
     so that their introduction carries a name.
   - They start no room or thread, and nobody adds them to another room. The
     server refuses these requests.
   - Admins, moderators, and bots are never restricted.
3. **The lobby's description tells newcomers what to do.** When the server
   sets no `description` of its own, it uses the lobby's description in the
   `server` frame ([§3.1](../PROTOCOL.md#31-server-frame)) for a connection
   that has not signed in, and for a restricted user. A server that sets no
   `welcome` of its own can use it as `welcome` too. After an edit of the
   description, or a sign-in that changes which description applies, the
   server sends a new `server` frame. When someone welcomes the newcomer, a
   `~private` notice tells the newcomer what happened and what to do next
   ([Appendix A.1](../PROTOCOL.md#a1-system-identities-and-scoped-notices)).
4. **A newcomer who signs up becomes a waiting account.** Self sign-up makes
   an account that is still restricted
   ([§3.2](../PROTOCOL.md#32-authentication)). Examples are a passkey
   registration, a new email address or external identity, and a guest who
   adds one of these before anyone welcomes it. The account lasts across connections, so that someone
   can welcome it later. The server adds the role `waiting` to its user
   objects ([§3.3.4](../PROTOCOL.md#334-roles)). The server derives the role
   from the account's state. No command grants or stores it. An account from
   an invite, such as an invite token
   ([Appendix B.3](../PROTOCOL.md#b3-an-invite-token-signs-up-several-people)),
   is a member at once.
5. **An admin or moderator runs `/welcome`** ([§4.1](../PROTOCOL.md#41-command)).
   The command finds its target in this order:
   1. The command uses the one user in `mentions`
      ([§3.5.5](../PROTOCOL.md#355-mentions)). The text of the mention does
      not matter, such as `@guest_5` or "@Guest 5".
   2. Else, the command uses a `user_id` that is the one word after the
      command, with or without a leading `@`.
   3. Else, the command uses the author of the message in `reply_to`.

   So a moderator can reply `/welcome` to an introduction. With no target, or
   with several mentions, the command is `invalid_params`. An unknown user is
   `invalid_params` too. A sender who is not an admin or moderator gets
   `denied`. Welcoming a member changes nothing. Before the result, the
   welcomer gets a `~private` notice that says what happened.
6. **A welcomed guest adds a sign-in to become a member.** The guest gets the
   role `welcomed` in `user` notifications: `you` to its own connections, and
   `new` to the users who share the lobby with it
   ([§3.3.3](../PROTOCOL.md#333-changes)). Its notice says what to do next,
   such as "@grace welcomed you. Add a passkey to finish joining; until you
   do, closing this page ends your visit." The guest is still restricted.
   When it adds a passkey ([§4.10](../PROTOCOL.md#410-webauthn-authentication)),
   an email address ([§4.11](../PROTOCOL.md#411-email-sign-in)), or an
   external identity ([§4.12](../PROTOCOL.md#412-external-sign-in)), the
   guest becomes a member account, not a waiting one. The server gives the
   account a new `user_id` that is not a guest's, so that nobody takes the
   account for a guest. As when a guest signs in to an existing account
   ([§3.3.3](../PROTOCOL.md#333-changes)), the server announces that the guest
   left, and sends no `old`. The account joins the guest's rooms as a new
   user. What the guest posted stays the guest's.
7. **A waiting account becomes a member at once.** The server stores the
   change. It sends `user` notifications whose `roles` no longer hold
   `waiting`, and a new `server` frame if the description changes.
8. **The server shows a new member its rooms with `room_update`**
   ([§4.2.3](../PROTOCOL.md#423-updates)). It joins the member to the room
   where members start, such as `general`. The member sees that room in
   `joined`, with its members and the membership. The member keeps the lobby.
   `updated` holds the records of the other rooms that the member can now see
   and has not joined: the rooms that `room_list` would put in `not_joined`.
   §4.2.3 does not list this use of `updated`. A client that adds these
   records as rooms not joined shows them at once, and nothing reconnects. A
   client that ignores records of rooms that it does not know finds them with
   its next `room_list`. A server can split the records over several frames,
   or send only the rooms most recently active. A welcomed guest that becomes
   an account lists its rooms again, as after any sign-in
   ([§3.3.3](../PROTOCOL.md#333-changes)). A waiting account gets the frame
   with the welcome, and then a `~private` notice, such as "@grace welcomed
   you in."

Before sign-in, a newcomer sees the lobby's description:

```jsonc
// <- to a new connection while the lobby is open
{
  "method": "server", "params": {
    "apron": 10,
    "capabilities": ["command", "rooms", "history", "edit", "reactions"],
    "auth": ["webauthn", "token", "guest"], "signup": ["webauthn", "token"],
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
    "auth": ["webauthn", "token", "guest"], "signup": ["webauthn", "token"],
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
raid, and open it again. Suggested command: `/lobby close` and `/lobby open`,
with `/lobby` alone to show whether it is open. A command that only flips the
state is risky: two moderators who close the lobby at once open it again.
While the lobby is closed:

- A new connection gets a `server` frame without `guest` in `auth`, and
  without the sign-up schemes that work without an invite. `token` stays in
  `signup` when an invite is a bearer token
  ([Appendix B.3](../PROTOCOL.md#b3-an-invite-token-signs-up-several-people)).
  Otherwise `signup` is `[]`. Its description does not come from the lobby. A
  guest `auth` is `unsupported` ([§3.2](../PROTOCOL.md#32-authentication)).
- Each connected guest, also a welcomed one, gets an error without `id`, with
  the code of `denied` ([§1.1](../PROTOCOL.md#11-envelope-and-replies)).
  Then the server closes its connection. Clients do not reconnect
  automatically after `denied`, so the guest does not try a guest `auth`
  that would fail.
- Waiting accounts still sign in, see the lobby, and can be welcomed.
- Members still see the lobby.

Each change sends every connection a new `server` frame. When the lobby opens
again, all of its history is public again, also what members posted while it
was closed.

```jsonc
// <- to each connected guest; then the server closes the connection
{"error": {"code": -32001, "message": "The Public Lobby is closed. Ask for an invite link."}}
// <- to a new connection while the lobby is closed
{
  "method": "server", "params": {
    "apron": 10,
    "capabilities": ["command", "rooms", "history", "edit", "reactions"],
    "auth": ["webauthn", "token"], "signup": ["token"],
    "title": "Example Chat"
  }
}
```

## Other modes

A server can offer the lobby as one of three access modes:

- **Public**: guests see every room that is not private
  ([§4.2.4](../PROTOCOL.md#424-creating-and-editing)), as usual.
- **Lobby**: this recipe.
- **Private**: no guests, and no scheme makes an account by itself. New
  people come in only with an invite, such as an invite token
  ([Appendix B.3](../PROTOCOL.md#b3-an-invite-token-signs-up-several-people)).
  `/welcome` lets in waiting accounts from an earlier lobby. Before sign-in,
  the `server` frame holds only what signing in needs.

A closed lobby is private for newcomers, while waiting accounts keep their
place. Invites work in every mode, and make members.

## Clients

Clients need little. They already show the server's `description` and
`welcome`, show `~private` notices, merge `user` notifications, and add rooms
from `room_update`. A client can help in these ways:

- The client keeps `reply_to` on a command that the user sends as a reply.
  Then `/welcome` as a reply works.
- The client shows roles as badges ([§3.3.4](../PROTOCOL.md#334-roles)).
  Then moderators see who is `waiting` or `welcomed`.
- The client shows a guest's `user_id` beside its name, such as
  "Robin (guest_2)". Guests choose their names, so a guest can take a
  member's name. The `user_id` shows that it is a guest.
- The client offers a restricted guest a way to add a passkey, an email
  address, or an external identity to its account.
- The client adds the records in `updated` of rooms that it does not know as
  rooms not joined (step 8).

## Limits

- **Guests are ephemeral.** A welcome lasts only as long as the guest's
  connection. A welcomed guest who leaves before it signs up loses the
  welcome, and comes back as a new guest. A welcomed guest who signs in to an
  existing account signs in as that account, which stays as it is: a waiting
  account still waits.
- **A new account starts without the guest's history.** What the guest posted
  stays the guest's, and the account cannot edit it. Linking the two with
  `old` would show it as the account's only to clients that saw the change
  live, since logged records keep the old `user_id`.
- **Roles are labels.** `waiting` and `welcomed` are only for display
  ([§3.3.4](../PROTOCOL.md#334-roles)). Clients learn which rooms the user
  sees from `room_list` and `room_update`, not from roles.
- **No signal for the lobby.** No capability or `ext` key says that a server
  has a lobby, which room it is, or whether it is open. Members learn that
  the lobby is public only from its title or description.
- **`updated` for rooms not joined.** [§4.2.3](../PROTOCOL.md#423-updates)
  describes `updated` for joined rooms and their threads, not for rooms that
  become visible. A client that adds records from `updated` only for rooms
  that it knows shows the new rooms after its next `room_list`.
- **One shared lobby.** Every newcomer sees every other newcomer, and what
  they post. Everything in the lobby is public while it is open, also a
  message that a moderator moves in ([§4.4](../PROTOCOL.md#44-edit)).
- **No way back.** A member does not become a waiting account again. The
  server's moderation, such as `/kick`, handles a member who misbehaves.
