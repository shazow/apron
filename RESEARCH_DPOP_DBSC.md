# Research: DPoP, DBSC, and binding Apron's sign-in to a key

Status: research notes, local and not committed, 2026-11-14. Input to
[PLAN_LOOSE.md](PLAN_LOOSE.md) and [PLAN_OAUTH.md](PLAN_OAUTH.md). Uses the
vocabulary of [EVALUATIONS.md](EVALUATIONS.md) (A1 to A5, W1, W3, N1, N3,
T) and [PLAN_CONFORMANCE.md](PLAN_CONFORMANCE.md).

## Summary

- **DPoP (RFC 9449)** is the only shipped, standard way to bind OAuth
  tokens to a client key that works in browsers. It is defined for HTTP
  only. No RFC or adopted draft carries a DPoP proof over WebSocket frames,
  SASL, or another non-HTTP protocol. The IETF mail profile says so
  explicitly, and binds only the refresh token for non-HTTP use.
- **DBSC** binds **cookies** to a TPM or Secure Enclave key in Chrome on
  Windows and macOS. It is a W3C First Public Working Draft (2025). Firefox
  is negative, WebKit has concerns, and nothing covers mobile or Linux. It
  says nothing about OAuth tokens or WebSocket frames.
- **DBSC with OAuth** is discussion only: one open issue on the DBSC
  repository, and vendor products (Entra Token Protection) that bind tokens
  to devices in proprietary ways. The IETF's browser-apps BCP, now RFC
  10017, names DPoP with a non-extractable WebCrypto key as the browser
  option.
- **For Apron**, nothing breaks today: Pocket ID and `workers-oauth-provider`
  issue only bearer tokens. But PLAN_OAUTH fails silently with any issuer
  that binds access tokens, and PLAN_LOOSE's server-side redemption fails
  with any issuer that requires DPoP at its token endpoint. Both are cheap
  to fix in the plans now. Binding the Apron `token` itself can come later,
  if a few names and rules are reserved now.

### Recommendations

Ranked. Each is marked **wire now**, **reserve now** (a reserved field or
rule, for forward compatibility), **guidance**, or **later**.

