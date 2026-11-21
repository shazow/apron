# `ext:command_list`

Adds the `ext:command_list` request, which returns the commands
([§4.1](../PROTOCOL.md#41-command)) that the user can use. It lists what
`/help` lists, as data, so that clients can offer commands while the user
types them. Without the extension, clients learn the server's commands only
from `/help`, and offer only the commands that they handle themselves.

```jsonc
// -> the commands that I can use
{"method": "ext:command_list", "id": "c40", "params": {}}
// <-
{
  "id": "c40", "result": {
    "commands": [
      {"name": "approve", "description": "Approve the agent's request that you reply to", "params": ["room_id", "reply_to"]},
      // §4.8.7 defines /avatar: one upload embed is the new avatar
      {"name": "avatar", "description": "Set your avatar from one attached image", "params": ["embeds"]},
      {"name": "embed-terminal", "description": "Get a link to stream a terminal into this room, such as a build", "hint": "[title]", "params": ["room_id"]},
      // ext:emoji defines /emoji add and /emoji remove
      {"name": "emoji add", "description": "Add a custom emoji, or replace its image, from one attached image", "hint": ":name:", "params": ["embeds"]},
      {"name": "emoji remove", "description": "Remove a custom emoji", "hint": ":name:"},
      {"name": "help", "description": "List the commands that you can use"},
      {"name": "invite-device add", "description": "Get a token that signs in as you on another device", "hint": "[<id>]"},
      {"name": "invite-device list", "description": "List the tokens that sign in as you on other devices"},
      {"name": "invite-device remove", "description": "Revoke a token that signs in as you on another device", "hint": "<id>"},
      {"name": "kick", "description": "Remove a user from this room", "hint": "<user_id>", "params": ["room_id"]},
      {"name": "passkeys", "description": "List your account's passkeys"},
      {"name": "passkeys remove", "description": "Remove one of your account's passkeys", "hint": "<n>"},
      {"name": "server", "description": "Show this server's title, description, and avatar"},
      {"name": "server avatar", "description": "Set this server's avatar from one attached image, or clear it", "params": ["embeds"]},
      {"name": "server description", "description": "Set this server's description, or clear it", "hint": "[<text>]"},
      {"name": "server title", "description": "Set this server's title, or clear it", "hint": "[<text>]"}
    ]
  }
}
```

```ts
class CommandList {             // ext:command_list result
  commands: Command[];          // in the order that /help lists them
}

class Command {                 // result.commands[]
  name: string;                 // the words after "/", such as "kick" or "emoji add"
  description: string;          // plain text: what the command does
  hint?: string;                // plain text: the arguments, such as "<user_id>"
  params?: string[];            // the command params that change what it does, besides body.text
}
```

- A server that advertises `ext:command_list` also advertises `command`.
- The result lists every command that the user can use, in any room.
- The result does not list the commands that clients handle themselves, such
  as `/nick` as `me` ([§4.1](../PROTOCOL.md#41-command)). Clients add them.
- A command that PROTOCOL.md or another extension defines keeps that
  definition, such as `/avatar`
  ([§4.8.7](../PROTOCOL.md#487-avatars)).
- The result can change when the user's roles or the server's settings change.

## Names

A command can take a fixed word after its name, such as `add` in
`/emoji add`. Each such form is a command of its own in the result, with its
own description, hint, and params.

- `name` is one or more words, with one space between them. The words are what
  the user types after `/`.
- Commands whose names start with the same word are forms of one command.
- A name can be the start of another name. Each is a command of its own, such
  as `server`, which shows the values, and `server title`, which sets one.
- Clients MAY show the first word once, and offer its forms when the user
  types it.

## Hints

- `hint` describes the arguments in free text, without the command's name.
- `hint` is absent when the command takes no arguments.
- Clients show `hint` as written, and do not parse it.

## Params

`params` lists the params of a `command` request, besides `body.text`, that
change what the command does. They are `room_id`, and the params that are
arguments ([§4.1](../PROTOCOL.md#41-command)), such as `reply_to` and `embeds`.

- Clients ignore names that they do not know.
- A command with `room_id` acts on the room that it is sent in, such as
  `/kick`. A command without it does the same in every room.
- A param in `params` is optional. The command uses it when it is present.
- Clients MAY offer a command only where its `params` fit, such as a command
  with `reply_to` while the user replies to a message.

## Refreshing

Suggested convention:

- Prefer to request the list on a relevant user interaction, such as when the
  user sends `/help`, or on demand when the user first starts to enter a
  command with `/`.
- If there is no cached list, it can make sense to request it on connect.
  Avoid doing so too often: once a day is fine, if it is needed at all.
