# `ext:settings`

Adds server-wide settings to the `server` frame, so that clients offer only the
controls that work. What each user may do is in
[`ext:permissions`](ext_permissions.md).

```json
"ext": {"settings": {"read_cursors": true, "read_receipts": "private", "private_rooms": 10}}
```

```ts
class Settings {                                // server.ext.settings
  read_cursors?: boolean = true;                // the server keeps read_message_id
  read_receipts?: "private" | false;            // where members see each other's read_message_id
  private_rooms?: number;                       // the most private rooms a user may be a member of
}
```

- `read_cursors: false` means that the server ignores `read_message_id`
  ([§4.6](../PROTOCOL.md#46-activity)). Clients then send none.
- `read_receipts: "private"` means that members of a private room see each
  other's `read_message_id`:
  - The server sends the `read_message_id` of a member to the other members
    of the room.
  - The server sends the kept `read_message_id` of the other members after a
    connection lists the room ([§4.2.1](../PROTOCOL.md#421-listing)).
  - The server MAY limit this to private rooms of up to a number of members
    that it chooses.
  - In any other room, including a private room past that limit, the server
    sends a `read_message_id` only to the connections of the user who sent
    it.
- A server that sends `"private"` keeps `read_message_id`, so it does not
  send `read_cursors: false`.
- Without `"private"`, `false` included, server policy decides where a
  `read_message_id` goes ([§4.6](../PROTOCOL.md#46-activity)).
- Whatever the setting, the server MUST NOT send the `read_message_id` of a
  user whose chosen status is `invisible`
  ([§4.5.1](../PROTOCOL.md#451-values)) to other users.
- `private_rooms` counts the private rooms
  ([§4.2.4](../PROTOCOL.md#424-creating-and-editing)) without a
  `parent_room_id`. Absent, there is no limit.
- Clients do not offer to create or join a private room past the limit.
