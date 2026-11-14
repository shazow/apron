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

### Begin

The `server` frame only lists `external` in `server.auth`. A client asks
for the sign-in details when it needs them, with an `external` request that
has neither `code` nor `token`. This is the begin request (decided
2026-11-14): one way to get the details, and room for a server to answer
differently by request, such as by the user's choice of provider
(`ext:auth_external`).

```jsonc
// <- from wss://chat.example/ws
{"method": "server", "params": {"apron": 10, "auth": ["external", "token"]}}

// -> begin
{"method": "auth", "id": "c1", "params": {"scheme": "external"}}
// <- the server is the issuer
{"id": "c1", "result": {"external": {"authorization_endpoint": "https://chat.example/oauth/authorize"}}}
// <- or a foreign issuer
{"id": "c1", "result": {"external": {"issuer": "https://id.example",
  "authorization_endpoint": "https://id.example/authorize", "client_id": "apron", "scope": "openid"}}}
```

```ts
class External {                  // the begin result's "external"
  authorization_endpoint: string; // where clients send the user
  issuer?: string;                // absent: the server's origin
  client_id?: string;             // a public client that any client MAY use
  scope?: string;                 // space-separated scopes to request
  params?: object;                // more authorization parameters, added as they are
}
```

- Begin authenticates nothing, on any connection, signed in or not. A
  server needs no state to answer it.
- The server's origin is `https://` plus the host and any port of its
  address. It is the `resource`, and the issuer when `issuer` is absent.
- `authorization_endpoint` lets simple clients skip discovery. Library
  clients discover the rest from `issuer` (RFC 8414).
- `params` carries parameters such as a provider hint, which the client adds
  to the authorization URL unchanged. They never replace `response_type`,
  `client_id`, `redirect_uri`, `code_challenge`, `code_challenge_method`,
  `state`, or `resource`.
- `step` is not needed: the fields tell begin, redemption, and a foreign
  access token apart, as they tell an email proposal from its approval.

### Simple client

