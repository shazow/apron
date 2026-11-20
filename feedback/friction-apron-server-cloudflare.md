# Friction log: apron-server-cloudflare (server.apron.chat)

Implementing the `webauthn` passkey page (PLAN_WEBAUTHN_EXTERNAL.md), the
shared authorization-server pieces, and (gated) the loose-OAuth `external`
scheme of PROTOCOL.md §4.12 on shazow/apron#115.

### F1. workers-oauth-provider does not fit; hand-rolled inside the Durable Object
- Spec: PLAN_WEBAUTHN_EXTERNAL.md "Implementation notes"; PLAN_LOOSE.md "server.apron.chat"
- Kind: extra burden
- What happened: The plan suggests `@cloudflare/workers-oauth-provider` (1.2.4 on npm). It wraps the Worker's whole `fetch`, keeps grants and tokens in a Workers KV namespace (a new binding outside the Durable Object, outside this repo's daily read/write budget ledger), mints its own access tokens, and refuses unknown `client_id`s without dynamic registration or CIMD. Apron here needs the opposite on each point: any `client_id`, codes bound to `resource`, the action and the page, redemption on a WebSocket connection inside the Durable Object (no library entry point for redeeming a code out of band), and an Apron session token as the access token.
- What I did: Hand-rolled the authorization endpoint pieces in the Durable Object, with codes, page ceremonies and addition handles in the object's key-value storage under SHA-256 keys and an expiry index, the way sessions already are. Roughly 250 lines for the code store, validation and redemption, plus the page.
- Suggested spec change: Drop the `workers-oauth-provider` note from the plan, or say "for a server whose sessions are already the library's tokens". The open-client rules (any `client_id`, `resource` binding, on-connection redemption) are what make a library a poor fit.

### F2. "Origin = https:// + host of the ws address" fit the existing link-building, and needed one more rule for the page's RP ID
- Spec: PROTOCOL.md §4.12.1; PLAN_WEBAUTHN_EXTERNAL.md "Rules" ("The passkey page is on an origin that the server accepts for its RP ID")
- Kind: worked well / missing
- What happened: The server already records each connection's `ws(s)://host/path` (for `/invite-bot`), so the origin for `external.url`, `iss` and the `resource` check was a 10-line helper, and the page's own requests use the request URL's origin, which is the same thing on Cloudflare. But the passkey page can only run where its origin is valid for the RP ID. On server.apron.chat (RP ID `apron.chat`) it is; in this repo's tests (host `demo.test`, RP ID `localhost`) it is not. The plan says the page "is on an origin that the server accepts for its RP ID" but not what a server does when its own host is not one.
- What I did: The page (and `external`, and the metadata) are served only where the host is the RP ID or under it (`http` only on `localhost`). Elsewhere a `webauthn` begin carries no `external` and `server.auth` is as before. So existing behaviour and tests on other hosts did not change.
- Suggested spec change: In the §4.10 draft: "A server offers `external` in a begin result only where its passkey page's origin can use the RP ID: the RP ID's host, a host under it, or a related origin."

### F3. A begin result without `public_key` contradicts §4.10's step table
- Spec: PLAN_WEBAUTHN_EXTERNAL.md "Rules" (servers: "A begin result MAY carry `external` without `public_key`"); PROTOCOL.md §4.10 table ("Successful result: `challenge_id`, `public_key`")
- Kind: contradiction
- What happened: Clients without an `Origin` (native apps) or from an origin that is not in `RP_ORIGINS` cannot finish a ceremony in the client here: verification needs an allowed origin. Before, such connections were not offered `webauthn` at all. With the page they are, and their begin can only usefully return the page.
- What I did: For those connections begin returns `{"external": {"url": …}}` with no `challenge_id`/`public_key`, and keeps no local challenge. Connections from `RP_ORIGINS` get both. `server.auth` now lists `webauthn` for every connection on a host the page serves.
- Suggested spec change: In §4.10's table, make the begin result "`challenge_id` and `public_key`, or `external`, or both"; say a client that gets no `public_key` uses `external`.

