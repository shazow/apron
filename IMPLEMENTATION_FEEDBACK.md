# Implementation feedback: §4.12 `external` and the passkey page

Status: 2026-11-15. This file collects what three implementations taught us about the spec:

- PROTOCOL.md §4.12 on [shazow/apron#115](https://github.com/shazow/apron/pull/115), at dc9e56f;
- [PLAN_WEBAUTHN_EXTERNAL.md](PLAN_WEBAUTHN_EXTERNAL.md).

Its purpose is to decide whether the spec is ready to accept. Raw logs from each implementer are in [feedback/](feedback/).

| Repository | Branch `claude/charming-faraday-nrrajr` | Scope |
|---|---|---|
| apron-chat/apron-web | 6 commits | client: `external`, passkey-page fallback, `/signed-in/` callback, client metadata document |
| apron-chat/apron-server-go | 7 commits | own authorization server, passkey page, foreign issuer, `examples/sso` migrated |
| apron-chat/apron-server-cloudflare | 3 commits | passkey page; `external` behind `EXTERNAL_SIGN_IN` (off) |

Item IDs below (M, S, H, W) are stable, so we can refer to them. The source entries are in brackets: `go F6` means apron-server-go's log, F6.

## Verdict

The design held. Three implementers worked independently, and they reached the same shape, and the same guesses where the text was silent, for the following:

- URL building;
- code binding;
- redemption on the connection;
- the confirmation screens.

The plan's central claim also held: a client that implements `external` gets the passkey page almost free. In apron-web it cost about 1 KB on top of `external`, and one 15-line dispatch.

It is **not ready to accept as is**. Six items (M1–M6) are gaps or contradictions that made implementers guess. M1 also leaves a returning user unable to sign in from a guest connection. Each needs only a sentence or two. The passkey page also has to move from the plan into PROTOCOL.md, the schema and HISTORY.md (M5).

A real-browser run of apron-web against both servers worked on first contact for every main path (see "Interop"). It found one client bug, now fixed. It also found that a guest's "Create account" means different things on the two servers (M1), which breaks one flow on apron-server-go.

## Must fix before accepting

### M1. Guests and "additions" (§4.12.4)

[cf F6, go F6, web F6, go F5]

§4.12.4 says: "On a connection that is signed in, guests included, an `external` request adds the identity to that account, and returns `you`."

- When the server is its own issuer, the identity *is* an existing account, so nothing can be added.
- A returning user's code on a guest connection is therefore "an identity that belongs to another account", which is `denied`. Yet `webauthn` lets that same guest sign in.
- apron-web starts every connection as a guest.

Both servers followed the text, and both went past it in the same way:

| Code on a guest connection | apron-server-go | apron-server-cloudflare |
|---|---|---|
| identity of an existing account | `denied` | `denied` |
| new identity | guest becomes the account; returns `you` **and `token`** | guest becomes the account; returns `you` **and `token`** |

- **Returning users.** As written, a returning user who presses "Sign in" in apron-web gets `denied`, unless the client opens a fresh connection that is not a guest to redeem. apron-web does exactly that: it redeems a sign-in on a fresh connection. That is a workaround every client has to discover.
- **No token.** "`you` only" leaves a guest that became an account with no `token`. It loses the account on reconnect. Both servers return a `token`, which §3.2.1 allows.
- **The schemes differ on a guest.** A passkey-page *login* code on a guest connection signs in on both servers, with `you` and `token`. An `external` code for the same kind of account is `denied`. A client has to know the difference. [interop F4]
- **`register` on a guest: the servers split.** [interop F1, F2] §4.10 says "already signed in" without "guests included". §4.11.1 and §4.12.4 say it explicitly, so readers split:

  | `register` begin on a guest connection | apron-server-go | apron-server-cloudflare |
  |---|---|---|
  | reading | an addition to the guest | a new account |
  | `url` | `?action=register&request=…` | `?action=register&name=…` |
  | code redeemable | only on that guest's connection | on any connection |
  | after a full-page redirect | **fails**: the guest connection is gone, and a guest has no `token` to resume. The device keeps a passkey for no account | works |

  - **apron-server-go** also refuses a `register` begin on a connection that is not signed in, so a client cannot sidestep this.
  - **apron-web** first assumed apron-server-go's reading, and threw away valid codes from apron-server-cloudflare. Fixed in apron-web `479ef40`: it now sends the code and lets the server decide.

Recommendation: treat a guest connection like one that is not signed in, except that a new identity may keep the guest's account.

> - On a connection signed in to an account other than a guest, an `external` request adds the identity to that account, and returns `you`.
> - On a guest connection, it signs in: an identity with an account signs in to it, and a new identity becomes an account, which MAY be the guest's. The result carries `you` and a bearer `token`.

Apply the same rule to a passkey-page code. Under it, a guest's `register` code is redeemable on any connection that is not signed in: it makes the account that the guest would have become, or a new one. That keeps the full-page redirect working.

Say it in §4.10 too, which today has no "guests included":

> A registration on a connection signed in to an account other than a guest adds the passkey to that account.

### M2. A `webauthn` begin without `public_key`, and a finish with `code` (§4.10)

[cf F3, go F4, web F5]

The plan lets a begin carry `external` without `public_key`. §4.10's table says that begin returns `challenge_id` and `public_key`, and that finish takes `challenge_id`.

All three implementations made the same choice: a page-only begin has no `challenge_id`, and a finish with `code` sends none.

- **Both servers return page-only begins** to every connection that cannot run the local ceremony: native apps, which send no `Origin`, and web origins not in the RP's list.
- **These connections were refused before.** Until now, they were not offered `webauthn` at all.

Recommendation: make the table say "`challenge_id` and `public_key`, or `external`, or both". Add:

> A begin result without `public_key` has no `challenge_id`. A finish step with `code` carries no `challenge_id`.

### M3. The origin of a `ws://` address (§4.12.1)

[go F1, web F1]

"`https://` plus the host and any port" breaks loopback development. A client on `ws://127.0.0.1:8080/ws` must send `resource=https://127.0.0.1:8080` to a server whose `iss` is `http://127.0.0.1:8080`.

Each implementation patched around it differently:

- **apron-web** sends `http` for a loopback `ws:` address.
- **apron-server-go** accepts either spelling.

Recommendation:

> The server's origin is `https://` plus the host and any port of its address, or `http://` for a `ws://` address on a loopback host.

### M4. Which `url` a client may open (§4.12.1)

[web F2]

v10 said: "`url` is an absolute `https` URL, or `http` on a loopback host. Clients reject any other `url`, such as `javascript:…`." The revision dropped the sentence.

A web client that navigates to a `javascript:` URL runs the server's script on the client's origin. apron-web kept the check.

Recommendation: restore the sentence in §4.12.1. It also covers the passkey page's `external.url`.

### M5. Move the passkey page into PROTOCOL.md, schema and HISTORY.md

[go F2, cf F2, go F16, web F4, go F5]

The implementers worked from the plan's "Draft for PROTOCOL.md". The schema at dc9e56f still describes the proposal-based `external`:

- it still has `return_url`, `AuthResult.url`, and `state` for external;
- it has no `code`, `code_verifier`, `redirect_uri`, `client_id` or `external` object;
- `conform.py` still sends `return_url`.

The draft also needs these points:

- **Where the page can be offered.** The page works only where its origin can use the RP ID.
  - apron-server-cloudflare offers it where the host is the RP ID or under it.
  - apron-server-go offers it where its own origin is among the RP origins. That is a new setting for deployments with a separate frontend (go F16).

  > A server offers `external` in a begin result only where its passkey page's origin can use the RP ID.
- **Name the refusal that triggers the fallback.** The §4.10 RP ID check passes for a third-party web client: the server owns its RP ID, but the browser still refuses it. "Try first" is what works. A user cancel must not fall back (web F4).

  > Clients that cannot use the RP ID of `public_key`, or whose platform refuses it (such as with `SecurityError`), use `external`.
- **A new-account registration code.** Account policy, such as an invitation, applies at redemption. A non-addition `register` code finishes only on a connection that is not signed in (go F5). This follows from M1.

### M6. Errors on the authorization pages (§4.12.3)

[cf F7, web F15, interop F8]

The servers differ on a wrong `resource` with a valid `redirect_uri`:

- **apron-server-go** redirects `error=invalid_target`.
- **apron-server-cloudflare** shows a 400 page. A popup user then only hears "The sign-in window was closed".

Both are allowed by the text.

Open clients make every `https` `redirect_uri` "valid". So redirecting `invalid_request` back, as RFC 6749 does, would make the page an open redirector.

- **Server:** apron-server-cloudflare shows every error on the page, and redirects only after the user acts.
- **Client:** apron-web must still handle any RFC 6749 error, not only `access_denied`.

Recommendation, in §4.12.3:

> The page shows an invalid request's error itself. It redirects only after the user acts: with a code, or with `error=access_denied`.

And in §4.12.2:

> Clients treat any other `error` as a failed sign-in.

The cost is that a malformed request gives the client no machine-readable error. Only a buggy client sends one. If this is adopted, apron-server-go's `invalid_target` redirect changes to an error on the page.

## Should clarify

These are small, and none made two implementations disagree.

- **S1. The page must not cut off its opener.** [cf F12, web F13] Both implementers found this independently.
  - `Cross-Origin-Opener-Policy: same-origin` on a sign-in page breaks popup clients. `popup.closed` reads true at once, and `window.opener` is gone.
  - Proposed wording: "The page does not send `Cross-Origin-Opener-Policy: same-origin`: web clients open it in a popup."
  - Also proposed: a SHOULD for `Referrer-Policy: no-referrer`.
- **S2. `url`'s `client_id` is the client's `client_id`.** [go F14] The Go test client first redeemed with its own `client_id` after keeping `url`'s, and a foreign issuer correctly refused. The two rules sit in different bullets. Proposed wording, in §4.12.2: "If `url` carries `client_id`, clients use it in the request and the redemption."
- **S3. The server sends `resource` at the token endpoint.** [go F12] Some issuers pick the audience there.
- **S4. Foreign issuer requirements, stated plainly.** [go F11, go F13]
  - §4.12.4's `aud` MUST makes "binds to `resource`" a MUST in effect, and introspection needs credentials the server lacks with a public `client_id`.
  - Proposal: require JWT access tokens (RFC 9068) from a foreign issuer, or say that introspection needs the server's own credentials.
  - **Pocket ID checked (main, e22f0b6).** It works with configuration:
    - its access tokens are RFC 9068 JWTs;
    - `resource` becomes `aud` when the Apron server is registered as an API and the client is allowed to reach it;
    - its callback URL patterns accept wildcards;
    - client ID metadata documents are allowed by an operator URL allowlist.

    So "such as Pocket ID" can stay in our notes. SERVER.md should list these settings.
- **S5. Popups and user activation.** [web F3] Begin answers after the tap, so `window.open` may be blocked. Informative note: "A web client can open a window during the tap, before begin answers, and send it to `url` afterwards."
- **S6. An addition after a full-page redirect needs the session back.** [web F12] It works only with a resumable `token`. Informative note.
- **S7. `request` handle lifetime.** [cf F13] "Expires with the codes" is vague, because the handle is made before the user reads the page. Proposed wording: "expires within minutes, like a code". apron-server-cloudflare uses 10 minutes for the handle and 5 for a code.
- **S8. Confirmation wording.** [cf F11, go F7, go F8, interop F5, F6, F9, F13] The screens read word for word the same on both servers. Proposed changes:
  - Give "Only continue if you just started signing in on …" its own column, because "on An app on this device (com.example.myapp)" reads badly.
  - Allow a server's configured first-party origins to count as "recognised". apron-server-cloudflare already omits the "not verified" line for them; apron-server-go always shows it.
  - New-identity screen: proposed "…wants to sign in to chat.example as you", true whether the code makes an account or is added to one.
    - In the browser, "Add external sign-in" showed apron-server-go's "wants to create an account for you", then added the identity instead. The page cannot tell that a request is an addition.
  - A local web app on `http://127.0.0.1:5173/…` reads as "An app on this device". Showing the host and port would be more useful. Low priority.
  - "Not you?" starts the page's sign-in again. Whether that prompts depends on the identity provider.
- **S9. The State table undercounts the page.** [cf F4] The page's own ceremony spans two HTTP requests. A login code MAY be issued before Allow, if only the page holds it until Allow.
- **S10. "No passkey page" message.** [web F14] "Shows `server.welcome`" fits only screens that render it. Proposed wording: "points to `server.welcome`, where the client shows it".
- **S11. Optional extra binding.** [cf F10] "A server redeems a code only for the origin in its `resource`." This stops codes from crossing between hosts that share one backend.
- **S12. Client ID metadata documents and many origins.** [web F7] A client served from many origins (Previews, localhost, self-hosted) can use a document only on one of them. Informative note: "such a client sends a plain `client_id`".
- **S13. Orphan passkeys.** [interop F3, plan "Stray passkeys"] The plan calls a stray passkey harmless. In the browser it was not:
  - A passkey made on the page whose code is never redeemed is left on the device. That happens after a failed or burned code, or a closed tab.
  - The next "Continue with passkey" can pick it, and the page then fails with a generic error.

  Proposed wording: "When a login presents an unknown credential, the page SHOULD call `PublicKeyCredential.signalUnknownCredential`, and say that the passkey is not for an account here." Fix the security consideration's wording too.
- **S14. Origin binding of a token from a code.** [interop F10, go F9]
  - **apron-server-go** binds a token from `POST /oauth/token` to the token request's `Origin`. A connection with no `Origin`, such as a native app, then gets "Session expired".
  - **apron-server-cloudflare** leaves it unbound.
  - The plan says such a token "is not bound to an origin". Make that normative for both redemption paths, or allow binding to the obtaining origin explicitly. If normative, apron-server-go changes.
- **S15. A failed redemption may burn the code.** [interop F7] apron-server-cloudflare burns a code on any failed try; apron-server-go does not. Proposed wording: "A server MAY invalidate a code after a failed redemption."

## Housekeeping

- **H1.** Drop the `workers-oauth-provider` note from PLAN_WEBAUTHN_EXTERNAL.md and PLAN_LOOSE.md. [cf F1]
  - It needs its own KV binding, mints its own tokens, and refuses unknown `client_id`s.
  - It has no way to redeem a code on a WebSocket.
- **H2.** List the renumbering in #115's description: §4.11 email, §4.12 external, §4.13 `ext`. Implementations cite v10 numbers. [cf F9]
- **H3.** Update `conform.py`'s unsupported-scheme check, which sends `return_url`. [go F2]

## Worked well

- **W1. Redemption on the connection, with no `iss` check, kept clients small.** [web F10] apron-web's shared authorization module is about 90 lines. It does no metadata discovery and has no token endpoint.
- **W2. One redemption shape for both schemes.** [web F11] `external` and a `webauthn` finish take the same four fields. One object spreads into either frame.
- **W3. Binding codes to the page and action.** [go F3, cf F10] Every crossover is one comparison:
  - external → webauthn;
  - webauthn → external;
  - login → register;
  - an addition on another account.
- **W4. The confirmation wording dropped straight into both servers.** [cf F11]
- **W5. Bearer tokens from codes.** [cf F5, go F9] The token from a code is a plain bearer token, separate from origin-bound sessions. It was a prefix in apron-server-cloudflare, and the token request's `Origin` in apron-server-go.
- **W6. Re-authentication before adding a second passkey.** [go F17] The server's existing rule applied unchanged, because the addition's code is redeemed on the account's own connection.
- **W7. Fixed, well-known paths.** [cf F8] Updating production's edge allowlist was a one-time list.

## Cost

| | Size | Notes |
|---|---|---|
| apron-web, `external` + page fallback | +5.1 KB raw / +1.0 KB brotli startup JS; ~6 KB loaded on demand | the passkey page adds about 1 KB on top of `external` |
| apron-server-go, shared OAuth helpers | ~520 lines | request parsing, redirect rules, client naming, codes, confirmation |
| apron-server-go, `external` page + token endpoint | ~430 lines | |
| apron-server-go, passkey page | ~560 lines + ~80-line script | the script includes ~40 lines of WebAuthn JSON fallback |
| apron-server-go, foreign issuer | ~500 lines | hand-written JOSE: discovery, JWKS, verification |
| apron-server-cloudflare, code store + redemption | ~250 lines | Durable Object storage, with an expiry index |
| apron-server-cloudflare, page ceremony + page | ~450 lines | two same-origin JSON endpoints |

## Interop

Setup:

- **Browser:** Playwright Chromium, with a CDP virtual authenticator.
- **Client:** the apron-web dev server, driven against the real apron-server-go and apron-server-cloudflare (wrangler dev).
- **Topologies:**
  - loopback: the app on `127.0.0.1:5173`, which cannot use RP ID `localhost`, or on `localhost:5173`, which can;
  - https, with distinct hosts: the app on `app.localhost`, and the servers on `chat.localhost` and `cf.localhost`.
- **Cross-checks:** a protocol script presented codes between servers and between schemes.

The harness is in [feedback/interop/](feedback/interop/), and the log in [feedback/friction-interop.md](feedback/friction-interop.md).

| Scenario | Go | Cloudflare |
|---|---|---|
| Passkey page: register, login (both screens), by popup | ✅ | ✅ |
| Passkey page: login by full-page redirect | ✅ | ✅ |
| Passkey page: "Add passkey" from a signed-in session | ✅ (`you`+`token`) | ✅ (`you`) |
| Passkey page: a guest registers by full-page redirect | ❌ by its reading of the spec (M1) | ✅ after apron-web `479ef40` |
| Local ceremony when the origin can use the RP ID | ✅ | ✅ |
| `external`: new and existing account, by popup and redirect | ✅ | ✅ (its passkey-backed page) |
| `external`: Cancel or decline → `access_denied` → "Sign-in was cancelled." | ✅ | ✅ |
| "Add external sign-in" from a passkey session | ✅ | not run |
| Codes across servers, across schemes, login→register, wrong verifier, reuse, passkey code at `/oauth/token` | all `denied` | all `denied` |
| Token endpoint (CORS `*`), then `scheme: "token"` | ✅ from the same `Origin` only (S14) | ✅ |
| Wrong `resource` | redirects `invalid_target` | page error (M6) |

Commits from the run:

- **apron-web `479ef40`:** send a registration's code even when the account it began as is gone.
- **apron-server-go `8c8ad5f`:** a durable interop test. The web app creates an account on the passkey page by popup, and signs in by redirect with popups blocked. It also fixes a race in the existing test.