```text
1. begin, as above
2. verifier = 32 random bytes; challenge = BASE64URL(SHA-256(verifier)); state = 16 random bytes
3. opens  <authorization_endpoint>?response_type=code&client_id=<id>&redirect_uri=<return>
            &code_challenge=<challenge>&code_challenge_method=S256&state=<state>
            &resource=<the server's origin>[&scope=<scope>][&<params>]
4. the portal signs the user in, confirms, and redirects to
   <return>?code=…&state=…&iss=…        (or ?error=access_denied&state=…&iss=…)
5. checks state, and that iss is the issuer
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

Begin, then the standard authorization code flow with PKCE against
`issuer`, with `resource` and any `params`. Then:

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
- Clients start an addition only from an explicit account action, such as
  "Add a sign-in to ada", and show the account that `you` names.

**Decided (2026-11-14): the portal does not tell registration, login, or
addition apart.** Don't re-open this without a new threat.

- Registration vs login is the portal's and the server's business. The
  portal offers sign-up or refuses it; the server creates an account for a
  new `sub` or says `denied`, by policy. `server.signup` already says whether
  `external` creates accounts, `name` and `user_id` ride on the redemption
  (§3.2), and a client MAY add OpenID Connect's `prompt=create` as a UI hint.
- Addition vs sign-in is decided at redemption: the server knows whether the
  connection is signed in. v10's page warning existed because a link token
  worked on any connection. PKCE removes that: only the client that started
  can redeem.
- The remaining case, a phishing URL from an attacker's own client, is
  guarded by the consent screen's redirect host, as for sign-in, which is
  the worse outcome. A parameter such as `apron_intent=add` would only
  change that screen's wording. Rejected, with a pushed request that names
  the account, and account-page-only linking (which brings back F3).

## Rules

Clients:

- Send `resource` as the server's origin, worked out from the address that
  they connect to.
- Use PKCE with `S256`, and an unguessable `state`. Keep the verifier by
  `state`, so that any tab or connection can finish.
- Check `state`, and that `iss` is the issuer, before they use a code.
- Use the system browser or a sign-in session, never an embedded web view.
- Don't send `dpop_jkt` in the authorization URL on the simple path: the
  server redeems the code, so the code must not be bound to the client's
  key.

Servers:

- Accept only tokens from the issuer whose `aud` includes their origin, and
  check `iss` and `exp`.
- Pass a code and verifier only to the issuer's token endpoint, which they
  find from the issuer's metadata themselves.
- Never pass on a client's token, except to the issuer.
- Identify an account by the issuer and the token's `sub`.
- Return an Apron `token` for each successful `external` sign-in.
- Reject a token that is bound to a key (a `cnf` claim, or an introspection
  result with `cnf` or `token_type: DPoP`) unless they verify a proof for
  that key (RFC 9449 §7.2). A bound token never passes as a bearer token.
- When a foreign issuer supports or requires DPoP, redeem codes with a DPoP
  key of their own, and handle `use_dpop_nonce` themselves.
- An `external` request with neither `code` nor `token` is the begin
  request.

A server that is its own issuer:

- Its issuer is its origin. It SHOULD publish authorization server metadata
  there (RFC 8414), so that libraries work.
- It accepts any `client_id`, and any `redirect_uri` that is `https`, an app
  scheme with a `.`, or `http` on a loopback address on any port. It MAY
  narrow this.
- It requires PKCE with `S256`.
- It rejects a `resource` other than its own origin.
- The page signs the user in by any method. It shows the server, and the
  host of `redirect_uri`, or its scheme for an app scheme. It confirms before
  it redirects, also when the user is already signed in.
- It MAY fetch a client ID metadata document when `client_id` is an `https`
  URL. It then accepts only a `redirect_uri` that the document lists.
- It MAY show the document's `client_name` beside the host of `client_id`,
  never in place of a host. (Otherwise a phishing client could name a good
  client's real document with its own `redirect_uri`, and PKCE would not
  help, since the phishing client started the flow. RESEARCH_ATPROTO.md, B1.)
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
| A6, a copied token, from storage or a log | rotation with reuse detection: a copy works until the real client next connects, and its use revokes the line (F7). Optional key-bound tokens later ([Forward compatibility](#forward-compatibility-proof-of-possession)). A bound issuer token never passes as bearer. |
| A7, code running in the client while it is open | no binding helps; the portal's confirmation before each redirect (R5) |

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

## Scenarios behind the portal

Apron does not support these natively. They are scenarios the design must
keep working, each as a method behind a portal, so that clients see only
`external`. [EVALUATIONS.md](EVALUATIONS.md#behind-the-portal) checks where
each one runs.

- **Pocket ID or another OpenID Connect provider:** behind the server's
  portal, or as the foreign issuer.
- **SIWE:** the portal asks the user's wallet to sign an EIP-4361 message,
  then issues an Apron code. A native `ext:siwe` scheme was considered and
  set aside: clients would need wallet code, and the portal gives them SIWE
  for free.
- **AT Protocol ("Sign in with Bluesky"):** only behind the server's
  portal, never as a foreign issuer. The server is the AT Protocol OAuth
  client: its own client metadata document and callback, pushed
  authorization requests and DPoP with its own key, the `atproto` scope,
  and a check that the returned DID belongs to the authorization server. It
  maps the DID to an account, and issues an Apron code to the Apron client.
  A handle can arrive as `login_hint` (`ext:auth_external`). It cannot be a
  foreign issuer: its tokens are for the user's PDS, not for
  `https://chat.example`; its redirect URIs must be listed in one client
  metadata document; and the issuer depends on the user. Research:
  RESEARCH_ATPROTO.md (pending).

## Email

`email` stays as a native shortcut: v10, plus the mix-up fix, codes that
name their server, codes that work with the proposal's `state`, and `you`
for additions, as on shazow/apron#115. A server can also put email behind
its portal instead.

## Compared

| | v10 `external` (PLAN_MINIMAL) | loose `external` | `oauth` (PLAN_OAUTH) |
|---|---|---|---|
| simple client | propose, open, read the fragment, redeem | begin, build the URL, open, read the query, redeem | not possible |
| library client | not possible | ✅ | ✅ |
| third-party clients | a trust list, or a typed code | ✅ open, when the server is the issuer | needs client IDs and CORS from the issuer |
| foreign issuer | behind the server's page | ✅ | ✅ |
| binding | the connection and `Origin` | PKCE | PKCE |
| mix-up | the link's `server` | `resource`, `aud`, `iss` | `resource`, `aud`, `iss` |
| session | Apron `token` | Apron `token` | the issuer's tokens |
| server work | page, proposals, trust list | page, codes, token endpoint, metadata; or none behind a foreign issuer | an authorization server, or none |

