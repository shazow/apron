# Friction log: apron-web (client) implementing §4.12 `external` and the `webauthn` passkey page

Spec: PROTOCOL.md at shazow/apron `claude/charming-faraday-nrrajr` (dc9e56f), and apron-notes PLAN_WEBAUTHN_EXTERNAL.md.

### F1. The server origin for a `ws://` address is undefined
- Spec: §4.12.1 ("The server's origin is `https://` plus the host and any port of its address")
- Kind: ambiguity
- What happened: deriving `resource` from the WebSocket address. apron-web's dev setup (`npm run dev`) talks to `ws://127.0.0.1:8080/ws`, and both servers keep loopback `http` for development. Read literally, the client must send `resource=https://127.0.0.1:8080` to a server whose own origin is `http://127.0.0.1:8080`, which it then refuses. The rule also says nothing about default ports: `ws://chat.example` (port 80) becomes `https://chat.example` (port 443).
- What I did: `wss:` gives `https://` plus host and port. `ws:` on a loopback host (127.0.0.0/8, `[::1]`, `localhost`) gives `http://` plus host and port, matching what the brief says the servers keep for local development. Other `ws:` addresses follow the spec's `https://`. URL parsing drops a scheme's default port, so `wss://chat.example:443/` gives `https://chat.example`.
- Suggested spec change: "The server's origin is `https://` plus the host and any port of its address (`http://` for a `ws://` address on a loopback host, for local development)."

### F2. §4.12.1 no longer says which `url` a client may open
- Spec: §4.12.1 (compare v10 §4.11.5: "`url` is an absolute `https` URL, or `http` on a loopback host. Clients reject any other `url`, such as `javascript:…`.")
- Kind: missing
- What happened: the old proposal result had this rule, and apron-web enforced it (`signInPageUrl`). The new `External.url` has no such rule. A web client that does `location.assign(url)` with a `javascript:` URL runs the server's script on the client's origin.
- What I did: kept the check (`pageUrl`/`parseExternal` in `src/lib/protocol/authorization.ts`). A begin result whose `url` fails it is "The server’s sign-in page isn’t a secure web address", and a `webauthn` begin with such an `external` counts as having no passkey page.
- Suggested spec change: in §4.12.1, "`url` is an absolute `https` URL, or `http` on a loopback host. Clients reject any other `url`."

