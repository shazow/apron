# Plan 2: the endgame

Status: superseded by [PLAN_OAUTH.md](PLAN_OAUTH.md), which uses OAuth 2.1 itself
rather than carrying most of it over the Apron connection. Kept for reference.
Originally a proposal for protocol version 10. Merges the earlier endgame and
bound-token plans, with the fixes from [REVIEW.md](REVIEW.md) and lessons from
[PRIOR_ART.md](PRIOR_ART.md). Builds on [PLAN_MINIMAL.md](PLAN_MINIMAL.md);
scenarios are in [SCENARIOS.md](SCENARIOS.md).

## Summary

The server hosts a sign-in page behind `external` (§4.11), as in Plan 1, and
every kind of client gets a smooth way back from it, with no lists for the
operator to keep:

| client | way back from the page |
|---|---|
| Native app | its own scheme, such as `sidekick:`, or a loopback port |
| Web frontend | the page posts the result to the window that opened it |
| Terminal client | a code to type |
| Web client that the operator trusts | a redirect, as today |

A token that comes back to the user's device works only on the connection
that proposed. A client that may lose that connection, such as a mobile app
that the system suspends, can add PKCE, which lets it redeem the token on a
new connection. Either way, a token that reaches the wrong app or site is
useless there.

## Fix first, in both plans

Holes that any plan needs closed (the second landed in v10):

1. **Mix-up.** §4.11.2 tells a client to ignore `server` in a link with its
   own `state`. A hostile server can then copy a client's proposal to another
   server, show the user that server's real page, and receive the token.
   Fix: a client drops a link or message whose `server` is not the server
   that it proposed to. AT Protocol makes the same check mandatory.
2. **Passkey relay.** Clients run a passkey ceremony only when its RP ID is
   the server's host or a domain that the host is under (§4.10).

## Ways back

### Its own scheme

A native app proposes with a `return_url` on a scheme of its own, such as
`sidekick:/signed-in`, or `com.sidekick.app:/signed-in`.

- Servers accept an app's own scheme from any client, without a list.
- Servers refuse schemes that are not an app's own: `apron`, `http`, `https`,
  `javascript`, `data`, `file`, `blob`, `about`, `mailto`, and `tel`.
  (`http` is allowed only on a loopback address.)
- Clients SHOULD use a scheme in reverse-domain form, such as
  `com.sidekick.app:`, which RFC 8252 recommends to avoid two apps choosing
  the same name.
- On Apple platforms, the app opens the page in `ASWebAuthenticationSession`.
  On Android, it opens it in an Auth Tab or a Custom Tab. Elsewhere, the
  operating system passes the link to the app that claims the scheme.

### Loopback

A desktop app listens on a loopback port, and proposes with
`return_url: http://127.0.0.1:<port>/` or `http://[::1]:<port>/`.

- Servers accept a loopback `return_url` from any client, on any port.
- The app's listener serves one small page that sends the fragment back to
  the listener, since browsers do not send fragments.

### Popup

A web client proposes without `return_url`, and opens the page in a popup
from the user's click.

- A page with an opener posts its result to the opener, with the proposing
  connection's `Origin` as the target origin.
- A page without an opener shows the code to type.

### Code

A client proposes without `return_url`, and the page shows a short code. This
is §4.11 today. It is the way back for terminal clients, and the fallback for
every other way.

### A redirect to a trusted origin

As today: a `return_url` on an `https` origin that the server trusts. Its
token works on any connection, and the server binds it to that origin.

## Proving the proposer

- A token for an app's scheme, a loopback address, the popup, or the code
  works only on the proposing connection.
- A proposal MAY carry `challenge`. Its token then also works on another
  connection, with the matching `verifier`.
- A wrong token or `verifier` counts as a failed attempt (§4.11.1).

Binding alone needs no new fields and no client code. PKCE costs two fields
and a hash, and survives a dropped connection, a suspended mobile app, or an
app that the operating system starts again to handle a link.

