# `ext:auth_external`: a label for external sign-in

Status: proposal, not implemented. Protocol version 10. The label still
applies under [PLAN_OAUTH.md](PLAN_OAUTH.md); the Pocket ID example below
shows the server-in-the-middle flow, which PLAN_OAUTH.md replaces with Pocket
ID as the authorization server. Companion to
[EXT_HANDOFF.md](EXT_HANDOFF.md) and [AUTH_APRON.md](AUTH_APRON.md).

## Summary

`external` sign-in
([PROTOCOL.md §4.11](https://github.com/shazow/apron/blob/main/PROTOCOL.md#411-email-and-external-sign-in))
lets a server put any sign-in portal behind one page: its own passkey page,
an OpenID Connect provider such as Pocket ID or Google, or a page that
another party hosts. Clients open the `url` that the server returns, and
never need to know what is behind it.

So a client can only offer a plain "Sign in", and the user does not know
where it leads until a portal opens. `ext:auth_external` adds a label for
the `external` option, such as "Pocket ID", so that clients can say "Sign in
with Pocket ID", and the user knows what to expect before the redirect.

## `ext:auth_external`

```json
"ext": {"auth_external": {"label": "Pocket ID"}}
```

```ts
class AuthExternal {     // server.ext.auth_external
  label?: string;        // the name of the sign-in portal, as plain text
}
```

- A server that lists `ext:auth_external` in `server.capabilities` MAY send
  `server.ext.auth_external.label`.
- The server sends `label` only while `server.auth` lists `external`.
- `label` is the name of the portal that `external` opens, such as
  "Pocket ID" or "Google". It is at most 64 characters.
- Clients show `label` where they offer `external`, such as
  "Sign in with Pocket ID".
- Clients show `label` as plain text, never as markup.
- Each `server` frame replaces the label
  ([§3.1](https://github.com/shazow/apron/blob/main/PROTOCOL.md#31-server-frame)).
- Without the label, or without the capability, clients use their own
  wording for `external`.

Not included, on purpose:

- No icon. An icon is a URL that every client would load from another
  origin, which leaks readers' addresses, and it is the easiest way to
  imitate a portal that the server does not use.
- No choice between several portals. A server with several can make its
  `external` page a chooser, which needs no wire change.

## Example deployment: Pocket ID

[Pocket ID](https://github.com/pocket-id/pocket-id) is a self-hosted OpenID
Connect provider that signs users in with passkeys only. It supports public
clients with PKCE, loopback redirects on any port (RFC 8252), wildcard
callback URLs, refresh tokens, a public key endpoint (JWKS), token
introspection, the device authorization grant, backchannel logout, and
client ID metadata documents behind an allowlist. It has no dynamic client
registration.

An Apron server uses Pocket ID as an ordinary OIDC client, and offers it to
Apron clients through `external`:

```jsonc
// <- server frame
{"method": "server", "params": {
  "apron": 10, "auth": ["external", "token"], "capabilities": ["ext:auth_external"],
  "ext": {"auth_external": {"label": "Pocket ID"}}
}}
```

1. The client shows "Sign in with Pocket ID". When the user picks it, the
   client proposes: `auth {scheme: "external", return_url, state}`, with a
   PKCE `challenge` (EXT_HANDOFF.md, part 1) from a native client.
2. The server keeps the proposal, and replies with a `url`: Pocket ID's
   authorize URL, with the server's `client_id`, the server's own callback,
   a `state` tied to the proposal, and a PKCE pair between the server and
   Pocket ID.
3. The client opens the `url`: a popup or redirect on the web,
   `ASWebAuthenticationSession` on macOS. The user signs in on Pocket ID's
   domain with a passkey.
4. Pocket ID redirects to the server's callback. The server exchanges the
   code, checks the ID token, and maps the Pocket ID user to an account.
5. The server redirects to the client's `return_url` with
   `#token=…&state=…&server=…`. Without `return_url`, its callback page shows
   a code to type.
6. The client redeems the token with `auth {scheme: "external", token}`, and
   the `verifier` if it sent a `challenge`.

What the server knows, as configuration and never on the wire:

- Pocket ID's issuer URL, such as `https://id.example.com`.
- The server's `client_id` and client secret.
- The server's callback URL.
- The label, "Pocket ID".

What clients see: `external` in `server.auth`, the label, and Pocket ID's
URL in the proposal's result. Changing the provider is a server
configuration change: clients pick up the new label, and change nothing
else.

Server work:

- An OIDC client: a callback route, the code exchange, and ID token checks
  against the provider's public keys.
- Accounts from the provider's users: `sub` to `user_id`,
  `preferred_username` as the requested `user_id`, `name` and `picture` to
  `name` and `avatar`, and groups to `roles`.
- Proposals, the temporary token, and redeeming it, as in EXT_HANDOFF.md
  part 1.
- Optional: backchannel logout, so that a user removed in Pocket ID loses
  their Apron tokens.

The server offers `"auth": ["external", "token"]`. It does not offer
`webauthn`: the passkeys are in Pocket ID, under Pocket ID's domain.

Client support:

| client | needs |
|---|---|
| apron-web on an origin that the server trusts | the label; it already proposes `external` and handles the link back |
| apron-web on another origin, terminal clients | the label; the code path, which apron-web already supports |
| native clients | the label; EXT_HANDOFF.md part 1, and no platform entitlements, since the passkey step runs on Pocket ID's domain |

## Why not let clients talk to the provider directly

A client could instead sign in at Pocket ID itself, with a standard OAuth
library, and present the provider's token to the server. That needs:

- the provider's issuer in the `server` frame.
- a new `auth` form for provider tokens.
- a `client_id` for every client on every deployment. Client ID metadata
  documents help, but the operator still allows each client's URL.
- OAuth support in every client, for each provider.
- the server accepting only tokens issued to Apron clients, so that a token
  issued to another app on the same provider cannot sign anyone in.

So the server stays in the middle, and clients stay unaware of providers.
This is the "client in the middle" design in AUTH_APRON.md.

## Security considerations

- `label` is the server's claim. A server could label its own page
  "Google". This gives a server no more than it already has: the client
  trusts the server, and the browser session shows the real page's domain.
- Without an icon, clients load nothing from the portal's origin before the
  user picks it.

## Open questions

- Should several portals get a list with a choice in the proposal later, or
  is a chooser page on the server enough?
