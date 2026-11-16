# Apron Extensions

Extensions add optional features beyond what [PROTOCOL.md](PROTOCOL.md)
defines. This page lists extensions in common use, so that clients and
servers who do not know about each other can benefit from implementing the
same extensions.

- Each extension's heading is the capability that the server advertises.
- Clients use an extension only while the latest `server` frame lists its
  capability, unless the extension says otherwise.
- An extension keeps its data under its name in `ext`
  ([§4.13](PROTOCOL.md#413-ext)).
- Clients ignore a field whose value has the wrong type, and use its default.
- Each extension says what clients do without it.

Each extension has its own file in [extensions/](extensions/):

- [`ext:settings`](extensions/ext_settings.md): Adds server-wide settings to the
  `server` frame, so that clients offer only the controls that work.
- [`ext:limits`](extensions/ext_limits.md): Adds a category, `data.ext.limits`,
  to `retry_after` errors ([§1.1](PROTOCOL.md#11-envelope-and-replies)), so that
  clients hold back every request that the same limit counts, rather than send
  each one to be refused.
- [`ext:media`](extensions/ext_media.md): Adds the server's media origins and
  file limits to the `server` frame, so that clients load media from them and
  fit a file before they upload it.
- [`ext:permissions`](extensions/ext_permissions.md): Adds the user's
  permissions to `you` ([§3.3](PROTOCOL.md#33-identity)), so that clients offer
  only the controls that the user may use.
- [`ext:bio`](extensions/ext_bio.md): Adds a short bio to user objects
  ([§3.3](PROTOCOL.md#33-identity)), such as what the user works on.
- [`ext:emoji`](extensions/ext_emoji.md): Adds custom emoji: images that the
  server defines, and that users write as `:name:` in reactions and text.
- [`ext:editors`](extensions/ext_editors.md): Lets the sender of a message share
  the editing of its text with the users that it mentions, such as a list that
  the people in it keep up to date.
- [`ext:oauth`](extensions/ext_oauth.md): Adds the standard OAuth 2.1 and OpenID
  Connect parts that external sign-in
  ([§4.12](PROTOCOL.md#412-external-sign-in)) leaves out.
- [`ext:auth_external`](extensions/ext_auth_external.md): Lists the ways that a
  server's external sign-in ([§4.12](PROTOCOL.md#412-external-sign-in)) can go,
  such as "GitHub" and "Google", and lets a client send the user's choice with
  the begin.
