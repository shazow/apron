# Apron Extensions

Extensions add features that [PROTOCOL.md](PROTOCOL.md) does not define. This
document collects extensions in common use, so that implementations can agree
on them. PROTOCOL.md wins where the two disagree.

- A section's heading is the capability that the server advertises.
- An extension `ext:foo` keeps its data under `ext.foo`
  ([§4.12](PROTOCOL.md#412-ext)). It does not need capability `ext`.
- Each section says what clients do without the extension.

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
  width?: number;               // with height, the aspect ratio; absent: square
  height?: number;
  static_url?: string;          // a still copy of an animated image
  category?: string;            // groups the picker
  tags?: string[];              // more words to search by, in any language
  hidden?: boolean = false;     // not offered in the picker
}
```

### Catalog

- A key is `:`, a name, and `:`. A name is one or more of `[A-Za-z0-9_+-]`.
- Keys are case-sensitive.
- A server that keeps its emoji private sends `ext.emoji` only in a `server`
  frame after sign-in ([§3.1](PROTOCOL.md#31-server-frame)).
- Clients match a search against the key, `alt`, and `tags`.
- Clients render `hidden` emoji, but do not offer them in a picker.
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
- Clients find keys from left to right. Keys can be adjacent, such as
  `:party-left::party-right:`.
- When the catalog does not have a key, its closing `:` can open the next
  key, such as `:partyparrot:` in `12:30:partyparrot:`.
- Keys in CommonMark code spans and code blocks stay text.
- A mention ([Appendix A.3](PROTOCOL.md#a3-prefixes-in-text)) can continue
  into a `:` that directly follows it. So composers put a space between a
  mention and a key.

### Managing

Suggested convention, with capabilities `command` and `embed:upload`
([§4.1](PROTOCOL.md#41-command), [§4.8.3](PROTOCOL.md#483-writes)):

- `/emoji add :name:` with one `upload` embed adds the file as that key, or
  replaces its image.
- `/emoji remove :name:` removes the key.
- The server sends a new `server` frame with the changed catalog.
