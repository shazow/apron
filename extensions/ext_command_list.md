# `ext:command_list`

Adds the `ext:command_list` request, which returns the commands
([§4.1](../PROTOCOL.md#41-command)) that the user can use in a room. It lists
what `/help` lists, as data, so that clients can offer commands while the user
types them.

```jsonc
// -> the commands that I can use in general
{"method": "ext:command_list", "id": "c40", "params": {"room_id": "general"}}
// <-
{
  "id": "c40", "result": {
    "commands": [
      {"name": "avatar", "description": "Set your avatar: send this command with one image attached"},
      {"name": "help", "description": "List the commands that you can use here"},
      {"name": "invite-device", "description": "List, get, or revoke tokens that sign in as you on another device", "hint": "list|add|remove [<id>]"},
      {"name": "kick", "description": "Remove a user from this room", "hint": "<user_id> [reason]"}
    ]
  }
}
```

```ts
class CommandListParams {       // ext:command_list params
  room_id?: string;             // as in a command; absent: the server's default room
}

class CommandList {             // ext:command_list result
  commands: Command[];          // in the order that /help lists them
}

class Command {                 // result.commands[]
  name: string;                 // as the user types it after "/", such as "kick"
  description: string;          // plain text: what the command does
  hint?: string;                // plain text: the arguments, such as "<user_id> [reason]"
}
```

- A server that advertises `ext:command_list` also advertises `command`.
- `room_id` refers to the room that a command would run in, as in a `command`
  request.
- The result lists the commands that the user can use in that room, and that
  `/help` would list there.
- `hint` describes the arguments in free text, without the command's name.
  It is absent when the command takes no arguments.
- Clients show `hint` as written, and do not parse it.
- The result does not list the commands that clients handle themselves, such
  as `/nick` as `me` ([§4.1](../PROTOCOL.md#41-command)). Clients add them.
- The result can change when the user's roles or the server's settings change.
  Clients MAY keep a result until the next `server` frame
  ([§3.1](../PROTOCOL.md#31-server-frame)), or until `you` changes
  ([§3.3.3](../PROTOCOL.md#333-changes)).
- Without the extension, clients learn the server's commands only from
  `/help`, and offer only the commands that they handle themselves.