## Forward compatibility: proof of possession

Research: [RESEARCH_DPOP_DBSC.md](RESEARCH_DPOP_DBSC.md). Nothing here
ships now. DPoP (RFC 9449) is the only shipped way to bind OAuth tokens to
a client key in browsers; it is defined for HTTP only, and no standard
carries a proof over a WebSocket. DBSC binds cookies only. Pocket ID and
`workers-oauth-provider` issue bearer tokens only. So the plan reserves
names and rules now, and binds the Apron `token` later.

**Decided (2026-11-14): binding is allowed by the design, never required.**
No client has to implement DPoP, now or as part of the baseline. A client
that never sends `dpop` works with every server. Reasons:

- It guards one case, a token copied out of storage or a log (A6). It does
  nothing against code running in the client while it is open (A7), the
  usual way a web token is stolen.
- In browsers, a non-extractable WebCrypto key still lives in the profile on
  disk, so malware that copies the profile likely copies the key. Only
  native hardware keys bind strongly.
- Comparable systems (Matrix's authentication service, Slack, Discord, MCP)
  use bearer tokens; OAuth 2.1 accepts rotation instead of binding for
  public clients. Only AT Protocol and financial-grade profiles require
  binding.
- It costs every client a key store per platform, a JOSE signature, the DER
  conversion on Apple and Android, a retry path, and giving up `auth` before
  `server`.

**The baseline instead: rotation with reuse detection.** Server-side only;
clients already save the latest `token` (§3.2.1).

- The server rotates a `token` each time it signs in a connection, and
  stores only its hash.
- A replaced token that comes back means someone holds a copy. The server
  revokes that token's whole line, which signs out the copy and the user,
  who signs in again.
- A short grace period lets several tabs reconnect with the same token at
  once.
- A copied token then works at most until the real client next connects,
  and using it shows the theft. PROTOCOL.md §5.2 names this as an optional
  mitigation (shazow/apron#115).

**Revisit binding when** one of these happens:

1. Token theft from web storage becomes a real problem for Apron
   deployments.
2. Apron must support issuers that give clients only bound tokens (mostly a
   PLAN_OAUTH problem; PLAN_LOOSE's server absorbs it).
3. Platforms make binding free: DBSC for tokens, or OAuth libraries that
   bind keys by default.
4. Operators of high-value deployments want to require it.

What follows is the design that keeps that door open.

**Reserved now:**

- `auth.params.dpop`: a proof JWT.
- `AuthResult.token_type`: `"Bearer"` or `"DPoP"`. Absent means `"Bearer"`.
- `server.dpop`: `{algs: string[], nonce: string}`.
- `data.dpop_nonce` on a `denied` reply to `auth`: retry once with this
  nonce.

**Binding is opt-in.** A server binds a token only when the `auth` that
issued it carried a valid `dpop`. An old server ignores `dpop` and returns
no `token_type`, so the client uses a bearer token. An old client never
sends `dpop`, so it never gets a bound token.

**The proof (decided: reuse RFC 9449's JWT).** Existing DPoP code and
verifiers carry over.

| RFC 9449 | On `auth` |
|---|---|
| `DPoP` header | `params.dpop` |
| `typ` | `dpop+jwt` |
| `htm` | `"GET"`, the method of the upgrade request that opened the connection |
| `htu` | the server's address as the client connected to it, such as `wss://chat.example/ws` |
| `ath` | the hash of `params.token`, when there is one |
| `DPoP-Nonce` | `server.dpop.nonce` |
| `use_dpop_nonce` | `denied` with `data.dpop_nonce` |

- The nonce is unpredictable and bound to its connection, as WebAuthn
  challenges are (§4.10). A proof copied from a log fails on any other
  connection, and `jti` only needs to be unique per connection.
- A client with a bound token waits for the `server` frame before it sends
  `auth`, and doesn't pipeline requests after an `auth` without a nonce. This
  is the one exception to §3.2.2's "MAY send `auth` before `server`".
- Each reconnect signs one new proof with the same key, with no extra round
  trip.
- ES256 MUST be supported; Ed25519 MAY; `none` and MAC algorithms MUST NOT.
- Every proof failure is `denied`, as today.

```jsonc
// <- a fresh nonce on every connection
{"method": "server", "params": {"apron": 10, "auth": ["external", "token"],
  "dpop": {"algs": ["ES256"], "nonce": "n_7Qx2…"},
  "external": {"authorization_endpoint": "https://chat.example/oauth/authorize"}}}

// -> redeem a code, and ask for a bound token
{"method": "auth", "id": "c1", "params": {"scheme": "external", "code": "Hk41x9…",
  "code_verifier": "dBjftJ…", "redirect_uri": "com.sidekick.app:/signed-in",
  "client_id": "com.sidekick.app", "dpop": "eyJ0eXAiOiJkcG9wK2p3dCIs…"}}
// <-
{"id": "c1", "result": {"you": {"user_id": "ada", "name": "Ada"}, "token": "st_…", "token_type": "DPoP"}}

// -> a later connection; the proof's payload adds "ath"
{"method": "auth", "id": "c1", "params": {"scheme": "token", "token": "st_…", "dpop": "eyJ0eXAiOiJkcG9wK2p3dCIs…"}}
// <- a proof without this connection's nonce
{"id": "c1", "error": {"code": -32001, "message": "Sign-in proof expired; retry", "data": {"dpop_nonce": "n_Zp9…"}}}
```

**The library path.** The token endpoint returns the Apron token as the
`access_token` with `token_type: "Bearer"` until the server advertises
`server.dpop`. Only then MAY it return `"DPoP"`, and advertise
`dpop_signing_alg_values_supported` in its metadata.

**Foreign issuers.**

- An issuer that requires DPoP gets proofs from the Apron server's own key
  (Rules, above). The bound refresh token, if the server keeps one, is then
  useless to anyone who copies the server's database without the key.
- An issuer that requires pushed authorization requests, such as AT
  Protocol, cannot serve the simple path: its authorization URL needs a
  `request_uri` from an HTTP POST. Library clients only, unless the server
  pushes the request for the client (question 9).

**Guidance now:**

- Servers never log `auth` params, and store only hashes of tokens.
- Servers rotate Apron tokens for web clients, as OAuth 2.1 asks for public
  clients' refresh tokens.
- Clients keep tokens out of URLs and crash reports.
- Keep the portal's "confirm before redirect, also when signed in": against
  code running in a client (A7), no binding helps, and that click is the
  guard (RFC 10017 §5.1.3).

**Later, and optional:**

- Bind the Apron `token`, for clients that choose to: web clients with a non-extractable ES256 WebCrypto
  key in IndexedDB, native clients with Secure Enclave or Android Keystore
  keys. It strengthens the answer to token theft from storage and logs (A6,
  F7) beyond rotation, and makes §4.10's origin binding of WebAuthn tokens
  redundant (F4).
- DBSC for first-party web clients only: a DBSC-bound cookie that mints
  short-lived Apron tokens over HTTP, with no wire change. Nothing signs in
  from the upgrade's cookie until DBSC is shown to cover WebSocket upgrades
  and ships beyond Chrome on desktop.

## Changes to shazow/apron#115

Done in `8755cfa` (2026-11-14): §4.12 now follows this plan, with begin,
and `auth` gains `ext` for extensions such as `ext:auth_external`. Still to
do: HISTORY.md, the schema, and fixtures.


- §3.1: `server.external` goes; the details come from begin.
- §3.2: `external` takes nothing (begin), `code` with `code_verifier`,
  `redirect_uri`, and `client_id`, or `token`. The result of begin carries
  `external`. `return_url`, `state`, and the result's `url` stay gone.
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
7. Should every `server` frame carry `server.dpop.nonce`, or only a server
   that offers binding?
8. Should a server be able to require binding (`server.dpop.required`) and
   refuse unbound tokens? Old clients would then fail to sign in with
   `token`.
9. Issuers that require pushed authorization requests: settled. They go
   behind the server's portal, which pushes requests on its own behalf (see
   AT Protocol in "Scenarios behind the portal").
10. Terminals: is a key file worth binding to, or only keys in an agent, a
    TPM, or a platform keystore?
11. Once tokens bind to keys, does §4.10's origin binding of WebAuthn tokens
    stay, or become the fallback for clients without a key?
12. Does Chrome refresh an expired DBSC-bound cookie before a WebSocket
    upgrade? Worth one test before any cookie scheme is considered.
