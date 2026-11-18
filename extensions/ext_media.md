# `ext:media`

Adds the server's media origins and file limits to the `server` frame, so
that clients load media from them and fit a file before they upload it.

```json
"ext": {"media": {
  "origins": ["https://media.chat.example"],
  "upload": {"image/*": {"max_bytes": 5242880, "max_side": 2048}, "audio/*": {"max_bytes": 10485760}},
  "avatar": {"image/*": {"max_bytes": 262144, "max_side": 512}},
  "emoji": {"image/png": {"max_bytes": 262144}, "image/gif": {"max_bytes": 262144}}
}}
```

```ts
class Media {                     // server.ext.media
  origins?: string[];             // other origins that serve the server's media
  upload?: {[pattern: string]: Limits};  // files for upload embeds (§4.8.4)
  avatar?: {[pattern: string]: Limits};  // images for avatars (§4.8.7)
  emoji?: {[pattern: string]: Limits};   // images for custom emoji (ext:emoji)
}

class Limits {
  max_bytes?: number;             // the largest file, in bytes
  max_side?: number;              // the longest image side, in pixels, after the server scales it down
}
```

- An origin is `scheme://host[:port]`. It is `https:`, or `http:` on a
  loopback host. Clients ignore other entries.
- Clients MAY load the `og` media
  ([§4.8.1](../PROTOCOL.md#481-opengraph-metadata-og)) of the server's content
  from `origins`.
- A pattern is a MIME type, `type/*`, or `*/*`. Patterns and types match
  without regard to case.
- A file takes only the `Limits` of its most specific pattern. Limits do not
  combine across patterns.
- The server accepts only the types that match a pattern. A pattern whose
  `Limits` is `{}` accepts its types without a limit.
- A file's type is the `Content-Type` of its write
  ([§4.8.3](../PROTOCOL.md#483-writes)).
- The server refuses a write over `max_bytes` with HTTP 413, and a type that
  it does not accept with HTTP 415.
- The server scales a larger image down to `max_side`. Clients MAY scale it
  down before they upload it.
- Without `upload`, `avatar`, or `emoji`, clients apply no limits to those
  files.
- Without the extension, clients load media only from the server's origin,
  and apply no limits.
