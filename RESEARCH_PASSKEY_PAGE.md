# Research: prior art for the passkey page

Prior art for [PLAN_WEBAUTHN_EXTERNAL.md](PLAN_WEBAUTHN_EXTERNAL.md): a
`webauthn` begin that also returns `external.url`, a passkey page on the
server's own domain. A client that cannot use the RP ID opens the page and
finishes the same exchange with an OAuth-style code. Checked 2026-11-15.
Items marked *(memory)* come from background knowledge and were not checked
for this note.

## Summary

The pattern is well known: run sign-in natively where the platform allows
it, and otherwise send the user through the system browser to an
authorization page that returns a code. RFC 8252 and MSAL's broker fallback
work this way, and so does Sign in with Apple on platforms other than
Apple's. The closest standard is the IETF draft *OAuth 2.0 for First-Party
Applications* (draft-04, July 2026). There, a native challenge flow, which
can include a passkey, ends in an authorization code, and a `redirect_to_web`
error sends the client to an ordinary browser authorization request whose
code goes to the same token endpoint. Apron adds two things that I found
nowhere else as a defined mechanism. The browser branch is pinned to the
same method: a passkey-only page, with the code bound to it. And both
branches live inside one challenge-response scheme. No W3C, WICG, or FIDO
document defines an RP-designated page that completes a ceremony for apps.
The well-known passkey endpoints draft has only `enroll` and `manage`, and
the platforms' delegation mechanisms are gated to browsers and enterprise
allowlists. The security lessons that apply come from consent phishing in
cross-device and device-code flows (RFC 10027, Storm-2372).

## Systems and specs

