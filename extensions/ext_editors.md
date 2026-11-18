# `ext:editors`

Lets the sender of a message share the editing of its text with the users
that it mentions, such as a list that the people in it keep up to date.

```jsonc
// -> Alice shares the text with the users that it mentions
{
  "method": "message", "id": "c70", "params": {
    "room_id": "general",
    "body": {"text": "Lunch orders, @bob @carol:\n- Alice: soup", "mentions": ["bob", "carol"]},
    "ext": {"editors": {"body.text": "mentioned"}}
  }
}
// -> Bob saves the text
{
  "method": "message", "id": "c71", "params": {
    "message_id": "1724803200042", "room_id": "general",
    "body": {"text": "Lunch orders, @bob @carol:\n- Alice: soup\n- Bob: salad"}
  }
}
// <- the server keeps every other field
{
  "method": "message", "params": {
    "message_id": "1724803200042", "log_id": "1724803312007", "room_id": "general",
    "prev_log_id": "1724803200042",
    "from": {"user_id": "alice", "name": "Alice"},
    "body": {"text": "Lunch orders, @bob @carol:\n- Alice: soup\n- Bob: salad", "mentions": ["bob", "carol"]},
    "ext": {"editors": {"body.text": "mentioned", "edited_by": "bob"}}
  }
}
```

```ts
class Editors {                 // message.ext.editors
  "body.text"?: "mentioned";    // who else may save body.text
  edited_by?: string;           // set by the server: who saved this snapshot, if not the sender
}
```

- Each key other than `edited_by` is the path of a client field of the
  message ([§3.5](../PROTOCOL.md#35-messages)).
- `"mentioned"` lets each user in the current `body.mentions` save that field
  ([§4.4](../PROTOCOL.md#44-edit)).
- A save by such a user changes only the shared fields. The server keeps
  every other field from the current snapshot, `ext` included. (Otherwise the
  user could change `mentions` or the grant.)
- When a user other than the sender saves the message, the server sets
  `edited_by` to that user's `user_id`. It removes `edited_by` on the
  sender's saves, and ignores it in requests.
- Clients show `edited_by` with the message, such as "edited by Bob".
  (Otherwise the edited text reads as the sender's words.)
- Clients offer the editing that a grant allows. A key or value that a
  client or server does not know shares nothing.
- Without the extension, clients do not send `editors`, and offer editing only
  to the sender.
