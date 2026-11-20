# Third-party clients and first-party passkeys: options

How a client that the server's operator does not know (a native app such as
SideTable, or a web frontend on foo.example.com) can sign in to a server such
as server.apron.chat, whose passkeys belong to `apron.chat`.

Options A–F work under protocol v10 as written. Options G–J need a protocol
or extension change, and [Protocol changes](#protocol-changes) gives each
change exactly.

## Work today

### A. Device tokens (`/invite-device`)

The user signs in on web.apron.chat, mints a token with `/invite-device add`,
and pastes it into the third-party client, which signs in with
`scheme: "token"`. The token does not expire, and the user can list and revoke
it. Tradeoff: zero work and already deployed, but copying a secret by hand is
clunky, and no passkey is used on the new client.

### B. A passkey per client (§4.10)

Each client registers its own passkey under its own domain, after it signs in
once another way, such as A. A registration on a signed-in connection adds the
passkey to the account. Tradeoff: no new protocol, but users end up with one
passkey per client, and a native app needs its own domain and association
file.

### C. Shared RP ID for clients that the operator blesses

The server lets a few clients use `apron.chat` passkeys directly: web clients
through a related-origins file at `https://apron.chat/.well-known/webauthn`,
native apps through Apple or Android associated domains. Each one is added to
`RP_ORIGINS`, and sign-in stays in the connection with `webauthn`, with no
redirect. Tradeoff: the smoothest sign-in, but the operator blesses each
client (about 5 web domains at most), so it does not work between strangers.

### D. `external` with a code to type

The server hosts a passkey page under `apron.chat` and offers `external`. The
client proposes without `return_url` and opens the page. After the passkey
step, the page shows a short code, which the user types into the client, and
which works only on the connection that proposed (§4.11.2). Tradeoff: safe for
every kind of client with no allowlist and no PKCE, but typing a code is
clunkier than a redirect.

### E. `external` with a redirect

As D, but the client proposes with a `return_url`, and the page redirects the
token there. The server accepts `https` origins that it trusts, and app schemes
such as `sidetable:` for native apps that open the page in
`ASWebAuthenticationSession`, which returns the callback only to the session
that opened it. Tradeoff: smooth, but every web origin must be on the
operator's list, and a native app that opens the system browser can have its
token caught by another app.

### F. An identity provider behind `external`

The server's `external` page is an OpenID Connect provider, such as a
self-hosted Pocket ID, or later a shared auth.apron.chat. The server is the
provider's client: it handles the callback, maps the provider's users to
accounts, and then finishes as in D or E. Clients change nothing. Tradeoff:
Pocket ID is clean and invisible to clients, but a shared provider is new
infrastructure, makes users register passkeys again, and lets a third party
vouch for the server's users.

## Need a change

### G. `apron:` redirects with PKCE

As E, but native apps on any platform return through `apron:`, and prove with
PKCE that they made the proposal. Every Apron app can share the scheme, so the
server needs no list of app schemes, and a token that lands in the wrong app
is useless without the verifier. Tradeoff: works between strangers on every
platform, but it changes §4.11 and the `apron:` rule in A.4. Change:
[1](#1-pkce-on-external).

### H. `postMessage` for web frontends

The web client opens the page in a popup, and the page posts the token to its
opener, which the browser delivers only to the origin that the proposal gave.
An unknown frontend gets a smooth sign-in with no allowlist and no PKCE, and a
page opened from a mailed link has no opener, so it falls back to the code.
Tradeoff: no coordination and smooth on the web, but it changes §4.11, and it
depends on popups and opener rules. Change: [2](#2-return_origin-for-web-frontends).

### I. A sign-in page on another party's site

A web client such as web.apron.chat hosts the passkey page for a server, and
approves the server's proposals through page methods over its own
connection. Servers can then skip building a page. Tradeoff: less work for
each server, but it adds extension methods, and the server trusts the page's
site as it trusts its own sign-in. Change:
[3](#3-exthandoff-page-methods).

### J. A label for `external`

The server names the portal that `external` opens, such as "Pocket ID", so
clients can say "Sign in with Pocket ID", and users know where they are going
before the redirect. It improves D–I, and changes no flow. Tradeoff: a small
extension, but the label is the server's claim, and the browser's address
shows the real page. Change: [4](#4-extauth_external-label).

## Protocol changes

### 1. PKCE on `external`

For option G. In PROTOCOL.md, so every `external` sign-in can use it.

`Auth` (§3.2) gains two fields:

```ts
class Auth {
  // "external" scheme (§4.11)
  challenge?: string;   // proposal: unpadded base64url of SHA-256(verifier)
  verifier?: string;    // approval: 43 to 128 characters of A-Z a-z 0-9 - . _ ~
}
```

§4.11.1, Proposals, gains:

- A proposal MAY carry `challenge`, the unpadded base64url of the SHA-256 of
  a `verifier` that the client keeps.
- Clients make a new `verifier` for each proposal.

§4.11.3, Approval, gains:

- An approval of a proposal with `challenge` MUST carry the matching
  `verifier`. Otherwise it is `denied`, and the temporary token is used up.

§4.11.5, External, gains:

- A server accepts an `apron:` `return_url` only from a proposal with
  `challenge`.

Appendix A.4 changes "Servers never write a link with `token` in the
`apron:` form" to:

- Servers write a link with `token` in the `apron:` form only to the
  `return_url` of a proposal with `challenge` (any app can claim the scheme).

§5.2 gains: a token sent to `apron:` can reach any app that claims the scheme,
and is useless to it without the verifier.

HISTORY.md and the schema gain `challenge` and `verifier` on `auth`.

### 2. `return_origin` for web frontends

For option H. In PROTOCOL.md §4.11.5.

`Auth` (§3.2) gains:

```ts
class Auth {
  // "external" scheme (§4.11)
  return_origin?: string;   // an origin, in place of return_url
}
```

§4.11.5 gains:

- A proposal MAY carry `return_origin` in place of `return_url`.
- The server accepts `return_origin` only when it equals the proposing
  connection's `Origin`, and is `https` or a loopback address.
- With `return_origin`, the page posts its result to `window.opener`, with
  `return_origin` as the target origin, and then closes.
- The result is `{apron: "external", token, state, server}` on approval, and
  `{apron: "external", error: "access_denied", state, server}` when the user
  declines.
- Without an opener, the page shows a code to type, as without `return_url`.
- Clients accept only a message from the window that they opened, from the
  `url`'s origin, with their own `state`.

The page does not set `Cross-Origin-Opener-Policy: same-origin`, which would
cut its opener.

§5.2 gains: the browser delivers the token only to a window on
`return_origin` that opened the page, and a page opened from a link has no
opener. HISTORY.md and the schema gain `return_origin` on `auth`.

### 3. `ext:handoff` page methods

For option I. In EXTENSIONS.md, as part 2 of EXT_HANDOFF.md.

- The server frame gains `ext.handoff.page`, the origin of the sign-in page.
- The proposal's `url` is on that origin, with `server` and `p` in its query.
- `ext:handoff_get {proposal}` returns `{agent?, destination, expires}`, and
  works before the page signs in.
- `ext:handoff_approve {proposal}` needs a connection signed in to an account,
  uses up the proposal, and returns `{redirect}`, or `{code}` for a proposal
  without `return_url`.
- `ext:handoff_deny {proposal}` uses up the proposal, and returns `{redirect}`
  with `error=access_denied`, or `{}`.
- The server answers these methods only on connections from the page's
  origin.

### 4. `ext:auth_external` label

For option J. In EXTENSIONS.md, as in EXT_AUTH_EXTERNAL.md.

- The server frame gains `ext.auth_external.label`, a plain-text name of at
  most 64 characters, sent only while `server.auth` lists `external`.
- Clients show it where they offer `external`, as plain text.

## Related change

Clients run an in-connection passkey ceremony only when its RP ID is the
server's host or a domain that the host is under (§4.10). This guards options
B and C against a server that relays another server's challenge. It landed in
v10.

The mix-up fix is still pending: §4.11.2 tells a client to ignore `server` in
a link with its own `state`, so a hostile server can collect a token for
another server (REVIEW.md, problem 1).
