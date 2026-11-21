# `ext:command_list`

Adds the `ext:command_list` request, which returns the commands
([§4.1](../PROTOCOL.md#41-command)) that the user can use. It lists what
`/help` lists, as data, so that clients can offer commands while the user
types them.

```jsonc
// -> the commands that I can use
{"method": "ext:command_list", "id": "c40", "params": {}}
// <-
{
  "id": "c40", "result": {
    "commands": [
      {"name": "approve", "description": "Approve the agent's request that you reply to", "params": ["room_id", "reply_to"]},
      {"name": "avatar", "description": "Set your avatar: send this command with one image attached", "params": ["embeds"]},
      {"name": "help", "description": "List the commands that you can use"},
      {"name": "invite-device", "description": "List, get, or revoke tokens that sign in as you on another device", "hint": "list|add|remove [<id>]"},
      {"name": "kick", "description": "Remove a user from this room", "hint": "<user_id> [reason]", "params": ["room_id", "mentions"]}
    ]
  }
}
```

```ts
class CommandList {             // ext:command_list result
  commands: Command[];          // in the order that /help lists them
}

class Command {                 // result.commands[]
  name: string;                 // as the user types it after "/", such as "kick"
  description: string;          // plain text: what the command does
  hint?: string;                // plain text: the arguments, such as "<user_id> [reason]"
  params?: string[];            // the command params that change what it does, besides body.text
}
```

- A server that advertises `ext:command_list` also advertises `command`.
- The result lists every command that the user can use, in any room.
- `hint` describes the arguments in free text, without the command's name.
  It is absent when the command takes no arguments.
- Clients show `hint` as written, and do not parse it.
- `params` refers to the params of a `command` request: `room_id`, and the
  params that are arguments ([§4.1](../PROTOCOL.md#41-command)), such as
  `reply_to` and `embeds`. Clients ignore names that they do not know.
- A command with `room_id` in `params` acts on the room that it is sent in,
  such as `/kick`. A command without it does the same in every room.
- A param in `params` is optional. The command uses it when it is present.
- Clients MAY offer a command only where its `params` fit, such as a command
  with `reply_to` while the user replies to a message.
- The result does not list the commands that clients handle themselves, such
  as `/nick` as `me` ([§4.1](../PROTOCOL.md#41-command)). Clients add them.
- The result can change when the user's roles or the server's settings change.
  Clients MAY keep a result until the next `server` frame
  ([§3.1](../PROTOCOL.md#31-server-frame)), or until `you` changes
  ([§3.3.3](../PROTOCOL.md#333-changes)).
- Without the extension, clients learn the server's commands only from
  `/help`, and offer only the commands that they handle themselves.
