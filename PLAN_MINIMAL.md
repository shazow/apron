# Plan: full coverage with minimal change

Status: proposal, local and not committed. Protocol version 10 as on `main`
(`687605b`), with small wire fixes. Section numbers below are `main`'s.

This is the shortest path: it keeps v10's `external` as it is. The
alternatives change `external`'s shape:

- [PLAN_OAUTH.md](PLAN_OAUTH.md): `external` becomes an OAuth 2.1 profile,
  drafted on [shazow/apron#115](https://github.com/shazow/apron/pull/115).
  That PR removes v10's `external` proposals, so this plan and the PR do not
  combine as is.
- [PLAN_LOOSE.md](PLAN_LOOSE.md): `external` as loose OAuth, with PKCE
  instead of connection binding.

See [SCENARIOS.md](SCENARIOS.md), [OPTIONS.md](OPTIONS.md), and
[EVALUATIONS.md](EVALUATIONS.md).

## Summary

server.apron.chat serves a passkey page behind `external` (§4.11), as v10
already defines it. Clients use one of two existing ways back from the page:

- **Redirect** to a `return_url`: for web frontends that the operator trusts,
  and for Apple native apps, which open the page in
  `ASWebAuthenticationSession` with their own scheme.
- **Code to type**, without `return_url`: for every other client, including
  unknown web frontends, native apps outside Apple, and terminal clients.

A server that does not want its own page puts an identity provider, such as
Pocket ID, behind `external`. No server needs the `ext:handoff` page methods,
and nobody runs a shared auth.apron.chat.

## Fixes

Holes that every plan needs closed:

1. **Mix-up (wire).** §4.11.2 tells a client to ignore `server` in a link
   with its own `state`, so a hostile server can collect a token for another
   server. Fix: a client uses a link with its own `state` only if the link's
   `server` is the server that it proposed to, and drops any other. This
   applies to email and external links alike.
2. **Mix-up for codes (text).** A hostile server can also relay a proposal,
   and get the code from the user. Fix: an email or a page that shows a code
   gives the server's address, and tells the user to type the code only in
   a client that is connected to it. §4.11.5 already tells the page to say
   "only in the client where they started"; it adds the address.
3. **Passkey relay.** Clients run a passkey ceremony only when its RP ID is
   the server's host or a domain that the host is under (§4.10). Done: landed
   in v10.

Recommended, from [EVALUATIONS.md](EVALUATIONS.md):

4. **Codes survive a reconnect (wire, F1).** A short code works only on the
   proposing connection. A phone app in the background loses that connection
   while the user reads the code. Fix: a short code also works on another
   connection that presents the proposal's `state`. A guesser lacks the
   `state`, and failed attempts still count against the proposal. This plan
   relies on codes for most clients, so it matters more here than in the
   other plans.
5. **Additions return `you` (wire).** An approved addition returns `{}`
   today, and a WebAuthn registration on a signed-in connection returns
   `you`. Returning `you` for both lets a client tell an addition from a
   proposal by the result alone.

Fixes 1, 2 (for email), 4 (for email), and 5 (for email) are on
shazow/apron#115. This plan applies them to `external` too.

## Wire

Every exchange is §4.11 as written, plus the fixes:

- Proposal: `auth {scheme: "external", return_url?, state}` returns `{url}`.
- Redirect: `return_url#token=…&state=…&server=…`.
- Code: the page shows a short code and the server's address. The code works
  on the proposing connection, or with the proposal's `state` (fix 4).
- Approval: `auth {scheme: "external", token}` returns `{you, token}`.
- Addition: a proposal on a signed-in connection; approval returns `you`
  (fix 5).

Two optional lines for §4.11.5, which are text only:

- The page refuses to be shown in a frame.
- A server trusts a `return_url` by its own list: `https` origins, and the
  schemes of native apps that it allows.

## Coverage

| scenario | how |
|---|---|
| 1. macOS app, existing passkey | redirect through `ASWebAuthenticationSession` |
| 2. Native app without a sign-in session | code |
| 3. Two Apron apps on one device | code (no scheme is involved) |
| 4. Unknown web frontend | code |
| 5. Terminal client | code |
| 6. Server behind Pocket ID | provider behind `external`; `ext:auth_external.label` names it on the button |
| 7. Server without its own page | not covered: running a provider is more work than a page; a reference page in shazow/apron could help |
| 8. Declined sign-in | not covered: it looks like a closed window |

Against the [EVALUATIONS.md](EVALUATIONS.md#grid) grid, `external` here:

| | W1 | W3 | N1 | N3 | T |
|---|---|---|---|---|---|
| `external` | ✅ redirect | ⚠️ code, unless trusted | ✅ redirect (Apple); ⚠️ code elsewhere | ⚠️ code, unless the scheme is trusted | ✅ code |

- Register, log in, add, and recover work in every cell, through the page.
- ⚠️ cells work, but the user types a code. With fix 4, a code survives a
  reconnect.
- Safety: A1 by fixes 1 and 2, A2 by the page's confirmation, A3 by binding
  app-scheme tokens to the proposing connection, A4 by `state` and the
  addition rules, A5 by short codes bound to the connection or the `state`.

## Tradeoffs

- **For:** it ships with server work only. apron-web needs no change, and
  the wire changes are a few bullets.
- **Against:**
  - Unknown web frontends and native apps outside Apple make users type a
    code.
  - A token for an app scheme is bound to the proposing connection, so it
    fails if that connection drops during the sign-in, and only the tab
    that proposed can finish.
  - A declined sign-in looks like a cancelled one.
  - Clients cannot use an OAuth library, and a server behind Pocket ID is
    always its OpenID Connect client.

## Impact

### apron-server-cloudflare (server.apron.chat)

- Offer `external` and `token` in `server.auth`. Today `external` is
  `unsupported`.
- Keep proposals: `return_url`, `state`, `agent`, the proposing connection,
  and a 10-minute expiry. Check `return_url` against a configured list of
  `https` origins and app schemes.
- Serve the sign-in page under `apron.chat`, such as
  `https://server.apron.chat/sign-in`, and add its origin to `RP_ORIGINS`.
  Existing passkeys work there unchanged. The page signs in with the existing
  `webauthn` code, confirms with the user, and refuses to be framed
  (`frame-ancestors 'none'`).
- On approval, mint a temporary token: single use, expiring within 5
  minutes. Redirect to `return_url` with it, or show a short code and the
  server's address. A short code works on the proposing connection, or with
  the proposal's `state`.
- Bind a token for an app scheme to the proposing connection too. A scheme
  on the list proves nothing about which app receives it, and §4.11.2
  already allows this binding for codes.
- The proposal's `url` is always the server's own page, which redirects to a
  provider if there is one.
- Redeem the temporary token, and return an expiring session token, listed
  with its origin or `agent`. Device tokens are capped at 5, never expire,
  and work from any origin.
- Size: the largest piece. Passkey checks, device tokens, and rate limits
  already exist. Passkeys already use a random 16-byte user handle.

### apron-web

- Drop a link whose `server` is not the server that it proposed to (fix 1).
- Present a typed code with the proposal's `state` (fix 4).
- Otherwise no change. It already proposes `external`, opens the page,
  handles the link back, and handles typing a code.
- On an origin that server.apron.chat trusts (web.apron.chat), it gets the
  redirect. On any other origin, it gets the code.

### SideTable (macOS)

- New: propose with `return_url: "sidetable://signed-in"`, open `url` in
  `ASWebAuthenticationSession` with callback scheme `sidetable`, check
  `state` and `server`, and redeem the token.
- Already there: signing in with a saved token.

### Native apps outside Apple, and terminal clients

- New: propose without `return_url`, open `url` in the system browser, or
  print it, and let the user type the code, with the proposal's `state`.

### Other servers

- A server behind Pocket ID becomes an OIDC client of it, maps users to
  accounts, and finishes as server.apron.chat does. Clients see only
  `external`.
- The minimal servers in shazow/apron are unaffected: they offer only
  `guest`.

### shazow/apron

- PROTOCOL.md:
  - §4.11.2: fixes 1 and 4.
  - §4.11.3: fix 5.
  - §4.11.4 and §4.11.5: fix 2.
  - §4.11.5: the two optional lines.
  - §5.2: the lines for fixes 1, 2, and 4.
- HISTORY.md: fixes 1, 4, and 5 are wire changes.
- Schema: none. `state` is already on `auth` for both schemes.
- Conformance: optional checks for servers that offer `external`, such as a
  proposal's `url`, a used temporary token being `denied`, and a code with
  the wrong `state` being `denied`.
