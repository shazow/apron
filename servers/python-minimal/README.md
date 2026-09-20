# Apron Chat Server

A small, single-file Python server for [Apron Chat Protocol](https://github.com/shazow/apron/blob/main/PROTOCOL.md), intended for trusted, compliant clients.

## Run

Requires Python 3.10+. With `uv`, the WebSocket dependency is installed automatically:

```sh
uv run apron_server.py --host 0.0.0.0 --port 8765
```

## Features

- One shared room: `general`.
- Anonymous authentication and changeable display names.
- Ordered message broadcasts, including to the sender.
- Replies to retained messages; message bodies, embeds, and extension fields pass through.
- In-memory history of the latest 1,000 messages, with inclusive `after`/`before` pagination. Pages default to 50 entries, capped at 200.

## Assumptions

- The server runs in a trusted environment; anyone who can connect may read and post to `general`.
- Clients follow the protocol and send well-formed JSON with valid field types and values.
- Clients keep up with incoming messages; the server does not bound per-client outgoing buffers.

## Limits

- History is held in memory; restarting clears it.
- Reconnecting assigns a new anonymous identity.
- Replies must target a message still retained in history.
- Edits, deletions, threads, and uploads are unsupported.
- Requests are not deduplicated; retrying a message may create a duplicate.
- Malformed requests may close the connection instead of returning protocol errors.
- No credentials or rate limits are enforced.
- Incoming frames are limited to 256 KiB.
