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

Without the extension, clients redeem codes on the connection
([§4.12.2](../PROTOCOL.md#4122-signing-in)), and an `external` request with
`token` is `denied`.
