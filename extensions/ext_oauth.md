# `ext:oauth`

Adds the standard OAuth 2.1 and OpenID Connect parts that external sign-in
([§4.12](../PROTOCOL.md#412-external-sign-in)) leaves out.

External sign-in and the passkey page
([§4.10.1](../PROTOCOL.md#4101-passkey-page)) work without this extension. Both
use the authorization code grant with PKCE. Any client, with no
registration, sends the user to the server's sign-in page, and redeems the
code on its connection. Clients need no OAuth library, and no endpoint other
than the sign-in page.

This extension is for what goes beyond that flow:

- Clients that use an OAuth library, which expects metadata and a token
  endpoint ([Endpoints](#endpoints)).
- Servers that let another authorization server sign their users in, such as
  one that a company already runs. One provider then serves many servers, and
  controls the users' sessions
  ([Another authorization server](#another-authorization-server)).
- Other sites that sign users in with their account on this server, where the
  server offers it ([Identity provider](#identity-provider-optional)).

```jsonc
// <- begin, when the server uses another authorization server
{"id": "c1", "result": {"external": {"url": "https://id.example/authorize", "issuer": "https://id.example"}}}

// -> a client that redeemed the code at the issuer presents the access token, on each connection
{"method": "auth", "id": "c2", "params": {"scheme": "external", "token": "eyJhbGciOiJFUzI1NiIsInR5cCI6ImF0K2p3dCJ9…"}}
// <-
{"id": "c2", "result": {"you": {"user_id": "ada", "name": "Ada"}}}
```

## Endpoints

These rules apply to a server that is its own authorization server:

- The server publishes its
  [metadata](https://www.rfc-editor.org/rfc/rfc8414) at
  `/.well-known/oauth-authorization-server`.
- Its token endpoint redeems a code with the authorization code grant and
  PKCE. The access token is a bearer token for `scheme: "token"`.
- The token endpoint accepts a public client's `client_id` in the request
  body, or with HTTP Basic and an empty password. A request that it refuses
  before it redeems the code leaves the code usable (otherwise a client that
  tries Basic first loses its code).
- The server allows cross-origin requests to its metadata and its token
  endpoint.
- The server MAY fetch a client ID metadata document when `client_id` is an
  `https` URL. It then accepts only a `redirect_uri` that the document lists,
  and shows the document's `client_name` only beside the host of `client_id`
  (otherwise a client could borrow another client's name).

## Another authorization server

- The server sets `issuer`, and `url` is the issuer's authorization endpoint.
- The issuer MUST bind codes and tokens to `resource`, send `iss`, and issue
  [JWT access tokens](https://www.rfc-editor.org/rfc/rfc9068).
- The issuer MUST accept clients only by their client ID metadata documents,
  and ask the user to confirm each client by the host of its document
  (otherwise clients that share one `client_id` share the user's consent, and
  any site can get a code without a click).
- The server publishes its
  [protected resource metadata](https://www.rfc-editor.org/rfc/rfc9728), with
  its origin as `resource` and the issuer in `authorization_servers`.
- The server finds the issuer's endpoints from its OAuth metadata or its
  OpenID Connect discovery document. With `code`, it redeems at the issuer's
  token endpoint, and sends its origin as `resource`.
- Clients MAY redeem the code at the issuer's token endpoint themselves. They
  then MUST check that [`iss`](https://www.rfc-editor.org/rfc/rfc9207) in the
  authorization response is `issuer` (otherwise an authorization server could
  take a code that another one issued).
- Such clients present the access token with `scheme: "external"` and `token`,
  on each connection. They refresh it at the issuer, so that the issuer's
  revocation and policy apply.
- The server accepts only access tokens from the issuer with an `aud` that
  includes its origin. It checks the signature against the issuer's keys, and
  checks `typ` (`at+jwt`), `iss`, and `exp` (an ID token is not an access
  token, even when its `aud` matches).
- The server rejects a token that is bound to a key, such as by a `cnf`
  claim.
- The server identifies an account by the issuer and the token's `sub`. For
  a new account, it MAY take a name from the issuer's userinfo, when its
  `sub` matches.
- Clients without a browser MAY use the
  [device authorization grant](https://www.rfc-editor.org/rfc/rfc8628), where
  the issuer offers it.

## Identity provider (optional)

Lets another site, such as another Apron server, sign users in with their
account on this server, without access to their messages. The server acts as
an OpenID Connect provider.

```jsonc
// another server sends the user to
//   https://chat.example/oauth/authorize?response_type=code&scope=openid%20profile
//   &client_id=https://other.example/client.json&redirect_uri=https://other.example/signed-in
//   &code_challenge=E9Mel…&code_challenge_method=S256&state=q8Rz…&nonce=n-0S6…
// the page asks, and redirects with a code; the other server redeems it at the token endpoint
// <- the token endpoint's answer
{"token_type": "Bearer", "access_token": "ui_7Hd…", "id_token": "eyJhbGciOiJFUzI1NiJ9…", "expires_in": 300}
// the ID token's claims
{
  "iss": "https://chat.example", "sub": "u_8Fq2…", "aud": "https://other.example/client.json",
  "nonce": "n-0S6…", "iat": 1763258400, "exp": 1763258700,
  "name": "Ada", "preferred_username": "ada"
}
```

- A server MAY act as an identity provider. It then publishes its OpenID
  Connect discovery document, with `openid` in `scopes_supported`. A server
  without that document is not an identity provider.
- An authorization request with `scope` `openid` and no `resource` asks only
  for who the user is. A server that is not an identity provider refuses it
  ([§4.12.3](../PROTOCOL.md#4123-authorization-server)).
- The server accepts such a request only from a client with a client ID
  metadata document (otherwise the page cannot name the client).
- The page asks, such as "other.example wants to know who you are on
  chat.example. It will see your name and user ID, and cannot read or send
  messages." The user's choice is kept as §4.12.3 says.
- The token endpoint returns an ID token, signed with a key from the server's
  `jwks_uri`. The ID token carries `iss` (the server's origin), `sub`, `aud`
  (the `client_id`), and the request's `nonce`. With `profile`, it also
  carries `name` and `preferred_username` (the `user_id`).
- `sub` never changes for an account, and is never its `user_id` (otherwise
  a renamed or reused `user_id` would sign in to another account).
- The access token works only at the userinfo endpoint. It is not a bearer
  token for `scheme: "token"`.
- A code from such a request finishes neither `external` nor `webauthn`.
- The discovery document also gives `userinfo_endpoint`, `jwks_uri`, and
  `subject_types_supported` `["public"]`.
- The other site uses the server as any OpenID Connect provider, behind its
  own sign-in page, and identifies the account by `iss` and `sub`.

Without the extension, clients redeem codes on the connection
([§4.12.2](../PROTOCOL.md#4122-signing-in)), and an `external` request with
`token` is `denied`.

## References

- [RFC 6749 §2.3.1](https://www.rfc-editor.org/rfc/rfc6749#section-2.3.1):
  how a `client_id` is sent with HTTP Basic
- [RFC 8414](https://www.rfc-editor.org/rfc/rfc8414): the server's metadata
- [RFC 9068](https://www.rfc-editor.org/rfc/rfc9068): JWT access tokens
- [RFC 9728](https://www.rfc-editor.org/rfc/rfc9728): protected resource
  metadata
- [OAuth Client ID Metadata Document](https://datatracker.ietf.org/doc/draft-ietf-oauth-client-id-metadata-document/)
- [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html):
  ID Token (§2), UserInfo (§5.3)
- [OpenID Connect Discovery 1.0](https://openid.net/specs/openid-connect-discovery-1_0.html)
