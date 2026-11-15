# Friction log: apron-server-go

Implementing PROTOCOL.md §4.12 (loose-OAuth `external`) and the
PLAN_WEBAUTHN_EXTERNAL.md passkey page in the Go server, against spec branch
`claude/charming-faraday-nrrajr` at dc9e56f.

### F1. "The origin is `https://` plus the host" has no room for loopback development
- Spec: §4.12.1 (server's origin), §4.12.2 (`resource`)
- Kind: ambiguity
- What happened: aprond's development setup is plain `http://localhost:8080` / `ws://127.0.0.1:8080/ws`. §4.12.1 defines the origin as `https://` plus host and port, always, so a strictly conforming client connected to `ws://127.0.0.1:8080/ws` sends `resource=https://127.0.0.1:8080`, while the server's own idea of its origin (`--public-url`, or the scheme and host a request arrived on) is `http://127.0.0.1:8080`. The `iss` and metadata `issuer` would then differ from `resource`.
- What I did: the server's issuer is its base URL (PublicURL, else the scheme and host of the request), and it accepts `resource` equal to that, or to `https://` plus the same host. So a dev server answers either spelling, and a production server (https) has exactly one.
- Suggested spec change: "The server's origin is `https://` plus the host and any port of its address, or `http://` for a `ws:` address on a loopback host."

### F2. The schema and conformance checks still describe the proposal-based `external`
- Spec: schema/apron.schema.json, tests/conformance/conform.py at dc9e56f
- Kind: missing
- What happened: the schema at the spec branch still has `return_url`, `state` "for email and external proposals", and an `AuthResult.url` "the sign-in page to open" for external, and no `code`, `code_verifier`, `redirect_uri`, `client_id`, or `external` object. conform.py's "unsupported scheme" check sends `{"scheme":"external","return_url":…}`, which under §4.12 is a begin (unknown key ignored), so it still passes. Nothing describes the passkey page's `external` on a webauthn begin, or `code` on a webauthn finish.
- What I did: left the submodule pinned where it was (the branch's only schema change is § renumbering), and wrote the wire tests in Go instead.
- Suggested spec change: update the schema's `Auth` (`code`, `code_verifier`, `redirect_uri`, `client_id`) and `AuthResult` (`external: {url, issuer?}`) with the spec; drop `return_url` and the external half of `state`.

### F3. Keeping one code store per page made "codes don't cross over" free
- Spec: §4.12.3 (codes), PLAN_WEBAUTHN_EXTERNAL.md "Rules" (a passkey-page code finishes only webauthn, with its action)
- Kind: worked well
- What happened: each page (`/oauth/authorize`, `/passkey`) owns its own `oauth.Codes`, so an external code is simply unknown to `webauthn` finish and the other way round; the action is a field of the grant. Binding to `client_id`, `redirect_uri`, the challenge, and `resource` was one struct comparison plus the S256 check. The shared helper (request parsing, redirect rules, client naming, codes, confirmation rendering) is ~520 lines of Go and serves both pages; the external page and token endpoint are ~430 more, the passkey page ~560 plus an ~80-line script.
- What I did: as described; tests check external→webauthn, webauthn→external, and login→register all `denied`.
- Suggested spec change: none.

### F4. Is `challenge_id` required in a webauthn begin result that carries only `external`?
- Spec: §4.10 table of steps; PLAN "Rules" (a begin MAY carry `external` without `public_key`)
- Kind: ambiguity
- What happened: this server refuses a local ceremony from a WebSocket `Origin` its RP does not list (native apps send none; third-party web clients send theirs). Those are exactly the clients the passkey page is for, so for them begin now returns `{"external": {...}}` alone. §4.10's table lists `challenge_id` and `public_key` as the begin result, and the plan says a server may omit `public_key`, but not whether `challenge_id` goes with it.
- What I did: omit both `challenge_id` and `public_key` when the connection's origin cannot run the ceremony; send all three when it can (and the page's origin is an RP origin).
- Suggested spec change: in the §4.10 draft, "A begin result without `public_key` has no `challenge_id`, and is finished only with a code."

### F5. A new-account registration on the page vs. a server that makes accounts only by invitation
- Spec: PLAN "Registering a new account" ("creates the account when the code is redeemed, by server policy")
- Kind: ambiguity
- What happened: on aprond a passkey registration needs a guest connection or an invitation. An invitation token is a secret, so it cannot ride in `external.url`; the page has no way to check it. The plan does not say what a non-addition `register` code does on a signed-in connection.
- What I did: begin on an unsigned connection still needs an invitation (as before), and the page URL carries only `name`. The code holds the verified credential; redeeming it needs a connection that is not signed in and presents an invitation, which the server uses up as for a local registration. On a signed-in connection such a code is `denied` (a begin on a signed-in connection, guests included, is an addition with `request`, so a well-behaved client never gets there).
- Suggested spec change: "A registration's code that is not an addition finishes only on a connection that is not signed in." and "Server policy for new accounts (such as an invitation) applies when the code is redeemed."

### F6. An addition returns "`you` only", but a guest that becomes an account then has no way back
- Spec: §4.12.4 ("On a connection that is signed in, guests included, an `external` request adds the identity … and returns `you`")
- Kind: ambiguity
- What happened: aprond's guests become accounts by adding an identity. With `you` only, the guest-now-account has no bearer token, and loses the account on reconnect unless it signs in again. §3.2.1 lets any successful result carry `token`.
- What I did: return `{you}` for an addition to an account, and `{you, token}` when the connection was a guest. The passkey page's addition returns `{you, token}`, as aprond's local passkey addition always has ("the result is `you`, as for a local addition").
- Suggested spec change: "…adds the identity to that account, and returns `you`, and a `token` if the connection had none (a guest)."

### F7. The page cannot know whether the identity will make an account or be added to one
- Spec: PLAN_LOOSE.md "Confirmation" ("A new account" variant; "The page does not need to know whether the code will add an identity")
- Kind: nit
- What happened: for an identity with no account, the page says "… wants to create an account for you on chat.example". If the app then redeems on a guest connection, the identity is added to the guest instead, so the wording is not quite true.
- What I did: kept the plan's wording; the outcome is still "this app can act as you".
- Suggested spec change: for the new-identity screen, "**chat.alice.dev** wants to sign in to **chat.example** as you. It will be able to read and send messages as you." covers both outcomes.

### F8. "Not you? Sign in as someone else" depends on the identity provider
- Spec: PLAN_LOOSE.md "Confirmation" (after sign-in)
- Kind: extra burden
- What happened: restarting the extension's sign-in usually lands on the same person: GitHub (in the sso example) and most OIDC providers keep a session and redirect straight back. Doing better needs the extension to send `prompt=select_account`/`login`, which the server cannot do for it.
- What I did: "Not you?" posts `restart`, which starts a fresh sign-in with the extension (a new `ExternalRequest.ID`); the extension decides how to prompt. Documented nothing more.
- Suggested spec change: none needed in the protocol; the plan's phrasing could say the link "starts the page's sign-in again".

### F9. The token endpoint vs. a server that binds sessions to the frontend origin
- Spec: §4.12.2 ("the access token is a bearer token for `scheme: "token"`"), PLAN "Rules" (a token from a code is not bound to an origin)
- Kind: worked well
- What happened: aprond binds every session token to the WebSocket `Origin` that signed in. On-connection redemption binds it to the redeeming connection, which is what a client expects. For `POST /oauth/token`, a browser's `fetch` sends `Origin`, and a native app sends none, so binding the token to the token request's `Origin` matches the WebSocket that later resumes with it. ~60 lines (factoring account resolution out of the connection's sign-in).
- What I did: as described.
- Suggested spec change: none.

### F10. Rejecting `crossOrigin`/`topOrigin` needed a check of its own
- Spec: PLAN "Rules" (reject client data with `crossOrigin: true` or a `topOrigin`)
- Kind: nit
- What happened: go-webauthn verifies the origin against the whole RP origin list and handles `topOrigin` by a configurable mode, so neither "exactly the page's origin" nor "no `topOrigin` at all" falls out of it.
- What I did: ~30 lines decoding `clientDataJSON` before verification: origin must be the page's, `crossOrigin` false or absent, no `topOrigin`. Tests cover each.
- Suggested spec change: none.

### F11. Foreign issuer: "aud includes the server's origin" rules out most off-the-shelf OIDC providers
- Spec: §4.12.3 (last paragraph, SHOULD bind to `resource`), §4.12.4 (MUST accept only tokens whose `aud` includes the origin)
- Kind: extra burden (close to a blocker for the "such as Pocket ID" example)
- What happened: the server side is easy (see F13), but it only works with an issuer that turns the client's `resource` into the access token's `aud`, issues JWT access tokens, and accepts a public `client_id` with every app's redirect URI. Many OIDC providers put their own `client_id` in `aud` and ignore `resource` (RFC 8707 support is uncommon). I could not check Pocket ID's behaviour from this sandbox, so I do not claim it either way; the fake issuer in the tests does what the spec asks. With an issuer that ignores `resource`, every sign-in is `denied`, by design, and the operator has no knob to fix it short of changing issuers.
- What I did: implemented the MUSTs as written, documented in SERVER.md exactly what the issuer must do, and refused a token without a matching `aud` (tested).
- Suggested spec change: say plainly in §4.12.3 that a foreign issuer MUST put the server's origin in `aud` (it is a MUST in effect, through §4.12.4), and drop "such as an OpenID Connect provider" from §4.12's intro unless one is known to do this; or allow "an `aud` the operator configured for this server" as an alternative.

### F12. Who sends `resource` at the issuer's token endpoint, and what the server's origin is there
- Spec: §4.12.4 ("the server redeems the code … at the issuer's token endpoint")
- Kind: ambiguity
- What happened: RFC 8707 lets the token request repeat `resource`; some issuers need it there to pick the audience. §4.12 says only that the client sends it in the authorization request.
- What I did: the server sends `resource` = its origin (as it derives it from the connection) with the code. An issuer that ignores it still binds from the authorization request.
- Suggested spec change: "When it redeems a code, the server sends its origin as `resource`."

### F13. A JWT check needed hand-written JOSE; introspection is not realistic for public clients
- Spec: §4.12.4 ("check the signature against the issuer's keys, or introspect the token")
- Kind: extra burden
- What happened: go.mod has no JOSE library, so discovery (RFC 8414 with the OIDC fallback), JWKS fetching with kid-miss refresh, and RS/PS/ES/EdDSA verification are ~500 lines (foreign.go 330, jwt.go 170), plus ~280 lines for the fake issuer test. Introspection (RFC 7662) requires the caller to authenticate to the issuer, i.e. the Apron server needs confidential-client credentials at the issuer, which the spec's setup (a public `client_id`) does not give it.
- What I did: JWT only; opaque tokens are `denied`. Documented.
- Suggested spec change: if introspection stays, mention that it needs the server's own credentials at the issuer; or require JWT access tokens (RFC 9068) from a foreign issuer.

### F14. "Clients keep url's `client_id` and redeem with it" is easy to miss
- Spec: §4.12.1 (`url` may carry `client_id`), §4.12.2 ("redeem the code with … the `client_id` that they sent")
- Kind: worked well (with a nit)
- What happened: my own test client first added its `client_id` only when absent but redeemed with its own, and the foreign issuer (correctly) refused the code. The two rules together are right, but a client author reads them in different bullets.
- What I did: fixed the test client (`internal/oauthtest`), which now adopts `url`'s `client_id`.
- Suggested spec change: in §4.12.2, "If `url` carries a `client_id`, that is the client's `client_id` for this sign-in, in the request and the redemption."

### F15. A foreign issuer's access token rarely names the person
- Spec: §4.12.4 (identify by issuer and `sub`); account creation is server policy
- Kind: nit
- What happened: access tokens usually carry `sub` and little else; a display name comes from the ID token or the userinfo endpoint, which this flow never sees (the client keeps the ID token, if any).
- What I did: take `name`/`preferred_username` from the access token when present; otherwise the new account is `user_<n>` with the requested `name`. The identity is spelled `external:<issuer>#<sub>` for `--role` and the allowlist.
- Suggested spec change: none required; maybe note that the client's `name` (§3.2) is the usual source of a new account's name.

### F16. The passkey page's origin must be an RP origin, which is a new deployment knob
- Spec: PLAN "Rules" ("The passkey page is on an origin that the server accepts for its RP ID")
- Kind: extra burden
- What happened: aprond's `--webauthn.origin` lists frontend origins. The page lives on the server's origin (`--public-url`), which a deployment with a separate frontend never had to list. Without it the server silently offers no page.
- What I did: offer the page exactly when the server's own origin is among the RP origins; documented it in SERVER.md and README (the default dev setup, `http://localhost:8080`, already qualifies).
- Suggested spec change: none; it is the right rule. The plan could say servers "typically add their own origin to the RP's allowed origins".

### F17. Additions on the page meet the server's re-authentication rule without the spec saying so
- Spec: PLAN "Adding a passkey to an account"
- Kind: worked well
- What happened: aprond requires a recent passkey sign-in on the connection before a second passkey is added to an account that has one. Because the page's addition code is redeemed on the account's own connection, the same rule applies there unchanged, and a remote client can satisfy it with a login code from the page on that connection first.
- What I did: nothing special; the `request` handle binding plus redemption on the connection made it fall out.
- Suggested spec change: none.

### F18. The page's script and WebAuthn JSON
- Spec: PLAN "Implementation notes", brief ("a small inline script for navigator.credentials is fine")
- Kind: nit
- What happened: `PublicKeyCredential.parseCreationOptionsFromJSON`/`toJSON` are not in every browser yet, so the page script carries a ~40-line fallback; it also needs a CSP nonce because of `frame-ancestors`/no-inline policy. The whole script is ~80 lines. Verified end to end in Chromium with a virtual authenticator (tests/interop/passkey-page.spec.ts).
- What I did: as described.
- Suggested spec change: none.

### F19. Every authorization-request error on the page (M6) made the code smaller
- Spec: §4.12.3 (errors on the authorization pages), as decided for feedback M6
- Kind: worked well
- What happened: the server used to split request problems in two: before `redirect_uri` validated, on the page; after, redirected as `error=invalid_target` / `invalid_request` / `unsupported_response_type` with `state` and `iss`. Moving every problem to the page dropped `Problem.Page`, `Request.Refuse`, and the two-way switch in both pages (net about -10 lines). Redirects now happen only from a button (Allow, Cancel, decline at the identity provider), which is easy to audit.
- What I did: one 400 page, "This sign-in link doesn't work", with a human sentence ("The app that sent you here asked to sign in to another server (resource must be this server's origin, …)") and a muted "Error: invalid_target" line, so a developer can still see the OAuth code. A bad `action` on the passkey page is the same page. Tests now expect 400 with no `Location`.
- Suggested spec change: the M6 wording as proposed; optionally "The page SHOULD name the OAuth error, for the client's developer", since the client gets no machine-readable error.

### F20. "A token from a code" leaves the foreign issuer's `token` path and additions implicit
- Spec: §4.12.4 ("A token from a code, here or at the token endpoint, is not bound to an origin"); PLAN_WEBAUTHN_EXTERNAL.md "Rules"
- Kind: ambiguity
- What happened: making code tokens unbound (S14) needed a per-session "any origin" flag, a stored field (`any_origin`), and the flag threaded through the server's three sign-in paths (sign-in, addition with a token, invitation enrollment): about 30 lines and a signature change of `Core.Issue`. Two cases are not covered by the sentence's wording: an `external` sign-in with a foreign issuer's access token the client redeemed itself (`token`, no code at this server), and the token an addition returns (a guest becoming an account, or the passkey page's addition).
- What I did: every `external` sign-in (own codes, foreign codes, foreign access tokens) and every passkey-page code finish, additions included, issues an unbound token. Local ceremonies, email, and proposals stay bound to the connection's `Origin`.
- Suggested spec change: "Every token from §4.12, and from a `webauthn` finish with `code`, is not bound to an origin; only a token from a ceremony in the client (§4.10) is."
