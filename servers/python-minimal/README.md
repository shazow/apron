# Apron Chat Server

A small, single-file Python server for [Apron Chat Protocol](https://github.com/shazow/apron/blob/main/PROTOCOL.md), intended for trusted, compliant clients.

## Run

Requires Python 3.10+. With `uv`, the WebSocket dependency is installed automatically:

```sh
uv run apron_server.py --host 0.0.0.0 --port 8765
```

## Features

- Apron protocol v8, advertising capability `history`.
- One shared default room, `general`: requests without `room_id` use it, and its creation record, titled "General", is in history while retained. Without capability `rooms`, clients learn the room from the messages and history in it.
- Guest authentication with `guest_` user IDs and changeable display names (`auth` or `me`; `""` clears the name). Under its guest-access policy the server accepts any scheme and ignores credentials, except `webauthn` and `email`, which are `error/unsupported`. A missing scheme is `error/invalid_params`.
- `auth` and `me` results carry the complete `you`: `user_id` and `name`. Profile `avatar` and `ext` are declined.
- Ordered, flat message snapshot broadcasts, including to the sender, before the sender's result. `message_id` equals the message's creation `log_id`. A message with no text and no embeds is neither logged nor broadcast.
- Replies via `reply_to` (a bare `{"message_id": ...}` reference); `body` (with `format` defaulting to `plain`) and embeds pass through.
- One server-wide `log_id` sequence covering the room record and every message.
- In-memory history of the latest 1,000 log records, with inclusive `after`/`before` pagination, `first_log_id`/`last_log_id`, and `more`. The room's creation record appears in `rooms` while retained. Pages default to 50 records, capped at 200.

## Assumptions

- The server runs in a trusted environment; anyone who can connect may read and post to `general`.
- Clients follow the protocol and send well-formed JSON with valid field types and values.
- Clients keep up with incoming messages; the server does not bound per-client outgoing buffers.

## Limits

- History is held in memory; restarting clears it. Once more than 1,000 records exist, the oldest are discarded and `history_log_id` advances.
- Reconnecting assigns a new guest identity.
- Replies must target a message still retained in history.
- Edits, deletions, moves, room creation, reactions, activity, status, push, and uploads are unsupported; `message` with a `message_id` returns `error/unsupported`, and so does any other unknown request.
- Without capability `ext`, the server drops `ext` that clients send.
- Requests are not deduplicated; retrying a message may create a duplicate.
- Unknown top-level message fields are dropped.
- Malformed requests may close the connection instead of returning protocol errors.
- No credentials or rate limits are enforced.
- Incoming frames are limited to 256 KiB.
