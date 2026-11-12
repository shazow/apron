# Plan: `external` as loose OAuth

Status: proposal, local and not committed. Protocol version 10. An
alternative to [PLAN_OAUTH.md](PLAN_OAUTH.md), which is drafted on
[shazow/apron#115](https://github.com/shazow/apron/pull/115). It starts from
v10's `external` and [PLAN_MINIMAL.md](PLAN_MINIMAL.md). Judged with
[EVALUATIONS.md](EVALUATIONS.md).

## Summary

Apron has two kinds of sign-in:

- **`token`**, the session: a bearer token that the server issues.
- **`external`**, the portal: the user signs in on a web page by any method
  (a passkey, email, Pocket ID, SIWE, a password), and the client upgrades
  the result to a `token`.

Other schemes are **native shortcuts**: they finish inside the client, with
no trip to a portal. `webauthn` and `email` are native shortcuts. A new one
earns its place only when it skips the portal for a common kind of client,
and is safe inside the connection. OAuth is not a shortcut, since it also
opens a browser, so it is the shape of `external` instead of a scheme of its
own.

`external` is a loose profile of OAuth 2.1:

- A simple client builds an authorization URL by hand, opens it, and redeems
  the code on the connection. It needs no HTTP calls, no registration, and
  no OAuth library.
- A client with an OAuth library uses it unchanged.
- The issuer is the server itself by default, with open registration, so any
  client works on any server.
- A server can name a foreign issuer, such as Pocket ID, instead. Clients
  follow the same steps.
- Every path ends in an Apron `token`.

## The safety idea

The client always requests a token for the server that it is connected to:
`resource` is `https://` plus the host and any port of the server's address,
and the client works it out itself. The issuer binds the code and the token
to that `resource`, and the server accepts only tokens whose `aud` includes
its own origin. So a token can be spent only where the client meant it, and
the issuer does not matter: a malicious server that advertises another
server's issuer gets tokens addressed to itself, which the other server
rejects.

PKCE binds the code to the client that started (scheme squatting, loopback
ports, other tabs), and `state` binds the result to its request (login
CSRF). Nothing is bound to a connection or an `Origin`, so other tabs and
reconnects work.

## Wire

### Advertising

```jsonc
// <- from wss://chat.example/ws: the server is the issuer
{"method": "server", "params": {"apron": 10, "auth": ["external", "token"],
  "external": {"authorization_endpoint": "https://chat.example/oauth/authorize"}}}

// <- or with a foreign issuer
{"method": "server", "params": {"apron": 10, "auth": ["external", "token"],
  "external": {"issuer": "https://id.example", "authorization_endpoint": "https://id.example/authorize",
               "client_id": "apron", "scope": "openid"}}}
```

```ts
class External {                  // server.external
  authorization_endpoint: string; // where clients send the user
  issuer?: string;                // absent: the server's origin
  client_id?: string;             // a public client that any client MAY use
  scope?: string;                 // space-separated scopes to request
}
```

- A server that lists `external` in `server.auth` sends `server.external`.
- The server's origin is `https://` plus the host and any port of its
  address. It is the `resource`, and the issuer when `issuer` is absent.
- `authorization_endpoint` lets simple clients skip discovery. Library
  clients discover the rest from `issuer` (RFC 8414).

### Simple client

```text
1. verifier = 32 random bytes; challenge = BASE64URL(SHA-256(verifier)); state = 16 random bytes
2. opens  <authorization_endpoint>?response_type=code&client_id=<id>&redirect_uri=<return>
            &code_challenge=<challenge>&code_challenge_method=S256&state=<state>
            &resource=<the server's origin>[&scope=<scope>]
3. the portal signs the user in, confirms, and redirects to
   <return>?code=…&state=…&iss=…        (or ?error=access_denied&state=…&iss=…)
4. checks state, and that iss is the issuer
```

```jsonc
// -> on any connection: another tab, or after a reconnect
{"method": "auth", "id": "c1", "params": {"scheme": "external", "code": "Hk41x9…",
  "code_verifier": "dBjftJ…", "redirect_uri": "com.sidekick.app:/signed-in", "client_id": "com.sidekick.app"}}
// <-
{"id": "c1", "result": {"you": {"user_id": "ada", "name": "Ada"}, "token": "st_…"}}
```

The server redeems the code: itself when it is the issuer, or at the
foreign issuer's token endpoint for the client. Then it checks the token,
and issues an Apron `token`.

### Library client

The standard authorization code flow with PKCE against `issuer`, with
`resource`. Then:

- **The server is the issuer:** the token endpoint's `access_token` is an
  Apron bearer token. The client presents it with `scheme: "token"`.
- **A foreign issuer:** the client presents the access token, and gets an
  Apron `token` back:

```jsonc
{"method": "auth", "id": "c1", "params": {"scheme": "external", "token": "eyJhbGciOiJFUzI1NiIs…"}}
```

### Ways back

| client | way back |
|---|---|
| web, first or third party | a redirect to its own origin |
| native, first or third party | an app scheme with a `.`, such as `com.sidekick.app:/signed-in`, or a loopback address on any port, in a sign-in session or the system browser, never an embedded web view |
| terminal | the device authorization grant, or a loopback redirect where a browser runs |

### Additions

- On a connection that is signed in, guests included, `external` adds the
  identity to that account, and returns `you`. It never signs in to another
  account.
- An identity that belongs to another account is `denied`.

## Rules

Clients:

- Send `resource` as the server's origin, worked out from the address that
  they connect to.
- Use PKCE with `S256`, and an unguessable `state`. Keep the verifier by
  `state`, so that any tab or connection can finish.
- Check `state`, and that `iss` is the issuer, before they use a code.
- Use the system browser or a sign-in session, never an embedded web view.

Servers:

- Accept only tokens from the issuer whose `aud` includes their origin, and
  check `iss` and `exp`.
- Pass a code and verifier only to the issuer's token endpoint, which they
  find from the issuer's metadata themselves.
- Never pass on a client's token, except to the issuer.
- Identify an account by the issuer and the token's `sub`.
- Return an Apron `token` for each successful `external` sign-in.
- An `external` request with neither `code` nor `token` is `invalid_params`.

A server that is its own issuer:

- Its issuer is its origin. It SHOULD publish authorization server metadata
  there (RFC 8414), so that libraries work.
- It accepts any `client_id`, and any `redirect_uri` that is `https`, an app
  scheme with a `.`, or `http` on a loopback address on any port. It MAY
  narrow this.
- It requires PKCE with `S256`.
- It rejects a `resource` other than its own origin.
- The page signs the user in by any method. It shows the server, and the
  host or scheme of `redirect_uri`, or the client's name from a client ID
  metadata document. It confirms before it redirects, also when the user is
  already signed in.
- It redirects with `code`, `state`, and `iss`, or with
  `error=access_denied`.
- A code is single-use, expires within minutes, and is bound to `client_id`,
  `redirect_uri`, the challenge, and `resource`.
- Its token endpoint and metadata allow cross-origin requests.
- It SHOULD offer the device authorization grant.

A foreign issuer (operator setup, not wire):

- Binds codes and tokens to the requested `resource`, and rejects one that
  it does not serve.
- Sends `iss` in the authorization response (RFC 9207).
- Gives any client a way in: a public `client_id` with wildcard callbacks,
  client ID metadata documents, or dynamic registration.

## Coverage

| | W1 | W3 | N1 | N3 | T |
|---|---|---|---|---|---|
| server is the issuer | ✅ | ✅ | ✅ | ✅ | ✅ device grant or loopback |
| foreign issuer | ✅ | ✅ if the issuer lets the client in | ✅ | ✅ if the issuer lets the client in | ✅ if the issuer has the device grant |

Register, log in, add, and recover work in each cell. Recovery is the
portal's own. The full grid is in EVALUATIONS.md, which needs a re-run for
this plan.

| Attacker | Guard |
|---|---|
| A1, relay or mix-up | `resource` bound to the server that the client is connected to, `aud` checked by that server, and `iss` |
| A2, a phishing client | the portal's confirmation, which shows the redirect's host or scheme |
| A3, scheme squatting, loopback ports | PKCE |
| A4, login CSRF; linking to someone else's account | `state`; additions only on the account's own connection |
| A5, guessing | codes need their verifier |

## Pocket ID

1. Define an API with the identifier `https://chat.example`.
2. Register one public client, such as `apron`, with the callbacks to allow:
   Pocket ID takes `*` wildcards in callback URLs. Or allow client ID
   metadata documents by URL pattern.
3. Set `issuer`, `authorization_endpoint`, `client_id`, and `scope` in the
   server's configuration.

Pocket ID already rejects an unknown `resource` (`invalid_target`), makes
the resource the token's `aud`, sends `iss`, allows cross-origin requests,
and offers the device grant. The Apron server needs no sign-in UI: it checks
tokens, redeems codes for simple clients, and maps `sub` to accounts.

## server.apron.chat

- Becomes its own issuer with `workers-oauth-provider` 1.2.4: its passkey
  page becomes the authorization page.
- The library refuses an unknown `client_id`. Open registration needs a
  client created on first sight, with `createClient()`, or client ID
  metadata documents. To check.
- App schemes need `allowPrivateUseRedirectUris`.
- No device grant in the library: terminals use loopback until one is built
  beside it.
- Keeps `webauthn` for web.apron.chat, and `token` for bots and invites.

## Email

`email` stays as a native shortcut: v10, plus the mix-up fix, codes that
name their server, codes that work with the proposal's `state`, and `you`
for additions, as on shazow/apron#115. A server can also put email behind
its portal instead.

## Compared

| | v10 `external` (PLAN_MINIMAL) | loose `external` | `oauth` (PLAN_OAUTH) |
|---|---|---|---|
| simple client | propose, open, read the fragment, redeem | build the URL, open, read the query, redeem | not possible |
| library client | not possible | ✅ | ✅ |
| third-party clients | a trust list, or a typed code | ✅ open, when the server is the issuer | needs client IDs and CORS from the issuer |
| foreign issuer | behind the server's page | ✅ | ✅ |
| binding | the connection and `Origin` | PKCE | PKCE |
| mix-up | the link's `server` | `resource`, `aud`, `iss` | `resource`, `aud`, `iss` |
| session | Apron `token` | Apron `token` | the issuer's tokens |
| server work | page, proposals, trust list | page, codes, token endpoint, metadata; or none behind a foreign issuer | an authorization server, or none |

## Changes to shazow/apron#115

- §3.1: `server.external` as above.
- §3.2: `external` takes `code` with `code_verifier`, `redirect_uri`, and
  `client_id`, or `token`. `return_url`, `state`, and the result's `url`
  stay gone.
- §4.12, renamed "External sign-in" with this plan: advertising, signing
  in, the issuer's rules, and token checks.
- §5.2: one line for each guard above.
- Keep the email changes.
- C3 shrinks to the foreign-issuer setup above.

## Open questions

1. With a foreign issuer, does the server keep the issuer's refresh token,
   to notice a revoked user and close their sessions, or does the Apron
   `token` stand alone?
2. Is metadata (RFC 8414) a MUST for a server that is its own issuer, so
   that libraries work everywhere, or a SHOULD?
3. Terminals: is the device grant enough, or should a code shown by the
   portal, redeemed on the connection with the verifier, also be allowed?
   It is not standard OAuth, but it is the simplest flow for a terminal.
4. Field names on the connection: OAuth's (`code`, `code_verifier`,
   `redirect_uri`), as above, or Apron's own?
5. Should email codes also take a verifier, for the same binding as
   `external`? Email links that open on another device would then need the
   v10 path, which asks the user first.
6. Does `workers-oauth-provider` let server.apron.chat accept any
   `client_id`?