1. **Reserve now: the binding fields.** Reserve `auth.params.dpop` (a proof
   JWT), `AuthResult.token_type` (`"Bearer"` or `"DPoP"`; absent means
   `"Bearer"`), `server.dpop` (`{algs, nonce}`), and `data.dpop_nonce` on a
   `denied` reply to `auth`. A server binds a token only when the request
   that issued it carried a proof. So old servers ignore `dpop` and issue
   bearer tokens, and old clients never receive bound tokens. See
   [the checklist](#forward-compatibility-checklist).
2. **Wire now: never accept a bound token as a bearer token.** In both
   plans' token checks: a server MUST reject an access token that is bound
   to a key (a `cnf` claim, or an introspection response with `cnf` or
   `token_type: DPoP`) unless it verifies a proof for that key. This is
   RFC 9449 §7.2's downgrade rule. It costs one check now, and stops a
   stolen bound token from working at Apron as a bearer token.
3. **Wire now (PLAN_LOOSE): the server redeems with its own DPoP key.** When
   the Apron server redeems a code at a foreign issuer, and the issuer
   supports or requires DPoP, the server signs the proof with a key of its
   own, and handles `use_dpop_nonce` itself. Simple clients MUST NOT add
   `dpop_jkt` to the authorization URL on this path. Do not define
   forwarding a client's proof. See [(a)](#a-websocket-redemption).
4. **Wire now (PLAN_OAUTH): clients use DPoP at the token endpoint only if
   the server can take it.** A client sends DPoP proofs to the issuer only
   if `server.dpop` is present, or if it then gets `token_type: Bearer`. A
   client that gets a DPoP-bound access token for a server without
   `server.dpop` cannot use it. Until then, PLAN_OAUTH says plainly that it
   supports bearer access tokens only.
5. **Guidance now: token hygiene.** Servers never log `auth` params, and
   store only token hashes. Servers rotate Apron tokens on use for web
   clients, as OAuth 2.1 §4.3 asks for public clients' refresh tokens.
   Clients keep tokens out of URLs and crash reports. Keep PLAN_LOOSE's
   "confirm before redirect, also when signed in": it is what makes
   binding worth having against XSS (RFC 10017 §5.1.3).
6. **Reserve now: the proof format.** An RFC 9449 proof JWT (`typ:
   dpop+jwt`), with `htm: "GET"` and `htu` the server's address as the
   client connected to it, a `nonce` from the `server` frame that is bound
   to the connection, and `ath` when a token is presented. Write it in the
   plans; no PROTOCOL.md text yet. Question [Q1](#open-questions).
7. **Later: bound Apron tokens.** Implement 1 and 6 in server.apron.chat and
   apron-web, with a non-extractable ES256 WebCrypto key in IndexedDB; then
   native clients with Secure Enclave or Android Keystore keys. It closes
   F4 for native clients, and token theft from storage and logs (new A6).
8. **Later: DPoP-bound issuer tokens in PLAN_OAUTH.** Accept them on
   `auth` with a proof (1, 6). Recommend issuers that bind refresh tokens
   only, where offered (Keycloak 26.4), as the mail profile does.
9. **Guidance, then later: DBSC for first-party web only.** A W1 deployment
   MAY keep its session in a DBSC-bound cookie, and mint short-lived Apron
   tokens from it over HTTP, with no wire change. A scheme that signs in
   from the WebSocket upgrade's cookie waits until DBSC is shown to cover
   WebSocket upgrades, and ships beyond Chrome desktop.
10. **Later: watch list.** The generic DPoP drafts, the AS metadata
    parameter `dpop_bound_access_tokens_required`, DPoP for the device
    grant, DBSC federation, and `workers-oauth-provider` DPoP.

## State of the technologies

### DPoP (RFC 9449)

Mechanism ([RFC 9449](https://www.rfc-editor.org/rfc/rfc9449)):

- The client holds a key pair. On each HTTP request, it sends a `DPoP`
  header: a JWT with `typ: dpop+jwt`, an asymmetric `alg` (never `none`),
  and the public `jwk` in the header. Its payload has `jti`, `iat`, `htm`
  (the HTTP method), and `htu` (the target URI, without query or fragment).
- At the token endpoint, the authorization server binds the access token to
  the key's JWK thumbprint (`cnf.jkt` in a JWT, or in introspection), and
  returns `token_type: DPoP`. It MAY return a bearer access token instead
  (`token_type: Bearer`); the client MUST check, and MAY discard the
  response (§5).
- Refresh tokens issued to **public clients** are bound to the key (§5). So
  a public client that sends a proof gets a bound refresh token even when
  the access token is bearer.
- At a resource server, the request carries `Authorization: DPoP <token>`
  and a proof with `ath`, the hash of the access token. A resource server
  that supports DPoP MUST reject a bound token sent as a bearer token
  (§7.2).
- **Nonces** (§8, §9): a server answers `use_dpop_nonce` with a `DPoP-Nonce`
  header, and the client retries with `nonce` in the proof. A nonce limits
  pre-generated proofs (§11.2). After a nonce is given, proofs without it
  MUST be rejected (§11.3). Okta requires a nonce on the first token request
  ([Okta guide](https://developer.okta.com/docs/guides/dpop/nonoktaresourceserver/main/));
  AT Protocol requires nonces everywhere.
- **`dpop_jkt`** (§10): the client puts its key's thumbprint in the
  authorization request, and the authorization server binds the code to it.
  Only a token request with a proof by that key can redeem the code.
- **Metadata:** `dpop_signing_alg_values_supported` for authorization
  servers (RFC 9449 §5.1) and protected resources
  ([RFC 9728](https://www.rfc-editor.org/rfc/rfc9728) §2), RFC 9728's
  `dpop_bound_access_tokens_required`, and the client registration
  parameter `dpop_bound_access_tokens` (RFC 9449 §5.2).
- **Limits** (§11.4): code that runs in the client, such as XSS, cannot
  export a non-extractable key, but can sign proofs while the client is
  online. Proof replay protection relies on `jti`, `iat`, and nonces.

Adoption, with status as found:

| | DPoP | Notes |
|---|---|---|
| AT Protocol | mandatory | All clients, with PAR; server nonces mandatory, rotated at least every 5 minutes; a key per session ([spec](https://atproto.com/specs/oauth)) |
| Okta | supported | Per app: "Require DPoP header in token requests"; nonce on first request ([guide](https://developer.okta.com/docs/guides/dpop/nonoktaresourceserver/main/)) |
| Auth0 | Early Access (uncertain) | Docs still say Early Access; a policy can require DPoP for public apps only ([docs](https://auth0.com/docs/secure/sender-constraining/demonstrating-proof-of-possession-dpop)) |
| Keycloak | supported since 26.4 | Preview since 23. Per client "Require DPoP bound tokens"; `dpop_jkt`; an option to bind only refresh tokens for public clients ([blog](https://www.keycloak.org/2025/10/dpop-support-26-4)) |
| Microsoft Entra ID | no RFC 9449 found (uncertain) | Token Protection binds the device's PRT; GA for native apps; preview for a few browser apps on ARM via a broker and an SSO extension, not DBSC ([concept](https://learn.microsoft.com/en-us/entra/identity/conditional-access/concept-token-protection), [web apps](https://learn.microsoft.com/en-us/entra/identity/conditional-access/deployment-guide-token-protection-web-apps)) |
| Curity | supported | Its HAAPI SDKs handle nonces ([docs](https://curity.io/docs/identity-server/developer-guide/haapi-sdks/concepts/dpop-and-nonces)) |
| Pocket ID | no | v2.19.1 source (commit `0691435`, 2026-11-02) has no DPoP; it uses `pocket-id/fosite` v1.4.3. Upstream `ory/fosite` closed its DPoP issue ([#829](https://github.com/ory/fosite/issues/829)). No Pocket ID issue found. |
| `workers-oauth-provider` | no | 1.2.4 source (commit `5c75ddc`) returns `token_type: 'bearer'`, and fails closed on ID-JAG `cnf` "until … DPoP processing [is] implemented". [#191](https://github.com/cloudflare/workers-oauth-provider/issues/191) (feature request) is open with no maintainer reply; [#412](https://github.com/cloudflare/workers-oauth-provider/issues/412) (an API proposal) was closed as not planned on 2026-10-19. |
| oauth4webapi | yes | `DPoP(client, keyPair)` takes a WebCrypto `CryptoKeyPair` and tracks nonces ([docs](https://github.com/panva/oauth4webapi/blob/main/docs/functions/DPoP.md)) |
| AppAuth | no | Open requests: [AppAuth-Android #1158](https://github.com/openid/AppAuth-Android/issues/1158) (2026), [AppAuth-iOS #856](https://github.com/openid/AppAuth-iOS/issues/856) (2024) |

**Browser keys.** RFC 10017 §6.3.4.2.2 recommends a non-extractable
WebCrypto `CryptoKeyPair` stored in IndexedDB. Non-extractable stops script
from exporting the key, not from using it. WebCrypto does not promise
hardware storage, and we found no browser that keeps such keys in a TPM.
Treat them as software keys in the browser profile: they stop a one-shot
read of storage, but not malware that copies the profile (uncertain; see
[InfoQ, 2026-04](https://www.infoq.com/articles/dpop-key-storage-unsolved-problem/)).
Native apps can use hardware keys: the Secure Enclave and Android Keystore
both offer P-256, which ES256 uses.

### DPoP outside HTTP

- **The IETF mail profile**
  ([draft-ietf-mailmaint-oauth-public-06](https://datatracker.ietf.org/doc/draft-ietf-mailmaint-oauth-public/),
  §3.8, 2026-09): DPoP is HTTP only, and OAUTHBEARER cannot carry a proof.
  A client that also uses IMAP, POP, or SMTP sends proofs to the token
  endpoint, so its refresh token is bound, and asks for a separate access
  token for its non-HTTP resources. When every `resource` is a bare
  hostname, the server MUST issue a bearer access token. Any other request
  with a proof gets a DPoP-bound access token. Servers that support DPoP
  SHOULD support resource indicators. A new SASL mechanism is out of scope.
- **Generic DPoP:**
  [draft-nandakumar-oauth-dpop-proof](https://datatracker.ietf.org/doc/draft-nandakumar-oauth-dpop-proof/)
  and its MoQ variant replace `htm` and `htu` with an `actx` object, typed
  per protocol. Individual drafts, both expired.
- **EPOP:**
  [draft-ambekar-oauth-epop-03](https://datatracker.ietf.org/doc/draft-ambekar-oauth-epop/)
  (individual, 2026-07) wraps the token and proof in one envelope for MQTT,
  Kafka, gRPC, MCP, and a new SASL mechanism, OAUTHEPOP, with a client nonce
  derived offline in place of server nonces. Presented at IETF 126; not
  adopted.
- **HTTP message signatures:**
  [draft-richer-oauth-httpsig-03](https://datatracker.ietf.org/doc/draft-richer-oauth-httpsig/)
  (individual), HTTP only.
- **WebSocket:** no draft. Browsers cannot set headers on a WebSocket
  upgrade, so a proof has to travel in a frame.

### OAuth WG work related to binding

| Document | State | Relevance |
|---|---|---|
| [RFC 10017](https://www.rfc-editor.org/rfc/rfc10017) (BCP 212), OAuth 2.0 for Browser-Based Applications | published 2026-08 | DPoP with a non-extractable key stops token exfiltration (§6.3.4.2.2), not new token acquisition by XSS (§5.1.3), nor proxying through the browser (§5.1.4) |
| [OAuth 2.1, -17](https://datatracker.ietf.org/doc/draft-ietf-oauth-v2-1/) | WG draft, 2026-10 | Public clients' refresh tokens MUST be sender-constrained or rotated (§4.3) |
| [Attestation-Based Client Auth, -12](https://datatracker.ietf.org/doc/draft-ietf-oauth-attestation-based-client-auth/) | WG consensus, awaiting write-up | Key-bound client attestation; "combined mode" makes the DPoP key the client instance key. For apps with a platform attester, not open clients |
| [draft-emelia-oauth-as-metadata-dpop-required-00](https://datatracker.ietf.org/doc/draft-emelia-oauth-as-metadata-dpop-required/) | individual, 2026-11 | AS metadata `dpop_bound_access_tokens_required`, so clients know before they start |
| [draft-rosomakho-oauth-dpop-rt-00](https://datatracker.ietf.org/doc/draft-rosomakho-oauth-dpop-rt/) | individual, expired | Separate keys for refresh and access tokens (a `DPoP-RT` header) |
| [draft-parecki-oauth-dpop-device-flow-00](https://datatracker.ietf.org/doc/draft-parecki-oauth-dpop-device-flow/) | individual, expired | DPoP from the device authorization request onward; relevant to terminals |
| [draft-parecki-oauth-jwt-dpop-grant-02](https://datatracker.ietf.org/doc/draft-parecki-oauth-jwt-dpop-grant/) | individual, 2026-10 | A key-bound JWT assertion grant |
| [draft-ritz-idpop-01](https://datatracker.ietf.org/doc/draft-ritz-idpop/) | individual | DPoP with attested keys to unseal identity |

### DBSC

Mechanism ([Editor's Draft, 2026-11-09](https://w3c.github.io/webappsec-dbsc/)):

- A response's `Secure-Session-Registration` header asks the browser to
  create a key pair (ES256 or RS256) and to POST a proof JWT (`typ:
  dbsc+jwt`, with `jti` set to the server's challenge) to a registration
  endpoint.
- The endpoint returns a session configuration: `session_identifier`,
  `refresh_url`, a `scope` (origin or site, with include and exclude rules),
  and `credentials`, each of which MUST be of type `cookie`.
- Before a request in scope goes out without its short-lived cookie, the
  browser defers it, POSTs a `Secure-Session-Response` proof over a cached
  challenge to `refresh_url`, gets a fresh cookie, and restarts the request.
  A 403 with `Secure-Session-Challenge` asks for a new proof.
- Keys live in the TPM on Windows and the Secure Enclave on macOS. No device
  identifier or attestation reaches the server.

Venue and status:

- W3C Web Application Security WG.
  [First Public Working Draft](https://www.w3.org/TR/dbsc-1/) on
  2025-08-21; the Editor's Draft calls itself "very early drafting".
- Chrome: public on Windows from Chrome 146
  ([Google, 2026-04-09](https://blog.google/security/protecting-cookies-with-device-bound-session-credentials/));
  Chrome's notes are cited for 145. macOS rolls out gradually from about
  Chrome 147 ([Scott Helme](https://scotthelme.co.uk/device-bound-session-credentials-lands-in-chrome-on-macos/));
  sources disagree on versions. On by default for Google Workspace from
  2026-05
  ([Workspace](https://workspaceupdates.googleblog.com/2026/05/prevent-account-takeovers-with-DBSC-now-generally-available-in-the-Chrome-browser-for-Windows.html)).
  No Android, iOS, or Linux.
- Edge: listed as released in some trackers (uncertain). Firefox: [position
  negative](https://github.com/mozilla/standards-positions/issues/912).
  WebKit: ["concerns: usability"](https://github.com/WebKit/standards-positions/issues/281)
  (backup and restore).
- Google's post plans federated sessions, binding to existing keys (mTLS,
  security keys), and software keys. The Editor's Draft already has a
  federated mode, which shares a provider's key with a relying party.
- **DBSC(E)**, for enterprise attestation of the binding key, is an
  explainer in the WICG repository with no shipping status that we could
  confirm.

**WebSocket.** The spec does not mention WebSocket, and Chrome's docs do not
either. The WHATWG WebSockets standard runs the upgrade through Fetch, which
DBSC modifies, so in principle a WebSocket upgrade would be deferred and
refreshed. We found no evidence that Chrome does so. In
[w3c/webappsec-dbsc#250](https://github.com/w3c/webappsec-dbsc/issues/250)
(2026-04), an editor notes that WebSockets send cookies only on the
upgrade, and the reporter checks the cookie only there. Treat WebSocket
coverage as untested.

### DBSC-style binding for OAuth

| | What |
|---|---|
| Shipped | DPoP (RFC 9449), with bound refresh tokens for public clients. mTLS-bound tokens (RFC 8705), not usable from browsers. Entra Token Protection (proprietary, device-bound PRT; native GA, browser preview). DBSC, for cookies only. |
| Draft | RFC 10017 (published BCP, DPoP as the browser option). Attestation-based client auth (WG). The individual drafts in the table above. Nothing combines DBSC and OAuth. |
| Discussion | [w3c/webappsec-dbsc#31](https://github.com/w3c/webappsec-dbsc/issues/31) (open since 2024-04, no editor reply): let the browser hold the access token and its DPoP key, with a new grant type, so that SPAs never touch tokens. Related: [#112](https://github.com/w3c/webappsec-dbsc/issues/112) (HTTP message signatures), [#23](https://github.com/w3c/webappsec-dbsc/issues/23) (request signing). |
| History | Token Binding ([RFC 8471](https://www.rfc-editor.org/rfc/rfc8471) to 8473, 2018) bound tokens to the TLS connection. Chrome removed its implementation, and [draft-ietf-oauth-token-binding](https://datatracker.ietf.org/doc/draft-ietf-oauth-token-binding/) died at -08 in 2019. DPoP replaced it at the application layer. |

## Impact on PLAN_LOOSE

### (a) WebSocket redemption

**Server is the issuer.** Nothing breaks. The server decides whether to bind
the Apron `token` (b).

**Foreign issuer.** The Apron server sends the client's `code`,
`code_verifier`, `redirect_uri`, and `client_id` to the issuer's token
endpoint. If the issuer requires DPoP for that `client_id` (Okta's per-app
switch, Keycloak's "Require DPoP bound tokens", AT Protocol), a token
request without a proof fails. What can be done:

- **The server signs its own proof (recommended, 3).** RFC 9449 does not
  tie the DPoP key to the client's identity for public clients (§11.11).
  So the server can sign with a key of its own, retry on `use_dpop_nonce`,
  and receive tokens bound to its own key. That is what PLAN_LOOSE wants:
  the server only checks the token, maps `sub`, and issues an Apron
  `token`. It can also call userinfo with its own proofs, and keep the
  bound refresh token (PLAN_LOOSE question 1), which is then useless to
  anyone who steals the server's database without the key.
- **It fails if the code is bound to another key.** If the authorization
  request carried `dpop_jkt`, only that key can redeem. A simple client
  never needs `dpop_jkt` on this path, so PLAN_LOOSE should say: don't send
  it. A later version could advertise the server's thumbprint in
  `server.external` for issuers that require `dpop_jkt`, but no issuer we
  found requires it without also requiring PAR.
- **Forwarding a client's proof works mechanically, but is not worth
  defining.** A proof names `htm: POST` and the issuer's token endpoint,
  and the issuer does not care who sends it. But the client would need the
  token endpoint from the issuer's metadata (an HTTP call that simple
  clients avoid), and a nonce from the issuer, relayed through an extra
  `denied` round trip. The tokens would be bound to the client's key, so
  the server could neither refresh them nor call userinfo. The client gets
  nothing from them, since the path ends in an Apron `token` anyway.
- **PAR-only issuers** (AT Protocol) cannot serve the simple path at all:
  the authorization URL needs a `request_uri` from an HTTP POST. Only
  library clients work there, unless the server pushes the request for the
  client ([Q4](#open-questions)).

### (b) A sender-constrained Apron `token`

**Should it be?** Yes, later. The Apron `token` is a long-lived session
credential, like a refresh token, and web clients on arbitrary origins keep
it in localStorage or IndexedDB. OAuth 2.1 asks that a public client's
refresh token be bound or rotated. Today Apron leaves rotation to server
policy, and binding exists only for WebAuthn tokens, and only to a web
origin (F4).

**What a proof on `auth` looks like.** No standard covers this, so Apron
picks a shape. The recommended one (6) reuses RFC 9449's proof JWT, so that
DPoP verifiers and the keys and code of DPoP clients carry over:

| RFC 9449 | Apron `auth` |
|---|---|
| `DPoP` header | `params.dpop` |
| `htm` | `"GET"`, the method of the upgrade request that opened the connection |
| `htu` | the server's address, as the client connected to it, such as `wss://chat.example/ws`. The scheme keeps it apart from any HTTP endpoint on the same path. |
| `ath` | the hash of `params.token`, when there is one |
| `DPoP-Nonce` | `server.dpop.nonce`, in the `server` frame |
| `use_dpop_nonce` | `denied` with `data.dpop_nonce` |

- **Where the nonce comes from:** the `server` frame, which every
  connection already gets before `auth`, at no extra round trip. The nonce
  is unpredictable, and bound to its connection, as WebAuthn challenges are
  (§4.10). So a proof that leaks, such as from a log, does not work on any
  other connection, and the server needs no global `jti` store: `jti`
  is unique per connection. A server that re-sends `server` (§3.1) MAY
  change the nonce.
- **The barrier (§3.2.2).** A client with a bound token waits for `server`
  before it sends `auth`, since it needs the nonce. After that, pipelining
  works as today. A client that sends `auth` first, without a nonce, gets
  `denied` with `data.dpop_nonce`, and the requests that it pipelined get
  `denied` too, so it MUST NOT pipeline before a proof with a nonce.
- **Reconnects:** each connection has a fresh nonce. The client signs one
  new proof with the same key: one signature, and no extra round trip.
  Tabs share the key through IndexedDB.
- **Issuance:** the client sends `dpop` on the `auth` that signs in (any
  scheme: `external`, `webauthn` finish, `email`, `guest`). The server binds
  the new `token` to the proof's key, and returns `token_type: "DPoP"`.
  Rotation (§3.2.1) keeps the binding.
- **Key loss** (cleared site data, a new device): the token is useless, and
  the user signs in again. §3.2.1 already asks clients to encourage a
  second scheme.
- **What it does not stop:** XSS that signs proofs while the page is open
  (RFC 9449 §11.4), and malware that copies a software key with the
  profile. Native hardware keys stop the second.
- **Other transports** (TCP, stdio): `htu` is the address URI; `htm` stays
  `"GET"` as a fixed value. This is the weak spot of reusing RFC 9449
  ([Q1](#open-questions)). TLS channel binding (RFC 9266) would be
  stronger, but browsers do not expose it.

### (c) The library path

- When the server is the issuer, its token endpoint returns the Apron token
  as the `access_token`, with `token_type: "Bearer"`.
  `workers-oauth-provider` 1.2.4 always does so, and ignores a `DPoP`
  header. RFC 9449 §5 allows that, and libraries check `token_type`.
- Rule now: the token endpoint returns `"DPoP"` only when the server
  verifies proofs on `auth` (it advertises `server.dpop`), and then the
  client MUST present that token with a proof by the same key. It advertises
  `dpop_signing_alg_values_supported` in its metadata only then.
- On server.apron.chat, binding can live in the Apron server rather than
  in the library: the server records the thumbprint beside the token, and
  checks it on `auth`, which `workers-oauth-provider` never sees. Binding
  at the HTTP token endpoint still needs the library ([#191](https://github.com/cloudflare/workers-oauth-provider/issues/191)).
- Libraries sign proofs for their own HTTP requests. A client may need a
  JOSE library to sign a proof for `auth` with the same key (uncertain per
  library).

## Impact on PLAN_OAUTH

- **Access tokens on every connection.** If the issuer binds access tokens
  (by its policy, or because the client sent a proof), the client must show
  a proof with each `auth {scheme: "external", token}`. The Apron server
  then verifies the proof against `cnf.jkt` from the JWT or from
  introspection. The proof shape, nonce, and barrier rules are those of
  (b). Without that support, today's plan fails: a server that ignores
  `cnf` accepts a stolen bound token as a bearer token, and a server that
  checks it rejects every DPoP client. Hence recommendations 2 and 4.
- **When is that likely?** AT Protocol style issuers require it. Okta and
  Keycloak bind by per-client settings; Keycloak with the switch off still
  binds a token when the client sends a proof ([blog](https://www.keycloak.org/2025/10/dpop-support-26-4)).
  Libraries that send proofs by default would trip this.
- **Refresh tokens.** PLAN_OAUTH keeps the issuer's refresh token in the
  client: in localStorage for web clients. This is the credential most
  worth binding. RFC 9449 binds a public client's refresh token whenever
  the client sends a proof, even if the access token stays bearer. The
  mail profile §3.8 and Keycloak's refresh-only option give exactly that
  split. Recommend it to operators: refresh tokens bound, access tokens
  bearer and short, until Apron servers take proofs.
- **`resource`.** PLAN_OAUTH's `resource` is an `https` URL, so under the
  mail profile's rule, a proof at the token endpoint yields a DPoP-bound
  access token, not a bearer one. Apron cannot get the IMAP exception
  without a bare hostname, which PLAN_OAUTH rejected for good reasons. So
  PLAN_OAUTH needs proofs on `auth` sooner than PLAN_LOOSE does.
- **Protected resource metadata.** A server that verifies proofs adds
  `dpop_signing_alg_values_supported`, and MAY add
  `dpop_bound_access_tokens_required`, to its RFC 9728 metadata.

## DBSC and Apron

Could web.apron.chat use a DBSC-bound cookie on the WebSocket upgrade to
server.apron.chat, instead of a token in storage?

- **Only for W1.** The cookie must be same-site with the page:
  `web.apron.chat` and `server.apron.chat` are. A third-party web client
  (W3) cannot: DBSC does not support partitioned cookies, and Chrome skips
  DBSC when third-party cookies are blocked
  ([Chrome docs](https://developer.chrome.com/docs/web-platform/device-bound-session-credentials)).
  Native and terminal clients have no DBSC at all.
- **Only for some users.** Chrome on Windows and macOS. No Firefox, Safari,
  or mobile browser. So a W1 client still needs another path for most
  users.
- **The upgrade is untested.** Whether Chrome refreshes an expired bound
  cookie before a WebSocket upgrade is unknown. A client can force a
  refresh first with a `fetch` to the server, which DBSC does cover.
- **Cookies on a WebSocket bring cross-site WebSocket hijacking.** A server
  that signs in from the upgrade's cookie MUST check `Origin` against an
  allowlist. Apron avoids this today because no ambient credential exists.
- **Apron is transport neutral.** Signing in from the upgrade's cookie
  would need a new scheme, such as `auth {scheme: "session"}`, with the
  server reading the credential from the transport (like SASL EXTERNAL).
  Nothing in the current plans blocks adding it later.

What is realistic now (9): the operator's site keeps its own session in a
DBSC-bound cookie. web.apron.chat fetches a short-lived Apron `token` from
an HTTP endpoint with that cookie, holds it in memory only, and signs in
with `scheme: "token"`. No wire change, and nothing long-lived in storage
for Chrome desktop users. Other browsers fall back to a stored token. This
is also the shape of the DBSC-for-OAuth proposal in #31.

## Forward-compatibility checklist

To put in the plans now:

1. **Field names.** `auth.params.dpop` (string, a proof JWT);
   `AuthResult.token_type` (`"Bearer"` or `"DPoP"`; absent is
   `"Bearer"`); `server.dpop` (`{algs: string[], nonce: string}`);
   `data.dpop_nonce` on `denied`. `dpop` is the RFC 9449 header's name, so
   OAuth readers recognize it.
2. **Opt-in binding.** A server binds a token only when the request that
   issued it carried a valid `dpop`. Unknown keys are ignored (§1), so an
   old server returns a bearer token without `token_type`, and the client
   uses it as bearer. An old client never sends `dpop`, so never gets a
   bound token.
3. **No downgrade.** A server MUST reject a bound token, Apron's or an
   issuer's, without a valid proof. (2, wire now.)
4. **Nonce delivery.** In the `server` frame, so it costs no round trip, and
   in `denied`'s `data` for a retry. `ping` stays proof-free.
5. **Errors.** Keep `denied` for every proof failure, so that clients that
   identify errors by `code` behave as today. `data.dpop_nonce` means
   "retry once with this nonce"; its absence means the token or proof is
   bad. §1.1's "after `denied`, do not reconnect automatically" stays
   right, since the retry is on the same connection.
6. **Algorithms.** ES256 MUST, for WebCrypto, Secure Enclave, and Android
   Keystore. Ed25519 MAY. `none` and MAC algorithms MUST NOT. `typ` MUST be
   `dpop+jwt` (RFC 9449 §11.5).
7. **PLAN_LOOSE, simple path:** clients don't send `dpop_jkt` in the
   authorization URL; the server redeems with its own key (3).
8. **PLAN_LOOSE, library path:** the token endpoint returns `"Bearer"`
   until the server advertises `server.dpop`.
9. **PLAN_OAUTH:** clients use DPoP at the token endpoint only as in 4,
   and check `token_type`.
10. **Nothing to remove.** Neither plan blocks this. Two things to keep in
    mind: the WebAuthn token's origin binding (§4.10) becomes redundant
    once tokens bind to keys, and §3.2.2's "MAY send `auth` before
    `server`" needs the exception in (b).

Likely future shape:

```jsonc
// <- every connection gets a fresh nonce
{"method": "server", "params": {"apron": 10, "auth": ["external", "token"],
  "dpop": {"algs": ["ES256"], "nonce": "n_7Qx2…"},
  "external": {"authorization_endpoint": "https://chat.example/oauth/authorize"}}}

// -> a simple client redeems a code, and asks for a bound token
{"method": "auth", "id": "c1", "params": {"scheme": "external", "code": "Hk41x9…",
  "code_verifier": "dBjftJ…", "redirect_uri": "com.sidekick.app:/signed-in",
  "client_id": "com.sidekick.app", "dpop": "eyJ0eXAiOiJkcG9wK2p3dCIs…"}}
// <-
{"id": "c1", "result": {"you": {"user_id": "ada", "name": "Ada"}, "token": "st_…", "token_type": "DPoP"}}
```

```jsonc
// the proof in params.dpop: header, then payload
{"typ": "dpop+jwt", "alg": "ES256", "jwk": {"kty": "EC", "crv": "P-256", "x": "l8tF…", "y": "9VE4…"}}
{"jti": "e1j3V_bK…", "iat": 1794672000, "htm": "GET", "htu": "wss://chat.example/ws", "nonce": "n_7Qx2…"}
```

```jsonc
// -> a later connection presents the bound token; the payload adds "ath"
{"method": "auth", "id": "c1", "params": {"scheme": "token", "token": "st_…", "dpop": "eyJ0eXAiOiJkcG9wK2p3dCIs…"}}
// <- a proof without the connection's nonce
{"id": "c1", "error": {"code": -32001, "message": "Sign-in proof expired; retry", "data": {"dpop_nonce": "n_Zp9…"}}}
```

```jsonc
// -> PLAN_OAUTH: an issuer's DPoP-bound access token
{"method": "auth", "id": "c1", "params": {"scheme": "external", "token": "eyJhbGciOiJFUzI1NiIs…", "dpop": "eyJ0eXAiOiJkcG9wK2p3dCIs…"}}
// <-
{"id": "c1", "result": {"you": {"user_id": "ada", "name": "Ada"}}}
```

## EVALUATIONS.md

New attacker rows:

| # | Attacker | Must hold |
|---|---|---|
| A6 | Someone who copies a stored or logged credential: one-shot XSS, a malicious extension, a stolen backup or synced profile, an infostealer, or a log of frames on the server, a proxy, or in devtools | A copied token or refresh token alone does not sign in from elsewhere. |
| A7 | Code that runs in the client while it is open (persistent XSS, a malicious extension) | It cannot get a new session without the user's action. |

- **A6 today:** fails for `token`, and for PLAN_OAUTH's refresh tokens. A
  WebAuthn token resists only on another web origin (F4). With bound
  tokens: holds against copies for web (software keys; not against malware
  that also copies the key) and native (hardware keys). Terminal clients:
  a key file is copied as easily as a token, unless it lives in an agent or
  TPM.
- **A7:** no binding helps (RFC 10017 §5.1.3, §5.1.4). PLAN_LOOSE's portal
  confirms before every redirect, so a new session needs a click when the
  server is the issuer. A foreign issuer that skips consent for a known
  client weakens this. Add it to Remaining risks as R5.
- New findings: **F7**, Apron tokens are long-lived bearer credentials in
  web storage on arbitrary origins (A6). **F8**, PLAN_OAUTH breaks with
  issuers that bind access tokens (recommendations 2, 4). **F9**, a foreign
  issuer that requires DPoP breaks PLAN_LOOSE's redemption unless the
  server signs proofs (3).
- A binding column per client kind: W (software, non-extractable), N
  (hardware), T (file or agent).

## PLAN_CONFORMANCE.md

Server, once bound tokens exist:

| ID | Side | Checks |
|---|---|---|
| `token.shape.unbound-default` | server | without `dpop`, the result has no `token_type` or `"Bearer"`, and the token works without a proof |
| `token.shape.bound` | server | with `dpop`, the result has `token_type: "DPoP"` |
| `token.A6.needs-proof` | server | a bound token without `dpop` is `denied` |
| `token.A6.wrong-key` | server | a proof by another key is `denied` |
| `token.A6.other-connection` | server | a proof with another connection's nonce is `denied`, with `data.dpop_nonce` |
| `token.A6.htu` | server | a proof for another address is `denied` |
| `token.A6.ath` | server | a proof whose `ath` does not match `token` is `denied` |
| `token.A6.jti` | server | a second proof with the same `jti` on one connection is `denied` |
| `token.shape.alg` | server | `alg: none`, HS256, and a `typ` other than `dpop+jwt` are `denied` |
| `external.A6.cnf` | server | an issuer token with `cnf` and no proof is `denied` (wire now) |
| `external.shape.token-type` | server | the token endpoint returns `"Bearer"` unless `server.dpop` is present |
| `external.shape.foreign-dpop` | server | redemption works with an issuer that requires DPoP, such as Keycloak with "Require DPoP bound tokens" |

Client:

| ID | Side | Checks |
|---|---|---|
| `token.shape.bearer-fallback` | client | after sending `dpop` to a server that returns no `token_type`, uses the token without a proof |
| `token.shape.nonce-retry` | client | after `denied` with `data.dpop_nonce`, retries once with that nonce, and not again |
| `token.A1.htu` | client | signs `htu` as the address that it connected to |
| `token.A6.no-pipeline` | client | sends no requests after an `auth` with a proof that has no nonce |
| `token.A6.non-extractable` | client | MANUAL or adapter: a web client's key is non-extractable |
| `external.A3.no-dpop-jkt` | client | the simple path's authorization URL has no `dpop_jkt` |

The drivers need a JOSE library; `uv` scripts can declare one.

## Open questions

1. **Proof format:** RFC 9449's JWT with `htm: "GET"` and `htu` the
   address, as recommended, or an Apron type (`typ: apron-pop+jwt`, with
   `aud` the address and no `htm`), which fits non-HTTP transports better
   but has no existing verifiers?
2. **Nonce in every `server` frame**, or only when a server offers binding?
   One random value per connection is cheap, but it is one more field.
3. **Should a server be able to require binding**, such as
   `server.dpop.required`, and refuse unbound tokens for web clients? Old
   clients would then fail to sign in with `token`.
4. **PAR-only foreign issuers** (AT Protocol): support them on the simple
   path by having the server push the authorization request, or accept
   library clients only?
5. **Terminals:** is a key file worth it, or only keys in an agent, a TPM,
   or a platform keystore?
6. **WebAuthn tokens:** once tokens bind to keys, does §4.10's origin
   binding stay, or become a fallback for clients without a key?
7. **DBSC on the upgrade:** worth a test in Chrome on Windows (does an
   expired bound cookie get refreshed before a WebSocket upgrade?) before
   any cookie scheme is considered.

## Sources

IETF and W3C:

- [RFC 9449, DPoP](https://www.rfc-editor.org/rfc/rfc9449); [RFC 9728, Protected Resource Metadata](https://www.rfc-editor.org/rfc/rfc9728); [RFC 10017, OAuth for Browser-Based Applications](https://www.rfc-editor.org/rfc/rfc10017); [RFC 8471, Token Binding](https://www.rfc-editor.org/rfc/rfc8471)
- [draft-ietf-oauth-v2-1-17](https://datatracker.ietf.org/doc/draft-ietf-oauth-v2-1/); [draft-ietf-mailmaint-oauth-public-06](https://datatracker.ietf.org/doc/draft-ietf-mailmaint-oauth-public/); [draft-ietf-oauth-attestation-based-client-auth-12](https://datatracker.ietf.org/doc/draft-ietf-oauth-attestation-based-client-auth/); [draft-ietf-oauth-token-binding-08](https://datatracker.ietf.org/doc/draft-ietf-oauth-token-binding/)
- Individual drafts: [emelia-oauth-as-metadata-dpop-required](https://datatracker.ietf.org/doc/draft-emelia-oauth-as-metadata-dpop-required/), [rosomakho-oauth-dpop-rt](https://datatracker.ietf.org/doc/draft-rosomakho-oauth-dpop-rt/), [parecki-oauth-dpop-device-flow](https://datatracker.ietf.org/doc/draft-parecki-oauth-dpop-device-flow/), [parecki-oauth-jwt-dpop-grant](https://datatracker.ietf.org/doc/draft-parecki-oauth-jwt-dpop-grant/), [nandakumar-oauth-dpop-proof](https://datatracker.ietf.org/doc/draft-nandakumar-oauth-dpop-proof/), [nandakumar-moq-generic-dpop-proof](https://datatracker.ietf.org/doc/draft-nandakumar-moq-generic-dpop-proof/), [ambekar-oauth-epop](https://datatracker.ietf.org/doc/draft-ambekar-oauth-epop/), [richer-oauth-httpsig](https://datatracker.ietf.org/doc/draft-richer-oauth-httpsig/), [ritz-idpop](https://datatracker.ietf.org/doc/draft-ritz-idpop/)
- [DBSC Editor's Draft](https://w3c.github.io/webappsec-dbsc/); [DBSC FPWD](https://www.w3.org/TR/dbsc-1/); issues [#31](https://github.com/w3c/webappsec-dbsc/issues/31), [#250](https://github.com/w3c/webappsec-dbsc/issues/250); [Mozilla position](https://github.com/mozilla/standards-positions/issues/912); [WebKit position](https://github.com/WebKit/standards-positions/issues/281)

Vendors and implementations:

- [Google: Protecting cookies with DBSC](https://blog.google/security/protecting-cookies-with-device-bound-session-credentials/); [Chrome DBSC docs](https://developer.chrome.com/docs/web-platform/device-bound-session-credentials); [Workspace DBSC GA](https://workspaceupdates.googleblog.com/2026/05/prevent-account-takeovers-with-DBSC-now-generally-available-in-the-Chrome-browser-for-Windows.html); [Scott Helme on macOS](https://scotthelme.co.uk/device-bound-session-credentials-lands-in-chrome-on-macos/)
- [AT Protocol OAuth](https://atproto.com/specs/oauth); [Okta DPoP](https://developer.okta.com/docs/guides/dpop/nonoktaresourceserver/main/); [Auth0 DPoP](https://auth0.com/docs/secure/sender-constraining/demonstrating-proof-of-possession-dpop); [Keycloak 26.4 DPoP](https://www.keycloak.org/2025/10/dpop-support-26-4); [Entra Token Protection](https://learn.microsoft.com/en-us/entra/identity/conditional-access/concept-token-protection); [Curity DPoP and nonces](https://curity.io/docs/identity-server/developer-guide/haapi-sdks/concepts/dpop-and-nonces)
- [oauth4webapi `DPoP`](https://github.com/panva/oauth4webapi/blob/main/docs/functions/DPoP.md); [AppAuth-Android #1158](https://github.com/openid/AppAuth-Android/issues/1158); [AppAuth-iOS #856](https://github.com/openid/AppAuth-iOS/issues/856); [workers-oauth-provider #191](https://github.com/cloudflare/workers-oauth-provider/issues/191), [#412](https://github.com/cloudflare/workers-oauth-provider/issues/412); [ory/fosite #829](https://github.com/ory/fosite/issues/829)
- Local source: `workers-oauth-provider` 1.2.4 at `5c75ddc` (`src/oauth-provider.ts`, `docs/advanced-configuration.md`); Pocket ID v2.19.1 at `0691435` (`backend/go.mod`, `backend/internal/oidc/`)
- [InfoQ: DPoP key storage](https://www.infoq.com/articles/dpop-key-storage-unsolved-problem/)
