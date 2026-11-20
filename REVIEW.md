# Review: PLAN_MINIMAL.md and PLAN_ENDGAME.md

Since this review: v10 landed the §4.10 RP ID check (problem 5), and
[PLAN_OAUTH.md](PLAN_OAUTH.md) replaced both plans' endgame. Problem 1, the
mix-up, is still open in v10.

Status: independent review, with a third option. Checked against PROTOCOL.md
on `origin/main` (v9, 2026-10-27), apron-server-cloudflare (`fdf410d`),
apron-web (`0b1feb4`, the newest `main` in this checkout), and Pocket ID's
source. "Unsure" marks platform behaviour that I did not test.

## 1. Verdict

**Plan 1 is sound as a deployment, and narrower than it says.** It needs no
wire change, the passkey claim holds (`server.apron.chat` can use RP ID
`apron.chat`, and its origin must be added to `RP_ORIGINS`), and apron-web
already falls back to the code when a `return_url` is refused
(`client.ts:4845`, on `invalid_params`). But its redirect path works only
where an operator listed the app or the origin, so between strangers every
client types a code, Apple apps included. It also inherits a gap in v9 that
lets a hostile server collect the token (problem 1), and the scheme list
proves nothing about the app (problem 4).

**Plan 2 is mostly sound on secrecy, and wrong on delivery.** The PKCE text is
correct (the example pair is RFC 7636's, and I recomputed it). But `apron:`
with PKCE keeps a stray token useless without making the token reach the
right app, so scenario 3 fails as a sign-in (problem 2). The popup rule
"from the `url`'s origin" breaks the Pocket ID case (problem 3). PKCE does not
stop problem 1. `return_origin` carries no information (section 3). The
`error`, label, frame, and "signed in as" pieces are fine.

## 2. Problems, most serious first

### 1. A hostile server can collect the token (both plans, and v9 today)

SCENARIOS.md says the mix-up is "guarded by `server` in the result, which the
client checks". §4.11.2 says the opposite: for a link with its own `state`,
the client "ignores `server`". apron-web does what §4.11.2 says
(`src/lib/ui/sign-in-link.ts:85` uses `proposal.url`).

- Ada tries chat.evil.example (M) from web.apron.chat or SideTable. Her
  client proposes to M with `state` S, and `challenge` C under Plan 2.
- M proposes to server.apron.chat with the same `return_url`, S, and C, and a
  forged `Origin`. M answers Ada's client with server.apron.chat's page `url`.
- The page shows a destination that Ada trusts (web.apron.chat, SideTable).
  She confirms with her passkey. A label such as "Apron" makes this page look
  expected.
- The link returns with S. The client matches its proposal to M, and sends
  the token, and the PKCE verifier, to M. M redeems them at server.apron.chat.

This is OAuth's mix-up attack. The same works with an emailed link. Fix, one
client rule in §4.11.2: a client drops a link or message whose `server` is not
the server that it proposed to. Servers write `server` from configuration, not
from a `Host` header. A typed code stays relayable by design: the page must
say which server and account the code signs in to, not only where to type it.

### 2. `apron:` with PKCE does not deliver the token (Plan 2, scenarios 2 and 3)

With two apps that claim `apron:`, the operating system picks one handler.
Unsure of each system's rule; from memory, iOS documents the choice as
undefined, desktop systems keep one default, and Android asks. The app that
is not the handler never gets its token. The app that is the handler follows
§4.11.2 for an unknown `state`: it asks the user, presents the token, gets
`denied`, and Plan 2 then uses the token up. The page has already redirected,
so there is no code to fall back to.

Smaller costs of the same piece: an app on Linux or Windows gets the link in a
new process and must forward it to the running one, which holds the verifier;
and A.4 loses its plain rule that no token travels in an `apron:` link.

Fix: return to something that only the proposing app owns. A loopback port
needs no registration, and RFC 8252 recommends it for desktop apps. NOTES.md
had it, and the plans dropped it.

### 3. The popup rules break behind an identity provider (Plan 2, scenario 4 with 6)

- Plan 2: clients accept a message only "from the `url`'s origin".
  EXT_AUTH_EXTERNAL.md returns Pocket ID's authorize URL as `url`, and the
  message comes from the server's callback page. The origins differ, so every
  such sign-in is dropped. Fix: the `url` is always a page of the server,
  which redirects to the provider; or drop the origin rule (see option 3,
  where the token cannot be forged).
- `Cross-Origin-Opener-Policy` on any page in the popup's chain cuts the
  opener for good, not only on the sign-in page. The opener is also cut when
  the client's own page sends `same-origin`. Pocket ID sends no such header
  today (`backend/internal/utils/csp.go` sets CSP only). Other providers do.
- Safari blocks `window.open` after an `await`, and the `url` comes from a
  request. Clients open a blank popup in the click, then navigate it. Reports
  say that this still fails at times.
- Unsure whether an installed web app on iOS keeps an opener.

The code fallback covers all of these, so say that the popup is best effort.

### 4. The scheme list proves nothing, and its token is not bound (Plan 1)

`ASWebAuthenticationSession` returns the callback only to the session that
started it. That part is right. But it does not check that the caller owns
the scheme, so any app on any system can propose `sidetable://signed-in`.
Listing `sidetable:` allows every app that claims the name. The token works
on any connection, so outside a sign-in session another handler can use it.
"The page shows its host" (§4.11.5) shows "signed-in" for this URL.

Fix, with no wire change: the server binds a token for a non-`https`
`return_url` to the proposing connection, as it does for a code, and the page
says "an app on this device", with `agent` marked as the app's own claim.

### 5. The passkey relay guard is not landed (both plans assume it)

SCENARIOS.md cites "the §4.10 RP ID check". §4.10 on `origin/main` has no such
rule, and apron-web has it only on the local branch
`claude/passkey-rp-id-check`. Until both land, a server reached through
web.apron.chat can relay a server.apron.chat challenge (NOTES.md). Land it
first. Section 3 has a way to close it on the server instead.

### 6. Scenario 7 is redefined, not covered (both plans)

Dan "does not want to build a passkey page" and "still checks the passkeys
itself". Running Pocket ID is more work than a page, and Pocket ID checks the
passkeys. Dropping option I is right (a page on web.apron.chat shares one RP
ID across servers). Say that scenario 7 is out, or cover it without protocol:
a reference single-file sign-in page in shazow/apron.

### 7. Device tokens are the wrong long-lived token (Plan 1, kept by Plan 2)

`MAX_DEVICE_TOKENS` is 5, the tokens never expire, and they work from any
origin (`src/index.ts:443`, `:2641`). A sixth sign-in is `denied`, and
foo.example.com would hold a stronger credential than web.apron.chat, whose
resume token is bound to its origin and expires. Fix: a session token like
the passkey one, bound to the web origin where there is one, expiring, and
listed with its origin and `agent`.

### 8. Sibling origins under `apron.chat` (both plans, server work)

media.apron.chat serves uploads and is same-site with the sign-in page. Any
`apron.chat` origin can ask the browser for an `apron.chat` assertion; only
the server's exact-origin check stops it, so keep `RP_ORIGINS` exact. If the
page keeps a session, use a `__Host-` cookie and check `Origin` on its
requests, since `SameSite` does not separate siblings.

### 9. The sign-in session may not hold the passkey (scenario 1, unsure)

Apple documents that macOS opens the default browser if it supports sign-in
sessions, and Safari otherwise. A passkey kept in another browser's password
manager is then missing from the session. Test with Chrome and Firefox as
the default browser before promising scenario 1. Opening the default browser
with a loopback return avoids it.

### 10. Small items

- Plan 2 uses the token up on a wrong `verifier`, so any app that sees the
  token can cancel the sign-in. Count a failed attempt instead.
- "No operator lists" in Plan 2 holds for SideTable only if it takes the
  "optional" switch away from `sidetable:`.
- `challenge` sits beside WebAuthn's `challenge_id` in one `Auth` class.
- Plan 1's frame rule needs its §5.2 line (AGENTS.md).

## 3. Simplifications

- **Drop `return_origin`.** The rule already forces it to equal the
  connection's `Origin`, which the server has. The page posts to that origin.
- **Drop PKCE; bind to the proposing connection.** §4.11.2 already binds a
  code that way. A native app and a popup's opener both keep their connection
  open. Cost: a dropped connection means a new sign-in.
- **Drop `apron:` as a return address.** Loopback is an origin, so a v9
  server may trust it as policy. Plan 1 plus that policy covers scenarios 2
  and 3 with no wire change and no code.
- **Let the popup deliver the code.** The page posts the same code that it
  shows. One token kind, one fallback, and old clients and servers still work.
- **Keep no session on the page.** A passkey step for every sign-in merges
  the confirmation into it, and removes cookies and problem 8's second half.
- **One web path.** Web clients propose without `return_url` and open a
  popup. The trusted-origin list stays only for full-page redirects.
- **Later: one passkey path.** If web.apron.chat also signs in through the
  page, `RP_ORIGINS` holds only the page's origin, and the relay in problem 5
  is closed on the server, whatever clients check.

## 4. Third option: bound to the proposing connection

One rule replaces PKCE, `apron:` returns, `return_origin`, and both lists: a
token that returns to the user's own device works only on the connection
that proposed. The return address then needs no trust decision. No new
`auth` field.

### Rules

§4.11.2:

- A temporary token works only on the proposing connection, unless the
  server sent it by email or to a trusted `https` `return_url`.
- Clients present a token on the proposing connection while it is open.
- A client drops a link or message whose `server` is not the server that it
  proposed to (replaces "ignores `server`").

§4.11.5:

- Servers accept a local `return_url` from any client: `http` on a loopback
  IP address with a port and the path `/`, or a URL whose scheme contains `.`
  and that has no query (an app's own scheme, as in RFC 8252).
- Without `return_url`, a page with an opener also posts its result to the
  opener, with the proposing connection's `Origin` as the target origin.
- When the user declines, the result carries `error=access_denied` in place
  of `token`.
- The page refuses to be shown in a frame.

Kept from Plan 2 unchanged: the label extension, and showing the account
after sign-in.

### Wire

```jsonc
// native app, listening on 127.0.0.1:49152
// ->
{"method": "auth", "id": "c1", "params": {"scheme": "external",
  "return_url": "http://127.0.0.1:49152/", "state": "q8Rz…", "agent": "Stupid/0.4"}}
// <-
{"id": "c1", "result": {"url": "https://server.apron.chat/sign-in?p=Qm7xT2…"}}

// the browser ends at
// http://127.0.0.1:49152/#token=xt_Hk41…&state=q8Rz…&server=wss://server.apron.chat/

// -> on the same connection
{"method": "auth", "id": "c2", "params": {"scheme": "external", "token": "xt_Hk41…"}}
// <-
{"id": "c2", "result": {"you": {"user_id": "ada", "name": "Ada"}, "token": "st_…"}}
```

```jsonc
// web client on https://foo.example.com: the v9 code proposal, in a popup
// ->
{"method": "auth", "id": "c1", "params": {"scheme": "external", "state": "q8Rz…"}}
// <-
{"id": "c1", "result": {"url": "https://server.apron.chat/sign-in?p=Qm7xT2…"}}

// the page shows the code 418092, and posts to its opener, target origin
// https://foo.example.com:
{"apron": "external", "token": "418092", "state": "q8Rz…", "server": "wss://server.apron.chat/"}

// -> on the same connection, as if the user typed it
{"method": "auth", "id": "c2", "params": {"scheme": "external", "token": "418092"}}
```

```text
http://127.0.0.1:49152/#error=access_denied&state=q8Rz…&server=wss://server.apron.chat/
{"apron": "external", "error": "access_denied", "state": "q8Rz…", "server": "wss://server.apron.chat/"}
```

The app's listener serves one small page that sends its fragment back to the
listener, since browsers do not send fragments.

### Scenarios

| scenario | how |
|---|---|
| 1. macOS app, existing passkey | its own scheme in `ASWebAuthenticationSession`, or loopback in the default browser; no list entry |
| 2. Native app without a sign-in session | loopback |
| 3. Two Apron apps on one device | each app has its own port or scheme, so the right app gets the token; a stray token fails off the proposing connection |
| 4. Unknown web frontend | popup; the page posts the code; the user types it if the opener is gone |
| 5. Terminal client | code over SSH; loopback with a local browser |
| 6. Server behind Pocket ID | provider behind `external`, with the label; `url` is the server's own page |
| 7. Server without its own page | not covered by protocol; a reference page |
| 8. Declined sign-in | `error=access_denied` |

Abuse cases:

- Mailed link: the page has no opener, so only a code; a local return lands
  on Ada's device, and works only on Mallory's connection.
- Wrong recipient: the token fails off the proposing connection.
- Relaying server, mix-up: the `server` rule. The passkey relay still needs
  problem 5 fixed.
- Signed in as someone else, forged popup message: a token for another
  proposal is `denied` on this connection, so a forged message cannot sign
  in. The client still checks the popup window and `state`.
- Open redirect: the page sends a token only to a trusted origin, the
  user's own device, or the window that opened it.
- Replay, framing, bad client, removed user: as in the plans.

### Impact

- **apron-server-cloudflare:** Plan 1's work, minus the scheme list. Keep
  the proposing `connId` with the proposal, as WebAuthn challenges do.
  Accept local return addresses. The page posts to its opener, has "Don't
  allow", and refuses frames. No PKCE.
- **apron-web:** open the popup from the click, take the posted code into
  the code flow that it already has (the connection is already kept open),
  add the `server` check, and handle `error`. Smaller than Plan 2: no second
  proposal form.
- **SideTable:** propose with its own dotted scheme, keep the connection
  open, check `state` and `server`, and redeem on that connection. No PKCE,
  and no entry on any server's list.
- **Other native apps:** a loopback listener and the system browser; on
  Android, an own scheme in a Custom Tab. No `apron:` handler, and no
  forwarding between processes.
- **Terminal clients:** as Plan 1.
- **Servers behind Pocket ID:** as Plan 1, plus the label. The `url` is the
  server's page, which redirects to the provider.
- **shazow/apron:** the seven rules above, their §5.2 lines, `error` in A.4,
  and a HISTORY entry. A.4's `apron:` rule and the `auth` schema stay.
  Conformance: a token on another connection is `denied`; a loopback
  `return_url` is accepted; an untrusted `https` one is `invalid_params`.

### Tradeoffs

- Against Plan 1: a small protocol change and client work, for no codes on
  the same device and no lists.
- Against Plan 2: no new `auth` fields in place of three, no A.4 exception,
  no hashing, and the token always reaches the app that asked. It also fixes
  problem 1, which Plan 2 leaves open.
- It costs: the client must keep its connection through the browser step,
  and a drop means starting again, where PKCE survives a reconnect. This
  matters most for mobile apps in the background. PKCE can be added later.
- Loopback leaves a browser tab open, and needs a listening socket, which
  suits desktop apps and not sandboxed ones. Unsure: top-level navigation to
  a loopback address works in current browsers, and Chrome's local network
  permission should not apply to it; test it.
- Mobile apps each need their own scheme, since `apron:` stays a link for
  places only.
- The popup depends on the opener, as in Plan 2.
