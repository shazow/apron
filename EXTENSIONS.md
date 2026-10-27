# Apron Extensions

Extensions add features that [PROTOCOL.md](PROTOCOL.md) does not define. This
document collects extensions in common use, so that clients and servers that
do not know each other can agree on them. PROTOCOL.md wins where the two
disagree.

- A section's heading is the capability that the server advertises.
- Clients use an extension only while the latest `server` frame lists its
  capability, unless its section says otherwise.
- An extension keeps its data under its name in `ext`
  ([§4.12](PROTOCOL.md#412-ext)).
- Clients ignore a field whose value has the wrong type, and use its default.
- Each section says what clients do without the extension.

## `ext:settings`

Adds server settings to the `server` frame, so that clients offer only the
controls that work. A server can let users do less than its capabilities
allow, such as a server whose guests only read.

```json
"ext": {"settings": {"guest_posting": false, "read_cursors": false, "private_rooms": 10}}
```

```ts
class Settings {                  // server.ext.settings
  guest_posting?: boolean = true; // guests may post, react, join, leave, and create threads
  read_cursors?: boolean = true;  // the server keeps or relays read_message_id
  add_members?: boolean = true;   // users may add other users to rooms
  private_rooms?: number;         // the most private rooms one user may be a member of
}
```

- A boolean that is absent, or not `false`, is `true`. Without the extension,
  every setting is `true`.
- A guest is a user who signed in with scheme `guest`
  ([§3.2](PROTOCOL.md#32-authentication)).
- `read_cursors` refers to `read_message_id` ([§4.6](PROTOCOL.md#46-activity)).
- `add_members` refers to `room_join` with a `user_id`
  ([§4.2.2](PROTOCOL.md#422-membership)). It does not apply to the members of
  a private room ([§4.2.4](PROTOCOL.md#424-creating-and-editing)).
- `private_rooms` counts private rooms without a `parent_room_id`. Absent, it
  states no limit.
- Clients ignore a `private_rooms` that is not a non-negative integer.

## `ext:limits`

Adds a category, `data.ext.limits`, to `retry_after` errors
([§1.1](PROTOCOL.md#11-envelope-and-replies)), so that clients hold back every
request that the same limit counts, rather than send each one to be refused.

```json
{"id": "c42", "error": {"code": -32002, "message": "Posting limit reached", "data": {"retry_after": 40, "ext": {"limits": "write"}}}}
```

| category | the limit counts                                                                       | clients hold back                  |
|----------|----------------------------------------------------------------------------------------|------------------------------------|
| `read`   | `history` or `room_list`                                                               | the refused method                 |
| `write`  | `message`, `reactions`, `room_join`, `room_leave`, and `room_set`                      | every request that `write` counts  |
| `upload` | `message` and `command` requests with a new `upload` embed ([§4.8.2](PROTOCOL.md#482-embed-identity)) | every request that `upload` counts |

- The server sends a category only on a request that its row counts.
- The server sends `write` or `upload` only for a limit that counts every
  request in its row.
- `write` does not count `command`, because a command can do anything.
- Until the delay ends, clients hold back what the last column lists.
- Without a category that they know and that counts the refused request,
  clients handle the error as PROTOCOL.md does.

## `ext:media`

Adds the server's media origins and file limits to the `server` frame, so
that clients load media from them and fit a file before they upload it.

```json
"ext": {"media": {
  "origins": ["https://media.chat.example"],
  "upload": {"image/*": {"max_bytes": 5242880, "max_side": 2048}, "audio/*": {"max_bytes": 10485760}},
  "avatar": {"image/*": {"max_bytes": 262144, "max_side": 512}}
}}
```

```ts
class Media {                     // server.ext.media
  origins?: string[];             // other origins that serve the server's media
  upload?: {[pattern: string]: Limits};  // files for upload embeds (§4.8.4)
  avatar?: {[pattern: string]: Limits};  // images for avatars (§4.8.6)
}

class Limits {
  max_bytes?: number;             // the largest file, in bytes
  max_side?: number;              // the longest image side, in pixels, after the server scales it down
}
```

- An origin is `scheme://host[:port]`. It is `https:`, or `http:` on a
  loopback host. Clients ignore other entries.
- Clients MAY load the `og` media
  ([§4.8.1](PROTOCOL.md#481-opengraph-metadata-og)) of the server's content
  from `origins`.
- A pattern is a MIME type, `type/*`, or `*/*`. Patterns and types match
  without regard to case.
- A file takes only the `Limits` of its most specific pattern. Limits do not
  combine across patterns.
- The server accepts only the types that match a pattern. A pattern whose
  `Limits` is `{}` accepts its types without a limit.
- A file's type is the `Content-Type` of its write
  ([§4.8.3](PROTOCOL.md#483-writes)).
- The server refuses a write over `max_bytes` with HTTP 413, and a type that
  it does not accept with HTTP 415.
- The server scales a larger image down to `max_side`. Clients MAY scale it
  down before they upload it.
- Without `upload` or `avatar`, clients apply no limits to those files.
- Without the extension, clients load media only from the server's origin,
  and apply no limits.

## `ext:permissions`

Adds what the user may do beyond their own messages to `you`
([§3.3](PROTOCOL.md#33-identity)), so that clients offer those controls. Roles
are labels only, so clients cannot tell this from them.

```json
"you": {"user_id": "ada", "name": "Ada", "roles": ["admin"], "ext": {"permissions": ["move_any", "add_members"]}}
```

| permission    | the user may                                                                     |
|---------------|----------------------------------------------------------------------------------|
| `move_any`    | move other users' messages ([§4.4](PROTOCOL.md#44-edit))                         |
| `add_members` | add other users to rooms, also when `ext:settings` sets `add_members` to `false` |

- The server sends `permissions` in `you`. `[]` means none.
- A change is a `user` notification with `you`
  ([§3.3.3](PROTOCOL.md#333-changes)).
- Clients read `permissions` only from `you`.
- Clients ignore permissions that they do not know.
- Servers ignore `ext.permissions` in a `me` request.
- Without the extension, clients offer to move only the user's own messages.

## `ext:bio`

Adds a short bio to user objects ([§3.3](PROTOCOL.md#33-identity)), such as
what the user works on.

```json
{"method": "me", "id": "c60", "params": {"ext": {"bio": "Counts things.\nMostly engines."}}}
```

- Clients set the user's `bio` with `me` ([§3.3.2](PROTOCOL.md#332-profile)).
- A server with capability `ext` keeps `bio` like any other key, so clients
  also use the extension with `ext`.
- Clients send at most 250 Unicode code points. `\n` is a line break.
- Clients send no control characters other than `\n`, and no bidirectional
  overrides or isolates (U+202A to U+202E, U+2066 to U+2069).
- Clients drop those characters when they show a bio (a bio could otherwise
  disguise the text around it).
- Clients show a bio as plain text, never as CommonMark or HTML.
- Without the extension or capability `ext`, clients send no `bio`.

## `ext:emoji`

Adds custom emoji: images that the server defines, and that users write as
`:name:` in reactions and text. The `server` frame carries them in
`ext.emoji`, keyed by that string. Without the extension, clients show the
string as text.

```jsonc
// <- the catalog
{
  "method": "server", "params": {
    "apron": 9, "auth": ["token"], "capabilities": ["reactions", "ext:emoji"],
    "ext": {"emoji": {
      ":partyparrot:": {"url": "https://chat.example/e/Qm7x…", "static_url": "https://chat.example/e/Qm7x…/still", "category": "Parrots", "tags": ["party", "celebrate"]},
      ":shipit:": {"url": "https://chat.example/e/Zr8T…", "width": 64, "height": 32, "alt": "Squirrel in a hat"}
    }}
  }
}
// -> a reaction
{"method": "reactions", "id": "c17", "params": {"message_id": "1724803200043", "emojis": ["👍", ":partyparrot:"]}}
// -> text
{"method": "message", "id": "c18", "params": {"room_id": "general", "body": {"text": "Shipped :partyparrot:"}}}
```

```ts
class Emoji {                   // server.ext.emoji[":name:"]
  url: string;                  // the image
  alt?: string;                 // hover and screen reader text; absent: the key
  width?: number;               // with height, the aspect ratio
  height?: number;
  static_url?: string;          // a still copy of an animated image
  category?: string;            // groups the picker
  tags?: string[];              // more words to search by, in any language
  hidden?: boolean = false;     // rendered, but not offered in the picker
}
```

### Catalog

- A key is `:`, a name, and `:`. A name is one or more of `[A-Za-z0-9_+-]`.
- Keys are case-sensitive.
- When the catalog changes, the server sends a new `server` frame
  ([§3.1](PROTOCOL.md#31-server-frame)).
- A server that keeps its emoji private sends `ext.emoji` only after sign-in.
- The server keeps the catalog small enough that the `server` frame stays
  within 256 KiB ([§1](PROTOCOL.md#1-transport--framing)).
- Clients use `width` and `height` together as the aspect ratio. When either
  is absent, the emoji is square.
- A server MAY keep a removed or renamed key as `hidden`, so that earlier
  reactions and text keep their image.
- `url` and `static_url` follow the rules for user avatars
  ([§4.8.6](PROTOCOL.md#486-avatars)).
- Clients SHOULD scale an emoji in text to the height of the line.
- Clients MAY show `static_url` in place of `url`, such as when the user
  prefers reduced motion.

### Reactions

- A `reactions` entry ([§4.7](PROTOCOL.md#47-reactions)) that is a key refers to
  that custom emoji.
- Clients show a key that the catalog has as its image, with `alt` or the key
  as its hover text.
- Clients show a key that the catalog does not have as a placeholder shape,
  with the key as its hover text.

### Text

- Clients render a key as its image when the catalog has it, in `body.text`
  and in the fields that PROTOCOL.md calls CommonMark
  ([§3.5.2](PROTOCOL.md#352-rendering)), such as a room's `description` and
  `server.welcome`. Other text stays as written.
- Clients scan from left to right. At each `:`, if the text up to the next
  `:` forms a key that the catalog has, clients render it and continue after
  it. Otherwise they continue at that next `:`. So keys can be adjacent, such
  as `:party-left::party-right:`, and `12:30:partyparrot:` renders
  `:partyparrot:`.
- Keys in CommonMark code spans and code blocks stay text.
- Composers put a space between a mention and a key (a mention can contain
  `:`, [Appendix A.3](PROTOCOL.md#a3-prefixes-in-text)).

### Managing

Suggested convention, with capabilities `command` and `embed:upload`
([§4.1](PROTOCOL.md#41-command), [§4.8.3](PROTOCOL.md#483-writes)):

- `/emoji add :name:` with one `upload` embed adds the file as that key, or
  replaces its image.
- `/emoji remove :name:` removes the key.
