# `ext:command_list`

Adds the `ext:command_list` request, which returns the commands
([§4.1](../PROTOCOL.md#41-command)) that the user can use. It lists them as
data, so that clients can offer commands while the user types them. Without
the extension, clients learn the server's commands only from `/help`, and
offer only the commands that they handle themselves.

```jsonc
// <- the server frame
{"method": "server", "params": {"apron": 10, "auth": ["token"], "capabilities": ["command", "ext:command_list"]}}
// -> list the commands that the user can use
{"method": "ext:command_list", "id": "c40", "params": {}}
// <-
{
  "id": "c40", "result": {
    "commands": [
      {"name": "approve", "group": "member", "description": "Approve the agent's request that you reply to", "uses": ["room_id", "reply_to"], "requires": ["reply_to"]},
      // §4.8.7 defines /avatar
      {"name": "avatar", "group": "member", "description": "Set your avatar from one attached image", "uses": ["body.embeds"], "requires": ["body.embeds"]},
      {"name": "embed-terminal", "group": "all", "description": "Get a link to stream a terminal into this room, such as a build", "hint": "[<title>]", "uses": ["room_id", "reply_to"], "requires": ["room_id"]},
      // ext:emoji defines /emoji add and /emoji remove
      {"name": "emoji add", "group": "role", "description": "Add a custom emoji, or replace its image, from one attached image", "hint": ":<name>:", "uses": ["body.embeds"], "requires": ["body.embeds"]},
      {"name": "emoji remove", "group": "role", "description": "Remove a custom emoji", "hint": ":<name>:"},
      {"name": "help", "group": "all", "description": "List the commands that you can use"},
      {"name": "kick", "group": "admin", "description": "Remove a user from this room", "hint": "@user [<reason>]", "uses": ["room_id", "body.mentions"], "requires": ["room_id", "body.mentions"]},
      {"name": "server", "group": "admin", "description": "Show this server's title, description, and avatar"},
      {"name": "server avatar", "group": "admin", "description": "Set this server's avatar from one attached image, or clear it without one", "uses": ["body.embeds"]},
      {"name": "server title", "group": "admin", "description": "Set this server's title, or clear it", "hint": "[<text>]"}
    ]
  }
}
// <- or, from a server that lists names only
{"id": "c40", "result": {"commands": [{"name": "help"}, {"name": "kick"}, {"name": "server"}]}}
```

```ts
class CommandList {             // ext:command_list result
  commands: Command[];          // in the server's order
}

class Command {                 // result.commands[]
  name: string;                 // the words after "/", such as "kick" or "emoji add"
  description?: string;         // plain text: what the command does
  hint?: string;                // plain text: the text after the name, such as "@user [<reason>]"
  uses?: string[] = [];         // the fields besides body.text that change what the command does
  requires?: string[] = [];     // the fields in uses that the command fails without
  group?: string;               // who may use it, such as "member" or "admin" (see Groups)
}
```

- A server that advertises `ext:command_list` also advertises `command`.
- The result lists the commands that the user can use on this connection, in
  at least one room. It does not say in which rooms.
- Clients send a command that is not in the result as `command`, as without
  the extension.
- Clients add the commands that they handle themselves
  ([§4.1](../PROTOCOL.md#41-command)).
- Clients keep a result for one `user_id` only
  ([§3.3.3](../PROTOCOL.md#333-changes)).

## Names

A command can take fixed words after its first word, such as `add` in
`/emoji add`. Each such form can be a command of its own in the result, with
its own description, hint, and fields.

- `name` is the words that the user types after `/`. A word is one or more
  characters other than whitespace. One space separates the words.
- Each name is in the result once.
- Names are case-sensitive. Servers match the words of a `command` against the
  names exactly, so `/Kick` is not `/kick`.
- A name can be the start of another name, such as `server` and
  `server title`. Each is a command of its own.
- Servers SHOULD list each form as a command of its own, so that clients can
  complete its words. Words that only choose a value, such as the feature in
  `/toggle activity|uploads`, can stay in `hint`.
- Clients MAY show the first word once, and offer its forms when the user
  types it.

## Hints

- `hint` describes the text after the name, in free text.
- `hint` is absent when the command takes no text after its name.
- Clients show `hint` as written, and do not parse it.

Suggested convention, based on the POSIX utility argument syntax:

- `<value>` is text that the user replaces, such as `<user_id>`.
- `[…]` is optional, such as `[<reason>]`.
- `a|b` is one of the choices, such as `list|add|remove`.
- `...` repeats the item before it, such as `<user_id>...` for one or more
  users.
- `@user` is a user and `#room` is a room, written with their prefixes
  ([A.3](../PROTOCOL.md#a3-prefixes-in-text)), such as `@user [<reason>]`.

## Uses

`uses` and `requires` refer to fields of a `command` request
([§4.1](../PROTOCOL.md#41-command)) other than `body.text`: `room_id`,
`reply_to`, `body.mentions`, and `body.embeds`.

- A command that uses `room_id` acts on the room that it is sent in, such as
  `/kick`. A command that does not use it does the same in every room.
- The room that gets a command's reply does not count as a use of `room_id`.
- Each field in `requires` is also in `uses`.
- A command that requires `room_id` acts only on a room that the client names,
  such as `/embed-terminal`. Clients send it with the `room_id` of the room
  that the user is in.
- Servers refuse a command that requires `room_id` when it comes without one,
  rather than run it in the default room
  ([§3.5](../PROTOCOL.md#35-messages)).
- Clients MAY offer a command only where its `requires` fits, such as a
  command that requires `reply_to` while the user replies to a message.

## Groups

`group` says who may use a command, so that clients can show commands in
groups.

- `group` is only for display. The result still lists only the commands that
  the user can use.
- Servers MAY send other values.
- Clients MAY show a command with another value, or without a `group`, after
  the groups below.

Clients expect these groups:

- `all`: every user.
- `guest`: users who signed in with the `guest` scheme
  ([§3.2](../PROTOCOL.md#32-authentication)).
- `member`: users who signed in another way, such as with a passkey.
- `room`: users with a part in running a room, such as the user who created
  it.
- `role`: users who hold a role ([§3.3.4](../PROTOCOL.md#334-roles)), such
  as a moderator.
- `admin`: the server's admins.

## Refreshing

Suggested convention:

- Prefer to request the list on a relevant user interaction, such as when the
  user sends `/help`, or on demand when the user first starts to enter a
  command with `/`.
- If there is no cached list, it can make sense to request it on connect,
  once signed in. Avoid doing so too often: once a day is fine, if it is
  needed at all.

## References

- [POSIX.1-2024, Utility Argument Syntax (§12.1)](https://pubs.opengroup.org/onlinepubs/9799919799/basedefs/V1_chap12.html)