### F4. The page's ceremony needs server-side state across two HTTP requests; the plan's "State" table undercounts it
- Spec: PLAN_WEBAUTHN_EXTERNAL.md "State", "Implementation notes"
- Kind: extra burden
- What happened: The page has to (a) begin a ceremony on the server's origin, (b) verify it, (c) for a login, show the account before Allow. Each step is a separate HTTP request to a hibernating Durable Object, so the page's challenge (bound to the authorization request) must be kept in storage, not memory. The "small web client of the server itself" option (open a WebSocket from the page) would need the page's origin admitted as a WebSocket origin and a private approval endpoint anyway.
- What I did: Two JSON endpoints for the page script (`POST /passkey/begin`, `POST /passkey/finish`, same-origin only), with the ceremony record in Durable Object KV under the SHA-256 of its id, swept from an expiry index, as sessions already are. The login code is issued at finish and held by the page until Allow (Cancel discards it), so no third "approval" record is needed. About 200 lines in the object plus about 250 for the page.
- Suggested spec change: Under "State", list "Remote login, page: the page's ceremony (kept between the page's begin and finish requests), then a code". Say a server MAY issue a login's code before Allow if only the page holds it until Allow.

### F5. A code token is a bearer token, but this server's sessions were origin-bound; needed a way to tell them apart without a read
- Spec: PLAN_WEBAUTHN_EXTERNAL.md "Rules" ("§4.10's binding of a finish token to the ceremony's origin applies to ceremonies in the client only. A token from a code is a bearer token"); PROTOCOL.md §4.10 last paragraph
- Kind: extra burden (small); the rule itself worked well
- What happened: Every passkey session here was stored with its origin and refused from any other origin, and the `token` path refused origins outside `RP_ORIGINS` before reading storage. A token from a code has to resume from a native app or a third-party web client.
- What I did: Sessions from codes are stored without an origin, and their tokens carry a prefix (`apron_session_`), so the `token` path picks the bearer rule without a storage read and an origin-bound session can never be resumed as a bearer one. About 15 changed lines.
- Suggested spec change: none. The plan's "Draft for PROTOCOL.md" wording ("The token of a finish with `code` is not bound to an origin") is enough.

### F6. "Guests included" makes `external` unusable for a returning user on a guest connection when the server is its own issuer
- Spec: PROTOCOL.md §4.12.4 ("On a connection that is signed in, guests included, an `external` request adds the identity to that account, and returns `you`. It never signs in to another account. An identity that belongs to another account is `denied`.")
- Kind: ambiguity
- What happened: When the server is its own authorization server, the identity behind an `/oauth/authorize` code is (issuer = itself, sub = an account here). So the identity *is* an account, and "adds the identity to that account" has nothing to add. On a guest connection, a returning user's code is "an identity that belongs to another account", so it has to be `denied`. The same user can sign in from that guest connection with `webauthn` (§4.10 lets a guest sign in). A client that auths as a guest first, as apron-web does, has to open a new connection to redeem an `external` code. "Guests included" also says nothing about what a guest connection returns when the code creates a new account: `you` only (an addition) or `you` and `token` (a sign-in, §3.2.2)?
- What I did: I followed the text conservatively. Registered connection: same account → `you`; any other account → `denied`. Guest connection: a code for an existing account → `denied`; a new-account code turns the guest into the new account and returns `you` and `token`, as a passkey registration on a guest connection does here. Fresh connection: signs in.
- Suggested spec change: Exempt guests from the additions rule, as §4.10 effectively does: "On a connection signed in to an account, an `external` request adds the identity to that account…". Or say that a guest connection signs in as with any other scheme. Also say what "adds the identity" means when the issuer is the server itself: the same account is a no-op `you`, and any other account is `denied`.

### F7. Errors after a valid redirect_uri: stayed on the page rather than redirecting
- Spec: brief "Interop contract" ("Before a redirect target is validated, errors show on the page itself"); RFC 6749 §4.1.2.1
- Kind: ambiguity
- What happened: OAuth would redirect `invalid_request` (missing PKCE, wrong `resource`, bad `response_type`) back to a valid `redirect_uri`. Any `https` URI is "valid" here (open clients), so auto-redirecting with an error would make the page an open redirector (RFC 9700 §4.11.2).
- What I did: Every invalid request shows its error on the page (HTTP 400, no `Location`). Only Cancel (a user action) redirects with `error=access_denied`. The client gets no machine-readable error for a malformed request, which is a client bug anyway.
- Suggested spec change: §4.12.3: "An invalid request shows its error on the page; the page redirects only after the user acts (with a code, or `error=access_denied`)."

