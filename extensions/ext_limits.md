# `ext:limits`

Adds a category, `data.ext.limits`, to `retry_after` errors
([§1.1](../PROTOCOL.md#11-envelope-and-replies)), so that clients hold back every
request that the same limit counts, rather than send each one to be refused.

```json
{"id": "c42", "error": {"code": -32002, "message": "Posting limit reached", "data": {"retry_after": 40, "ext": {"limits": "write"}}}}
```

| category | the limit counts                                                                       | clients hold back                  |
|----------|----------------------------------------------------------------------------------------|------------------------------------|
| `read`   | `history` or `room_list`                                                               | the refused method                 |
| `write`  | `message`, `reactions`, `room_join`, `room_leave`, and `room_set`                      | every request that `write` counts  |
| `upload` | `message` and `command` requests with a new `upload` embed ([§4.8.2](../PROTOCOL.md#482-embed-identity)) | every request that `upload` counts |

- The server sends a category only on a request that its row counts.
- The server sends `write` or `upload` only for a limit that counts every
  request in its row.
- `write` does not count `command`, because a command can do anything.
- Until the delay ends, clients hold back what the last column lists.
- Without a category that they know and that counts the refused request,
  clients handle the error as PROTOCOL.md does.