### F3. Begin comes before the URL, so a web client loses the tap's popup permission
- Spec: §4.12.1/§4.12.2 (begin, then open); PLAN_WEBAUTHN_EXTERNAL "Rules" ("a popup or a redirect for web clients")
- Kind: extra burden
- What happened: browsers allow `window.open` only during the user's tap (transient activation). The client learns `external.url` only after a begin round trip. For `webauthn` it is worse: the client learns that it needs the page after begin and after a failed `navigator.credentials` call. Safari treats that call as using up the activation.
- What I did: for `external` (sign-in and Add external sign-in), the tap opens a blank named popup at once, writes "Opening the sign-in page…" into it, clears `popup.opener` (so the server's page can't navigate the app), then navigates it after begin. For the passkey page, the popup opens after the failure, which a browser may block. Either way, a blocked popup falls back to a full-page redirect that keeps the PKCE verifier and `state` in `sessionStorage`. About 60 lines (`openSignInWindow`, `answerFrom`, the redirect fallback, and the callback page's two modes).
- Suggested spec change: an informative note in §4.12.2: "A web client can open a window during the user's tap, before begin answers, and send it to `url` afterwards." Nothing normative.

### F4. The §4.10 RP ID check doesn't tell a web client whether it can use the RP ID; the "try first" rule does
- Spec: §4.10 (RP ID check); PLAN_WEBAUTHN_EXTERNAL "Rules" ("A client MAY try `public_key` first, and go to `external` when the platform refuses the RP ID")
- Kind: worked well (with a nit)
- What happened: the §4.10 check asks whether the *server* owns the RP ID (its host is under the RP ID). For web.apron.chat talking to `chat.example` with RP ID `chat.example`, the check passes and the browser then refuses with `SecurityError`, unless chat.example lists web.apron.chat as a related origin. The plan's first rule ("Clients use `public_key` when they can use its RP ID, and pass the RP ID check") reads as if the client can know beforehand. A web client can't: related origins live on the RP's server. The MAY-try rule made the client simple: begin, try, and on `SecurityError` (or a failed check) go to `external`. A cancelled sheet (`NotAllowedError`) stays a cancel. About 25 lines (`passkey-route.ts` plus the branch in `usePasskey`).
- What I did: try first. A failed RP ID check also goes to the page, as the brief and security consideration 6 allow.
- Suggested spec change: in the §4.10 draft, "Clients that cannot use the RP ID of `public_key`, or whose platform refuses it (such as with `SecurityError`), use `external`". Name the refusal so implementers don't also fall back on a user cancel.

### F5. A `webauthn` finish with `code`: is `challenge_id` sent? Does a page-only begin carry one?
- Spec: PLAN_WEBAUTHN_EXTERNAL "Wire" (the `Auth` block lists `credential` *or* `code` + three) and "Rules" ("A begin result MAY carry `external` without `public_key`")
- Kind: ambiguity
- What happened: the login example's finish carries no `challenge_id`, but the text never says so, and §4.10's table lists `challenge_id` as a finish field. It's also unclear whether a begin with `external` and no `public_key` still returns `challenge_id`.
- What I did: a finish with `code` sends `scheme`, `action`, `step`, `code`, `code_verifier`, `redirect_uri`, `client_id` and no `challenge_id` (the e2e test asserts this). The local route requires both `challenge_id` and `public_key`. Otherwise the page route is used.
- Suggested spec change: in the §4.10 table or the draft: "A finish step with `code` carries no `challenge_id`. A begin result without `public_key` MAY omit `challenge_id`."

### F6. Registering on a guest connection through the passkey page: new account, or addition to the guest?
- Spec: PLAN_WEBAUTHN_EXTERNAL "Adding a passkey to an account" ("On a connection signed in as ada…"), §4.10 ("A registration on a connection that is already signed in adds the passkey to that account"), §4.12.4 ("guests included")
- Kind: ambiguity
- What happened: apron-web's connect screen lets a guest choose Create account with passkey. Locally, that adds the passkey to the guest's account and keeps the identity. On the page path, the client can't tell whether the server's begin made an addition (`request=` handle bound to the guest) or a new-account registration (`name=`). This matters because an addition's code works only on the guest's own connection.
- What I did: when the connection is signed in (guests included), the client records the account and finishes only on a connection still signed in as it. Otherwise it says "That passkey is for @guest_1, which this page isn’t signed in as now." This matches the local behaviour.
- Suggested spec change: in the draft, "On a connection that is signed in, guests included, a `register` begin is an addition, and its `url` carries the account's handle."

### F7. A client ID metadata document needs one fixed origin; this app has four kinds
- Spec: §4.12.3 ("MAY fetch a client ID metadata document when `client_id` is an `https` URL. It then accepts only a `redirect_uri` that the document lists"); brief's interop contract
- Kind: extra burden
- What happened: the app runs at https://web.apron.chat (production), at `https://<branch>-apron-web.shazow.workers.dev` (Cloudflare Previews, one per branch), at `http://localhost:5173` (`npm run dev`), and at any origin `aprond --static-dir` serves it from. A metadata document's `client_id` must be its own URL, and its `redirect_uris` must list the redirect. A static file can describe only production, and a server that reads it would refuse a Preview's redirect.
- What I did: `static/client-metadata.json` describes production (`client_name: "Apron"`, `redirect_uris: ["https://web.apron.chat/signed-in/"]`). The app sends its URL as `client_id` only when `location.origin` is `https://web.apron.chat`. Everywhere else it sends the plain `client_id` `apron-web`, which §4.12.3 servers must accept. A unit test keeps the file and `appClient()` in step.
- Suggested spec change: none needed. Optionally note in §4.12.2: "a client served from many origins can send a plain `client_id`".

### F8. Redirect URIs in dev, Previews and production; self-hosted `http` copies can't sign in on a page
- Spec: §4.12.3 (allowed `redirect_uri`: `https`, a scheme with `.`, loopback `http`)
- Kind: extra burden (minor)
- What happened: `redirect_uri` is `${location.origin}/signed-in/`. Dev is `http://localhost:5173/signed-in/` (loopback, allowed). Previews and production are `https` (allowed). The app served by `aprond --static-dir` on a LAN address over `http`, such as `http://192.168.1.5:8080/signed-in/`, is refused, so `external` and the passkey page don't work there. Passkeys don't work there either (WebAuthn needs a secure context), so little is lost.
- What I did: nothing beyond documenting it. The page shows the server's error, and the app never hears back. The user closes the window and sees "The sign-in window was closed before signing in finished."
- Suggested spec change: none.

### F9. The callback path: avoid `/oauth/…`, and use a directory index
- Spec: brief's interop contract (servers serve `/oauth/authorize`, `/oauth/token`, `/passkey` on their origin)
- Kind: nit
- What happened: the app can share an origin with its server (`aprond --static-dir`, and Vite dev proxies some paths), so its callback must not collide with the server's paths. Go's static file server also doesn't map `/x` to `x.html`, which is why `/archive` 404s there today.
- What I did: the callback is `/signed-in/`, a prerendered SvelteKit route with `trailingSlash = 'always'` (`build/signed-in/index.html`). Cloudflare, Go's `http.FileServer` and Vite all serve it. It boots nothing but the layout (no WebSocket).
- Suggested spec change: none.

### F10. Not checking `iss`, and ignoring `issuer`, kept the client small
- Spec: §4.12.2, PLAN_WEBAUTHN_EXTERNAL "Decisions" 6 ("No `iss` check: the server redeems the code itself")
- Kind: worked well
- What happened: redeeming on the connection means the client needs no metadata discovery, no token endpoint and no `iss` comparison. The whole shared flow is `authorizationRequest` → open → `redemption(request, response)` (checks `state`, maps `access_denied`) → one `auth` frame. `src/lib/protocol/authorization.ts` is about 90 lines of code. `External.issuer` is parsed and ignored.
- What I did: as the spec says.
- Suggested spec change: none.

### F11. One redemption shape for both schemes made sharing trivial
- Spec: §4.12.2 and PLAN_WEBAUTHN_EXTERNAL "Wire" ("with these three, as in §4.12")
- Kind: worked well
- What happened: `external` and a `webauthn` finish take the same four fields, so one `CodeRedemption` object spreads into either frame. All three purposes (external sign-in, external addition, passkey login/register/addition) share URL building, the popup/redirect, the callback page, the `sessionStorage` record and the `state` check. Only a roughly 15-line dispatch (`finishAuthorization`) differs. The plan's implementation note ("Clients that already implement `external` reuse…") held exactly.
- What I did: shared module `src/lib/ui/sign-in-page.ts`, used by the connect screen, the profile's Add passkey / Add external sign-in, and the page's link controller (the redirect return).
- Suggested spec change: none.

### F12. A full-page redirect for an addition needs session resume to finish
- Spec: §4.12.4 ("On a connection that is signed in… adds the identity"), PLAN_WEBAUTHN_EXTERNAL "Rules" ("an addition's code works only on a connection signed in to the account in its `request`")
- Kind: extra burden
- What happened: when the popup is blocked, the app leaves for the page and comes back to a fresh load. The addition's code then needs a connection signed in as the same account. That works only if the session comes back by itself (a kept `token`, §3.2.1). On a server without `token`, the app comes back signed out, and the code can't be used.
- What I did: the page's link controller waits for the session to settle (as it already does for an email addition link). It then redeems, or says "That sign-in was for adding to @ada, which this page isn’t signed in as now."
- Suggested spec change: an informative line in §4.12.2: "A client that leaves its page for the sign-in page needs a way back into the session to redeem an addition's code, such as a bearer `token`."

### F13. A COOP header on the server's page would make the popup look closed at once
- Spec: PLAN_WEBAUTHN_EXTERNAL "Rules" (frame refusal), brief (send `frame-ancestors 'none'` and `X-Frame-Options: DENY`)
- Kind: missing (informative)
- What happened: the client detects that the user closed the popup by polling `popup.closed`. If a sign-in page sends `Cross-Origin-Opener-Policy: same-origin`, Chromium severs the popup from its opener, and `closed` reads `true` straight away. The answer still arrives over `BroadcastChannel` from the callback page, but the client would already have said the window was closed.
- What I did: wait one second after `closed` before giving up, and take the answer from a same-origin `BroadcastChannel` rather than `window.opener` (which the client clears anyway). It works with today's servers, which send no COOP.
- Suggested spec change: in the passkey page rules, or in implementation notes: "The page SHOULD NOT send `Cross-Origin-Opener-Policy: same-origin`: web clients watch the window they opened." Or say nothing and let clients cope.

### F14. The "no `external`" message wants `server.welcome`, which only some screens show
- Spec: PLAN_WEBAUTHN_EXTERNAL "Rules" ("tells the user that the server's passkeys work only in its own apps and website, and shows `server.welcome`")
- Kind: nit
- What happened: the connect screen already renders `server.welcome` above the form, so the error is just "Chat Example’s passkeys work only in its own apps and website." The profile's Add passkey has no welcome rendering, so it shows the sentence alone.
- What I did: as described.
- Suggested spec change: "…and points to `server.welcome`, where the client shows it." Or make it a SHOULD.

### F15. Only `access_denied` is named; other OAuth errors and page-side errors reach the client differently
- Spec: §4.12.3 ("Redirects… with `error=access_denied` when the user declines"); brief ("Before a redirect target is validated, errors show on the page itself")
- Kind: nit
- What happened: the client must handle any RFC 6749 §4.1.2.1 error (`server_error`, `invalid_request`…), not just `access_denied`. Errors from before the redirect is validated never reach the client at all: the popup stays open on the server's error page until the user closes it.
- What I did: `access_denied` gives "Sign-in was cancelled.". Other errors give "The sign-in page couldn’t sign you in (<error_description or error>). Try again.". A closed window gives "The sign-in window was closed before signing in finished.".
- Suggested spec change: "Clients treat any other `error` as a failed sign-in (RFC 6749 §4.1.2.1)."

### F16. Cost in apron-web's startup budget
- Spec: §4.12 as a whole (client side)
- Kind: extra burden (measured)
- What happened: replacing the proposal flow with the OAuth flow plus the passkey page fallback added +5.1 KB of raw startup JS (+1.0 KB brotli) to the production build against main (866.2 → 871.3 KB, measured in this environment). That is after splitting it so that only the tap-time and boot-time parts load with the app: `sign-in-window.ts` (open the window on the tap, check for a returned answer) and `external.ts` (`parseExternal`). Everything else, about 6 KB (`authorization.ts`, `sign-in-page.ts`), loads on demand. My first version loaded it all eagerly and cost +10.7 KB plus 3 extra startup requests. Two causes: the `/signed-in/` route shared modules with `/`, and `external.ts` imported `types.ts`, which pulled `types.ts` into a chunk of its own. The callback page now imports nothing the app's page does (`sign-in-callback.ts` keeps copies of three storage keys, and a test keeps them equal).
- What I did: recorded the intended cost with `qa budget --update --changed` and `qa startup-budget --update` (main HEAD #276 was itself already about 5.6 KB above the recorded baseline, so the remaining slack wasn't enough).
- Suggested spec change: none. This is the cost of the feature. The plan's claim that `external` clients reuse the flow for passkeys held: the passkey page added only about 1 KB on top of `external`.