| System or spec | What it does | Closeness | Borrow or avoid |
|---|---|---|---|
| [OAuth 2.0 for First-Party Apps, draft-04](https://datatracker.ietf.org/doc/draft-ietf-oauth-first-party-apps/) | A native client POSTs to an authorization challenge endpoint, repeatedly (`insufficient_authorization`, `auth_session`), until it gets a code. App. A.1 shows a passkey login. `redirect_to_web` (HTTP 403, §5.2.2.1) tells the client to start "a new authorization code flow" in a browser, through PAR if the response carries a `request_uri`. Both codes go to the token endpoint. | **Similar, and the closest standard** | Borrow: the server may *force* the browser branch on risk (§9.2). Borrow: `request_uri` corresponds to Apron's `request` handle. Note the difference: the draft is for first-party clients only (§1.1, §9.1), and leaves first-party checks to attestation. In Apron, the platform makes that check for the native branch: only apps and origins that the domain vouches for can use the RP ID. |
| RFC 8252 and MSAL with a broker ([MSAL.NET WAM](https://learn.microsoft.com/en-us/entra/msal/dotnet/acquiring-tokens/desktop-mobile/wam), [Entra passkey matrix](https://learn.microsoft.com/en-us/entra/identity/authentication/concept-fido2-compatibility), [FIDO2 in your apps](https://learn.microsoft.com/en-us/entra/identity-platform/support-fido2-authentication)) | MSAL uses the OS broker where one exists, and the system browser otherwise. Entra says third-party MSAL apps without a broker still get passkeys through the system browser or ASWebAuthenticationSession. Fallback behaviour differs by SDK: MSAL Node on Linux does not fall back. | Similar | Borrow: an SDK chooses the branch, and the user sees one "sign in" action. The browser page is a general login page, not a passkey-only one. |
| Sign in with Apple ([other platforms](https://developer.apple.com/documentation/signinwithapple/incorporating-sign-in-with-apple-into-other-platforms), [REST API](https://developer.apple.com/documentation/signinwithapplerestapi)) | The same button is native on Apple platforms. On Android and the web it runs as a web authorization flow on Apple's domain and returns a code. | Similar, in UX | A precedent for one button with two branches. The fallback is limited to the developer's registered Services ID, so it is not open to strangers. |
| ASWebAuthenticationSession and Custom Tabs ([Apple staff, forums](https://developer.apple.com/forums/thread/723273), [Corbado](https://www.corbado.com/blog/native-app-passkeys), [Authsignal](https://docs.authsignal.com/authentication-methods/passkey/prebuilt-ui)) | Apple staff wrote: WKWebView supports passkeys only when the app has associated domains for the RP; "for other relying parties, you can use passkeys in SFSafariViewController or ASWebAuthenticationSession". Vendors with a hosted UI give the same advice. | The enabling fact | This is why the plan works for N3. Avoid embedded webviews: they lack passkeys, and RFC 8252 §8.12 calls them "unsafe for use by third parties". |
| [Auth0 native passkeys](https://auth0.com/docs/native-passkeys-for-mobile-applications) | Native passkey APIs need a custom domain and associated domains (`webcredentials:`). The default `*.auth0.com` domains don't work. Passkeys in Universal Login are a separate, browser path. I found no documented automatic fallback from one to the other. | Related | Shows the same split, but leaves the choice to the app developer. Status: native was Limited Early Access in 2025 sources; current status unverified. |
| [Cirrus PDS (AT Protocol)](https://b217197f-cirrusdocs.ascorbic.workers.dev/guides/passkey-login/) | A third-party PDS whose OAuth authorization page offers "Sign in with passkey" to any AT Protocol OAuth client. Passkeys "do not work outside the OAuth flow", including the Bluesky app's `createSession`. | Similar: a passkey for third-party clients through the server's page | Close to Apron's browser branch, with no native branch. The docs do not describe a consent step (uncertain). This is a preview-domain page for a small project, not Bluesky. |
| Matrix Authentication Service, [PR #4234](https://github.com/element-hq/matrix-authentication-service/pull/4234) | Experimental passkey sign-in on MAS's login page. Still an open draft (opened March 2025, last updated June 2026). | Related | When it ships, Matrix clients get passkeys only through MAS's browser page, with MAS's own consent screen. Matrix has no native passkey path. |
| [rest-mail-server #1331](https://github.com/rest-mail/rest-mail-server/issues/1331) | An open design issue (October 2026): a passkey ceremony on each install's own origin, opened from the mobile app in ASWebAuthenticationSession or Custom Tabs, with a one-time code back to the app. It rejected native APIs, because they tie passkeys to domains built into the app. | Similar, independent | The same reasoning for self-hosted domains, for first-party apps only. Not built. |
| [GitHub passkey sign-in](https://docs.github.com/en/authentication/authenticating-with-a-passkey/signing-in-with-a-passkey), [device flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps) | `github.com/login?passkey=true` opens the general login page set to passkey. CLIs use the device flow or a browser redirect. | Related | A query parameter that picks the method on a general page, much like `action=` in `external.url`. Unverified whether `gh` or `/login/device` can route to it. |
| [Tailscale passkeys](https://tailscale.com/kb/1269/passkeys) | Passkeys as a beta identity option on the login page. `tailscale up` signs in through a browser *(memory)*. | Related | A general login page with passkeys; nothing specific to the CLI. |
| FIDO hybrid (CTAP 2.2), described in [RFC 10027 §6.2.3](https://www.rfc-editor.org/rfc/rfc10027.html) | A phone acts as a roaming authenticator for a nearby client. BLE proves proximity. | Related | It does not relax the RP ID check on the requesting side, so it does not help third-party apps. It does work inside the passkey page, for example on a desktop without a local passkey. |
| [`remoteDesktopClientOverride` / `remoteClientDataJSON`](https://microsoftedge.github.io/MSEdgeExplainers/WebAuthnRemoteClientDataJSON/explainer.html) ([w3c/webauthn#2375](https://lists.w3.org/Archives/Public/public-webauthn/2026Feb/0003.html)) | Lets a remote-desktop origin run a ceremony for another RP. The old extension exists only in Chromium; its successor is proposed to the W3C. Each origin needs explicit authorization by enterprise policy or a flag, and the explainer says user agents "MUST NOT grant this permission globally". | Related | Platforms keep "act for another RP" behind allowlists. Not usable by ordinary clients. |
| [Android privileged apps](https://developer.android.com/identity/sign-in/privileged-apps); Apple's web-browser passkey entitlement *(memory)* | Browsers can set the origin of a request for any site, but only if the credential provider allowlists them (package name and signing certificate). | Related | The same point: delegation is for vetted browsers. |
| WebAuthn L3 cross-origin iframes ([W3C Rec, 25 Aug 2026](https://www.w3.org/TR/webauthn-3/), §7.2, §13.4.9); [Secure Payment Confirmation](https://www.w3.org/TR/secure-payment-confirmation/) | An RP page embedded in a cross-origin iframe may run `get()`. Client data then carries `crossOrigin` and `topOrigin`, which the RP "MUST validate". SPC lets a merchant run the ceremony for a bank's RP ID, if the bank opted in when it created the credential. | Related (web only) | A frame could stand in for the popup for W3 clients, but WebKit is "extremely concerned about the confusing UI this kind of delegation necessitates" ([WebKit #304](https://github.com/WebKit/standards-positions/issues/304)), and consent inside a frame invites clickjacking. Keep refusing frames. |
| [Passkey endpoints well-known URL](https://w3c.github.io/webappsec-passkey-endpoints/) (Editor's Draft, January 2026) | `/.well-known/passkey-endpoints` with `enroll`, `manage`, and `prfUsageDetails`: pages for password managers to link to. | Related | No endpoint for completing a ceremony. I found no proposal for one. |
| [OpenID Connect EAP ACR Values 1.0](https://openid.net/specs/openid-connect-eap-acr-values-1_0.html) (final, June 2025); [Okta step-up](https://developer.okta.com/docs/guides/step-up-authentication/main/) | `acr_values=phr` / `phrh` asks for phishing-resistant authentication at a general authorization server. Okta: "currently, only Passkey (FIDO2 WebAuthn) satisfies this requirement." | Related | The standard knob for "passkey only" when the page is a general OAuth or OIDC server. |
| [Okta FastPass](https://www.okta.com/blog/identity-security/phishing-resistance-in-unmanaged-ios-devices/) | The login page hands off to the Okta Verify app. A loopback server checks the Origin. Okta says universal links and custom schemes alone "do not provide the same level of phishing protection". | Related (the reverse direction) | App schemes and app links don't identify the caller. This supports the plan's "An app on this device" and its rule to always ask. |
| Device grant and QR linking: [RFC 8628](https://www.rfc-editor.org/rfc/rfc8628), Matrix [MSC4108](https://github.com/matrix-org/matrix-spec-proposals/pull/4108) (open; MAS has the device grant since v0.8.0), Signal, WhatsApp, Discord QR *(memory; see PRIOR_ART.md)* | The user approves on a trusted device, and the waiting device receives the session. | Related | The flows where consent phishing works best. The plan already declines a device grant. |
| Mastodon *(memory, unverified)* | WebAuthn only as a second factor; OAuth sign-in through the instance's web page. | Related | — |

## Closest matches

**OAuth 2.0 for First-Party Applications.** It has the same shape as the
plan. A native path ends in a code, and a defined fallback (`redirect_to_web`)
sends the user to the browser, where another code goes to the same
redemption endpoint. Three differences matter:

- **Who may use the native path.** The draft restricts it to first-party
  clients because a native prompt can be faked (§9.2: "it is more
  complicated to teach users how to recognize other fake login prompts").
  Apron's native branch is a platform passkey prompt, and the platform
  allows it only for clients that the domain vouches for. So Apron gets the
  draft's first-party condition for free.
- **The server can force the browser.** Under §9.2, the server "MAY decide
  to require that the user go through a redirect-based flow". The plan
  always sends `public_key`.
- **The fallback is generic in the draft.** The browser fallback is any
  authorization request, so the user may meet a different method there. The
  plan pins it to passkeys, and binds the code to the passkey page.

**MSAL and Sign in with Apple.** Both are shipped versions of "native if you
can, browser otherwise", behind one button. Neither pins the browser page to
one method. They show that users accept the trip to the browser when it is
a sign-in sheet (ASWebAuthenticationSession or a Custom Tab), not a
context switch.

**Consent phishing ([RFC 10027](https://www.rfc-editor.org/rfc/rfc10027.html), BCP 247, August 2026; [Storm-2372](https://www.microsoft.com/en-us/security/blog/2025/02/13/storm-2372-conducts-device-code-phishing-campaign/)).**
The attacker starts a real flow and gets the victim to approve it on the
real site. In RFC 10027's words, these attacks "are effective even when
multi-factor authentication is deployed". For the plan, the attacker's
client calls begin and mails the victim a passkey-page link with the
attacker's `redirect_uri`. The victim sees the real domain and a real
passkey prompt, which makes the lure *more* convincing, and approves. The
`redirect_uri` and PKCE ensure that the code reaches only the client that
started the flow. The defence is the page's statement of *who* receives the
session. Lessons:

- RFC 10027 §6.1.14: tell users to decline requests they did not start or
  expect.
- On February 14, 2025, Microsoft reported that Storm-2372 had switched to a
  trusted first-party client ID (the Microsoft Authentication Broker). A
  "recognised client" that is keyed on a client ID anyone can claim
  becomes a target.
- RFC 8252 §8.6: no automatic approval "except when the identity of the
  client can be assured".
- RFC 10027 says to avoid cross-device flows whose risks can't be
  mitigated. This supports the plan's decision against a device grant.

## Recommendations

1. **Change the plan.** Add a line to Screen 1, from RFC 10027 §6.1.14:
   "Only continue if you just started signing in on **chat.alice.dev**."
   The real passkey prompt lends the page credibility that a phishing link
   can borrow.
2. **Change the plan.** Define "recognises" (it controls the
   "not verified" line, here and in PLAN_LOOSE.md) by an `https`
   `redirect_uri` or a claimed `https` app link that the server has
   registered, never by `client_id` alone. Never treat app-scheme or
   loopback redirects as recognised (RFC 8252 §8.6, Storm-2372's switch to
   a trusted client ID).
3. **Change the plan.** On the passkey page, reject assertions whose client
   data has `crossOrigin: true` or a `topOrigin`, besides
   `frame-ancestors 'none'`. WebAuthn L3 §13.4.9 gives this check for apps
   that should not be embedded.
4. **Change the plan (optional).** Let a begin result that carries
   `external` omit `public_key`, so that a server can require the page on
   risk, as in First-Party Apps §9.2 and `redirect_to_web`. Clients then use
   `public_key` "when present".
5. **Note only.** In §5.2, cite First-Party Apps as the closest standard,
   and say what differs: the fallback is pinned to passkeys, and the
   platform enforces which clients may use the native branch.
6. **Note only.** Give RFC 8252 §8.12, and the lack of passkeys in
   WKWebView without associated domains, as the reason for the plan's
   rule: "the system browser or a sign-in session, never an embedded
   webview".
7. **Note only.** The plan's decision against a device grant is consistent
   with RFC 10027 and the device-code phishing record. Keep it.
8. **Note only.** If the passkey page is built on a general OAuth or OIDC
   server, `acr_values=phr` (and checking `acr` or `amr` on the result) is
   the standard way to require a passkey. GitHub's `?passkey=true` shows a
   lighter version on a general login page.
9. **Note only.** A server MAY also publish `/.well-known/passkey-endpoints`
   with `enroll` and `manage`. That draft is unrelated to the ceremony, and
   is still an Editor's Draft.
10. **No action.** Platform delegation (`remoteClientDataJSON`, Android
    privileged apps, cross-origin iframes, SPC) is gated by allowlists or by
    an RP opt-in for payments, and does not serve third-party chat clients.
    Hybrid needs nothing from Apron: it works inside the page.
