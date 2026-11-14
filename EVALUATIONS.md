# Evaluating sign-in

Local draft, not committed. A framework for checking that every way to sign
in is safe, and works well enough, for every kind of client and server. It
judges [PLAN_OAUTH.md](PLAN_OAUTH.md), with its changes C1 to C3, against
PROTOCOL.md on [shazow/apron#115](https://github.com/shazow/apron/pull/115).

## Axes

- **Actions:** register, log in, add a credential to an account, recover an
  account.
- **Clients:** web, native, terminal.
- **Pairing:** first party, when the client and the server have one
  operator, such as web.apron.chat with server.apron.chat. Third party
  otherwise, such as web.apron.chat with chat.example, or Sidekick with
  server.apron.chat. Terminal clients are always third party.
- **Schemes:** `token`, `webauthn`, `email`, `external`. `guest` has no
  credentials, and stays out.

Shorthand for the pairings: **W1** web, first party; **W3** web, third
party; **N1** native, first party; **N3** native, third party; **T**
terminal.

## Safety: pass or fail

Every supported cell holds against each attacker.

| # | Attacker | Must hold |
|---|---|---|
| A1 | A malicious server that the client connects to | It cannot sign in to another server as the user: no relay, mix-up, or token replay. |
| A2 | A malicious client or frontend | It gets nothing beyond what the user approved for it, on a screen that shows who is asking. |
| A3 | Another app on the same device | It cannot redeem a code or token meant for another client, such as by claiming the same scheme or loopback port. |
| A4 | A person who sends a link | No login CSRF, no silent switch to another account, and no linking the victim's identity to the sender's account. |
| A5 | A person who guesses | No brute force of codes, and no list of which addresses have accounts. |
| A6 | Someone who copies a stored or logged credential: one-shot XSS, a malicious extension, a stolen backup or synced profile, an infostealer, or a log of frames on a server, a proxy, or in devtools | A copied token or refresh token alone does not sign in from elsewhere. |
| A7 | Code that runs in the client while it is open: persistent XSS, a malicious extension | It cannot get a new session without the user's action. |

A6 and A7 come from [RESEARCH_DPOP_DBSC.md](RESEARCH_DPOP_DBSC.md).

- **A6 today:** fails for `token`, and for PLAN_OAUTH's refresh tokens. A
  `webauthn` token resists only on another web origin (F4). With key-bound
  tokens ([PLAN_LOOSE.md](PLAN_LOOSE.md#forward-compatibility-proof-of-possession)),
  it holds against copies: for web with a non-extractable software key (but
  not against malware that also copies the key), for native with a hardware
  key. For terminals, a key file is copied as easily as a token, unless the
  key lives in an agent, a TPM, or a platform keystore.
- **A7:** no binding helps (RFC 10017 §5.1.3, §5.1.4). The portal's
  confirmation before every redirect is the guard (R5).

## Works decently: graded

| # | Criterion |
|---|---|
| U1 | No coordination between strangers: no registration, allowlist, or platform entitlement that a third party must ask for. |
| U2 | Few steps: no copying of long strings, and at most one switch to another app. |
| U3 | Survives a dropped connection, such as a phone app in the background. |
| U4 | An off-the-shelf library or platform API covers it. |
| U5 | Works in the major browsers and platforms. |

## Method

1. Prove each scheme's safety once, as invariants. Then check only the cells
   where the client or the pairing changes something.
2. Mark each cell: ✅ works decently; ⚠️ works with a caveat; ✗ unsupported
   by design, with the fallback named; 🔴 unsafe.

Acceptance:

1. No cell is 🔴.
2. Every action, for every client and pairing, has a ✅ path on a server that
   follows the recommendations (C3).
3. Every ✗ names its fallback.

## Invariants

- **`token`:** a bearer string. Clients keep tokens for each server address,
  and send each only to its server. A token from `webauthn` is bound to the
  ceremony's origin, which stops theft between browser origins only (F4).
- **`webauthn`:** the client's RP ID check (§4.10) stops a server relaying
  another server's ceremony (A1). The browser or platform binds a passkey to
  its RP ID (A2, A3). Challenges are bound to their connection (A4).
- **`email`:** `state` stops login CSRF (A4). A link's `server` check, and
  the server's address in each email, stop mix-up (A1). Short codes work only
  on the proposing connection, or with the proposal's `state`, and failed
  attempts count against the proposal (A5, C1). A proposal returns `{}` for
  every address (A5). An addition works only on the proposing account's
  connection (A4).
- **`external`:** the client's `resource` check and the server's `aud` check
  stop replay (A1). The `issuer` and `iss` checks stop mix-up between
  authorization servers (A1). PKCE binds the code to its client (A3). OAuth
  `state` stops login CSRF (A4). The authorization server's consent screen
  shows the client (A2). An addition uses a token from the client's own
  sign-in (A4, C2).

## Grid

Cells are register · log in · add · recover. A cell that a change fixes
carries its ID.

| | W1 | W3 | N1 | N3 | T |
|---|---|---|---|---|---|
| `token` | ✅¹ · ✅ · — · ✗² | ✅¹ · ✅ · — · ✗² | ✅¹ · ✅ · — · ✗² | ✅¹ · ✅ · — · ✗² | ✅¹ · ✅ · — · ✗² |
| `webauthn` | ✅ · ✅ · ✅ · ✗³ | ✗⁴ | ✅⁵ · ✅⁵ · ✅⁵ · ✗³ | ✗⁴ | ✗⁴ |
| `email` | ✅ · ✅ · ✅ · ✅ | ✅ (C1) | ✅ (C1) | ✅ (C1) | ✅ (C1) |
| `external` | ✅⁶ · ✅ · ✅ (C2) · ✅⁷ | ✅ (C3) | ✅ · ✅ · ✅ (C2) · ✅⁷ | ✅ (C3) | ✅ (C3) |

1. Through `signup`, such as `guest`, or an invite token.
2. A token is not a recovery path. Clients encourage another scheme
   (§3.2.1).
3. Recovery uses another passkey, `email`, or `external`.
4. A passkey works only on its RP ID and related origins. Fallback:
   `external`, or `email`.
5. With associated domains or asset links for the RP ID, which only the
   RP ID's owner can grant.
6. The authorization server's sign-up, then server policy for a new `sub`.
7. The authorization server's own recovery.

## Traces

One line for each cell that is not plain.

- **`email`, W3, N3, T:** the link lands on the server's page or on
  link.apron.chat, not on the client that proposed. The user types the code
  into the client, which presents it with `state`, also after a reconnect
  (C1). iOS and Android fill one-time codes from mail.
- **`email`, N1:** link.apron.chat opens the first-party app, which has the
  proposal's `state`. Otherwise, the code.
- **`external`, W3:** a redirect to the frontend's own origin. It needs CORS
  on the authorization server, and a client ID: a client ID metadata
  document, dynamic registration, or `server.external.client_id` (C3).
- **`external`, N3:** a sign-in session or loopback, with PKCE. A client ID
  as for W3.
- **`external`, T:** the device authorization grant (C3). Without it, a
  loopback redirect, which works only on a machine with a browser. server.apron.chat is in this case: `workers-oauth-provider` has no
  device grant.
- **`external`, add:** on a signed-in connection, a token adds its `sub` to
  the account (C2). The same request with the account's own `sub` is a fresh
  token, and a guest connection becomes an account. The result carries `you`, as an email addition and a
  WebAuthn registration do.
- **`webauthn`, W3:** works if the server lists the frontend as a related
  origin. Chrome allows five labels, and Firefox does not support related
  origins yet.

## Behind the portal

`external` hides its method from the client, so the grid above has one
`external` row, whatever the portal does. What the grid does not show is
where the portal runs: in the browser context that the client opens. A
method has to work there. This is usability (U5), not safety: the portal's
method does not change the guards on the way back.

Contexts:

- **Same browser:** a web client's own browser, often the same profile.
- **Sign-in session:** `ASWebAuthenticationSession` on macOS and iOS, a
  separate Safari context.
- **Custom Tab:** Android's in-app browser tab.
- **System browser:** a desktop native app or a terminal with a local browser.
- **Another device:** a terminal's device grant or code, finished on a phone.

| Method behind the portal | Same browser | Sign-in session | Custom Tab | System browser | Another device |
|---|---|---|---|---|---|
| Passkey, RP ID of the portal's domain | ✅ | ✅ | ✅ | ✅ | ✅ synced passkey; ⚠️ otherwise a QR code to a phone |
| Email link | ⚠️¹ | ✗¹ | ✗¹ | ⚠️¹ | ⚠️¹ |
| Email code, typed into the portal | ✅ | ✅ | ✅ | ✅ | ✅ |
| Email link that approves a waiting portal page² | ✅ | ✅ | ✅ | ✅ | ✅ |
| OpenID Connect provider, such as Pocket ID | ✅ | ✅ | ✅ | ✅ | ✅ |
| SIWE | ✅ extension or WalletConnect | ⚠️³ | ⚠️³ | ✅ extension wallet | ✅ wallet app; ⚠️ return to the browser³ |

1. A link opens in the browser that the mail app chooses, not in the context
   that the client opened. The portal page that waits for the result is
   then in another context, and the flow never returns to the client. It
   works only when both are the same browser and profile.
2. The link only approves the pending sign-in on the server. The portal page
   that the client opened waits for the approval, by polling or a socket,
   and then redirects. It works in any context, and on any device that gets
   the mail. It needs the portal to show which sign-in the link approves, so
   that a link cannot approve someone else's waiting page.
3. Not verified. Browser extensions are probably not available in a sign-in
   session or a Custom Tab, so the portal falls back to WalletConnect. The
   return from the wallet app to the sign-in session may need the user to
   switch apps by hand. Check on devices.

Guidance for operators:

- Behind a portal, send email codes, or links that approve a waiting page;
  never plain magic links.
- A SIWE portal offers WalletConnect besides browser extensions.
- A passkey portal on its own domain works in every context; on another
  device, it relies on synced passkeys or a QR code.

## Findings

| # | Finding | Status |
|---|---|---|
| F1 | A short email code works only on the connection that proposed. A phone app in the background loses that connection, and with it the code. | Fixed by C1. |
| F2 | Email links land on the server's page, not on a third-party client. | Accepted: the code is the path for third-party clients, and works with C1. |
| F3 | An `external` identity cannot be added to an existing account. A server that offers `email` and a third-party authorization server cannot link the two. | Fixed by C2. |
| F4 | The origin binding of a `webauthn` token stops theft between browser origins only. A native client can send any `Origin`. | Accepted: §5.2 already says "another web origin". |
| F5 | `external` on third-party web and native clients needs CORS and a client ID from the authorization server; a terminal needs the device grant. | Fixed by C3, a recommendation to operators. |
| F6 | Plain email links behind a portal open in another browser context, so a native client's sign-in session never gets the result. | Guidance: portals send codes, or links that approve a waiting page ([Behind the portal](#behind-the-portal)). |
| F7 | Apron tokens are long-lived bearer credentials, kept in web storage on arbitrary origins (A6). | Open: names reserved now, key-bound tokens later (PLAN_LOOSE.md, Forward compatibility). Guidance now: no logging of `auth` params, hashed storage, rotation for web clients. |
| F8 | PLAN_OAUTH breaks with issuers that bind access tokens: a server that ignores `cnf` accepts a stolen bound token as bearer, and one that checks it rejects every DPoP client. | Fixed in the plans: servers reject bound tokens without a proof; clients use DPoP at the issuer only when `server.dpop` is advertised. |
| F9 | A foreign issuer that requires DPoP breaks PLAN_LOOSE's redemption on the connection. | Fixed: the Apron server redeems with its own DPoP key; simple clients send no `dpop_jkt`. |

## Remaining risks

- **R1.** The email code's mix-up guard relies on the user reading the
  server's address in the email.
- **R2.** Servers on one host and port share a `resource`, and servers under
  one RP ID share passkeys, so they trust each other.
- **R3.** A shared `server.external.client_id` shows every client as one
  name on the consent screen, so a phishing frontend looks like any other.
  Client ID metadata documents show the real client.
- **R4.** A frontend that a server lists as a related origin can relay its
  passkey ceremonies. The listing is the trust.
- **R5.** Code running in a client while it is open (A7) can start a new
  sign-in. The portal's confirmation before every redirect is the guard,
  also when the user is already signed in. A foreign issuer that skips
  consent for a known client weakens it.
