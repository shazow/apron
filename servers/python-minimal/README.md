# Apron Chat Server

A small, single-file Python server for [Apron Chat Protocol](https://github.com/shazow/apron/blob/main/PROTOCOL.md), intended for trusted, compliant clients.

## Run

Requires Python 3.10+. With `uv`, the WebSocket dependency is installed automatically:

```sh
uv run apron_server.py --host 0.0.0.0 --port 8765
```

## Features

- Apron protocol v4, advertising cap `history`.
- One shared room: `general`, titled "General", announced as a room record after authentication.
- Guest authentication (any scheme is accepted) with `guest_` user IDs and changeable display names (`auth` or `me`; `""` removes the name).
- Ordered, flat message snapshot broadcasts, including to the sender. `message_id` equals the message's creation `log_id`.
- Replies via `reply_to` (a bare `{"message_id": ...}` reference); `body` (with `format` defaulting to `plain`), embeds, and `ext` pass through.
- One server-wide `log_id` sequence covering the room record and every message.
- In-memory history of the latest 1,000 log records, with inclusive `after`/`before` pagination, `first_id`/`last_id`, and `more`. The room's creation record appears in `rooms` while retained. Pages default to 50 records, capped at 200.

## Assumptions

- The server runs in a trusted environment; anyone who can connect may read and post to `general`.
- Clients follow the protocol and send well-formed JSON with valid field types and values.
- Clients keep up with incoming messages; the server does not bound per-client outgoing buffers.

## Limits

- History is held in memory; restarting clears it. Once more than 1,000 records exist, the oldest are discarded and `history_log_id` advances.
- Reconnecting assigns a new guest identity.
- Replies must target a message still retained in history.
- Edits, deletions, moves, room creation, reactions, activity, and uploads are unsupported; `message` with a `message_id` returns `error/unsupported`.
- Requests are not deduplicated; retrying a message may create a duplicate.
- Unknown top-level message fields are dropped; use `ext` for extension data.
- Malformed requests may close the connection instead of returning protocol errors.
- No credentials or rate limits are enforced.
- Incoming frames are limited to 256 KiB.
