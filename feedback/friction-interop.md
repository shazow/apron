# Friction log: interop (apron-web × apron-server-go × apron-server-cloudflare)

Real browser (Playwright Chromium, CDP virtual authenticator) driving the apron-web dev
server against each real server, plus a protocol-level cross-check script. Harness:
`/tmp/claude-0/-home-user/20bcd46f-cefb-56b4-8905-7ffb49d5fe85/scratchpad/interop/`
(`run.cjs` browser scenarios, `cross.cjs` protocol cross-checks).

Topologies: (a) loopback: app on `http://127.0.0.1:5173` (cannot use RP ID `localhost`) or
`http://localhost:5173` (can), servers on `localhost:8080` (Go) / `localhost:8787` (Cloudflare);
(b) HTTPS: app on `https://app.localhost:5443`, Go on `https://chat.localhost:8443` (RP ID
`chat.localhost`, `--public-url`), Cloudflare on `https://cf.localhost:8444` (wrangler local
https, RP ID `cf.localhost`, `RP_ORIGINS` = the app only, as in production).

### F1. A guest's "Create account" is an addition on Go and a new account on Cloudflare
- Spec: §4.10 ("A registration on a connection that is already signed in adds the passkey to that account"); PLAN_WEBAUTHN_EXTERNAL "Wire" (`?action=register&name=…` vs `&request=…`)
- Kind: ambiguity (interop-visible)
- What happened: apron-web auto-joins as a guest and runs "Create account" on that guest connection. Go treats the guest as signed in: the begin returns `?action=register&request=…`, the account keeps `guest_N`, and the code works only on that guest's connection. Cloudflare treats a guest registration as a new account: `?action=register&name=Grace`, a new `grace_1234`, code redeemable anywhere. §4.10 says "already signed in" without "guests included"; §4.11.1 and §4.12.4 say "guests included" explicitly, so readers split. apron-web followed Go's reading and bound the code to the guest's user ID, so on Cloudflare a full-page-redirect registration came back to a new guest connection and the client refused a perfectly valid code ("That passkey is for @guest_8, which this page isn't signed in as now"), leaving a passkey on the device for an account that never got created.
- What I did: fixed apron-web to send the code anyway and let the server decide (apron-web 479ef40). Cloudflare redirect registration now signs in; Go still denies (correctly, by its reading) and the client names the account.
- Suggested spec change: say it either way in §4.10, e.g. "A registration on a connection signed in to an account, guests included, adds the passkey to that account." And in the plan: "Clients learn which it is only from the code's redemption; they SHOULD NOT assume."

### F2. On Go, a guest cannot create a passkey account through the full-page redirect at all
- Spec: PLAN_WEBAUTHN_EXTERNAL "Rules" ("an addition's code works only on a connection signed in to the account in its `request`"), §3.2.1 (guests get no bearer token on Go)
- Kind: blocker (for the redirect fallback on Go)
- What happened: with popups blocked, apron-web leaves for Go's page, the passkey is created, and the app comes back to a fresh page load. The guest's connection is gone and a guest session has no `token`, so no connection can ever be signed in as `guest_N` again; Go answers "Finish adding this passkey where the account that asked for it is signed in". The user sees an error and has an orphan passkey on the device. Go also refuses `register` begin on a connection that is not signed in ("Sign in as a guest, or present an invitation, before adding a passkey"), so a client cannot sidestep by beginning on a fresh connection; Go never emits the contract's `?action=register&name=…` form. The popup path works (same tab keeps the connection). apron-web's own friction F12 predicted this for additions; it also hits account creation because of F1.
- What I did: recorded it; no fix (it is the spec's rule meeting Go's guest model). apron-web's message is accurate but the user cannot act on it.
- Suggested spec change: either let a guest's addition code be redeemed on a connection that is not signed in (it then makes the account the guest would have become, or a new one), or have servers return a short-lived bearer `token` to guests that begin a page addition. Or: "Clients SHOULD NOT use the full-page fallback for an addition unless they can resume the session."

