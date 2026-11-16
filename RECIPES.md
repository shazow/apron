# Recipes

How to build common things on Apron without changing the protocol. Each recipe
answers "Can Apron do X?" with an outline that stays within
[PROTOCOL.md](PROTOCOL.md). Recipes are informative. Where a recipe and
PROTOCOL.md disagree, PROTOCOL.md wins.

## Trusted federation

**Can two Apron servers share rooms?** Yes, when their operators trust each
other. Each server mirrors the other's rooms into its own log. Clients see an
ordinary server, and need no changes.

### How it works

1. A mirror connects to the other server as a client: a bot user
   (`roles: ["bot"]`) that signs in with `token` and joins the shared rooms
   ([§3.2](PROTOCOL.md#32-authentication),
   [§4.2.2](PROTOCOL.md#422-membership)).
2. It receives the other server's records live, and catches up with `history`
   after an outage ([§4.3.5](PROTOCOL.md#435-replay-and-recovery)).
3. It writes each record into its own server's log, as that server. The server
   sets `from`, so remote users appear as themselves, not as the bot
   ([§3.5](PROTOCOL.md#35-messages)).
4. The other server runs the same mirror in the other direction. Each server
   is the authority for its own copy of the room.

Each side writes only into its own log, so no server ever posts as another
server's user. The mirror's account is a full account on the other server, so
give it only the rooms and rights that it needs.

### Mapping

| Thing | How the mirror handles it |
|---|---|
| Messages | A new snapshot with the mirror's own `message_id` and `log_id` ([§2](PROTOCOL.md#2-identifiers)). The mirror keeps a two-way map of IDs. |
| Replies and mentions | Map `reply_to.message_id` and the IDs in `mentions` through the map. |
| Edits and deletes | The origin publishes a new snapshot. The mirror writes a new snapshot of its copy. |
| Reactions and memberships | Map both parts of the key: `(message_id, user_id)` and `(room_id, user_id)`. |
| Remote users | Ordinary users on the mirror, with IDs that it assigns, such as `carol@b.example`, which stays mentionable ([Appendix A.3](PROTOCOL.md#a3-prefixes-in-text)). The mirror never gives a local user an ID in a peer's form, and never reuses a retired ID ([§3.3.3](PROTOCOL.md#333-changes)). IDs are opaque, so clients read the origin from `ext.peer.origin` on the user object, not from the ID. |
| Uploads and live text | Copy or proxy them. Clients do not load media from other origins ([§4.8.1](PROTOCOL.md#481-opengraph-metadata-og), [§4.8.2](PROTOCOL.md#482-embed-identity), [§4.8.3](PROTOCOL.md#483-writes)). |
| Loops | Mark mirrored records, such as `"ext": {"peer": {"origin": "b.example", "message_id": "…"}}` ([§4.13](PROTOCOL.md#413-ext)). Never mirror a record that carries the other server's mark. |
| Sign-in | Optional: one server's `external` sign-in can use the other server as its identity provider ([§4.12](PROTOCOL.md#412-external-sign-in), with [`ext:oauth`](extensions/ext_oauth.md)). |

### Limits

- **Times.** A `log_id` is the commit time on its server, and only increases.
  A record that is mirrored late, such as after an outage, shows the time it
  was mirrored, at the end of the room. The original time can travel in
  `ext.peer`, which clients ignore.
- **Order.** Concurrent messages can appear in a different order on each
  server.
- **Moderation.** Deleting a remote user's message on one server deletes only
  that server's copy. To forward the deletion, the mirror needs a moderator
  account on the other server. Moves and redactions work the same way.
- **One shared log.** Rooms that both servers write in a single order would
  need state resolution, as in Matrix. Mirroring avoids that by design.

## Passkeys in native apps

**Can a native app, such as one for macOS or iOS, sign in with a server's
passkeys?** Yes. An app that the RP ID's domain trusts runs the ceremony
itself. Any other app signs in on the server's passkey page, in a sign-in
session, and gets a code back
([§4.10.1](PROTOCOL.md#4101-passkey-page)).

### How it works

1. A platform lets an app use passkeys for a domain only when the domain
   lists the app: Associated Domains (`webcredentials:`) on Apple platforms,
   and Digital Asset Links on Android. In practice that is the server
   operator's own app. A third-party app cannot be listed.
2. An app that the RP ID's domain lists passes `public_key` to the platform,
   such as `ASAuthorizationPlatformPublicKeyCredentialProvider`, after the
   RP ID check ([§4.10](PROTOCOL.md#410-webauthn-authentication)). An error
   other than the user's cancel (`ASAuthorizationError.canceled`), such as
   one that says the app is not associated with the domain, is a refusal: the
   app uses `external` if the begin result has it.
3. Any other app uses `external` at once. It opens `external.url` with its own
   authorization parameters
   ([§4.12.2](PROTOCOL.md#4122-signing-in)) in a sign-in session:
   `ASWebAuthenticationSession` on Apple platforms, or a Custom Tab on
   Android. Never in a web view: the page refuses frames, and a web view
   cannot use the user's passkeys.
4. The app chooses its `redirect_uri`:
   - An `https` address on a domain that lists the app, as a universal link
     or App Link. `ASWebAuthenticationSession` takes `https` callbacks from
     iOS 17.4 and macOS 14.4. The page remembers the user's consent for an
     `https` `redirect_uri`, so a repeat sign-in is one tap
     ([§4.12.3](PROTOCOL.md#4123-authorization-server)).
   - Otherwise a scheme with a `.`, such as `com.example.app:/signed-in`. The
     page asks the user at each sign-in.
5. The app sends a `client_id` of its own, such as its bundle ID, or the URL
   of its client ID metadata document if that document lists its
   `redirect_uri` ([§4.12.2](PROTOCOL.md#4122-signing-in)).
6. The app finishes `webauthn` with `code`, `code_verifier`, `redirect_uri`,
   and `client_id`, on any connection
   ([§4.10.1](PROTOCOL.md#4101-passkey-page)). It keeps the bearer `token`
   in the platform's secure storage, such as the Keychain, and resumes with
   it ([§3.2.1](PROTOCOL.md#321-bearer-tokens)).

### Limits

- **A prompt before the page.** `ASWebAuthenticationSession` asks the user
  whether the app may sign in with the server's domain, before it opens the
  page.
- **Passkey autofill.** In a sign-in session, some platform versions offer
  passkeys only from a button that starts the ceremony, not as autofill. The
  passkey page starts the ceremony from a button.
- **Platform details change.** Check the platform's current documentation for
  the error that a missing association gives, and for callback support.