### F8. New HTTP paths ripple into the deployment's edge allowlist
- Spec: PLAN_WEBAUTHN_EXTERNAL.md "Rules" (the page on the server's origin); brief "Interop contract" (fixed paths)
- Kind: extra burden
- What happened: server.apron.chat blocks every request at Cloudflare's edge except WebSocket handshakes and a few named paths (a generated WAF rule, `apron_invalid_request`), so the Worker is never billed for junk. The passkey page, its two script endpoints, and (with `external`) the authorize page, token endpoint and metadata each had to be added to the rule generator, its tests and the edge docs. Without that, the page would have worked in tests and been blocked in production.
- What I did: The generator lets those paths through exactly where the Worker serves them: production host under `RP_ID`, `PASSKEY_PAGE` not false, and `EXTERNAL_SIGN_IN` for the `external` ones. Regenerated docs/edge-rules.generated.json. About 40 lines plus tests.
- Suggested spec change: none (deployment concern). The fixed, well-known paths in the brief made this a one-time list.

### F9. §4.12 renumbering collides with existing "§4.12 = ext" citations
- Spec: PROTOCOL.md on #115 (§4.12 External sign-in, §4.13 `ext`)
- Kind: nit
- What happened: This repo cites v10's section numbers throughout (SPEC.md, docs, about 30 source comments use "§4.12" for `ext`). The revision moves `ext` to §4.13 and puts external sign-in at §4.12, so my new comments and docs citing "§4.12" for `external` sit next to old ones that mean `ext`.
- What I did: Added a note in SPEC.md's protocol reference line and in src/oauth.ts that the sign-in work cites #115's numbering. I did not renumber the existing citations; that belongs with the migration to the revised spec as a whole.
- Suggested spec change: none needed. Implementations would be helped if the PR description listed the renumbering (§4.11 email, §4.12 external, §4.13 `ext`).

### F10. Binding codes to page and action made every crossover a one-line check and a one-line test
- Spec: PLAN_WEBAUTHN_EXTERNAL.md "Rules" (code bound to the action and the page), "Security considerations" 4 and 5
- Kind: worked well
- What happened: The code record carries `page` and `action`. A passkey-page code at `external` or `/oauth/token`, an `/oauth/authorize` code at `webauthn`, a login code at `register`, and an addition's code on another connection are all denied by one comparison each. With `client_id`, `redirect_uri`, the PKCE challenge and `resource`, redemption is a single 6-condition check. I also check `resource` against the origin of the connection that redeems, which costs nothing and stops a code from crossing between hosts that share one Durable Object.
- What I did: As specified, plus that `resource` check.
- Suggested spec change: Optionally: "A server redeems a code only for the origin in its `resource`."

### F11. The Confirmation wording dropped straight into the page; two small gaps
- Spec: PLAN_WEBAUTHN_EXTERNAL.md "Confirmation"
- Kind: worked well / nit
- What happened: The table (https host / "An app on this device (scheme)" / "An app on this device") and the screen texts were directly usable as server strings. Gaps: (1) "Only continue if you just started signing in on **An app on this device (com.example.myapp)**" reads badly. (2) "Recognised means a registered `https` redirect": this server has no client registry, but its `RP_ORIGINS` are its first-party clients.
- What I did: (1) For app schemes and loopback the line ends "…signing in on an app on this device." (2) An `https` redirect on one of `RP_ORIGINS` drops the "has not verified this app" line; everything else shows it.
- Suggested spec change: Give the "only continue" line its own column in the table ("on chat.alice.dev" / "on an app on this device"). Say that "registered" may be the server's own configured first-party origins.

### F12. The page must not send Cross-Origin-Opener-Policy
- Spec: PLAN_WEBAUTHN_EXTERNAL.md "Rules" (popup or redirect for web clients), "Security considerations" 2
- Kind: missing
- What happened: Hardening the page, I nearly added `Cross-Origin-Opener-Policy: same-origin` next to `frame-ancestors 'none'`. That would put the popup in a new browsing context group, and the client's redirect page could no longer reach `window.opener` to hand back the code. The popup flow would silently break.
- What I did: Send CSP (`frame-ancestors 'none'`, script nonce, `connect-src 'self'`), `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` (so `state` and `code_challenge` don't leak in `Referer` to the client), `Cache-Control: no-store`, and no COOP.
- Suggested spec change: Under the page's rules: "It MUST NOT cut off its opener (for example, with `Cross-Origin-Opener-Policy: same-origin`): web clients may open it in a popup." Optionally: "It SHOULD send no referrer."

### F13. "A request handle … expires with the codes" is vague
- Spec: PLAN_WEBAUTHN_EXTERNAL.md "Rules"
- Kind: nit
- What happened: The handle is created at begin, before the user opens the page, reads it, and makes a passkey. If it expired as fast as a code (5 minutes from issue), a slow user could lose it mid-page.
- What I did: The handle lasts 10 minutes from begin. The code it leads to lasts 5 minutes from issue.
- Suggested spec change: "A `request` handle expires within minutes, like a code."