## Why an app's own scheme, and not `apron:`

| | `apron:` | `sidekick:` |
|---|---|---|
| Delivery with two Apron apps installed | the operating system picks one, so the other app's sign-in fails | the app that owns the scheme |
| A token that reaches the wrong app | useless, by binding or PKCE | useless, by binding or PKCE |
| An app that squats on another app's scheme | not applicable | gets a useless token; the real app's sign-in fails, and can retry in a sign-in session |
| A.4's rule that no token travels in an `apron:` link | broken | kept |

`apron:` stays a scheme for links to places.

## Scheme squatting

Another app on the device can claim the same scheme as the real app. When
the operating system, not a sign-in session, hands over the redirect, the
squatting app may receive it.

| what the squatting app tries | result |
|---|---|
| Redeem the token it caught | `denied`: it is not on the proposing connection, and has no `verifier` |
| Keep the real app from finishing | succeeds: the real app never receives its token, and its sign-in fails |
| Send wrong tokens or verifiers | each counts as a failed attempt, and a few cancel the proposal; the sign-in had already failed |
| Start its own sign-in, and ask the user to approve it | possible: its proposal has its own binding or verifier, and the page can only show "an app on this device" and the name that the app gives itself |

The failure mode is a sign-in that does not come back, not a stolen account.
The last row needs no squatting: any malicious app on the device can open the
page and ask for approval. That is outside what the protocol can guard.

Mitigations, strongest first:

- **A sign-in session.** `ASWebAuthenticationSession` and Android's Auth Tab
  return the callback to the app that opened them, whatever app claims the
  scheme. Squatting does not apply.
- **Loopback.** The app binds a free port before it proposes, and no other
  process can bind the same port while it listens.
- **A verified `https` app link.** Apple Universal Links and Android App
  Links open only the app that the domain lists. This needs the app to own a
  domain, and the server to accept that `https` `return_url`.
- **A reverse-domain scheme**, such as `com.sidekick.app:`. It makes an
  accidental collision unlikely, and does nothing against a deliberate one.

The exposure that remains is an app's own scheme handed over by the
operating system: mainly on Linux and Windows, and on Android without an
Auth Tab. There, clients:

- prefer loopback where they can listen on a port.
- fall back to the code when the sign-in does not come back within a short
  time, and offer to retry.
- show the user which app the page says it is signing in, so that a second,
  unexpected request looks wrong.

A later improvement for the last row: a `client_id` URL in the proposal, with
the app's scheme in reverse order of its host, as AT Protocol requires. The
page could then show a domain that the app proved, in place of a name that it
claims.

## Other rules

- The proposal's `url` is a page of the server. A server behind an identity
  provider, such as Pocket ID, redirects from that page to the provider.
- The page refuses to be shown in a frame.
- The page shows where the result goes: the host of an `https` `return_url`,
  the opener's origin, or "an app on this device", with `agent` as the name
  that the app gives itself.
- The page offers "Don't allow", which returns `error=access_denied` in place
  of `token`.
- After an approval, clients show which account they signed in to.
- `ext:auth_external` labels the page, such as "Pocket ID"
  (EXT_AUTH_EXTERNAL.md).

## Wire

An app's own scheme, in a sign-in session:

```jsonc
// ->
{"method": "auth", "id": "c1", "params": {
  "scheme": "external", "return_url": "sidekick:/signed-in",
  "state": "q8Rz…", "agent": "Sidekick/1.2"
}}
// <-
{"id": "c1", "result": {"url": "https://server.apron.chat/sign-in?p=Qm7xT2…"}}

// the session returns
// sidekick:/signed-in#token=xt_Hk41…&state=q8Rz…&server=wss://server.apron.chat/

// -> on the same connection
{"method": "auth", "id": "c2", "params": {"scheme": "external", "token": "xt_Hk41…"}}
// <-
{"id": "c2", "result": {"you": {"user_id": "ada", "name": "Ada"}, "token": "st_…"}}
```

