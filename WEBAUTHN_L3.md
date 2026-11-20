# WebAuthn Level 3 and Apron

Local note, not committed (in `.git/info/exclude`). Written 2026-11-11. It
checks [PROTOCOL.md](PROTOCOL.md) §4.10 and §5.2 against W3C Web
Authentication Level 3, and re-checks the assumptions in
[EVALUATIONS.md](EVALUATIONS.md) and [PLAN_OAUTH.md](PLAN_OAUTH.md).

## Summary

**Status.** WebAuthn Level 3 is a **W3C Recommendation** dated 25 August 2026
([REC](https://www.w3.org/TR/2026/REC-webauthn-3-20260825/)). It follows the
Candidate Recommendation of 26 May 2026, and the REC says there were no
substantive changes since. There is also an
[implementation report](https://www.w3.org/2026/06/wpt-webauthn-2026-06-26.html).
The [editor's draft](https://w3c.github.io/webauthn/) has already moved on.
It adds a `remoteClientDataJSON` extension, which is gated by enterprise
policy, and a rule that authenticator outputs never carry cleartext PRF
results. Neither one matters for Apron.

**Bottom line.** §4.10 is still sound, and so is the client's RP ID check.
Nothing in L3 lets a stranger's native app or web frontend use a server's
passkeys, so `external` is still the fallback. One assumption is out of date:
**Firefox now supports related origin requests.** It is on by default in
release 160, with a confirmation prompt on each request. Every engine caps the
list at 5 labels. The most useful changes are small tightenings of §4.10, not
new features.

### Recommendations

Kinds:
- **Wire:** a change to the frames, or a new normative rule. It needs a
  HISTORY.md entry. The v10 RP ID check had one.
- **Server guidance** and **client guidance:** advice to implementers. These
  go in the docs, or as non-normative text.

| # | Recommendation | Kind |
|---|---|---|
| 1 | **Servers that share an RP ID share their accounts**, with one user handle (`user.id`) for each account. An authenticator keeps one passkey for each pair of RP ID and user handle, so this is the model in which a shared RP ID is safe: a user on one server is the same user, with the same handle, on the others. It replaces §5.2's "trust each other". Server guidance: keep the handle when `user_id` changes, and make it random, as WebAuthn recommends; server.apron.chat already uses 16 random bytes. | Wire (rule) |
| 2 | **Define `credential`** as the L3 JSON form that `toJSON()` returns (`RegistrationResponseJSON` or `AuthenticationResponseJSON`). Define `public_key` as the input of `parseCreationOptionsFromJSON` or `parseRequestOptionsFromJSON`. Today §4.10 never says what `credential` looks like. | Wire (clarified) |
| 3 | **Require the RP ID in `public_key`** (`rp.id` or `rpId`). Then drop "or the client's own domain". Also exclude public suffixes from "a domain that the host is under". | Wire (rule) |
| 4 | **Clients remove `prf` and `largeBlob`** from `public_key`. `toJSON()` puts PRF outputs into `credential`, so a server that passes the RP ID check could collect secrets that the user's other apps derive from the same passkey. | Wire (rule, SHOULD) |
| 5 | **Fix the docs:** Firefox supports related origins. Update the EVALUATIONS trace for `webauthn` W3, PRIOR_ART, and NOTES. Note Firefox's prompt and the 5-label cap in every engine. Add a caveat to the recover cell for synced passkeys. | Docs only |
| 6 | Server guidance: put the user's handle in `user.name` and the display name in `user.displayName`. Set `rp.name` to the RP ID (it is deprecated). Send `excludeCredentials` when a passkey is added. Use the L3 timeout of 5 minutes, and keep each challenge until its timeout. Store the BE and BS flags. Ask users whose only passkey is single-device to add another scheme. Reject `crossOrigin` ceremonies unless you expect to be embedded. | Server guidance |
| 7 | Client guidance: use the L3 JSON helpers, with a fallback encoder. Use `getClientCapabilities()` to choose a scheme. Treat a `SecurityError` on another domain's RP ID as "use `external`". Handle conditional get: abort it before a new begin step, and begin again when it expires. | Client guidance |
| 8 | **Signal API: defer.** A design is sketched below: an optional `signal` field on a verified finish result. Wait until Apple fixes its bugs that delete other accounts' passkeys ([302624](https://bugs.webkit.org/show_bug.cgi?id=302624), [322267](https://bugs.webkit.org/show_bug.cgi?id=322267)), and until Apron has a way to remove passkeys. Never use | Wire, deferred |
| 9 | **Do not adopt:** conditional create for guest upgrades, which needs a saved password and conflicts with required user verification. Also skip hints, cross-origin iframes, `credProps`, attestation, and `remoteClientDataJSON`. | — |

## Assumptions re-checked

### Related origins across browsers

| Engine | Support | Limit | Notes |
|---|---|---|---|
| Chrome, Edge | 128+ | 5 labels | [web.dev](https://web.dev/articles/webauthn-related-origin-requests), [passkeys.dev](https://passkeys.dev/device-support/) |
| Safari | macOS 15+, iOS 18+ | not documented | [passkeys.dev](https://passkeys.dev/device-support/). Every browser on iOS uses WebKit. passkeys.dev knows of no client that allows more than 5. |
| Firefox | 152+ per [passkeys.dev](https://passkeys.dev/device-support/), updated 2026-09-21 | 5 labels (`kMaxLabels = 5`) | See below. |

- In the Firefox 160 release source, `security.webauthn.related_origin_requests_mode`
  defaults to `2`, which means enabled with a prompt
  ([StaticPrefList.yaml](https://github.com/mozilla-firefox/firefox/blob/release/modules/libpref/init/StaticPrefList.yaml)).
- The prompt says "{origin} wants to use a passkey for {rpId}", and the user
  must press Continue
  ([WebAuthnRelatedOriginFetcher.sys.mjs](https://searchfox.org/firefox-main/source/dom/webauthn/WebAuthnRelatedOriginFetcher.sys.mjs)).
- `getClientCapabilities()` reports `relatedOrigins: true`
  ([PublicKeyCredential.cpp](https://github.com/mozilla-firefox/firefox/blob/release/dom/webauthn/PublicKeyCredential.cpp)).
- ESR 140 does not have it.
- MDN's Firefox 152 release notes do not mention it. The ship version therefore
  comes from passkeys.dev, and the "on by default" claim comes from the
  release-branch source.
- web.dev still says "Firefox is still considering" (January 2026). That is
  out of date.

The limit counts labels, not origins. A label is the registrable domain
without its suffix, such as `apron` for `web.apron.chat` and `apron.co.uk`
together, and only the first five labels in the file count
([§5.11.1](https://www.w3.org/TR/webauthn-3/#sctn-validating-relation-origin)).
So any number of frontends under one registrable domain cost one label. Five
independent self-hosted frontends use up the list.

**What this means for Apron.** W3 through related origins now works in all
three engines. It is still only for a few frontends that the operator
blesses, and R4 is unchanged: listing a frontend is trusting it.

Update EVALUATIONS.md as follows:
- Trace "`webauthn`, W3": replace "Firefox does not support related origins
  yet" with "all three engines, 5 labels; Firefox asks the user on each
  request".
- Grid, `webauthn` W3: becomes "⚠️ related origins only (≤5 labels);
  otherwise ✗⁴". `external` is still the general path.
- PRIOR_ART.md line 60 ("Chrome and Safari support it") and NOTES.md line 41
  ("check Firefox") need the same update.

### Native apps and another domain's passkeys

Nothing has changed. A third-party native app still cannot use a server's
passkeys in a sanctioned way.

- **Apple:** an app needs the `webcredentials:` associated domain, and the
  RP ID's `apple-app-site-association` must list the app. Only the domain's
  owner can grant that. The browser entitlement is only for browsers. Related
  origins is a web-only feature
  ([passkeys.dev](https://passkeys.dev/docs/advanced/related-origins/)).
- **Android:** an app needs Digital Asset Links on the RP ID. An app that sets
  `origin`, as browsers do, needs `CREDENTIAL_MANAGER_SET_ORIGIN`, Android 14
  or later, and a place on each credential provider's list of privileged
  callers. For Google Password Manager, that means an application form
  ([Android docs](https://developer.android.com/identity/sign-in/privileged-apps)).
  That is coordination between strangers, so it fails U1.
- **Desktop, uncertain:** Windows' `webauthn.dll` takes a `clientDataJSON`
  that the calling app builds
  ([Unit 42](https://unit42.paloaltonetworks.com/webauthn-added-to-browser-based-rdp/)),
  and CTAP libraries can use any RP ID with security keys. So a desktop app
  can technically run a ceremony for any RP ID and claim any origin. This is
  not a supported path. It also makes origin binding meaningless (F4). It is
  the reason the client's RP ID check matters outside browsers.
- **The origin that native apps report:** iOS apps report `https://` plus the
  RP ID, so the server sees the same origin as a web page. Android apps
  report `android:apk-key-hash:…`
  ([Corbado](https://www.corbado.com/blog/webauthn-origin-validation-native-apps),
  secondary source). For N1 on iOS, a token bound to the origin cannot be
  told apart from a web token. That is consistent with F4.

### The client's RP ID check under L3

It is still correct, and L3 makes it more necessary.

- A browser only relates the RP ID to the calling page's own origin, or to a
  related origin that the RP ID lists
  ([§5.1.3](https://www.w3.org/TR/webauthn-3/#sctn-createCredential),
  [§5.11](https://www.w3.org/TR/webauthn-3/#sctn-related-origins)). It never
  relates the RP ID to the Apron server that sent the options.
- Related origins let a page run ceremonies for an RP ID outside its own
  domain. For web.apron.chat, that is any server under `apron.chat` that
  lists it. So the relay in NOTES.md, where a malicious server uses a shared
  frontend, still needs the Apron check.
- The Signal API validates `rpId` the same way as ceremonies
  ([§5.1.10.1](https://www.w3.org/TR/webauthn-3/#abstract-opdef-asynchronous-rp-id-validation-algorithm)).
  So if Apron adds signals (R8), the client must apply the same check to
  them.

There are two gaps, and R3 closes both:
- **Public suffixes.** "A domain that the host is under" includes public
  suffixes, such as `pages.dev` for `alice.pages.dev`. Browsers reject a
  public suffix as an RP ID, but a native or CTAP client does not.
- **Missing RP ID.** "The client's own domain" means nothing to a native
  client. On the web, under related origins, it makes the RP ID the
  frontend's domain. That is the coupling which NOTES.md set out to remove.

IP-address hosts cannot be RP IDs in WebAuthn, so such servers cannot offer
`webauthn` to browsers. No rule is needed for them.

## Feature by feature

Support data comes from MDN
[browser-compat-data](https://github.com/mdn/browser-compat-data) (`api/PublicKeyCredential.json`,
`api/CredentialsContainer.json`, fetched 2026-11-11) unless another source is
given. "?" means the sources disagree, or there is no data.

### JSON helpers: `parseCreationOptionsFromJSON`, `parseRequestOptionsFromJSON`, `toJSON()`

- **What:** static helpers that turn
  [options JSON](https://www.w3.org/TR/webauthn-3/#sctn-parseCreationOptionsFromJSON)
  into options objects, and
  [`toJSON()`](https://www.w3.org/TR/webauthn-3/#dom-publickeycredential-tojson),
  which returns `RegistrationResponseJSON` or `AuthenticationResponseJSON`.
  Binary fields are base64url, and `clientExtensionResults` is included.
- **Support:** Chrome 129, Firefox 119, Safari 18.4.
  Password-manager extensions, such as 1Password and Bitwarden, have shipped
  wrapped credentials whose `toJSON()` throws or drops buffers
  ([1Password community](https://www.1password.community/discussions/1password/issues-with-publickeycredential-tojson-and-passkeys/158327)).
- **Android Credential Manager** takes the request JSON as is
  (`requestJson`). **iOS** `ASAuthorization` needs its fields mapped by hand.
- **For Apron (R2):** §4.10 already links the JSON form of the options. It
  never defines `credential`. The schema has `"type": "object"`, and the
  fixture case `credential_is_browser_json` assumes the browser's JSON. The
  fixture's register credential is missing members that
  `RegistrationResponseJSON` requires (`authenticatorData`, `transports`,
  `publicKeyAlgorithm`, `clientExtensionResults`). Fix it when the rule
  lands.

Current text:

> `public_key` holds creation options for a registration, or request options for a
> login. It uses standard
> [WebAuthn JSON](https://www.w3.org/TR/webauthn-3/#sctn-parseCreationOptionsFromJSON),
> with binary fields as unpadded base64url. Clients pass it to
> `navigator.credentials.create` or `.get`, and return the credential in `finish`.

Proposed:

> `public_key` holds creation options for a registration, or request options for a
> login, in
> [WebAuthn JSON](https://www.w3.org/TR/webauthn-3/#sctn-parseCreationOptionsFromJSON)
> with binary fields as unpadded base64url. Browsers read it with
> `PublicKeyCredential.parseCreationOptionsFromJSON` or
> `.parseRequestOptionsFromJSON`. `credential` is the result in the same JSON
> form, as [`toJSON()`](https://www.w3.org/TR/webauthn-3/#dom-publickeycredential-tojson)
> returns it.

HISTORY line: "Clarified: `credential` is WebAuthn's JSON form of the result, as
`toJSON()` returns it (§4.10)."

Client guidance (R7): keep a small fallback encoder for Safari before 18.4,
and for wrapped credentials whose `toJSON()` throws.

### Related origin requests

Covered [above](#related-origins-across-browsers). §4.10's intro already
describes them correctly. Clients can read
`getClientCapabilities().relatedOrigins` and still have to handle
`SecurityError`, because a client cannot know whether the RP ID's file lists
its origin. A `server` field that lists the allowed origins would let clients
hide the passkey button. It is not worth the wire: a failed `get` is cheap,
and `external` is the next step.

### Hints (`security-key`, `client-device`, `hybrid`)

- **What:** an ordered UI preference for the browser
  ([§5.8.8](https://www.w3.org/TR/webauthn-3/#enum-hints)).
- **Support:** Chrome 128. Safari no, per BCD. Firefox: the field is in its
  WebIDL, and passkeys.dev lists 128+; whether the field has any effect there
  is uncertain.
- **For Apron:** this does not matter. Servers MAY send hints, and clients
  pass them through.

### Conditional mediation for get (autofill)

- **What:** `mediation: "conditional"` offers passkeys in autofill for an
  `autocomplete="username webauthn"` field. Its timer is infinite
  ([§5.1.4](https://www.w3.org/TR/webauthn-3/#sctn-getAssertion)).
- **Support:** Chrome 108, Safari 16, Firefox 119 on desktop. Firefox on
  Android reports `conditionalGet: false`.
- **For Apron, client guidance (R7):** a conditional `get` holds the pending
  login ceremony while the sign-in screen is open, but §4.10 challenges
  expire, and a new begin step replaces the pending one. So:
  - Clients abort the conditional `get` before they send another begin step,
    such as a register.
  - Clients start again with a new begin step when the challenge expires, or
    when the connection drops.
  - Servers keep a challenge at least until the `timeout` they send.

  No wire change is needed.

### Conditional create (automatic passkey upgrades)

- **What:** `mediation: "conditional"` on `create`, which makes a passkey
  without a modal when the browser already has the user's consent.
- **Support:** Chrome 136 on desktop and 142 on Android. Safari 18. Firefox
  no (`conditionalCreate: false` in release 160).
- **Chrome's condition:** the user signed in recently with a password that
  Google Password Manager saved for the site. Magic links and federated
  sign-in do not count. The response has the UP and UV flags clear
  ([Chrome docs](https://developer.chrome.com/docs/identity/webauthn-conditional-create)).
  L3 throws `ConstraintError` if UV is required and cannot be collected
  ([§5.1.3](https://www.w3.org/TR/webauthn-3/#sctn-createCredential)).
- **For Apron (R9):** it does not help guest-to-account upgrades. Guests have
  no saved password, and §4.10 requires user verification. A guest upgrade
  stays an explicit `register` on the signed-in connection, which §4.10
  already allows. Keep "Both actions require user verification."

### `getClientCapabilities()`

- **What:** a record of capabilities, such as `conditionalCreate`,
  `conditionalGet`, `hybridTransport`, `passkeyPlatformAuthenticator`,
  `relatedOrigins`, and the three signal methods, plus `extension:*` keys
  ([§5.1.7](https://www.w3.org/TR/webauthn-3/#sctn-getClientCapabilities)).
- **Support:** Chrome 133, Firefox 135, Safari 17.4.
- **For Apron, client guidance (R7):** use it to order the sign-in options:
  - Offer `webauthn` first when `passkeyPlatformAuthenticator` or
    `hybridTransport` is true.
  - On a domain outside the RP ID without `relatedOrigins`, go straight to
    `external` or `email`.

  It replaces the older `isUserVerifyingPlatformAuthenticatorAvailable` and
  `isConditionalMediationAvailable` probes.

### Signal API

- **What:** three methods
  ([§5.1.10](https://www.w3.org/TR/webauthn-3/#sctn-signal-methods)), whose
  promises tell the page nothing:
  - `signalUnknownCredential({rpId, credentialId})`: the server does not know
    this credential.
  - `signalAllAcceptedCredentials({rpId, userId, allAcceptedCredentialIds})`:
    the provider hides or removes this user handle's passkeys that the list
    leaves out.
  - `signalCurrentUserDetails({rpId, userId, name, displayName})`: the
    provider updates the account's labels.

  The `rpId` passes the same validation as a ceremony, related origins
  included.
- **Support:** Chrome 132 on desktop
  ([Chrome docs](https://developer.chrome.com/docs/identity/webauthn-signal-api);
  later on Android, unconfirmed). Safari 26. Firefox no. Native: iOS 26 has
  `ASCredentialUpdater`, and 26.2 has `ASCredentialDataManager`. Android 15+
  has `androidx.credentials` 1.6
  ([Android docs](https://developer.android.com/identity/credential-manager/signal-api-rp)).
- **Known bugs:** on iOS and macOS 26, `signalUnknownCredential` and
  `signalAllAcceptedCredentials` can delete passkeys of *other* accounts on
  the same RP ID. Both WebKit bugs are open:
  [302624](https://bugs.webkit.org/show_bug.cgi?id=302624), reported
  2025-11-16, and [322267](https://bugs.webkit.org/show_bug.cgi?id=322267),
  which covers iOS 26.0.1 to 26.6.1. The reporter of 322267 says
  `signalCurrentUserDetails` is not affected.

**Can a server tell clients that a passkey was removed?** Only through a
client whose origin may use the RP ID: the first-party web client, a
related origin, or an associated native app. A third-party client cannot
signal for the server's RP ID, for the same reason that it cannot run the
ceremony.

**Shared RP IDs.** Under R1, servers that share an RP ID share their
accounts, so every one of them knows every credential on the RP ID. A
credential that one server does not know is unknown to all of them, and
`signalUnknownCredential` is safe. The other two methods are keyed by user
handle, which the servers also share. Apple's bug is the only hazard left.

**Design sketch, deferred (R8).** Revisit it when the Apple bugs are fixed and
Apron has a way to remove passkeys. Sessions mostly resume with `token`, so
passkey logins are rare, and so are the chances to signal.

```ts
class AuthResult {
  // ...
  // "webauthn" scheme, finish step
  signal?: object;   // AllAcceptedCredentialsOptions and CurrentUserDetailsOptions, in WebAuthn JSON
}
```

> - A verified finish result MAY carry `signal`, with the ceremony's `rpId`,
>   the account's user handle as `userId`, every credential ID of the account
>   as `allAcceptedCredentialIds`, and `name` and `displayName`.
> - Clients use `signal` only if its `rpId` is the RP ID of the ceremony, and
>   its `userId` is the user handle of the credential.
> - Clients then pass it to `signalAllAcceptedCredentials` and
>   `signalCurrentUserDetails`.
> - Servers never ask clients to signal an unknown credential (a credential
>   that one server does not know can belong to another server under the
>   same RP ID).

### Backup eligibility and backup state (BE, BS)

- **What:** authenticator data flags. BE (bit 3) is fixed when the passkey is
  made. BS (bit 4) tells whether the passkey is backed up now
  ([§6.1.3](https://www.w3.org/TR/webauthn-3/#sctn-credential-backup)). L3
  RECOMMENDS that relying parties store both in the
  [credential record](https://www.w3.org/TR/webauthn-3/#credential-record).
- **Support:** set by the authenticator. Synced providers set BE=1, and
  security keys set BE=0. Registration requires `BS ⇒ BE`.
- **For Apron, server guidance (R6):**
  - Store BE and BS.
  - When an account's only credential is single-device (BE=0), encourage the
    user to add another scheme, as §3.2.1 does for a token. That fits
    `welcome` or a `~private` notice. No wire change is needed.
  - In EVALUATIONS, the `webauthn` recover cell can say: "a synced passkey
    (BS=1) survives device loss; account recovery is still another passkey,
    `email`, or `external`".

### `credProps`

- **What:** a registration output, `rk`, which says whether the credential is
  discoverable ([§10.1.3](https://www.w3.org/TR/webauthn-3/#credprops)).
- **Support:** Chrome 89, Firefox 119, Safari no.
- **For Apron:** this does not matter. `residentKey: "required"` already
  fails registration when the passkey cannot be discoverable.

### PRF

- **What:** 32-byte PRF outputs for each credential, at chosen inputs, meant
  for client-side encryption keys
  ([§10.1.4](https://www.w3.org/TR/webauthn-3/#prf)). `toJSON()` includes
  `clientExtensionResults.prf.results`, and the spec warns that it may be
  necessary to omit them before the credential goes to a server.
- **Support:** Chrome 116. Firefox 139. Safari 18 for create; BCD lists no
  Safari support for get, which is doubtful.
- **For Apron (R4):** Apron has no end-to-end encryption, so it has no use for
  PRF. The risk: a server that passes the RP ID check can put `prf.eval` into
  `public_key`, and receive outputs that another app on that RP ID uses as a
  key. For example, `chat.example.com` asks for the RP ID `example.com`. A
  page on `chat.example.com` could already do this in a browser
  ([§13.4.8](https://www.w3.org/TR/webauthn-3/#sctn-code-injection)), so the
  new exposure is mainly native clients and clients on related origins. The
  rule is cheap.

### largeBlob

- **What:** small opaque data stored with the credential, which a relying
  party can read and write
  ([§10.1.5](https://www.w3.org/TR/webauthn-3/#largeblob)).
- **Support:** Chrome 113 (not Android). Firefox 139. Safari 17 for create.
- **For Apron (R4):** it has the same exposure as PRF, since a read returns
  the blob in `credential`. Remove it too.

Proposed rule for R4, in §4.10:

> - Clients SHOULD remove the `prf` and `largeBlob` extensions from
>   `public_key` (their outputs can be secrets of the user's other apps on the
>   RP ID, and `credential` would send them to the server).

### Cross-origin iframes and `topOrigin`

- **What:** with `allow="publickey-credentials-get"` or
  `allow="publickey-credentials-create"`, a cross-origin iframe can run
  ceremonies ([§5.10](https://www.w3.org/TR/webauthn-3/#sctn-iframe-guidance)).
  Create needs transient activation. The client data then carries
  `crossOrigin: true` and
  [`topOrigin`](https://www.w3.org/TR/webauthn-3/#dom-collectedclientdata-toporigin),
  which relying parties MUST validate
  ([§13.4.9](https://www.w3.org/TR/webauthn-3/#sctn-validating-origin)).
- **Support:** get works in Chrome 84 and Firefox 118; Safari is uncertain.
  Create works in Firefox 123. Chrome's
  [Intent to Ship](https://groups.google.com/a/chromium.org/g/blink-dev/c/Sq2WAVbPz6g)
  says it ships, but [web.dev](https://web.dev/articles/webauthn-within-iframe)
  lists no support. Safari does not support create. Firefox does not send
  `topOrigin`: it is commented out in its WebIDL.
- **For Apron:** a server could host a passkey page that any web frontend
  embeds, as an alternative to related origins for W3. Recommendation R9 is
  not to define it:
  - It is an `external`-like page without OAuth's consent and PKCE.
  - It does not help native clients.
  - Safari does not support it.
- **Server guidance (R6):** an Apron web client that is embedded as a widget
  produces `crossOrigin` ceremonies. Servers reject them unless they expect
  the embedding page. §4.10's "MUST perform WebAuthn verification" already
  requires the `topOrigin` check.

### Attestation changes

- **What changed:**
  - With `attestation: "none"`, the AAGUID is no longer zeroed.
  - `attestationFormats` was added, and so was the compound format.
  - SafetyNet is deprecated.
  - `rp.name` is deprecated, and relying parties MAY set it to the RP ID
    ([§5.4.1](https://www.w3.org/TR/webauthn-3/#dom-publickeycredentialentity-name),
    [changes](https://www.w3.org/TR/webauthn-3/#changes-l3-substantive)).
- **For Apron, server guidance (R6):**
  - Keep `attestation: "none"`, because small groups gain nothing from
    attestation.
  - Servers MAY label passkeys by AAGUID, such as "iCloud Keychain" in a
    passkey list.
  - Set `rp.name` to the RP ID. The fixture uses `"Apron"`, which is harmless.

### User entity: `user.id`, `user.name`, `user.displayName`

- **What:** an authenticator stores at most one discoverable credential for
  each pair of RP ID and user handle, and a new registration with the same
  pair overwrites the old one
  ([§4](https://www.w3.org/TR/webauthn-3/#user-handle),
  [§5.4.3](https://www.w3.org/TR/webauthn-3/#dom-publickeycredentialuserentity-id)).
  The user handle MUST NOT contain personal information, and 64 random bytes
  are RECOMMENDED
  ([§14.6.1](https://www.w3.org/TR/webauthn-3/#sctn-user-handle-privacy)).
  `user.name` is "the primary value displayed to users" to tell accounts
  apart.
- **For Apron (R1):** this is not new in L3. It decides what a shared RP ID
  means. Apron lets several servers share one, since the RP ID check allows a
  parent domain. If they kept separate accounts, an "ada" on
  `chat.example.com` and an "ada" on `dev.example.com` could get the same
  handle, and one registration would replace the other's passkey. If they
  share their accounts, it is the same Ada, and nothing collides.
- Sharing accounts is already the effect of sharing an RP ID: any server
  under it can relay a ceremony for the others (§5.2), so each can sign in
  the others' users. R1 states that as the model.
- server.apron.chat already uses a random 16-byte handle for each account,
  and reuses it when a passkey is added (`randomBase64Url(16)` in
  apron-server-cloudflare's `src/auth.ts`).

Proposed rule, in §4.10, after "Registration MUST require discoverable
credentials.":

> - Servers that share an RP ID MUST share their accounts, with one user
>   handle (`user.id`) for each account (an authenticator keeps one passkey
>   for each RP ID and user handle).

Server guidance: keep an account's handle when its `user_id` changes, and
make it random, as WebAuthn recommends for privacy.

**Server guidance (R6):**
- Use "@`user_id`", or the account's handle on the server, for `user.name`.
  Where several servers share the RP ID, add the server's host.
- Use the requested `name` for `user.displayName`.
- This needs a change to the existing text, "Servers SHOULD use the `name`
  … for `user.name` and `user.displayName`". The proposed text is "Servers
  SHOULD use the `name` ([§3.2](#32-authentication)) of a `register` begin
  step for `user.displayName`".
- Send `excludeCredentials` with the account's credentials when a signed-in
  connection registers, so that the same authenticator is not registered
  twice.

### Timeouts

L3 recommends a ceremony timeout of 5 to 10 minutes, with 5 minutes as the
default
([§15.1](https://www.w3.org/TR/webauthn-3/#sctn-timeout-recommended-range)).
The fixtures use 2 minutes.

**Server guidance (R6):** send `timeout: 300000`, and keep each challenge at
least that long. §4.10's "MUST expire" stays.

### Things that do not matter for Apron

- **`remoteClientDataJSON`** (editor's draft only,
  [§10.1.6](https://w3c.github.io/webauthn/#sctn-remote-client-data-json-extension)):
  for remote-desktop web clients. Each origin must be allowed by enterprise
  policy or in the browser's settings, so it is no path for third-party
  clients.
- **`hybrid` transport value and `authenticatorAttachment` in responses:**
  for information only.
- **ESP256/384/512 algorithms and the uncompressed-key rule:** servers keep
  `-7` (ES256) and may add `-8` (EdDSA).
- **The `appid` and `appidExclude` extensions:** for legacy U2F only.
- **The `uvm` extension removed, and `tokenBinding` reserved:** Apron uses
  neither.
- **The removed advice to abort a ceremony on focus loss:** no effect.
- **`isUserVerifyingPlatformAuthenticatorAvailable`:** use
  `getClientCapabilities()` instead.
- **Test vectors, WebDriver virtual authenticators, and "Set Credential
  Properties":** useful for server tests, with no protocol effect.

## Proposed §4.10 and §5.2 text, together

R1 to R4, in the spec's style. The existing bullets are kept unless shown.

```markdown
`public_key` holds creation options for a registration, or request options for a
login, in
[WebAuthn JSON](https://www.w3.org/TR/webauthn-3/#sctn-parseCreationOptionsFromJSON)
with binary fields as unpadded base64url. Browsers read it with
`PublicKeyCredential.parseCreationOptionsFromJSON` or
`.parseRequestOptionsFromJSON`. `credential` is the result in the same JSON
form, as [`toJSON()`](https://www.w3.org/TR/webauthn-3/#dom-publickeycredential-tojson)
returns it.

- `public_key` MUST carry its RP ID, in `rp.id` or `rpId`.
- Before they pass `public_key` on, clients MUST check that its RP ID is the
  host of the server's address ([§1](#1-transport--framing)), or a domain that
  the host is under and that is not a public suffix.
- Clients SHOULD remove the `prf` and `largeBlob` extensions from
  `public_key` (their outputs can be secrets of the user's other apps on the
  RP ID, and `credential` would send them to the server).
- Registration MUST require discoverable credentials.
- Servers that share an RP ID MUST share their accounts, with one user
  handle (`user.id`) for each account (an authenticator keeps one passkey for
  each RP ID and user handle).
- Login omits `allowCredentials`, or sends an empty array.
- Both actions require user verification.
- Servers SHOULD use the `name` ([§3.2](#32-authentication)) of a `register`
  begin step for `user.displayName` in `public_key`.
```

§5.2, which replaces the RP ID line and adds two lines:

```markdown
- Clients check that the RP ID of a ceremony belongs to the server
  ([§4.10](#410-webauthn-authentication)). Otherwise one server could pass
  another server's challenge through a client that both use, and sign in as
  the user with the response. Browsers do not stop this: they check the RP ID
  only against the client's own origin, and the origins that the RP ID lists
  as related. A server on a domain under the RP ID can still do this, so
  servers that share an RP ID share their accounts
  ([§4.10](#410-webauthn-authentication)). A user on one is the same user,
  with the same passkey, on the others.
- Clients remove PRF and large blob requests
  ([§4.10](#410-webauthn-authentication)). So a server that passes the RP ID
  check cannot collect secrets that the user's other apps keep with the
  passkey.
```

HISTORY.md, under the current version:

```markdown
- WebAuthn (§4.10): `public_key` carries its RP ID; the RP ID check excludes
  public suffixes; servers that share an RP ID share their accounts; clients
  remove `prf` and `largeBlob`; `credential` is the JSON that `toJSON()`
  returns; `name` labels only `user.displayName`.
```

## Sources

- W3C, *Web Authentication Level 3*, Recommendation, 2026-08-25:
  https://www.w3.org/TR/webauthn-3/ (and the
  [REC snapshot](https://www.w3.org/TR/2026/REC-webauthn-3-20260825/)).
  Editor's draft: https://w3c.github.io/webauthn/. Both were fetched
  2026-11-11.
- MDN browser-compat-data, `api/PublicKeyCredential.json` and
  `api/CredentialsContainer.json`:
  https://github.com/mdn/browser-compat-data
- passkeys.dev, device support (updated 2026-09-21):
  https://passkeys.dev/device-support/. Related origins:
  https://passkeys.dev/docs/advanced/related-origins/
- web.dev, related origin requests:
  https://web.dev/articles/webauthn-related-origin-requests. Passkeys in
  iframes: https://web.dev/articles/webauthn-within-iframe
- Firefox source, release branch (160):
  [StaticPrefList.yaml](https://github.com/mozilla-firefox/firefox/blob/release/modules/libpref/init/StaticPrefList.yaml),
  [PublicKeyCredential.cpp](https://github.com/mozilla-firefox/firefox/blob/release/dom/webauthn/PublicKeyCredential.cpp),
  [WebAuthnRelatedOriginFetcher.sys.mjs](https://searchfox.org/firefox-main/source/dom/webauthn/WebAuthnRelatedOriginFetcher.sys.mjs)
- Chrome:
  [JSON helpers in 129](https://developer.chrome.com/blog/passkeys-updates-chrome-129),
  [conditional create](https://developer.chrome.com/docs/identity/webauthn-conditional-create),
  [Signal API](https://developer.chrome.com/docs/identity/webauthn-signal-api),
  [iframe create, Intent to Ship](https://groups.google.com/a/chromium.org/g/blink-dev/c/Sq2WAVbPz6g)
- WebKit bugs [302624](https://bugs.webkit.org/show_bug.cgi?id=302624) and
  [322267](https://bugs.webkit.org/show_bug.cgi?id=322267)
- Android:
  [Signal API](https://developer.android.com/identity/credential-manager/signal-api-rp),
  [privileged apps](https://developer.android.com/identity/sign-in/privileged-apps)
- 1Password community, `toJSON` issues:
  https://www.1password.community/discussions/1password/issues-with-publickeycredential-tojson-and-passkeys/158327
- Secondary sources: Corbado on
  [native app origins](https://www.corbado.com/blog/webauthn-origin-validation-native-apps),
  and Unit 42 on
  [webauthn.dll](https://unit42.paloaltonetworks.com/webauthn-added-to-browser-based-rdp/).
