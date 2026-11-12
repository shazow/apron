# Plan: `external` as OAuth 2.1

Status: proposal, drafted in PROTOCOL.md on
[shazow/apron#115](https://github.com/shazow/apron/pull/115), as a change to
v10. The rest of the repository follows once the decisions settle.
Supersedes [PLAN_ENDGAME.md](PLAN_ENDGAME.md). Prior art is in
[PRIOR_ART.md](PRIOR_ART.md#oauth-for-open-protocols).

## Summary

`external` becomes an OAuth 2.1 profile, so that implementers use
off-the-shelf OAuth libraries, and a server can use an existing authorization
server, such as Pocket ID, as is.

- The Apron server is an OAuth **resource server**.
- An **authorization server** signs users in and issues access tokens: a
  service such as Pocket ID or Keycloak, or one that the Apron server runs
  itself.
- Clients are OAuth **public clients**. They sign in with the authorization
  code grant and PKCE, or with the device authorization grant, using any
  OAuth 2.1 library.
- A client presents the access token with `auth {scheme: "external", token}`.

Apron defines only how a server advertises its authorization server, how a
client presents a token on the connection, and the checks on both sides.
Everything else is OAuth 2.1 and its extensions. The profile follows the
IETF's OAuth profile for open public clients
(`draft-ietf-mailmaint-oauth-public`), which solves the same problem for
IMAP, SMTP, and JMAP, and the MCP authorization specification.

`email` keeps its proposals and temporary tokens, and gets the mix-up fix.

[EVALUATIONS.md](EVALUATIONS.md) checks every action, client, and pairing
against each scheme. Its findings add three changes, C1 to C3, now in
PROTOCOL.md: short email codes that survive a reconnect, adding an
`external` identity to an account, and an authorization server that any
client can use.

## Why reshape `external`, not add a scheme

- `external` already means "the user signs in outside the connection". OAuth
  is that, done by the standard.
- One scheme for the job, rather than two that overlap.
- The approval, `auth {scheme: "external", token}`, keeps its shape. Only
  where the token comes from changes.
- We own every implementation, and migrate them together, so the change
  stays in v10.
- The cost: `external` proposals, `return_url`, the proposal's `url`, the
  sign-in page rules, and adding an external identity to an account go.
  Linking identities becomes the authorization server's job.

## PROTOCOL.md changes

| Section | Change |
|---|---|
| §3.1 | `server.external` |
| §3.2 | `external` is sign-in with an OAuth 2.1 access token; `return_url` and the result's `url` go |
| §4.11 Email sign-in | email alone: proposals, temporary tokens, approval; the mix-up fix for links and codes |
| §4.12 External sign-in | new: §4.12.1 `server.external`, §4.12.2 Signing in, §4.12.3 Token checks |
| §4.13 `ext` | moved from §4.12; links updated across the repository |
| §5.2 | the `return_url` and sign-in page lines go; lines for each new guard |
| §5.4 | the line about the sign-in page's `url` goes |

## External sign-in

### Advertising (§4.12.1)

```jsonc
// <- from wss://chat.example/ws
{
  "method": "server", "params": {
    "apron": 10,
    "auth": ["external"],
    "external": {
      "issuer": "https://id.example",
      "resource": "https://chat.example",
      "scope": "openid offline_access"
    }
  }
}
```

```ts
class External {               // server.external
  issuer: string;              // the authorization server's issuer identifier
  resource: string;            // this server's resource indicator
  scope?: string;              // space-separated scopes to request
  client_id?: string;          // a public client ID that any client MAY use
}
```

- A server that lists `external` in `server.auth` MUST send `server.external`.
- `resource` is `https://` plus the host and any port of the server's
  address, without a path. For `wss://chat.example:8443/ws`, it is
  `https://chat.example:8443`.
- `scope` lists what the authorization server needs, such as `openid`, or
  `offline_access` for refresh tokens. Apron defines no scope.
- Servers SHOULD publish protected resource metadata (RFC 9728) for
  `resource`, with `issuer` in `authorization_servers`. The `server` frame
  is the normative way to advertise; clients do not need the metadata.
- Servers SHOULD advertise an authorization server that any client can use
  (C3).

### Signing in (§4.12.2)

- Clients MUST check that `resource` is the one for the server's address.
- Clients fetch the authorization server's metadata from `issuer` (RFC 8414),
  and MUST check that its `issuer` is identical.
- Clients use the authorization code grant with PKCE `S256`, and MUST NOT
  sign in if the metadata does not list `S256`.
- Clients without a browser MAY use the device authorization grant
  (RFC 8628), if the metadata offers it.
- Clients send `resource` as a resource indicator (RFC 8707) in the
  authorization and token requests, and `scope` unchanged.
- Clients MUST check `iss` in the authorization response (RFC 9207) when the
  metadata says that the authorization server sends it.
- Clients SHOULD get a client ID in this order, as MCP does:
  1. a client ID that they were configured with for `issuer`.
  2. a client ID metadata document, such as
     `https://sidekick.app/oauth-client.json`, if the metadata has
     `client_id_metadata_document_supported`.
  3. dynamic registration (RFC 7591), if the metadata has
     `registration_endpoint`.
  4. `server.external.client_id`.
- Clients present the access token in `auth`. They keep the refresh token,
  and present a fresh access token on each new connection.

```jsonc
// ->
{"method": "auth", "id": "c1", "params": {"scheme": "external", "token": "eyJhbGciOiJFUzI1NiIs…"}}
// <-
{"id": "c1", "result": {"you": {"user_id": "ada", "name": "Ada"}}}
```

### Token checks (§4.12.3)

- An `external` request without `token` is `invalid_params`.
- Servers MUST accept only access tokens from `issuer` whose `aud` includes
  `resource`. They check the signature against the issuer's keys, or
  introspect the token (RFC 7662), and check `exp`. (`aud` can list more:
  Pocket ID adds its issuer when the token carries an OpenID Connect scope.)
- An invalid, expired, or wrongly addressed token is `denied`. The client
  then refreshes, or signs in again.
- A successful sign-in carries `you`, and no Apron `token`.
- On a signed-in connection, a token adds its identity to the account, and
  never signs in to another account (C2).
- Servers identify an account by the token's `sub`, never by a claim that
  can change, such as a user name.
- Servers MUST NOT pass a client's token on, except to the issuer, such as for
  introspection or user info.
- A token's expiry does not end the connection that it signed in. A server MAY
  close a connection when the authorization server revokes its session.
- Account creation for new `sub` values is server policy.

### Left to OAuth 2.1, not restated

| client | way back |
|---|---|
| Web frontend | a redirect to its own origin |
| Native app | a reverse-domain scheme with at least one `.`, such as `com.sidekick.app:/signed-in`, or a loopback IP address on any port (RFC 8252), in an external user agent or a sign-in session, never an embedded web view |
| Terminal client | the device authorization grant |

- A declined sign-in returns `error=access_denied`.
- Clients SHOULD show which account they signed in to. This is client
  guidance, not a wire rule.

Recommendations for operators of authorization servers, from the
open-clients profile:

- Show that a client ID metadata document or a registered client is
  unverified, and show the redirect's host.
- Rotate refresh tokens for public clients.
- Issue access tokens that last at least 10 minutes.

## Email sign-in (§4.11)

Unchanged, except for the mix-up fix, and short codes that survive a
reconnect (C1):

- A client uses a link with the `state` of its own proposal only if the
  link's `server` is the server that it proposed to. It drops any other such
  link. (v10 said to ignore `server`.)
- An email with a code gives the server's address, and tells the user to type
  the code only in a client that is connected to that server.

Without the fix, a malicious server proposes a sign-in to another server with
the user's address and the client's `state`. The other server emails the
user, and the client hands the link's token, or the user types the code, to
the malicious server, which signs in to the other server as the user.

## Changes from the evaluation

Each change closes a finding in [EVALUATIONS.md](EVALUATIONS.md). Each is in
PROTOCOL.md on shazow/apron#115.

### C1: short email codes work with the proposal's `state` (F1, F2)

A phone app in the background loses its connection, and with it a code that
works only on that connection. With C1, the app reconnects, and presents the
code with the proposal's `state`.

§4.11.2, replacing the rule on short tokens:

> - A token that is short enough to type, such as six digits, works only on
>   the connection that made the proposal, or with the proposal's `state`
>   (short codes are easy to guess, and `state` is not).
> - A token that works without either MUST be unguessable.

```jsonc
// -> on a new connection, after the app comes back
{"method": "auth", "id": "c1", "params": {"scheme": "email", "token": "418092", "state": "q8Rz…"}}
// <-
{"id": "c1", "result": {"you": {"user_id": "ada", "name": "Ada"}, "token": "st_Hk41…"}}
```

- A guesser needs the `state`, which only the proposing client knows. Failed
  attempts still count against the proposal.
- A malicious server that relays a proposal already has the `state`, so C1
  gives it nothing new. The server's address in the email still guards that
  case (R1).
- No schema change: `auth` already carries `state` for `email`.

### C2: `external` on a signed-in connection adds the identity (F3)

Linking identities was the authorization server's job. That fails when a
server offers `email` and a third-party authorization server, such as Pocket
ID: an account made by email cannot gain its Pocket ID identity. C2 follows
email's rule: on a signed-in connection, sign-in schemes add, and never
switch.

§4.12.3, added:

> - On a connection that is signed in, guests included, an `external` request
>   adds the token's identity to that account. It never signs in to another
>   account.
> - An identity that belongs to another account is `denied`.

- The result carries `you`, as for any successful `external` request. A
  token with the account's own `sub` adds nothing, so a client can present a
  fresh token on an open connection.
- An email addition now returns `you` too (§4.11.3), as a WebAuthn
  registration on a signed-in connection already did (§4.10). So `{}` means
  only that nothing was authenticated, such as an email proposal, and a
  client can tell an addition from a proposal by the result alone.
- A guest that signs in with `external` keeps its account, and gains the
  identity.
- To switch accounts, a client opens a new connection.
- The token comes from the client's own sign-in, with PKCE and OAuth
  `state`, so a link cannot make it add someone else's identity.
- §5.2, added: "On a signed-in connection, `external` adds an identity, and
  never switches accounts (§4.12.3). So a token cannot silently move a
  session to another account."

### C3: an authorization server that any client can use (F5)

Third-party web and native clients need a client ID, web clients need CORS,
and terminal clients need the device grant. None of these is on the wire;
each is the operator's choice of authorization server.

§4.12.1, added:

> - Servers SHOULD advertise an authorization server that:
>   - allows cross-origin requests to its metadata, token, and registration
>     endpoints.
>   - gives any client a client ID: by a client ID metadata document, dynamic
>     registration, or `server.external.client_id`.
>   - offers the device authorization grant.

- Pocket ID meets C3 with a public client in `client_id`, or client ID
  metadata documents allowed by URL pattern, and its device grant.
- `workers-oauth-provider` 1.2.4 meets C3 except for the device grant. It
  reflects the request's `Origin` on its metadata, protected resource
  metadata, token, and registration endpoints, and offers dynamic
  registration and client ID metadata documents (opt-in). Its grant types
  are the authorization code, refresh, and optionally token exchange and
  JWT bearer. Native app schemes need `allowPrivateUseRedirectUris`;
  loopback redirects work by default.
- A shared `client_id` shows every client as one name (R3), so client ID
  metadata documents are better where the authorization server takes them.

### F4: no change

A `webauthn` token is bound to its ceremony's origin (§4.10). A native client
can send any `Origin`, so the binding stops theft between browser origins
only. §5.2 already says "another web origin".

## Coverage

The full grid is in [EVALUATIONS.md](EVALUATIONS.md#grid).

| scenario | how |
|---|---|
| 1. macOS app, existing passkey | an OAuth library with `ASWebAuthenticationSession`, against the server's authorization server |
| 2. Native app without a sign-in session | loopback, with PKCE |
| 3. Two Apron apps on one device | each app's own scheme or port; PKCE makes a stray code useless |
| 4. Unknown web frontend | a redirect to its own origin, with a client ID metadata document |
| 5. Terminal client | the device authorization grant |
| 6. Server behind Pocket ID | Pocket ID is the authorization server |
| 7. Server without its own page | any authorization server; the Apron server needs no sign-in UI |
| 8. Declined sign-in | `error=access_denied` |

Abuse cases, each with a §5.2 line:

- **Phishing, a mailed link:** the authorization server's consent screen,
  which marks unverified clients and shows the redirect's host.
- **Wrong recipient, scheme squatting:** PKCE.
- **Mix-up between authorization servers:** the `issuer` and `iss` checks.
- **Mix-up between Apron servers, by email:** the link's `server` check, and
  the code's server in the email.
- **A link that switches accounts, or adds someone else's identity:** a
  signed-in connection only adds, and only with a token from its own sign-in
  (C2).
- **A server replaying a client's token elsewhere:** the client's check of
  `resource` against the server's address, and `aud`.
- **A token from another app on the same authorization server:** its `aud`
  does not include this server's `resource`.
- **Passkey relay:** the passkey step runs on the authorization server's
  domain. The §4.10 RP ID check still applies to in-connection `webauthn`.

## Pocket ID

1. The operator defines an API in Pocket ID with the identifier
   `https://apron.foo.com`, and lets Apron clients reach it.
2. The operator either registers one public client for Apron, or allows
   client ID metadata documents by URL pattern.
3. The Apron server sets `issuer`, `resource`, `scope`, and, for a
   registered client, `client_id`.

`scope` is `openid profile offline_access`: Pocket ID issues refresh tokens
only for `offline_access`, and its userinfo endpoint gives the server a new
user's name and picture.

The Apron server checks Pocket ID's access tokens: the signature against
Pocket ID's keys, `iss`, `exp`, and that `aud` includes
`https://apron.foo.com`. It needs no sign-in page, callback, or proposals.

## Decisions

**`resource` is an `https` URL of the server's origin.**

- RFC 8707 and RFC 9728 require an absolute URI, and RFC 9728 requires
  `https`. MCP uses the server's `https` URL, and Pocket ID's API form
  suggests `https://api.example.com`.
- The mail profile uses a bare host only for IMAP, SMTP, and POP, which have
  no URL, and calls it a deviation from both RFCs. For JMAP, which runs over
  HTTP, it uses the endpoint's `https` URL. An Apron connection starts as an
  HTTP request, so it is in the second group.
- It leaves out the path. Servers on one host and port share a `resource`,
  and so accept each other's tokens. That is the same trust as the §4.10 RP
  ID check, which also stops at the host. It keeps RFC 9728's well-known URL
  at the root, and gives operators one identifier to type.
- It keeps the port, since another port can be another operator's server.

**Apron registers no scope.**

- The mail profile registers `urn:ietf:params:oauth:scope:mail` so that one
  token works on many servers of one provider. An Apron token is for one
  server: `resource` and `aud` say which. A scope would add nothing to that
  check.
- A plain `apron` scope could collide with an operator's own scopes. In
  Pocket ID, it would also be one more setting on the API, for no check.
- So `server.external.scope` carries what the authorization server needs, and
  clients pass it on unchanged. MCP does the same with `scopes_supported`.
- If Apron later needs to grant less than a whole account, such as a read-only
  bot, it can define scopes then.

**`email` stays.**

- It is the only scheme that both signs in and recovers an account without an
  authorization server or HTTP endpoints. Small servers rely on that.
- Its proposals do not depend on `external`'s.
- A server that runs an authorization server can move email into it, and
  stop offering `email` on the connection, as Matrix does with its
  authentication service.

**v10, not v11.** We own every implementation, and migrate them together.

**Sections.** §4.11 is email sign-in, §4.12 is external sign-in, and `ext`
moves to §4.13. Email stays first, so that its links keep their anchors.

**Codes survive a reconnect (C1).** Binding a code to the `state`, rather
than only to the connection, keeps guessing hard and lets phone apps finish.

**Sign-in schemes add on a signed-in connection, and never switch (C2).** It
matches email, gives a guest a way to keep its account, and covers fresh
tokens.

**Operators pick an authorization server that any client can use (C3).** A
recommendation, since the wire cannot make an authorization server open.

**No rule for a fresh token on an open connection.**

- The mail profile: access token expiry "SHOULD NOT affect" sessions that
  already signed in, and IMAP and SMTP cannot sign in again on a connection.
- Kafka (KIP-368) and MQTT 5 let a client sign in again on the same
  connection before expiry, as the same user, or the server closes it.
- Matrix and MCP send a token with every HTTP request, so the question does
  not arise.
- Apron follows the mail profile: expiry does not end the connection, so no
  client needs a fresh token. §3.2.2 already lets an `auth` keep the same
  user without a sign-in, so a server can accept one Kafka-style. C2 makes
  that explicit: a token with the account's own `sub` adds nothing, and
  returns `you`.

## Impact

### apron-server-cloudflare (server.apron.chat)

- Becomes its own authorization server, since its passkeys live with it,
  using Cloudflare's `workers-oauth-provider`. Version 1.x implements the MCP
  authorization specification: PKCE, client ID metadata documents (opt-in),
  dynamic registration, issuer identification, and tokens bound to a list of
  `resources`. Its authorization server and resource server can run as
  separate Workers, joined by a Service Binding.
- The existing passkey code becomes the sign-in step of its authorization
  page, at an origin under `apron.chat`.
- Accepts `external` tokens in `auth`, and publishes protected resource
  metadata.
- Sets `allowPrivateUseRedirectUris` for native apps, and opts in to client
  ID metadata documents.
- Has no device grant, so terminal clients use a loopback redirect, `email`,
  or `token` until one is added beside the library.
- Keeps `webauthn` for web.apron.chat, and `token` for bots and invites.

### apron-web

- An OAuth 2.1 browser client: metadata discovery, PKCE, a redirect to its
  own origin, refresh tokens for each server, and the `resource` and `iss`
  checks.
- Publishes a client ID metadata document at, for example,
  `https://web.apron.chat/oauth-client.json`.
- Replaces its `external` proposal code.
- Drops email links whose `server` is not the server it proposed to.
- Presents a typed email code with the proposal's `state` (C1).
- Adds an `external` identity from the account settings (C2).

### Sidekick, SideTable, and other native apps

- An OAuth library, such as AppAuth: a sign-in session or loopback, PKCE, and
  refresh.
- A client ID metadata document on the developer's domain, or dynamic
  registration, or the server's `client_id`.

### Terminal clients

- The device authorization grant, where the authorization server offers it.

### Servers behind Pocket ID or another provider

- Check tokens and map `sub`; no sign-in UI at all.

### Servers that offer `email`

- Name the server's address in emails with a code.
- Accept a short code with the proposal's `state`, on any connection (C1).

### shazow/apron

- [x] PROTOCOL.md (shazow/apron#115)
- [x] PROTOCOL.md: C1, C2, C3, their §5.2 lines, and `you` for email
  additions
- [ ] HISTORY.md: `external` is now OAuth, and `server.external`; the email
  mix-up fix; the `updated` date.
- [ ] Schema: `server.external`; `auth` with `external` takes only `token`;
  `return_url` and the result's `url` go; descriptions for §4.11 and §4.12.
- [ ] Fixtures: a `server` frame with `external`.
- [ ] Conformance: an `external` request without `token` is
  `invalid_params`; an email code with the wrong `state` is `denied`. The minimal servers offer `guest` only, so they are
  otherwise unaffected.
- [ ] Notes that refer to v10's `external`: EXT_AUTH_EXTERNAL.md,
  RECIPES_CANDIDATES.md.

## Tradeoffs

- **For:** standard libraries in every client, existing authorization servers
  used as is, and far less Apron-specific text. Matrix, AT Protocol, MCP, and
  the IETF mail profile all made this move.
- **Against:** a server that hosts its own passkeys runs an authorization
  server, with HTTP endpoints. Clients need HTTP and an OAuth library on top
  of the Apron connection.
- **Web clients:** the authorization server's metadata and token endpoints
  must allow CORS. Pocket ID does: it sends `Access-Control-Allow-Origin: *`
  on its token, introspection, JWKS, and metadata endpoints.
- **Client IDs:** client ID metadata documents show the real client, but the
  operator must allow their URLs; a shared `client_id` works everywhere, and
  shows every client as "Apron".
- **Sessions:** lifetime and revocation move to the authorization server.

## Open questions

1. server.apron.chat misses C3's device grant, since `workers-oauth-provider`
   has none. Build one beside the library, or accept loopback, `email`, and
   `token` for terminal clients there?
