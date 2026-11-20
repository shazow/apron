# `ext:handoff`: native sign-in through a sign-in page

Status: superseded by [PLAN_OAUTH.md](PLAN_OAUTH.md), where PKCE is part of
OAuth 2.1 and no page methods are needed. Kept for reference. Written against
protocol version 9.

## Summary

`ext:handoff` lets a native client, such as SideTable on macOS, sign in to an
Apron server with a passkey that the user made in a web client. The client
uses `external` sign-in
([PROTOCOL.md §4.11](https://github.com/shazow/apron/blob/main/PROTOCOL.md#411-email-and-external-sign-in))
as written. The extension has two parts:

1. **PKCE on `external`** (required for this flow): the client proves that it
   made the proposal when it redeems the token, so a token caught on its way
   back is useless. This part is between the client and the server, over the
   Apron connection, on any transport.
2. **A sign-in page that another party hosts** (optional): the page reads and
   approves a proposal over its own Apron connection. A server needs this
   part only when its page is on another party's origin, such as
   web.apron.chat. A server that hosts its own page skips it.

The client's side is the same whichever page the server uses: a proposal with
a `challenge`, a browser session, and an approval with the `verifier`.

## Motivation

A passkey belongs to an RP ID, a domain. The passkeys for server.apron.chat
belong to `apron.chat`. A third-party native app cannot use them: macOS lets
an app use an RP ID only when that domain lists the app. A page on an
`apron.chat` origin can use them, and a native app can open such a page in
`ASWebAuthenticationSession`, where the user's passkeys appear.

So the passkey step runs on a page, and the page hands the sign-in back to the
app. `external` already defines the proposal, the redirect, and the approval.
It does not bind the approval to the app that proposed it, and it does not
define how a page on another origin approves a proposal.

## Flow

```mermaid
sequenceDiagram
    participant App as Native app
    participant Server as Apron server
    participant Page as Sign-in page
    App->>Server: 1. auth external (return_url, state, challenge)
    Server-->>App: 2. url (page?server=…&p=…)
    App->>Page: 3. open url in ASWebAuthenticationSession
    Page->>Server: 4. ext:handoff_get (p)
    Server-->>Page: 5. agent, destination
    Page->>Server: 6. auth webauthn login, or a saved session
    Server-->>Page: 7. you
    Note over Page: The user confirms
    Page->>Server: 8. ext:handoff_approve (p)
    Server-->>Page: 9. redirect (return_url#token=…&state=…&server=…)
    Page-->>App: 10. navigate to redirect; the session returns it
    Note over App: Check state
    App->>Server: 11. auth external (token, verifier)
    Server-->>App: 12. you, long-lived token
```

- Steps 1–3 and 10–12 are part 1. Every client and server in this flow
  implements them.
- Steps 4–9 are part 2. With a page that the server hosts itself, they are
  internal to the server, and nothing here specifies them.

After step 12, the app signs in with `scheme: "token"` on later connections
([§3.2.1](https://github.com/shazow/apron/blob/main/PROTOCOL.md#321-bearer-tokens)).

## Capability

- A server that implements the extension lists `ext:handoff` in
  `server.capabilities`, and lists `external` and `token` in `server.auth`.
- `ext:handoff` means part 1. A server that also implements part 2 sends the
  page's origin in its `server` frame (see part 2).
- Clients send `ext.handoff` only to a server that lists `ext:handoff`.
- Without the capability, clients use `external` as §4.11 defines it, without
  PKCE.

---

## Part 1: PKCE on `external`

### Proposal

```jsonc
// ->
{"method": "auth", "id": "c1", "params": {
  "scheme": "external",
  "return_url": "sidetable://signed-in",
  "state": "q8Rz…",
  "agent": "SideTable/1.2",
  "ext": {"handoff": {"challenge": "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"}}
}}
// <-
{"id": "c1", "result": {"url": "https://web.apron.chat/sign-in?server=wss%3A%2F%2Fserver.apron.chat%2F&p=Qm7xT2…"}}
```

```ts
class Handoff {          // auth params: ext.handoff
  challenge?: string;    // proposal: unpadded base64url of SHA-256(verifier)
  verifier?: string;     // approval: the verifier itself
}
```

- The client makes a new verifier for each proposal: 32 random bytes as
  unpadded base64url, 43 characters.
- `challenge` is the unpadded base64url of the SHA-256 of the verifier's
  ASCII bytes. This is PKCE's `S256` method
  ([RFC 7636](https://www.rfc-editor.org/rfc/rfc7636)), and the only one.
- Clients that redirect to a loopback address or their own scheme send
  `challenge`.
- A server MAY refuse a proposal without `challenge` whose `return_url` is
  not `https`, as `invalid_params`.
- `state` is required. It is unguessable, at most 256 bytes
  ([§4.11.1](https://github.com/shazow/apron/blob/main/PROTOCOL.md#4111-proposals)).
- A proposal on a connection that is signed in proposes an addition
  (§4.11.1). A server MAY refuse additions as `denied`.

The server accepts these `return_url`s:

- an `http` URL on a loopback IP address, `127.0.0.1` or `[::1]`, on any port.
- a URL with a scheme of the client's own, such as `sidetable:`.
- an `https` URL on an origin that the server trusts.
- no `return_url`: the page shows a code to type (§4.11.5), for clients
  without a browser session, such as terminal clients.

The server refuses any other `return_url` as `invalid_params`, including
these schemes: `apron`, `javascript`, `data`, `file`, `blob`, and `about`.
(Any app can claim `apron:`, and the others run in or read from the page.)

The result's `url` is the sign-in page. A proposal expires 10 minutes after
it is made, and an approval or a denial uses it up.

### Approval

The page redirects to the `return_url` with a fragment, serialized as in
links ([Appendix A.4](https://github.com/shazow/apron/blob/main/PROTOCOL.md#a4-links)):

- On approval: `token`, `state`, and `server`.
- When the user declines: `error=access_denied`, `state`, and `server`.

```jsonc
// -> on a connection that is not signed in
{"method": "auth", "id": "c2", "params": {
  "scheme": "external",
  "token": "xt_Hk41…",
  "ext": {"handoff": {"verifier": "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"}}
}}
// <-
{"id": "c2", "result": {"you": {"user_id": "ada", "name": "Ada"}, "token": "apron_device_…"}}
```

- The client checks that `state` in the fragment is the `state` of its own
  proposal. It ignores a fragment with any other `state`.
- With `error=access_denied`, the client tells the user that the sign-in was
  declined.
- The approval follows
  [§4.11.3](https://github.com/shazow/apron/blob/main/PROTOCOL.md#4113-approval):
  it signs in the connection that presents the token, which is not signed in
  already.
- An approval of a proposal with `challenge` MUST carry `verifier`. The server
  compares the SHA-256 of `verifier` with `challenge`.
- A missing or wrong `verifier` is `denied`, and uses up the temporary token.
- The result carries `you` and a long-lived bearer `token`. Its kind and
  lifetime are server policy. Suggested convention: a token that the user
  can list and revoke, named from `agent`.

---

## Part 2: A sign-in page that another party hosts

A server implements this part when its sign-in page is on another party's
origin. The page is an ordinary Apron client of the server: it reads the
proposal, signs in, asks the user, and answers.

```json
"ext": {"handoff": {"page": "https://web.apron.chat"}}
```

```ts
class HandoffServer {    // server.ext.handoff
  page?: string;         // the origin of the sign-in page, for part 2
}
```

- The server sends `server.ext.handoff.page` when it implements part 2.
- The proposal's `url` is on that origin, with two query keys:
  - `server`: the server's address, as in links (Appendix A.4).
  - `p`: the proposal's ID, unguessable, with at least 128 random bits.
- The page connects to the server in `server`.

### Page methods

```jsonc
// -> before or after signing in
{"method": "ext:handoff_get", "id": "s1", "params": {"proposal": "Qm7xT2…"}}
// <-
{"id": "s1", "result": {"agent": "SideTable/1.2", "destination": "sidetable:", "expires": "1793490000000"}}

// -> signed in, after the user confirms
{"method": "ext:handoff_approve", "id": "s2", "params": {"proposal": "Qm7xT2…"}}
// <-
{"id": "s2", "result": {"redirect": "sidetable://signed-in#token=xt_Hk41…&state=q8Rz…&server=wss://server.apron.chat/"}}

// -> or, when the user declines
{"method": "ext:handoff_deny", "id": "s3", "params": {"proposal": "Qm7xT2…"}}
// <-
{"id": "s3", "result": {"redirect": "sidetable://signed-in#error=access_denied&state=q8Rz…&server=wss://server.apron.chat/"}}
```

`ext:handoff_get` returns:

- `agent`: the `agent` of the proposal, if it had one. The client chose it,
  and the server does not check it.
- `destination`: where the token goes. It is the origin of an `https`
  `return_url`, the scheme of a client's own scheme with its colon,
  `loopback`, or `code` for a proposal without `return_url`.
- `expires`: when the proposal expires, in the format of a `log_id`.

`ext:handoff_approve`:

- needs a connection that is signed in to an account. A guest or a connection
  that is not signed in gets `denied`.
- uses up the proposal.
- mints a temporary token for the signed-in user
  ([§4.11.2](https://github.com/shazow/apron/blob/main/PROTOCOL.md#4112-temporary-tokens)):
  single use, and expiring within 5 minutes. A token for a redirect has at
  least 128 random bits.
- returns `redirect`, the `return_url` with the approval's fragment, which
  replaces any fragment of the `return_url`.
- for a proposal without `return_url`, returns `code` instead: a short token
  that works only on the connection that made the proposal.

`ext:handoff_deny` uses up the proposal. It returns `redirect` with the
declined fragment, or `{}` for a proposal without `return_url`.

Rules for all three methods:

- The server answers them only on connections from the origin in
  `server.ext.handoff.page`, by the WebSocket `Origin` header. Other
  connections get `denied`.
- An unknown, expired, or used proposal is `invalid_params`.

### The page

- The page shows the server's host, `agent` as a name the app gives itself,
  and `destination`.
- The page asks the user to confirm before it approves, also when a saved
  session signs it in.
- The page offers to decline, and then calls `ext:handoff_deny`.
- The page navigates to `redirect` and to no other URL.
- With `code`, the page shows the code, and tells the user to type it only in
  the app where they started.

---

## Security considerations

Part 1:

- A redirect to a loopback address or a client's own scheme can be caught by
  another app on the device. PKCE makes a caught token useless without the
  verifier, which never leaves the client.
- `ASWebAuthenticationSession` returns the callback only to the session that
  opened it, so two apps that claim one scheme do not see each other's
  redirects. PKCE still covers clients that open the page another way.
- `state` stops a link from signing a client in to someone else's account.
- `server` in the fragment lets a client that talks to several servers see
  which one minted the token, like OAuth's `iss` (RFC 9207).

Part 2:

- Someone can make a proposal and send its page link to a victim. A token
  for a loopback address or a client's own scheme goes to the victim's own
  device, an `https` token goes only to an origin that the server trusts, and
  a code works only on the proposer's connection. The page shows where the
  token goes, and asks before it approves.
- The proposal ID in the page link is unguessable, single use, and short
  lived. Someone who learns it can approve it with their own account, and
  the client then signs in as them. The ID travels only to the client's own
  browser session.
- `agent` is what the client says it is. The page presents it as such, and
  shows `destination`, which the server checked.
- The page can approve any proposal for the user who signs in on it, so the
  server trusts its page as it trusts its own sign-in. Answering the page
  methods only on the page's origin keeps other web pages from calling them
  in a user's browser.

## Relation to OAuth

The flow is OAuth 2.1's authorization-code flow for native apps (RFC 8252),
carried over the Apron connection:

| `ext:handoff`                   | OAuth                                 |
|---------------------------------|---------------------------------------|
| proposal and `p`                | pushed authorization request, `request_uri` (RFC 9126) |
| `return_url`, `state`           | `redirect_uri`, `state`               |
| `agent`                         | `client_id`, unverified for a public client |
| sign-in page                    | authorization endpoint and consent    |
| temporary token                 | authorization code                    |
| approval                        | token endpoint, authorization-code grant |
| `challenge`, `verifier`         | PKCE `S256` (RFC 7636)                |
| `error=access_denied`           | `error=access_denied`                 |
| `server` in the fragment        | `iss` (RFC 9207)                      |
| proposal without `return_url`   | device authorization grant (RFC 8628) |

Part 2 has no OAuth equivalent: OAuth leaves how a consent page talks to its
own server to each implementation.

## Implementation notes

For server.apron.chat with its page on web.apron.chat, which uses both parts.

apron-server-cloudflare:

- Already there: passkey sign-in, with web.apron.chat in `RP_ORIGINS`;
  device tokens (`/invite-device`); rate limits on sign-in attempts.
- New for part 1: offer `external`; keep proposals with their `return_url`,
  `state`, `agent`, and `challenge`; redeem the temporary token with the
  `verifier`, which mints a device token.
- New for part 2: `server.ext.handoff.page`; the three page methods; the
  temporary token.

apron-web:

- Already there: passkey login with the RP ID check, saved sessions for each
  server, and a connection used only for sign-in.
- New for part 2: a `/sign-in?server=…&p=…` route that runs the page's steps.

SideTable:

- Already there: token sign-in and storage, from `/invite-device`.
- New for part 1: make the verifier and propose, open `url` in
  `ASWebAuthenticationSession` with its scheme, check `state`, and redeem the
  token with the verifier.

## Open questions

- Should the long-lived token be a device token, which has a limit of 5 for
  each user today, or a session token, which servers bind to a web origin?
- Should part 1 move into §4.11 for every `external` sign-in, leaving only
  part 2 in this extension?
- Should a page that a web client hosts serve any server, or only servers on
  a list that it keeps?
