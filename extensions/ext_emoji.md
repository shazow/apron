# `ext:emoji`

Adds custom emoji: images that the server defines, and that users write as
`:name:` in reactions and text. The `server` frame carries the URL of the
catalog, a JSON object keyed by that string, so that clients fetch it only
when they need it. Without the extension, clients show a key in text as
written, and in reactions as a placeholder ([§4.7](../PROTOCOL.md#47-reactions)).

```jsonc
// <- the server frame
{
  "method": "server", "params": {
    "apron": 10, "auth": ["token"], "capabilities": ["reactions", "ext:emoji"],
    "ext": {"emoji": {"catalog_url": "https://chat.example/e/catalog-7f3a9c.json"}}
  }
}
// GET https://chat.example/e/catalog-7f3a9c.json returns the catalog
{
  ":partyparrot:": {"url": "https://chat.example/e/Qm7x…", "static_url": "https://chat.example/e/Qm7x…/still", "category": "Parrots", "tags": ["party", "celebrate"]},
  ":shipit:": {"url": "https://chat.example/e/Zr8T…", "width": 64, "height": 32, "alt": "Squirrel in a hat"}
}
// -> a reaction
{"method": "reactions", "id": "c17", "params": {"message_id": "1724803200043", "emojis": ["👍", ":partyparrot:"]}}
// -> text
{"method": "message", "id": "c18", "params": {"room_id": "general", "body": {"text": "Shipped :partyparrot:"}}}
```

```ts
class EmojiExt {                // server.ext.emoji
  catalog_url: string;          // the catalog: an object that maps each key to an Emoji
}

class Emoji {                   // catalog[":name:"]
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

## Catalog

- A key is `:`, a name, and `:`. A name is one or more of `[A-Za-z0-9_+-]`.
- Keys are case-sensitive.
- `catalog_url` is an `https:` URL, an `http:` URL on a loopback host, or a
  `data:application/json` URL.
- The server changes `catalog_url` when the catalog changes, and sends a new
  `server` frame ([§3.1](../PROTOCOL.md#31-server-frame)).
- Clients MAY keep a catalog for as long as `catalog_url` stays the same.
- Clients fetch the catalog when they first need it, such as to show a picker
  or a key. Until they have it, they show keys as without the extension.
- A server that keeps its emoji private sends `ext.emoji` only after sign-in,
  with an unguessable `catalog_url`
  ([§4.8.2](../PROTOCOL.md#482-embed-identity)).
- Clients use `width` and `height` together as the aspect ratio. When either
  is absent, the emoji is square.
- A server MAY keep a removed or renamed key as `hidden`, so that earlier
  reactions and text keep their image.
- `url` and `static_url` follow the rules for user avatars
  ([§4.8.7](../PROTOCOL.md#487-avatars)).
- Clients SHOULD scale an emoji in text to the height of the line.
- Clients MAY show `static_url` in place of `url`, such as when the user
  prefers reduced motion.

## Reactions

- A `reactions` entry ([§4.7](../PROTOCOL.md#47-reactions)) that is a key refers to
  that custom emoji.
- The server MAY refuse a key that the catalog does not have. It MUST accept
  such a key when the user's current set on that message already has it (a
  request carries the whole set, so a removed emoji would otherwise stop the
  user from changing their other reactions).
- Clients show a key that the catalog has as its image, with `alt` or the key
  as its hover text.

## Text

- Clients render a key as its image when the catalog has it, in `body.text`
  and in the fields that PROTOCOL.md calls CommonMark
  ([§3.5.2](../PROTOCOL.md#352-rendering)), such as a room's `description` and
  `server.welcome`. Other text stays as written.
- Clients scan from left to right. At each `:`, if the text up to the next
  `:` forms a key that the catalog has, clients render it and continue after
  it. Otherwise they continue at that next `:`. So keys can be adjacent, such
  as `:party-left::party-right:`, and `12:30:partyparrot:` renders
  `:partyparrot:`.
- Keys in CommonMark code spans and code blocks stay text.
- Composers put a space between a mention and a key (a mention can contain
  `:`, [Appendix A.3](../PROTOCOL.md#a3-prefixes-in-text)).

## Managing

Suggested convention, with capabilities `command` and `embed:upload`
([§4.1](../PROTOCOL.md#41-command), [§4.8.3](../PROTOCOL.md#483-writes)):

- `/emoji add :name:` with one `upload` embed adds the file as that key, or
  replaces its image.
- `/emoji remove :name:` removes the key.
