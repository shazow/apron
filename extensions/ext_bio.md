# `ext:bio`

Adds a short bio to user objects ([§3.3](../PROTOCOL.md#33-identity)), such as
what the user works on.

```json
{"method": "me", "id": "c60", "params": {"ext": {"bio": "Counts things.\nMostly engines."}}}
```

- Clients set the user's `bio` with `me` ([§3.3.2](../PROTOCOL.md#332-profile)).
- A server with capability `ext` keeps `bio` like any other key, so clients
  also use the extension with `ext`.
- Clients send at most 250 Unicode code points. `\n` is a line break.
- Clients send no control characters other than `\n`.
- A bio is plain text, without markup such as CommonMark.
- Clients MAY turn URLs in a bio into links.
- Without the extension or capability `ext`, clients send no `bio`.