Loopback:

```jsonc
// ->
{"method": "auth", "id": "c1", "params": {
  "scheme": "external", "return_url": "http://127.0.0.1:49152/", "state": "q8Rz…"
}}
// the browser ends at
// http://127.0.0.1:49152/#token=xt_Hk41…&state=q8Rz…&server=wss://server.apron.chat/
```

PKCE, redeemed after a reconnect:

```jsonc
// -> proposal
{"method": "auth", "id": "c1", "params": {
  "scheme": "external", "return_url": "com.sidekick.app:/signed-in", "state": "q8Rz…",
  "challenge": "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
}}
// -> approval, on a new connection
{"method": "auth", "id": "c2", "params": {
  "scheme": "external", "token": "xt_Hk41…",
  "verifier": "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
}}
```

Popup, from a page on `https://foo.example.com`:

```jsonc
// ->
{"method": "auth", "id": "c1", "params": {"scheme": "external", "state": "q8Rz…"}}
// <-
{"id": "c1", "result": {"url": "https://server.apron.chat/sign-in?p=Qm7xT2…"}}
```

The page shows the code `418092`, and posts to its opener, with
`https://foo.example.com` as the target origin:

```json
{"apron": "external", "token": "418092", "state": "q8Rz…", "server": "wss://server.apron.chat/"}
```

Declined:

```text
sidekick:/signed-in#error=access_denied&state=q8Rz…&server=wss://server.apron.chat/
```

```json
{"apron": "external", "error": "access_denied", "state": "q8Rz…", "server": "wss://server.apron.chat/"}
```

Label:

```json
"ext": {"auth_external": {"label": "Pocket ID"}}
```

## Protocol changes

- §3.2: `challenge` and `verifier` on `Auth`, for the `external` scheme.
- §4.11.1: a proposal MAY carry `challenge`; a wrong token or `verifier`
  counts as a failed attempt.
- §4.11.2:
  - A token for an app's scheme, a loopback address, the popup, or a code
    works only on the proposing connection, or on another one with the
    matching `verifier`.
  - A client drops a link or message whose `server` is not the server that it
    proposed to. (Replaces "ignores `server`".)
- §4.11.3: an approval of a proposal with `challenge` on another connection
  MUST carry the matching `verifier`; clients show the account after an
  approval.
- §4.11.5: the accepted `return_url`s, the popup, the page's `url`, framing,
  what the page shows, and `access_denied`.
- §4.10: the RP ID check.
- A.4: `error` as a key. The `apron:` rule stays.
- §5.2: a line for each guard.
- EXTENSIONS.md: `ext:auth_external`.
- HISTORY.md: a v10 entry. Schema: `challenge` and `verifier`.

## Coverage

| scenario | how |
|---|---|
| 1. macOS app, existing passkey | its own scheme in `ASWebAuthenticationSession`, or loopback in the default browser |
| 2. Native app without a sign-in session | loopback, or its own scheme with PKCE |
| 3. Two Apron apps on one device | each has its own scheme or port; a stray token is useless |
| 4. Unknown web frontend | popup; the code if the opener is gone |
| 5. Terminal client | code |
| 6. Server behind Pocket ID | the server's page redirects to Pocket ID; the label |
| 7. Server without its own page | not in the protocol; a reference page in shazow/apron |
| 8. Declined sign-in | `error=access_denied` |

Abuse cases:

- **Mailed link:** the page has no opener, so it shows only a code, and a
  token for a local way back works only on Mallory's connection.
- **Wrong recipient, scheme squatting:** the token is useless off the
  proposing connection without the `verifier`.
- **Mix-up, relaying server:** the `server` check, and the RP ID check.
- **Signed in as someone else, forged popup message:** a token for another
  proposal is `denied` on this connection, and clients check the popup
  window and `state`.
