# Implementation feedback: §4.12 `external` and the passkey page

Status: 2026-11-16. This file collects what three implementations taught us about the spec:

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
| M1. Guests and additions | On a guest connection, server policy decides whether signing in with another scheme adds it to the guest's account. "Guests included" is gone from §4.11.1 and §4.12.4. | §3.2, `8837756`, `7489bc3` |
| M2. Begin without `public_key` | A begin result carries `challenge_id` and `public_key`, `external`, or both. Without `public_key`, there is no `challenge_id`. A finish with a code sends none. | §4.10, §4.10.1, `a475c07` |
| M3. Origin of a `ws://` address | The origin is `http://` for a `ws://` address on a loopback host. | §4.12.1, `a475c07` |
| M4. Which `url` a client opens | Only `https`, or `http` on a loopback host. | §4.12.1, `a475c07` |
| M5. Passkey page into the spec | The page is §4.10.1. It is offered only where the page's origin can use the RP ID. Clients fall back on a failed RP ID check, or when the platform refuses the RP ID (such as with `SecurityError`), but not when the user cancels. The schema, HISTORY.md and `conform.py` are updated. | §4.10.1, `a475c07` |
| M6. Errors on the sign-in pages | The page shows an invalid request's error itself, and redirects only after the user acts. Clients treat any `error` other than `access_denied` as a failed sign-in. | §4.12.2, §4.12.3, `a475c07` |
| S14. Tokens from codes and `Origin` | The rules now say what servers check, instead of "binding" a token to an origin. A passkey token from a ceremony in the client is accepted only on a connection with the ceremony's `Origin`. Servers never refuse a token from a code, or any token of `external`, because of `Origin`. §5.2 says that rotation limits a copy. | §4.10, §4.10.1, §4.12.4, §5.2, `347ebd4` |
| Offering the passkey page to old clients | Servers offer `webauthn` with `external.url` to every connection, and the begin result has no `public_key` where the origin can't use the RP ID. There is no rollout switch: clients that predate §4.10.1 see a passkey option they can't complete, and they update. `token` and `guest` keep working for them. | apron-server-cloudflare#97, as is |
| Confirmation screens (trimmed) | The page redirects only to a client that the user allowed. A user allows an `https` `redirect_uri` once per account, and any other at each sign-in. The `external` page shows one screen after its sign-in; the passkey page shows one screen before the passkey. Repeat sign-ins through Pocket ID cost 1 tap instead of 3. | §4.12.3 `72a6e2b`; Go `9265022`, `44aef05`; Cloudflare `e1d1500` |
| Another authorization server | Kept, as an optional server feature in `ext:oauth`, not core. Only with client ID metadata documents, JWT access tokens (`typ: at+jwt`), `resource` bound to `aud`, and a userinfo lookup for new accounts' names. Built in apron-server-go only. | `dee3bde`, `3ae073f`; Go `19403b8`, `a8d4ea1` |
| PLAN_LOOSE over PLAN_MINIMAL | Kept. Without foreign-issuer mode the difference is PKCE, `resource` and `client_id`, which let any client get a redirect safely; PLAN_MINIMAL would type codes instead. | session decision |
| Core and extension split | §4.12 keeps only what every client and server needs: begin, the authorization request, the server's own page, and redemption on the connection. `issuer` stays in core, as the authorization server of `url`. A client with a client ID metadata document SHOULD use its URL as `client_id`. Everything else moves to `ext:oauth`: metadata, the token endpoint, CORS, fetching metadata documents, another authorization server, and library clients. §4.12.4 is now "Redemption". | `39d44e6`, `3ae073f`, `0707b1b` |
| Token endpoint client authentication | `client_id` in the body or as HTTP Basic with an empty password; a request refused before redemption keeps the code usable (x/oauth2's default tries Basic first). | `ext:oauth`; Go `3dc4f6c`, Cloudflare `9b7e828` |
| Protected resource metadata | RFC 9728, naming the authorization server, for MCP-style clients. | `ext:oauth`; Go `627de97` |
| Identity provider | Optional part of `ext:oauth`: another site signs users in through OpenID Connect (`scope=openid`, no `resource`), and gets an ID token and userinfo but no Apron session. A server opts in by publishing its discovery document. Core now refuses a request without `resource`, so a server without it never treats such a request as a sign-in. Not built. | `d049193` |
| Popups and referrer (S1) | The sign-in pages MUST NOT send `Cross-Origin-Opener-Policy` other than `unsafe-none`, and SHOULD send `Referrer-Policy: no-referrer`. §4.12.3's lead-in now says that "the page" means the page at `url` and the passkey page. | `25eba8c` |
| Email | An approval MAY carry the proposal's `state`, so a short code works after a reconnect. Servers that list `email` or `external` MUST list `token`. | `b4dfef2`; Go `f2e44a8`, apron-web `60a1960` |
| Passkey page return | By redirect and code, not a back channel to the begin connection (PLAN_WEBAUTHN_EXTERNAL.md, decision 8). | `a5c88f3` |
| Dependencies | apron-server-go replaces its hand-written foreign-issuer JOSE and OAuth code with go-jose v4 and x/oauth2. go-oidc is left out: it only does OpenID Connect discovery, refetches keys on every unknown key ID, and reads responses without size caps. Code lines in the foreign-issuer files: 483 → 354; 2 direct modules; binary +1.4%. | Go `5c42dc9`…`7102d21` |
| Extensions layout | One file per extension in `extensions/`, EXTENSIONS.md as the index, and `extensions/AGENTS.md` for style. `ext_oauth.md` ends with the references it relies on. | `52ef121`, `2cfea2d`, `ac6beba` |
| S15. Failed redemption | A failed redemption MAY use up the code. Both servers burn a code on some failures (apron-server-go's `Codes.Redeem` on any mismatch; apron-server-cloudflare on any failure), so clients don't retry a code. | §4.12.4, `659f52b` |
| S11. Codes and `resource` | A code whose `resource` is not the server's origin is invalid. This replaces "wrongly addressed", and stops codes from crossing between hosts that share one backend. | §4.12.4, `659f52b` |
| S12. Client ID metadata documents and many origins | A client uses its document's URL as `client_id` only when the document lists the `redirect_uri` that it sends. Elsewhere, such as Previews or localhost, it sends a plain `client_id`, as apron-web does. | §4.12.2, `659f52b` |
| S16. Email `state` details | Left to the server. A client whose approval is `denied` proposes again with a new `state`. apron-server-go lets the newest proposal own a `state`, and denies a `state` that matches no proposal. | no change |
| S13. Orphan passkeys | Both passkey pages can call `signalUnknownCredential` for a passkey that no account has and no unexpired registration holds, behind a switch that is **off by default**. With it off, the page gives the usual error, so it reveals nothing about which passkeys exist. FIXME: keep it off until WebKit [302624](https://bugs.webkit.org/show_bug.cgi?id=302624) and [322267](https://bugs.webkit.org/show_bug.cgi?id=322267) are fixed (on iOS and macOS 26 the call can delete other accounts' passkeys); check again on 2027-02-16; turn it on only where the server is the sole user of its RP ID. Not in PROTOCOL.md. | Go `--webauthn.signal-unknown` (`60f4a72`…`ed1877f`); Cloudflare `SIGNAL_UNKNOWN_PASSKEYS` (`6aae3cc`…`6f6f689`) |
| `redirect_uri` refusal | The server MUST refuse a `redirect_uri` that is not `https`, a scheme with a `.`, or loopback `http`. Before, the spec only said which ones to accept. | §4.12.3, §5.2, `fcfed7e` |
| Conformance | `conform.py` checks sign-in: the passkey page, external, email basics and ext:oauth, without a person, and after sign-in with `--sign-in`. Stable IDs, `--json`, a passkey portal driver, and a client driver followed (PLAN_CONFORMANCE.md, "What was built"). | `3b282cf`…`0dfdebc` |
| apron-web's startup budget | Raised for the startup JS size only, `a4f9220` | apron-web#278 |

Implementations brought in line:

- **apron-server-go** shows errors on the page (`e773491`), and doesn't refuse tokens from codes because of `Origin` (`b5a2f3c`). It leaves `webauthn` out of `signup` with guests off (S17, `135b9c0`), and names new accounts from userinfo (S18, `19403b8`).
- **apron-server-cloudflare** and **apron-web** already matched. apron-web says when a server has the older `external` (`d1888cc`), and hints when a code is refused off its connection (`309aed8`).

### Follow-up: apron-web and email links

apron-web uses an email link with its own proposal's `state` whatever the link's `server` says (`src/lib/ui/sign-in-link.ts`). §4.11.2 says to drop it unless `server` is the server it proposed to; otherwise a server can get another server's token (mix-up). The client driver's `email.A1.link-server` found it. HISTORY.md now lists the rule (`1db9e57`).

### Follow-up: apron-server-go and guests

On apron-server-go, a guest's "Create account" on the passkey page is an addition to the guest. Its code works only on that guest's connection. With popups blocked, the full-page redirect loses that connection, and a guest has no `token` to resume. The user is left with a passkey for no account. [interop F1, F2]

Under M1 this is the server's policy, so the fix belongs in apron-server-go. Either:

- treat a guest's registration as a new account, as apron-server-cloudflare does; or
- return a `token` to a guest that begins an addition on the page.

## Should clarify

These are small, and none made two implementations disagree. S1–S4, S11–S18 are resolved (see "Decisions"). The rest stay out of PROTOCOL.md:

- S5 and S6 are client hints, for RECIPES.md.
- S7, S9 and S10 are about the plan's internals, and have no wire effect.
- S8 is about what the user sees, which §5.2 already covers.

- **S5. Popups and user activation.** [web F3] Begin answers after the tap, so `window.open` may be blocked. Informative note: "A web client can open a window during the tap, before begin answers, and send it to `url` afterwards."
- **S6. An addition after a full-page redirect needs the session back.** [web F12] It works only with a resumable `token`. Informative note.
- **S7. `request` handle lifetime.** [cf F13] The plan's handle is made before the user reads the page. "Expires with the codes" is too short for that. Proposed: "expires within minutes, like a code". apron-server-cloudflare uses 10 minutes for the handle and 5 for a code.
- **S8. Confirmation wording.** [cf F11, go F7, go F8, interop F5, F6, F9, F13] The screens read word for word the same on both servers. Proposed changes:
  - Give "Only continue if you just started signing in on …" its own column. "on An app on this device (com.example.myapp)" reads badly.
  - Let a server's configured first-party origins count as "recognised". apron-server-cloudflare already omits the "not verified" line for them; apron-server-go always shows it.
  - A local web app on `http://127.0.0.1:5173/…` reads as "An app on this device". Showing the host and port would be more useful. Low priority.
  - "Not you?" starts the page's sign-in again. Whether that prompts depends on the identity provider.
- **S9. The State table undercounts the page.** [cf F4] The page's own ceremony spans two HTTP requests. A login code MAY be issued before Allow, if only the page holds it until Allow.
- **S10. "No passkey page" message.** [web F14] "Shows `server.welcome`" fits only screens that render it. Proposed: "points to `server.welcome`, where the client shows it".

- **S19. "The page" when `url` redirects at once.** [conformance] apron-server-go's `url` answers a well-formed request with a 302 to its identity provider. It is unclear whether that response is "the page" that sends `Referrer-Policy` and shows errors.
- **S20. A listed scheme whose every begin is refused.** [conformance] apron-server-go at `127.0.0.1` lists `webauthn` but denies every begin, because the origin is not configured for passkeys. Nothing says whether that breaks "MUST use this exchange". A policy refusal (§1) probably covers it.
- **S21. A new account's code burned by a failed try.** [conformance] A failed redemption MAY use up the code, and a new account is created when its code redeems. A client bug or a retry can then leave a passkey that belongs to no account, which is the S13 case. Clients should redeem a new account's code once, and correctly.
- **S22. Adding `external` when the page's own sign-in makes a new account.** [interop 2026-11-16 #2] On apron-server-cloudflare, a signed-in user who chooses "Create an account" on `/oauth/authorize` gets "That sign-in belongs to another account". §4.12.4 adds an identity that belongs to no account. It is unclear what a new identity means when the authorization server's sign-in is the server's own passkey. The new passkey is then an orphan.
- **S23. A wrong `resource` at the token endpoint.** [interop 2026-11-16 #5] apron-server-go answers `invalid_target` and uses up the code; apron-server-cloudflare keeps it. `ext:oauth` says a request refused "before it redeems the code" leaves the code usable, but not on which side a `resource` mismatch falls. Proposed: a `resource` mismatch is refused before redemption.
- **S24. Origin and tokens from email.** [interop 2026-11-16 #6] apron-server-go refuses an email token from an `Origin` other than the one that got it. §3.2.1 and §4.11 say nothing, unlike §4.10.1 and §4.12.4 for tokens from codes. Possibly fine as policy, but a native client that signs in by email and a web client that resumes would see different results per server.
- **S25. Policy limits on additions.** [conformance] apron-server-go allows one `external` identity per account. §1.1's policy refusals probably cover it, but §4.12.4 states additions without a word on policy.
- **S26. `user.name` in a register begin.** [conformance] §4.10's SHOULD (the begin's `name` for `user.name`) is in tension with WebAuthn, where `user.name` identifies the account. apron-server-cloudflare uses its own handle there, which gives a WARN.
- **S27. Sending a bearer token only to its own server.** [client driver] No rule says that a client sends a token only to the server that issued it; §5.2 only explains copied tokens. Proposed for §3.2.1: "Clients send a bearer token only to the server that issued it."
- **S28. Client rules without key words.** [client driver] Many client rules are plain sentences ("A client drops a link…", "Clients reject any other `url`"). The drivers treat them as requirements, as the server rules are. Worth a line in AGENTS.md, or key words where a rule guards against an attack.
- **S29. A trusted native app's token from its own ceremony.** [recipe review] §4.10 accepts a `token` from a finish with `credential` only on a connection whose `Origin` is the ceremony's origin, but a native app sends no `Origin`, and the spec doesn't say what a native ceremony's origin is (Apple uses the associated domain; Android `android:apk-key-hash:…`). A first-party app that runs the ceremony itself may not be able to resume with that token. Options: say that a native app sends the ceremony's origin as `Origin`, or that such an app uses the passkey page's code (which works from any `Origin`).

## Housekeeping

- **H1.** Drop the `workers-oauth-provider` note from PLAN_WEBAUTHN_EXTERNAL.md and PLAN_LOOSE.md. [cf F1] It needs its own KV binding, mints its own tokens, refuses unknown `client_id`s, and cannot redeem a code on a WebSocket.
- **H2.** Done: #115's description lists the renumbering (§4.11 email, §4.12 external, §4.13 `ext`). [cf F9]

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
| apron-server-go, foreign issuer | ~500 lines | now go-jose + x/oauth2: 354 code lines, with discovery, the `typ`/`cnf` checks, the key throttle and Ed25519 still hand-written |
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

A second run on 2026-11-16 found no regressions, and the orphan-passkey signal worked on both servers. Logs are in the session scratchpad. It ran apron-server-go at `de63fcf`, before the signal became a switch and before passkeys pended from code issue (`ed1877f`), so Go's "signalled at once after a burned code" is now "after up to 7 minutes", like Cloudflare. Still failing: Go's guest registration by full-page redirect (see "Follow-up"). Not run: the https topology with distinct hosts.

Commits from the run:

- **apron-web `479ef40`:** send a registration's code even when the account it began as is gone.
- **apron-server-go `8c8ad5f`:** a durable interop test. The web app creates an account on the passkey page by popup, and signs in by redirect with popups blocked.
