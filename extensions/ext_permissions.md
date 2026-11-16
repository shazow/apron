# `ext:permissions`

Adds the user's permissions to `you` ([§3.3](../PROTOCOL.md#33-identity)), so
that clients offer only the controls that the user may use. Roles
([§3.3.4](../PROTOCOL.md#334-roles)) are labels only, so clients cannot learn
permissions from them.

```jsonc
// a guest who only reads
"you": {"user_id": "guest_1234", "name": "Guest", "ext": {"permissions": {"write": false}}}
// an admin
"you": {"user_id": "ada", "name": "Ada", "roles": ["admin"], "ext": {"permissions": {"add_members": true, "move_any": true}}}
```

```ts
class Permissions {               // you.ext.permissions
  write?: boolean = true;         // may send the requests of the write row of ext:limits
  add_members?: boolean = false;  // may send room_join with a user_id, in any room
  move_any?: boolean = false;     // may move other users' messages
}
```

- An absent key takes its default.
- Without the extension, clients offer what PROTOCOL.md allows, and handle
  `denied`. They offer to move only the user's own messages.
- `write` refers to the requests that the `write` row of
  [`ext:limits`](ext_limits.md) lists.
- `add_members` refers to `room_join` with a `user_id`
  ([§4.2.2](../PROTOCOL.md#422-membership)). When it is `false`, clients offer
  to add users only to the private rooms that the user is a member of
  ([§4.2.4](../PROTOCOL.md#424-creating-and-editing)).
- `move_any` refers to moves ([§4.4](../PROTOCOL.md#44-edit)). When it is
  `false`, clients offer to move only the user's own messages.
- The server ignores `ext.permissions` in a `me` request.