- **Open redirect:** a token goes only to a trusted origin, the user's own
  device, or the window that opened the page.
- **Framing, replay, a bad client, a removed user:** the framing rule;
  single-use tokens with failed-attempt limits; expiring, listed, revocable
  session tokens; backchannel logout from the provider.

## Impact

### apron-server-cloudflare (server.apron.chat)

- Plan 1's work: offer `external`, keep proposals with the proposing
  connection, and serve the page under `apron.chat` with its exact origin in
  `RP_ORIGINS`.
- Accept app schemes and loopback addresses from anyone, and bind their
  tokens to the proposing connection.
- PKCE: store `challenge`, and compare the SHA-256 of `verifier`.
- The page: posts to its opener, offers "Don't allow", refuses frames, shows
  the destination, and asks for the passkey on every sign-in, keeping no
  session.
- Return expiring session tokens, listed with their origin or `agent`, in
  place of device tokens.
- The label setting.

### apron-web

- Open a blank popup from the click, then navigate it to `url`, since Safari
  blocks `window.open` after an `await`.
- Take the posted code into its existing code flow, on the connection that
  it already keeps open.
- The `server` check, `access_denied`, the label, and "Signed in as …".

### Sidekick, SideTable, and other macOS apps

- Propose with its own scheme, open the page in `ASWebAuthenticationSession`,
  check `state` and `server`, and redeem on the same connection.
- Add PKCE only if it must survive a dropped connection.
- Test with Chrome and Firefox as the default browser; loopback in the
  default browser is the fallback.

### Desktop apps on Linux and Windows

- Loopback with the system browser, or its own scheme with PKCE, since the
  operating system may start a new process to handle the link.

### Mobile apps

- Its own scheme in an Auth Tab, Custom Tab, or `ASWebAuthenticationSession`,
  with PKCE, since the system may suspend the app and close its connection.

### Terminal clients

- The code. Loopback when a browser runs on the same machine.

### Servers behind Pocket ID

- The server's page redirects to Pocket ID, and the server finishes the flow
  as server.apron.chat does. The label names the provider.

### shazow/apron

- PROTOCOL.md v10, HISTORY.md, the schema, and EXTENSIONS.md, as listed under
  Protocol changes.
- Conformance: a bound token on another connection is `denied`; with
  `verifier`, it works; a loopback `return_url` and an app scheme are
  accepted; `apron:` and an untrusted `https` `return_url` are
  `invalid_params`; a link with another `server` is dropped.
- Optional: a reference sign-in page, for scenario 7.

## Tradeoffs

- **Against Plan 1:** a protocol revision and some client work, for no codes
  outside terminal clients, and no lists for the operator.
- **Binding by default:** the client keeps its connection through the browser
  step. PKCE covers the clients that cannot.
- **Loopback:** needs a listening socket, which suits desktop apps and not
  sandboxed ones, and leaves a browser tab open.
- **App schemes:** another app can squat on a scheme and break, but not
  steal, a sign-in outside a sign-in session. See
  [Scheme squatting](#scheme-squatting) for the mitigations.
- **The popup:** depends on the opener; the code covers every case where it
  is lost.

## To test

- The sign-in session on macOS with Chrome or Firefox as the default browser.
- Navigation to a loopback address from the page in current browsers, and
  Chrome's local network access prompt.
- How long iOS and Android keep a WebSocket open during the browser step.
- Whether an installed web app on iOS keeps `window.opener`.

## Dropped alternatives

- **`apron:` with PKCE:** safe, but the operating system delivers to one app,
  so the other Apron apps' sign-ins fail.
- **A `return_origin` field:** the server already has the proposing
  connection's `Origin`, so the field adds nothing.
- **PKCE required for everything:** binding covers most clients with no
  client code; PKCE stays optional for the rest.
- **Device tokens as the result:** capped at 5, never expiring, and usable
  from any origin.