### F3. A passkey created on the page outlives a code that is never redeemed
- Spec: PLAN_WEBAUTHN_EXTERNAL "Registering a new account" ("creates the account when the code is redeemed"), "Security considerations"
- Kind: missing
- What happened: on both servers the credential is created on the page, but the account (or the addition) exists only after the code is redeemed. When redemption fails or never happens (F2, a closed tab, an expired code, a code burned by a failed try, see F7), the authenticator keeps a discoverable passkey for nothing. The next "Continue with passkey" on that device may pick it, and the page then fails (seen in the harness on both servers: a 400 from the page's finish and no Allow screen).
- What I did: the harness removes such credentials; nothing in the repos.
- Suggested spec change: "When a login presents an unknown credential, the page SHOULD call `PublicKeyCredential.signalUnknownCredential` so the device can forget it." Optionally let the page show "That passkey isn't for an account here" instead of a generic error.

### F4. The guest + `external` divergence the brief expected does not show up: both servers deny, and apron-web never hits it
- Spec: §4.12.4 ("On a connection that is signed in, guests included, … An identity that belongs to another account is `denied`")
- Kind: worked well (with a caveat)
- What happened: the coordinator's note said Go returns `you`+`token` for a guest connection redeeming an `external` code for an existing account and Cloudflare denies. In practice Go also denies ("This external sign-in belongs to an account"); Cloudflare too. A NEW identity on a guest connection is added to the guest on Go (`you`+`token`). apron-web redeems `external` as the first `auth` of a connection of its own, so users never reach the guest rule; redirect returns also redeem on a fresh connection. A `webauthn` login code on a guest connection signs in on both servers (`you`+`token`), so the two schemes behave differently on a guest connection, which a client has to know.
- What I did: recorded; covered by `cross.cjs`.
- Suggested spec change: Cloudflare F6's suggestion stands (exempt guests from the additions rule, or say a guest connection signs in). At least note that a client redeeming `external` should use a connection that is not signed in.

### F5. The consent screens read the same on both servers
- Spec: PLAN_WEBAUTHN_EXTERNAL "Confirmation", PLAN_LOOSE "Confirmation"
- Kind: worked well
- What happened: screen 1 and screen 2 texts are word-for-word the same on Go and Cloudflare ("app.localhost:5443 wants to sign in to your account on chat.localhost:8443. It will be able to read and send messages as you." / "Allow app.localhost:5443 to use Grace (@grace_5480)'s account?" / "Not you? Use another passkey"), including the loopback "An app on this device" form. Only titles differ ("Sign in to localhost:8080" vs "Sign in to Apron Demo"; Cloudflare's screen 2 heading "Allow access"). Driving both from one script needed only button names.
- What I did: nothing.
- Suggested spec change: none.

### F6. A loopback web app is labelled "An app on this device"
- Spec: brief/plan "Confirmation" ("for loopback it is 'An app on this device'")
- Kind: nit
- What happened: apron-web served from `http://127.0.0.1:5173` (development) shows as "An app on this device wants to sign in…" and "Only continue if you just started signing in on an app on this device." Correct per the rule, but for a web page in the same browser "127.0.0.1:5173" would be more useful.
- What I did: nothing.
- Suggested spec change: "For loopback, 'An app on this device', or the loopback host and port when the redirect is `http://localhost`/`127.0.0.1` with a path (a local web app)." Low priority.

### F7. Whether a failed redemption burns the code differs
- Spec: §4.12.3 codes ("single use"); PLAN "Rules"
- Kind: ambiguity (informative)
- What happened: Go keeps a code usable after a refused try (the wrong scheme, presented to the other server); Cloudflare burns it on any failed attempt on its own server (a passkey-page code tried as `external` can no longer finish `webauthn`). Neither breaks apron-web, which tries once. Combined with F3, a burned new-account code leaves an orphan passkey.
- What I did: recorded.
- Suggested spec change: "A server MAY invalidate a code after a failed redemption." (RFC 6749 §4.1.2 already lets servers revoke on reuse.)

### F8. Wrong `resource`: Go redirects `invalid_target`, Cloudflare shows the error on the page
- Spec: brief ("Refuse any other `resource`"; "Before a redirect target is validated, errors show on the page itself"); RFC 8707 §2
- Kind: ambiguity
- What happened: with a valid `redirect_uri`, Go sends `error=invalid_target&error_description=…&iss&state` back to the client (RFC 8707 style); Cloudflare renders a 400 page and never returns. Both are allowed by the text. apron-web handles the redirect ("The sign-in page couldn't sign you in (resource must be …)"); on Cloudflare the user is left on the page's error in the popup until they close it, and then apron-web says "The sign-in window was closed before signing in finished." (inferred from apron-web's code and the 400 page; not driven in the browser, since apron-web always sends the right `resource`).
- What I did: recorded.
- Suggested spec change: pick one: "After the redirect target is validated, other errors are redirected (RFC 6749 §4.1.2.1, RFC 8707 `invalid_target`)."

### F9. Cloudflare omits "has not verified this app" for its own frontends
- Spec: PLAN_WEBAUTHN_EXTERNAL "Confirmation"
- Kind: ambiguity
- What happened: with the redirect on one of `RP_ORIGINS`, Cloudflare drops the "has not verified this app" line; Go always shows it. Sensible, but not in the plan.
- What I did: recorded.
- Suggested spec change: "A server MAY omit the line for clients it has verified (such as its own frontends)."

### F10. Go binds a token from `POST /oauth/token` to the token request's `Origin`
- Spec: PLAN_WEBAUTHN_EXTERNAL "Rules" ("A token from a code is a bearer token"), "Draft for PROTOCOL.md" ("The token of a finish with `code` is not bound to an origin")
- Kind: contradiction (minor; not user-visible in apron-web)
- What happened: an `access_token` from Go's token endpoint fetched with `Origin: http://127.0.0.1:5173` signs in from a WebSocket with that Origin, but a connection with no Origin gets "Session expired; sign in again". Go binds every session to the Origin that obtained it (Go friction F9 calls it a feature). Cloudflare's tokens from codes are unbound. apron-web always resumes from the same origin, so users don't see it; a native app that fetched from a web view would.
- What I did: recorded.
- Suggested spec change: make the plan's line normative for both paths ("not bound to an origin"), or allow binding to the obtaining origin explicitly.

### F11. Cloudflare names accounts made through `external` "Guest XXXXXX"
- Spec: §4.12 (new account from an `/oauth/authorize` code)
- Kind: nit
- What happened: an account created on Cloudflare's `/oauth/authorize` "Create an account" gets `user_id` `u_…` and name "Guest bhhcXA", and the next screen says "Allow app… to use Guest bhhcXA (@u_…)'s account?". The page asks no name, and apron-web's External form has a Display name field that is not sent with `external`. On Go the identity provider supplies the name.
- What I did: recorded.
- Suggested spec change: none for the protocol; the page could ask a name when creating an account, as the passkey page's `name` does.

### F12. Interop worked on first contact for every main path
- Spec: whole interop contract
- Kind: worked well
- What happened: popup and full-page redirect, passkey register/login/addition, `external` new/existing/cancel (page Cancel, IdP decline, Cancel on the Allow screen), the local ceremony when the origin can use the RP ID, `resource` derivation from `ws:`/`wss:`, `iss`/`state`, the token endpoint with CORS `*`, and every code-crossing check (server A→B, passkey-page→external, external→webauthn, login→register, wrong verifier, passkey code at `/oauth/token`) behaved on both servers with no code change, over loopback http and over https with distinct hosts. The only fix needed was F1's client assumption.
- What I did: nothing.
- Suggested spec change: none.

### F13. Adding an `external` identity to a signed-in account shows the "create an account" screen
- Spec: PLAN_LOOSE "Confirmation"; brief ("an `external` code adds the identity to that account and returns `you` only")
- Kind: nit
- What happened: from a passkey session, apron-web's Profile "Add external sign-in" (popup and redirect both pass on Go) begins `external` on a connection of its own, so Go's page cannot tell it is an addition. With a new identity it says "An app on this device wants to create an account for you on localhost:8080" and "Continue"; the redemption on the signed-in connection then adds the identity to @guest_9 and returns `you` only, and apron-web says "Added · sign in with it anywhere". The words on the page are wrong for what happens (Go F7 predicted it).
- What I did: recorded.
- Suggested spec change: Go F7's neutral wording ("…wants to sign in to chat.example as you"), or let the client mark an addition in the request (an `apron_addition=1` parameter the page may show) so the page can say "add this sign-in to your account".

### F14. Testing note: a popup has its own virtual authenticator
- Spec: none (test burden)
- Kind: extra burden
- What happened: Chromium's CDP virtual authenticator is per target, so a passkey created in the page's popup is not in the opener's authenticator, and copying credentials between them needs `WebAuthn.credentialAdded`/`credentialAsserted` (the sign counter must follow, or the server's clone check refuses the next sign-in). About 30 lines of harness; the Go interop test does the same.
- What I did: as described.
- Suggested spec change: none.
