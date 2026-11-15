# Implementation feedback: §4.12 `external` and the passkey page

Status: 2026-11-15. This file collects what three implementations taught us about the spec:

- PROTOCOL.md §4.10.1 and §4.12 on [shazow/apron#115](https://github.com/shazow/apron/pull/115);
- [PLAN_WEBAUTHN_EXTERNAL.md](PLAN_WEBAUTHN_EXTERNAL.md), now drafted into §4.10.1.

Its purpose is to decide whether the spec is ready to accept. Raw logs from each implementer are in [feedback/](feedback/).

| Repository | Pull request (draft until #115 is accepted) | Scope |
|---|---|---|
| apron-chat/apron-web | [#278](https://github.com/apron-chat/apron-web/pull/278) | client: `external`, passkey-page fallback, `/signed-in/` callback, client metadata document |
| apron-chat/apron-server-go | [#39](https://github.com/apron-chat/apron-server-go/pull/39) | own authorization server, passkey page, foreign issuer, `examples/sso` migrated |
| apron-chat/apron-server-cloudflare | [#97](https://github.com/apron-chat/apron-server-cloudflare/pull/97) | passkey page; `external` behind `EXTERNAL_SIGN_IN` (off in production) |

Item IDs (M, S, H, W) are stable, so we can refer to them. Source entries are in brackets: `go F6` means apron-server-go's log, F6.

## Verdict

The design held:

- **Same shape everywhere.** Three implementers worked independently. They reached the same shape for URL building, code binding, redemption on the connection, and the confirmation screens. Where the text was silent, they made the same guesses.
- **The passkey page came almost free.** A client that implements `external` gets it for about 1 KB more in apron-web, plus one 15-line dispatch.
- **Interop.** A real-browser run of apron-web against both servers worked on first contact for every main path (see "Interop").

**The must-fix items are resolved.** Each is now in PROTOCOL.md (see "Decisions"), and the implementations follow it. What remains is the "Should clarify" list (S) and housekeeping (H). None of these made two implementations disagree.

## Decisions (2026-11-15)

| Item | Decision | Where |
|---|---|---|
| M1. Guests and additions | Whether a guest counts as signed in is server policy. "Guests included" is gone from §4.11.1 and §4.12.4. | §3.2, `8837756` |
| M2. Begin without `public_key` | A begin result carries `challenge_id` and `public_key`, `external`, or both. Without `public_key`, there is no `challenge_id`. A finish with a code sends none. | §4.10, §4.10.1, `a475c07` |
| M3. Origin of a `ws://` address | The origin is `http://` for a `ws://` address on a loopback host. | §4.12.1, `a475c07` |
| M4. Which `url` a client opens | Only `https`, or `http` on a loopback host. | §4.12.1, `a475c07` |
| M5. Passkey page into the spec | The page is §4.10.1. It is offered only where the page's origin can use the RP ID. Clients fall back on a failed RP ID check, or when the platform refuses the RP ID (such as with `SecurityError`), but not when the user cancels. The schema, HISTORY.md and `conform.py` are updated. | §4.10.1, `a475c07` |
| M6. Errors on the sign-in pages | The page shows an invalid request's error itself, and redirects only after the user acts. Clients treat any `error` other than `access_denied` as a failed sign-in. | §4.12.2, §4.12.3, `a475c07` |
| S14. Tokens from codes and `Origin` | The rules now say what servers check, instead of "binding" a token to an origin. A passkey token from a ceremony in the client is accepted only on a connection with the ceremony's `Origin`. Servers never refuse a token from a code, or any token of `external`, because of `Origin`. §5.2 says that rotation limits a copy. | §4.10, §4.10.1, §4.12.4, §5.2, `347ebd4` |
| apron-web's startup budget | Raised for the startup JS size only, `a4f9220` | apron-web#278 |

Implementations brought in line:

- **apron-server-go** shows errors on the page (`e773491`), and doesn't refuse tokens from codes because of `Origin` (`b5a2f3c`).
- **apron-server-cloudflare** and **apron-web** already matched.

### Follow-up: apron-server-go and guests

On apron-server-go, a guest's "Create account" on the passkey page is an addition to the guest. Its code works only on that guest's connection. With popups blocked, the full-page redirect loses that connection, and a guest has no `token` to resume. The user is left with a passkey for no account. [interop F1, F2]

Under M1 this is the server's policy, so the fix belongs in apron-server-go. Either:

- treat a guest's registration as a new account, as apron-server-cloudflare does; or
- return a `token` to a guest that begins an addition on the page.

## Should clarify

These are small, and none made two implementations disagree.

- **S1. The page must not cut off its opener.** [cf F12, web F13] Both implementers found this independently.
  - `Cross-Origin-Opener-Policy: same-origin` on a sign-in page breaks popup clients: `popup.closed` reads true at once, and `window.opener` is gone.
  - Proposed: "The page does not send `Cross-Origin-Opener-Policy: same-origin`: web clients open it in a popup."
  - Also proposed: a SHOULD for `Referrer-Policy: no-referrer`.
- **S2. `url`'s `client_id` is the client's `client_id`.** [go F14] The Go test client kept `url`'s `client_id`, then redeemed with its own, and a foreign issuer correctly refused. The two rules sit in different bullets. Proposed, in §4.12.2: "If `url` carries `client_id`, clients use it in the request and the redemption."
- **S3. The server sends `resource` at the token endpoint.** [go F12] Some issuers pick the audience there.
- **S4. Foreign issuer requirements, stated plainly.** [go F11, go F13, go F20]
  - §4.12.4's `aud` MUST makes binding to `resource` a MUST in effect.
  - Introspection needs credentials that the server lacks with a public `client_id`.
  - Proposal: require JWT access tokens (RFC 9068) from a foreign issuer, or say that introspection needs the server's own credentials.
  - **Pocket ID checked (main, e22f0b6).** It works with configuration:
    - its access tokens are RFC 9068 JWTs;
    - `resource` becomes `aud` when the Apron server is registered as an API and the client is allowed to reach it;
    - its callback URL patterns accept wildcards;
    - client ID metadata documents are allowed by an operator URL allowlist.

    SERVER.md should list these settings.
- **S5. Popups and user activation.** [web F3] Begin answers after the tap, so `window.open` may be blocked. Informative note: "A web client can open a window during the tap, before begin answers, and send it to `url` afterwards."
- **S6. An addition after a full-page redirect needs the session back.** [web F12] It works only with a resumable `token`. Informative note.
- **S7. `request` handle lifetime.** [cf F13] The plan's handle is made before the user reads the page. "Expires with the codes" is too short for that. Proposed: "expires within minutes, like a code". apron-server-cloudflare uses 10 minutes for the handle and 5 for a code.
- **S8. Confirmation wording.** [cf F11, go F7, go F8, interop F5, F6, F9, F13] The screens read word for word the same on both servers. Proposed changes:
  - Give "Only continue if you just started signing in on …" its own column. "on An app on this device (com.example.myapp)" reads badly.
  - Let a server's configured first-party origins count as "recognised". apron-server-cloudflare already omits the "not verified" line for them; apron-server-go always shows it.
  - New-identity screen: "…wants to sign in to chat.example as you". That is true whether the code makes an account or is added to one. Today, "Add external sign-in" shows apron-server-go's "wants to create an account for you", then adds the identity.
  - A local web app on `http://127.0.0.1:5173/…` reads as "An app on this device". Showing the host and port would be more useful. Low priority.
  - "Not you?" starts the page's sign-in again. Whether that prompts depends on the identity provider.
- **S9. The State table undercounts the page.** [cf F4] The page's own ceremony spans two HTTP requests. A login code MAY be issued before Allow, if only the page holds it until Allow.
- **S10. "No passkey page" message.** [web F14] "Shows `server.welcome`" fits only screens that render it. Proposed: "points to `server.welcome`, where the client shows it".
- **S11. Optional extra binding.** [cf F10] "A server redeems a code only for the origin in its `resource`." This stops codes from crossing between hosts that share one backend.
- **S12. Client ID metadata documents and many origins.** [web F7] A client served from many origins (Previews, localhost, self-hosted) can use a document on only one of them. Informative note: "such a client sends a plain `client_id`".
- **S13. Orphan passkeys.** [interop F3] The plan calls a stray passkey harmless. In the browser it was not:
  - A passkey made on the page whose code is never redeemed stays on the device. This happens after a failed or burned code, or a closed tab.
  - The next "Continue with passkey" can pick it, and the page then fails with a generic error.

  Proposed: "When a login presents an unknown credential, the page SHOULD call `PublicKeyCredential.signalUnknownCredential`, and say that the passkey is not for an account here."
- **S15. A failed redemption may burn the code.** [interop F7] apron-server-cloudflare burns a code on any failed try; apron-server-go does not. Proposed: "A server MAY invalidate a code after a failed redemption."

- **S16. Email `state` on approval: details.** [email-state F1, F2] The new rule ("An approval MAY carry the proposal's `state`") works in apron-server-go (`f2e44a8`) and apron-web (`60a1960`). Two cases are open:
  - **Two pending proposals with one `state`.** apron-server-go lets the newest proposal own it. Proposed: "Clients use a new `state` for each proposal."
  - **A `state` that matches no pending proposal.** apron-server-go treats it as `denied`, and the attempt counts against nothing. Proposed: "A `state` that matches no pending proposal is ignored."

## Housekeeping

- **H1.** Drop the `workers-oauth-provider` note from PLAN_WEBAUTHN_EXTERNAL.md and PLAN_LOOSE.md. [cf F1] It needs its own KV binding, mints its own tokens, refuses unknown `client_id`s, and cannot redeem a code on a WebSocket.
- **H2.** List the renumbering in #115's description: §4.11 email, §4.12 external, §4.13 `ext`. Implementations cite v10 numbers. [cf F9]

## Worked well

- **W1. Redemption on the connection kept clients small.** [web F10] There is no `iss` check. apron-web's shared authorization module is about 90 lines, with no metadata discovery and no token endpoint.
- **W2. One redemption shape for both schemes.** [web F11] `external` and a `webauthn` finish take the same four fields. One object spreads into either frame.
- **W3. Binding codes to the page and the action.** [go F3, cf F10] Each crossover is one comparison:
  - external → webauthn;
  - webauthn → external;
  - login → register;
  - an addition on another account.
- **W4. The confirmation wording dropped straight into both servers.** [cf F11]
- **W5. Tokens from codes, separate from origin-checked sessions.** [cf F5, go F9, go F19] apron-server-cloudflare tells them apart by a prefix, and apron-server-go by a stored flag. Showing every error on the page made apron-server-go's code about 10 lines smaller.
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

The harness is in [feedback/interop/](feedback/interop/), and the log in [feedback/friction-interop.md](feedback/friction-interop.md). The run predates the M6 and S14 changes in apron-server-go; the last two rows show its behaviour since.

| Scenario | Go | Cloudflare |
|---|---|---|
| Passkey page: register, login (both screens), by popup | ✅ | ✅ |
| Passkey page: login by full-page redirect | ✅ | ✅ |
| Passkey page: "Add passkey" from a signed-in session | ✅ | ✅ |
| Passkey page: a guest registers by full-page redirect | ❌ server policy (see "Follow-up") | ✅ after apron-web `479ef40` |
| Local ceremony when the origin can use the RP ID | ✅ | ✅ |
| `external`: new and existing account, by popup and redirect | ✅ | ✅ (its passkey-backed page) |
| `external`: Cancel or decline → `access_denied` → "Sign-in was cancelled." | ✅ | ✅ |
| "Add external sign-in" from a passkey session | ✅ | not run |
| Codes across servers, across schemes, login→register, wrong verifier, reuse, passkey code at `/oauth/token` | all `denied` | all `denied` |
| Token endpoint (CORS `*`), then `scheme: "token"` from any `Origin` | ✅ since `b5a2f3c` | ✅ |
| Wrong `resource` | page error since `e773491` | page error |

Commits from the run:

- **apron-web `479ef40`:** send a registration's code even when the account it began as is gone.
- **apron-server-go `8c8ad5f`:** a durable interop test. The web app creates an account on the passkey page by popup, and signs in by redirect with popups blocked.
